// 键盘麦克风管线：HID 音频报文 → (SBC 解码 | PCM 直通) → DSP 增强链 → PCM 输出
// DSP 链（2026-08-24 重构，标定依据见 tools/audio-analysis.js）：
//   1. 4 阶高通 100Hz——实测 86% 底噪能量 <125Hz，旧一阶 6dB/oct 挡不住
//   2. RNNoise 神经降噪（48kHz 域，16k↔48k 线性重采样）+ 附带 VAD 概率
//   3. VAD 门控 AGC：旧版在纯噪段也拉增益把底噪放大至 8×（实测底噪 RMS≈161
//      高于旧门限 90，噪声门从不生效）——现在只有语音段才升增益
//   4. 自适应噪声门 + tanh 软限幅（替代硬 clamp 削波）
//
// 音频报文格式（实测确认）：
//   蓝牙 [0x1B, seq, ...60B 净荷]：净荷 = 3 × 20B SBC 小帧 → 每报文 240 样本 @16kHz
//   USB   [0x1C, seq, 2B, 30×int16LE]：原始 PCM 直出，免解码

const { Denoiser } = require('./denoise');
const { DeepFilter } = require('./df');
const { NoiseSubtractor } = require('./noise-profile');
const { RateConverter } = require('./resample');

function init(mod) { mod.init(); return mod; }

function loadDecoder() {
  if (loadDecoder._cache) return loadDecoder._cache;
  let mod;
  if (process.platform === 'win32') {
    mod = init(require('../../vendor/mi-sbc/prebuilds/sbc-win32-x64/node-napi-v4.node'));
  } else if (process.platform === 'darwin') {
    mod = process.arch === 'arm64'
      ? init(require('../../vendor/mi-sbc/prebuilds/sbc-darwin-arm64/node-napi-v4.node'))
      : init(require('../../vendor/mi-sbc/prebuilds/sbc-darwin-x64/node-napi-v4.node'));
  } else {
    mod = process.arch === 'arm64'
      ? init(require('../../vendor/mi-sbc/prebuilds/sbc-linux-arm64/node-napi-v4.node'))
      : init(require('../../vendor/mi-sbc/prebuilds/sbc-linux-x64/node-napi-v4.node'));
  }
  loadDecoder._cache = mod;
  return mod;
}

// ---- RBJ cookbook 二阶高通（Q=0.707 Butterworth），两级级联 = 4 阶 24dB/oct ----
function highpassCoeffs(fs, f0, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cw = Math.cos(w0);
  const b0 = ((1 + cw) / 2), b1 = -(1 + cw), b2 = ((1 + cw) / 2);
  const A0 = 1 + alpha, A1 = -2 * cw, A2 = 1 - alpha;
  return { b0: b0 / A0, b1: b1 / A0, b2: b2 / A0, a1: A1 / A0, a2: A2 / A0 };
}

// RBJ cookbook 二阶高频搁架（high shelf）：把 f0 以上按 gainDb 抬起来。
// 用途见 mode='speech'：这个键盘麦的辅音区（2-8kHz）实测只有正常值的 1/4，
// 而识别严重依赖该频段——用搁架把它补回来，是「提升识别率」最直接的一刀。
function highShelfCoeffs(fs, f0, gainDb, S = 1) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sa = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cw + 2 * sa * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  const b2 = A * ((A + 1) + (A - 1) * cw - 2 * sa * alpha);
  const a0 = (A + 1) - (A - 1) * cw + 2 * sa * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cw);
  const a2 = (A + 1) - (A - 1) * cw - 2 * sa * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const BLOCK = 160; // 处理块长：10ms @16kHz → ×3 = 480 样本 @48kHz（RNNoise 帧长）
const FIFO_CAP = 16000; // 1s 上限防积压

// 块 RMS（降噪前后对比探针用）
function rmsOf(a, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * a[i];
  return Math.sqrt(s / n);
}

class MicPipeline {
  constructor(opts = {}) {
    this.dec = loadDecoder();
    this.dstBuf = Buffer.alloc(160);
    this.srcBuf = Buffer.alloc(23);
    this.denoiseWanted = opts.denoise !== false;
    // DSP 可调参数（远距识别优化，默认值即新行为）：
    //   gateRelease —— 门控释放系数。旧值 0.04 太慢（语音后十几秒才降回底噪），
    //     句中换气几百毫秒被持续压低；0.25 ≈ 400ms 半衰，兼顾不切字头尾与句中电平
    //   agcTarget  —— AGC 目标 RMS。旧值 4200(-17dBFS) 偏激进，底噪被一起抬起；
    //     3600(-19dBFS) 更贴合 ASR 甜区且留足压缩器余量
    //   attenLimDb —— DFN3 最大衰减。实测（CDP 扫描真实麦克风）：
    //     越大降噪越强——2dB→16.2dB 降噪量、6dB→20.8dB，24dB 后收益递减。
    //     曾降至 3dB 求「保护辅音」，实测方向错了：底噪偏高需要更强降噪，
    //     调低反而压不住底噪、输出电平被门控吃掉（送进 ASR 只剩 114，甜区是 800+）。
    //     注意 libdf 把 0 当「无限制」而非「不降噪」——API 陷阱，须避开 0。
    //   gateOpenMul —— 语音判定倍数（底噪倍数）。关键修复：原值 5 对远距说话是
    //     「越远越听不清」的直接元凶——实测键盘麦底噪 RMS≈150，阈值 750，
    //     而远距离语音 RMS 只有 600~900，永远判不出语音，AGC 不启动、
    //     电平不被抬起，ASR 自然听不清。降到 3（阈值 450）后弱语音能过判定，
    //     距底噪仍有 3 倍余量，纯噪段门控照常闭合
    this.tune = {
      gateRelease: opts.gateRelease ?? 0.25,
      agcTarget: opts.agcTarget ?? 3600,
      attenLimDb: opts.attenLimDb ?? 6,
      gateOpenMul: opts.gateOpenMul ?? 3,
      gateFloor: opts.gateFloor ?? 0.05,
      agcMaxGain: opts.agcMaxGain ?? 32,
    };

    // 处理档位（v0.13.2）：
    //   raw  —— 全跳过，键盘麦原样（听原始做基准）
    //   hp   —— 只开 4 阶 100Hz 高通。实测底噪 38% 能量在 200Hz 以下，
    //           这部分低频轰鸣除了「闷」，还会让廉价耳机/音箱产生非线性失真
    //           而听感「刺」——所以「只去低频」是一个独立且低风险的档位
    //   full —— 完整处理链（高通+降噪+谱减+门控+AGC+压缩+限幅）
    this.mode = opts.mode || (opts.bypass === true ? 'raw' : 'full');
    this.bypass = this.mode === 'raw';

    // ---- 输入真采样率转换（v0.13.1）----
    // 键盘实际输出约 17129Hz（实测），代码原按 16000Hz 处理 → 声音降调 7%。
    // 这是「传输层纠错」不是音频处理：即使旁路模式也要开，否则听到的是变调的假原始。
    // inRate=0 或 16000 时不做转换。
    this.inRate = Number(opts.inRate) > 0 ? Number(opts.inRate) : 17129;
    // 只有显式 autoRate:false 才禁用自动校准。
    // 曾把「inRate 恰好传 16000」也当作禁用信号——但 16000 是合法采样率，
    // 结果是：用户把配置设成 16000 后，切回 17129Hz 的链路也不再校准，
    // 凭空退回 7% 降调。语义必须分开。
    this.inRateLocked = opts.autoRate === false;
    this.rc = Math.abs(this.inRate - 16000) > 1 ? new RateConverter(this.inRate, 16000) : null;
    // 自动校准状态：采样率是「链路 + 固件」的属性，不该硬编码。
    // 实测 2.4G 链路是 17129Hz；有线直连可能不同，固件升级也可能变——
    // 所以按「样本数 ÷ 墙上时钟」实测，异常值不采纳（保留配置值兜底）。
    this._cal = { samples: 0, t0: 0, done: false };
    this._calRate = 0;   // 最近一次校准结果（诊断用）

    this.hp1 = new Biquad(highpassCoeffs(16000, 100));
    this.hp2 = new Biquad(highpassCoeffs(16000, 100));
    // 辅音区补偿（mode='speech'）：实测该麦 2-8kHz 只有正常语音的约 1/4 能量，
    // 两级级联 = 约 2×gainDb 的搁架斜率，起点 1800Hz（元音/辅音分界附近）
    this.hfBoostDb = Number(opts.hfBoostDb) >= 0 ? Number(opts.hfBoostDb) : 6;
    this._buildShelf();
    // 降噪引擎：DFN3 主力，RNNoise 兜底（dll/模型缺失时自动降级）
    this.df = new DeepFilter();
    this.rnnoise = new Denoiser();
    this.engine = null; // 'df' | 'rnnoise' | null
    this.denoiseFailLogged = false;
    this._initing = false;        // initDenoiser 并发去重
    this._denoiseRetryAt = 0;     // 引擎坏状态旁路后的冷却重试时刻
    this.snrDb = 0;               // 最近一帧局部 SNR（链路体检上报用）
    this._dspDiag = 0;

    // 稳态噪声扣除（v0.12.5）：学习期只建模不扣除，学习满后按噪声谱扣除。
    // 削波率统计（调参器的打分项之一）
    this.clipCount = 0;
    this.clipRate = 0;
    // 降噪前后对比探针（默认开：开销是两个 160 点 RMS，可忽略）
    this._probeOn = true;
    this._probeSilence = { pre: 0, post: 0, n: 0, m: 0 };
    this._probeSpeech = { pre: 0, post: 0, n: 0, m: 0 };
    this.noiseSub = opts.noiseSubtract === false
      ? null
      : new NoiseSubtractor({ enabled: true, overSub: opts.overSub, floorDb: opts.floorDb });

    // 样本 FIFO（16k 域 float32）
    this.fifo = new Float32Array(FIFO_CAP);
    this.fifoLen = 0;

    // AGC/门控状态
    this.gain = 1;
    this.gate = 1;
    this.noiseFloor = 150;   // 实测键盘麦环境底噪 RMS≈161，取近似初值自适应收敛
    this.lastUp = 0;         // 重采样连续性
    this.compEnv = 0;        // 压缩器包络
    // 统计（供 UI 电平显示）
    this.level = 0;
    this.packets = 0;
    this.vad = 0;
  }

  // wasm/ffi 初始化：boot 时预热；未就绪期间自动旁路降噪（其余 DSP 照常）。
  // _initing 并发去重：setDenoise 与 boot 预热同时触发时不重复实例化 wasm
  async initDenoiser() {
    if (!this.denoiseWanted) return null;
    if (this.engine) return this.engine;
    if (this._initing) return this.engine;
    this._initing = true;
    try {
      try {
        this.df.init(this.tune.attenLimDb);
        this.engine = 'df';
        return 'df';
      } catch (e) {
        console.log('[mic] DFN3 初始化失败，回退 RNNoise:', e.message);
      }
      try {
        await this.rnnoise.init();
        // 等待期间用户关掉了降噪：不能把引擎又点亮（开关语义优先）
        if (!this.denoiseWanted) return null;
        this.engine = 'rnnoise';
        return 'rnnoise';
      } catch (e) {
        console.log('[mic] RNNoise 初始化失败，降噪旁路:', e.message);
      }
      return null;
    } finally {
      this._initing = false;
    }
  }

  // 运行时开关降噪（设置页切换即时生效，无需重启）：
  //   off → 立即旁路（engine 置空，帧处理跳过 native 调用）
  //   on  → 重新预热引擎（此前初始化失败/从未初始化也能恢复）
  setDenoise(on) {
    const wanted = on !== false;
    if (wanted === this.denoiseWanted) return;
    this.denoiseWanted = wanted;
    if (!wanted) {
      this.engine = null;
    } else {
      this.denoiseFailLogged = false;
      this.initDenoiser().catch(() => {});
    }
  }

  // 运行时开关稳态噪声扣除 / 重新学习底噪
  setNoiseSubtract(on) {
    const wanted = on !== false;
    if (!this.noiseSub) {
      if (!wanted) return false;
      this.noiseSub = new NoiseSubtractor({ enabled: true, overSub: this.tune.overSub, floorDb: this.tune.floorDb });
      return true;
    }
    this.noiseSub.enabled = wanted;
    if (!wanted) this.noiseSub.reset();
    return wanted;
  }

  // 重新学习底噪：用户换了位置/环境噪声变了时调用
  relearnNoise() {
    if (!this.noiseSub) return false;
    this.noiseSub.reset();
    return true;
  }

  // 噪声扣除过减系数/谱底限（调参器可控）
  setNoiseProfile(patch = {}) {
    if (!this.noiseSub) return null;
    if (patch.overSub !== undefined) {
      const v = Number(patch.overSub);
      if (Number.isFinite(v)) this.noiseSub.overSub = Math.max(0.5, Math.min(6, v));
    }
    if (patch.floorDb !== undefined) {
      const v = Number(patch.floorDb);
      if (Number.isFinite(v)) this.noiseSub.floorDb = Math.max(-40, Math.min(0, v));
    }
    return this.noiseSub.diagnostics();
  }

  // 运行时调 DSP 参数（设置页改即时生效，无需重启）。
  // attenLimDb 走 df_set_atten_lim，不重建引擎；其余下次 block 即生效。
  setTune(patch = {}) {
    const T = this.tune;
    for (const k of ['gateRelease', 'agcTarget', 'attenLimDb', 'gateOpenMul', 'gateFloor', 'agcMaxGain']) {
      if (patch[k] === undefined || patch[k] === null) continue;
      const v = Number(patch[k]);
      if (!Number.isFinite(v)) continue;
      if (k === 'gateRelease') T[k] = Math.max(0.01, Math.min(1, v));
      else if (k === 'agcTarget') T[k] = Math.max(500, Math.min(8000, v));
      else if (k === 'attenLimDb') T[k] = Math.max(0, Math.min(24, v));
      else if (k === 'gateOpenMul') T[k] = Math.max(1.5, Math.min(20, v));
      else if (k === 'gateFloor') T[k] = Math.max(0, Math.min(1, v));
      else if (k === 'agcMaxGain') T[k] = Math.max(1, Math.min(32, v));
    }
    if (this.engine === 'df' && this.df.ready) this.df.setAttenLim(T.attenLimDb);
    return this.tune;
  }

  // 链路体检快照：给设置页/日志/调参器看的实时指标
  diagnostics() {
    return {
      engine: this.mode === 'raw' ? 'bypass' : (this.engine || 'none'),
      bypass: !!this.bypass,
      mode: this.mode,
      inRate: this.inRate,
      inRateMeasured: this._calRate || 0,
      inRateCalibrated: this._cal.done,
      resampling: !!this.rc,
      snrDb: Math.round(this.snrDb * 10) / 10,
      vad: Math.round(this.vad * 100) / 100,
      noiseFloor: Math.round(this.noiseFloor),
      level: Math.round(this.level),
      gate: Math.round(this.gate * 100) / 100,
      gain: Math.round(this.gain * 100) / 100,
      packets: this.packets,
      fifoLen: this.fifoLen,
      clipRate: Math.round((this.clipRate || 0) * 10000) / 10000,
      noiseProfile: this.noiseSub ? this.noiseSub.diagnostics() : null,
      // 降噪前后对比（核心诊断：回答「底噪高是降噪没工作还是物理底噪」）
      probe: this._probeOn ? this.probeReport() : null,
      tune: { ...this.tune },
    };
  }

  // 蓝牙口：SBC 解码 240 样本进链
  pushPacket(pkt) {
    this.packets++;
    const pcm = new Int16Array(240);
    let w = 0;
    for (let f = 0; f < 3; f++) {
      this.srcBuf[0] = 0xad; this.srcBuf[1] = 0x31; this.srcBuf[2] = 0x0c;
      pkt.copy(this.srcBuf, 3, 2 + f * 20, 2 + f * 20 + 20);
      const n = this.dec.decode(this.srcBuf, 23, this.dstBuf);
      // dstBuf 只容 80 样本：native 异常返回更大值时钳制，防 readInt16LE 越界抛错刷日志
      const cnt = Math.min(n, 80);
      for (let i = 0; i < cnt && w < 240; i++) pcm[w++] = this.dstBuf.readInt16LE(i * 2);
    }
    while (w < 240) pcm[w++] = 0;
    return this.feed(pcm, w);
  }

  // USB 口：30 样本原始 PCM 进链
  pushWiredFrame(frame) {
    this.packets++;
    const pcm = new Int16Array(30);
    let w = 0;
    for (let o = 4; o + 1 < frame.length && w < 30; o += 2) pcm[w++] = frame.readInt16LE(o);
    return this.feed(pcm, w);
  }

  // 进 FIFO 并按块处理；返回本次产出的 int16 PCM Buffer（可能为空）
  feed(samples, n) {
    // 入口先做真采样率转换（见构造函数注释）：之后高通/DFN3/谱减/门控
    // 才都工作在真正的 16kHz 上
    let src = samples, cnt = n;
    if (this.rc) {
      src = this.rc.process(samples, n);
      cnt = src.length;
    }
    for (let i = 0; i < cnt; i++) {
      if (this.fifoLen >= FIFO_CAP) break; // 积压保护：丢新保旧
      this.fifo[this.fifoLen++] = src[i];
    }
    this._autoCalibrate(n);
    let outs = [];
    while (this.fifoLen >= BLOCK) {
      const blk = this.fifo.slice(0, BLOCK);
      this.fifo.copyWithin(0, BLOCK, this.fifoLen);
      this.fifoLen -= BLOCK;
      outs.push(this.processBlock(blk));
    }
    if (!outs.length) return Buffer.alloc(0);
    return outs.length === 1 ? outs[0] : Buffer.concat(outs);
  }

  processBlock(blk) {
    // 0) 原始直出（跳过全部处理）：只做 float→int16，不加高通/降噪/谱减/门控/AGC/压缩/限幅。
    // 用途是「听原始音频」做基准对比——判断这套算法到底有没有帮上忙。
    // 关键：这里必须真的什么都不做，任何一处「顺手修一下」都会让对比失去意义。
    if (this.mode === 'raw') {
      // 但诊断不能跟着哑掉：面板要能显示电平/信噪比才能判断链路是否正常。
      // 这些只是**测量**，不改变一个样本的输出（原始档的透明性由单测守着）。
      const pre = rmsOf(blk, BLOCK);
      if (this._probeOn) {
        this.level = this.level * 0.7 + pre * 0.3;
        this._trackNoiseFloor(pre);
        this._updateProbe(pre, pre);   // 未处理：前后相同，snrGain 自然为 0
      }
      return this._passthrough(blk);
    }

    // 1) 陡高通（16k 域）—— raw 之外的所有档位都要（hp 档就到此为止）
    for (let i = 0; i < BLOCK; i++) blk[i] = this.hp2.process(this.hp1.process(blk[i]));

    // 探针的「处理前」基准点：高通之后、任何整形/降噪之前。
    // 放在这里而不是更下面，是为了让 hp / speech 这些会提前 return 的档位
    // 也能采到数据——否则只有 full 档能测信噪比，无法横向对比（踩过）。
    const preHpRms = this._probeOn ? rmsOf(blk, BLOCK) : 0;
    const probeAnd = (buf) => {
      if (this._probeOn) {
        const post = rmsOf(blk, BLOCK);
        // 输出电平也要在这里更新：原实现只在 _gateAgc 里算，而 hp/speech 档
        // 不经过门控/AGC，导致面板「输出电平」恒为 0（看着像坏了）
        this.level = this.level * 0.7 + post * 0.3;
        this._trackNoiseFloor(preHpRms);
        this._updateProbe(preHpRms, post);
      }
      return buf;
    };

    // speech 档：去低频轰鸣 + 补辅音区（高频搁架），不做降噪/增益/门控。
    // 依据：实测该麦说话段 2-8kHz 仅占 1.3%（正常语音约 4~5%），
    // 而 s/sh/t/k/f 等决定可懂度的辅音全在该频段，ASR 对此高度敏感。
    if (this.mode === 'speech') {
      const buf = Buffer.alloc(BLOCK * 2);
      for (let i = 0; i < BLOCK; i++) {
        let v = this.sh1.process(blk[i]);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        blk[i] = v;                      // 写回，便于探针在统一位置取「处理后」值
        buf.writeInt16LE(Math.round(v), i * 2);
      }
      return probeAnd(buf);
    }

    // hp 档：只去低频轰鸣，不做降噪/增益/门控。用来验证「刺」是否来自低频
    if (this.mode === 'hp') {
      const buf = Buffer.alloc(BLOCK * 2);
      for (let i = 0; i < BLOCK; i++) {
        let v = blk[i];
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        blk[i] = v;
        buf.writeInt16LE(Math.round(v), i * 2);
      }
      return probeAnd(buf);
    }

    // 1.5) 引擎此前抛异常被旁路：冷却期到后自动重试恢复（用户补齐 dll/模型也生效）
    if (!this.engine && this.denoiseWanted && this._denoiseRetryAt && Date.now() >= this._denoiseRetryAt) {
      this._denoiseRetryAt = 0;
      this.initDenoiser().then(e => { if (e) console.log('[mic] 降噪引擎重试恢复:', e); }).catch(() => {});
    }

    // 2) 升采样 ×3 → DFN3/RNNoise 降噪（原地写回）→ 取中点降采样
    if (this.engine) this._denoiseBlock(blk);

    // 2.4) 辅音区补偿（full 档也生效，见 config.micHfBoost）。
    // 位置刻意在降噪之后、门控之前：先让 DFN3 在「自然频谱」上工作
    // （它的声学模型是按正常人声训练的，提前抬高频会被当成噪声压掉），
    // 再做频谱整形，最后才交给门控/AGC 定电平。
    if (this.hfBoostDb > 0 && this.mode === 'full') {
      for (let i = 0; i < BLOCK; i++) {
        let v = this.sh1.process(blk[i]);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        blk[i] = v;
      }
    }

    // 2.5) 稳态噪声扣除（v0.12.5）：放在神经网络之后、门控之前。
    // 顺序有讲究——DFN3/RNNoise 处理完非稳态噪声（键盘声、突发声），
    // 剩下的是它刻意保留的稳态底噪（麦自噪、风扇、房间底噪），
    // 这部分正好被噪声谱建模扣除。各司其职，不重复处理。
    if (this.noiseSub) this.noiseSub.processBlock(blk);

    // ★ 诊断探针（处理后）：与 preHpRms 同一点位、同一算法，差值即处理量
    if (this._probeOn) this._updateProbe(preHpRms, rmsOf(blk, BLOCK));

    // 3) VAD 门控 + AGC + 压缩器 + 软限幅（16k 域逐样本状态机，块间无缝）
    return this._gateAgc(blk);
  }

  // 底噪跟踪（所有档位共用）。
  // 原实现只在 _gateAgc（full 档）里收敛，导致 hp/speech/raw 档的 noiseFloor
  // 永远停在默认 150 —— 而实测该麦真实底噪约 70~90，于是「语音判定阈值
  // = 底噪×3 = 450」把大量真实语音误判成静音：面板判读卡在「采样中」、
  // 语音桶始终凑不满样本。底噪是链路属性，与处理档位无关，必须一直跟。
  _trackNoiseFloor(rms) {
    if (rms > 5 && rms < this.noiseFloor * 1.5) {
      this.noiseFloor += (rms - this.noiseFloor) * 0.02;
    }
  }

  // 降噪前后对比的滑动统计。分开累计「语音段」和「静音段」——
  // 判读关键就在这里：静音段的降噪量反映底噪被压了多少（这是用户要的答案），
  // 语音段的降噪量反映有没有伤到人声。
  _updateProbe(pre, post) {
    // 语音判定与 _gateAgc 保持一致（vad 概率 或 高于底噪倍数），
    // 否则会出现「探针说语音、门控说静音」的割裂
    const T = this.tune;
    const speech = this.engine
      ? (this.vad > 0.55 || pre > this.noiseFloor * T.gateOpenMul)
      : (pre > this.noiseFloor * T.gateOpenMul);
    const acc = speech ? this._probeSpeech : this._probeSilence;
    if (speech) acc.n++; else acc.m++;
    // 指数滑动平均：1s 左右窗口
    const a = 0.02;
    acc.pre = acc.pre === 0 ? pre : acc.pre * (1 - a) + pre * a;
    acc.post = acc.post === 0 ? post : acc.post * (1 - a) + post * a;
  }

  // 自动校准输入采样率：累计「原始输入样本数」与墙上时钟，4 秒后算一次。
  // 偏离 16000 超过 0.5% 就重建转换器；结果落在 14000~19000 之外视为异常，
  // 保留原值并标记不再重试（避免在坏数据上反复重建）。
  _autoCalibrate(nInputSamples) {
    if (this.inRateLocked || this._cal.done) return;
    const now = Date.now();
    if (!this._cal.t0) { this._cal.t0 = now; this._cal.samples = 0; return; }
    this._cal.samples += nInputSamples;
    const el = (now - this._cal.t0) / 1000;
    if (el < 4) return;
    const measured = this._cal.samples / el;
    this._calRate = Math.round(measured);
    if (measured >= 14000 && measured <= 19000) {
      this._cal.done = true;
      this.inRate = Math.round(measured);
      this.rc = Math.abs(this.inRate - 16000) > 80 ? new RateConverter(this.inRate, 16000) : null;
      console.log(`[mic] 自动校准输入采样率: ${this._calRate}Hz（累计 ${this._cal.samples} 样本 / ${el.toFixed(1)}s）` +
        (this.rc ? ` → 重采样到 16000Hz` : ' → 与 16k 一致，不需转换'));
    } else {
      // 异常值不锁定：音频刚开始流动/中途断续时，样本数会严重偏低
      // （实测开局测到 1123Hz）。若在此锁定 done，就会一直用一个错误速率——
      // 比如把 16k 的蓝牙流按 17129 重采样，凭空引入 7% 升调。
      // 重置窗口重试；连续 5 次异常才放弃并保留配置值。
      this._cal.retry = (this._cal.retry || 0) + 1;
      if (this._cal.retry >= 5) {
        this._cal.done = true;
        console.log(`[mic] 采样率校准连续 ${this._cal.retry} 次异常（最近 ${this._calRate}Hz），保留配置值 ${this.inRate}Hz`);
      } else {
        console.log(`[mic] 采样率校准样本不足/异常（${this._calRate}Hz，第 ${this._cal.retry} 次），稍后重试`);
      }
      this._cal.t0 = 0; this._cal.samples = 0;
    }
  }

  // 重建辅音区补偿滤波器（增益可运行时调）。
  // 单级搁架、起点 2600Hz：实测（用真实语音离线扫描）该组合把 2-8kHz 占比
  // 从 1.33% 提到约 6%，最接近正常语音的 4~5%；且几乎不动已经正常偏高的
  // 1-2kHz 区（两级级联会到 +12dB，实测把该带推到 19.9%，严重过头）。
  _buildShelf() {
    this.sh1 = new Biquad(highShelfCoeffs(16000, 2600, this.hfBoostDb));
    this._shelfReset();
  }

  _shelfReset() {
    if (this.sh1) { this.sh1.x1 = this.sh1.x2 = this.sh1.y1 = this.sh1.y2 = 0; }
  }

  // 运行时调辅音区补偿量（dB，0 = 关闭补偿）
  setHfBoost(db) {
    const v = Math.max(0, Math.min(18, Number(db)));
    if (!Number.isFinite(v)) return this.hfBoostDb;
    this.hfBoostDb = v;
    this._buildShelf();
    return this.hfBoostDb;
  }

  // 原始直出：唯一的处理是 float→int16 的类型转换与溢出钳制。
  // 不加任何滤波/增益/门控——听的就是键盘麦原样的声音。
  _passthrough(blk) {
    const buf = Buffer.alloc(BLOCK * 2);
    for (let i = 0; i < BLOCK; i++) {
      let v = blk[i];
      if (!(v === v)) v = 0; // NaN 兜底（原始数据理论上不会有，防上游异常）
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      buf.writeInt16LE(Math.round(v), i * 2);
    }
    return buf;
  }

  // 运行时切换处理档位（raw / hp / full）
  setMode(mode) {
    if (!['raw', 'hp', 'speech', 'full'].includes(mode)) return this.mode;
    this.mode = mode;
    this.bypass = mode === 'raw';
    {
      // 复位状态机，避免切回来时残留旧的门控/增益/滤波状态造成突变
      this.gate = 1; this.gain = 1; this.compEnv = 0; this.vad = 0;
      this.hp1 = new Biquad(highpassCoeffs(16000, 100));
      this.hp2 = new Biquad(highpassCoeffs(16000, 100));
      this.noiseFloor = 150;
      this._shelfReset();
      this.noiseSub && this.noiseSub.reset();
      this.resetProbe();
    }
    return this.mode;
  }

  // 兼容旧接口
  setBypass(on) { return this.setMode(on !== false ? 'raw' : 'full'); }

  // 重置探针统计。调参器每试一档参数前调用——否则读到的是历史累积值，
  // 分不清「这一档的效果」和「之前所有档位的平均」
  resetProbe() {
    this._probeSilence = { pre: 0, post: 0, n: 0, m: 0 };
    this._probeSpeech = { pre: 0, post: 0, n: 0, m: 0 };
  }

  // 探针读数 + 判读结论
  probeReport() {
    // 旁路模式下所有 DSP 都跳过，探针不再更新——必须明确说明，
    // 否则面板会一直显示旁路前的旧数字，误导判断
    if (this.mode === 'raw') {
      return {
        bypassed: true,
        silence: { pre: 0, post: 0, cutDb: 0, samples: 0 },
        speech: { pre: 0, post: 0, cutDb: 0, samples: 0 },
        inSnrDb: 0, outSnrDb: 0, snrGainDb: 0,
        verdict: '原始音频模式',
        advice: '全部降噪与增强已跳过，听到的就是键盘麦原声。用「录音测试」录一段，再关掉这个开关录一段，两个文件对比着听——原始更清楚就说明算法帮倒忙。',
      };
    }
    const s = this._probeSilence, v = this._probeSpeech;
    // pre/post 是 RMS（幅度量），幅度比转 dB 必须用 20·log10。
    // 用 10·log10 会把所有降噪量报成实际值的一半（12dB 显示成 6dB）。
    const db = (pre, post) => (pre > 0 && post > 0 ? Math.round(20 * Math.log10(pre / post) * 10) / 10 : 0);
    const silPre = Math.round(s.pre), silPost = Math.round(s.post);
    const spPre = Math.round(v.pre), spPost = Math.round(v.post);

    // ★ 真正决定 ASR 能不能听清的是「信噪比提升了多少」，不是「降噪量多大」。
    //   降噪量只说明压了多少（压得再狠，若人声一起压掉也是白压）；
    //   SNR 提升 = 底噪压制 - 人声压制，直接把两件事放在一起衡量。
    //   实测教训：曾出现「底噪压 15.7dB、人声也压 15.3dB」——降噪量好看，
    //   SNR 只提升 0.1dB，等于只是把整体音量调小，对识别毫无帮助。
    const inSnr = (s.pre > 0 && v.pre > 0) ? 20 * Math.log10(v.pre / s.pre) : 0;
    const outSnr = (s.post > 0 && v.post > 0) ? 20 * Math.log10(v.post / s.post) : 0;
    const snrGainDb = Math.round((outSnr - inSnr) * 10) / 10;
    const r1 = x => Math.round(x * 10) / 10;

    // 判读分两种口径：
    //   降噪档（full）→ 看「信噪比提升」，回答「降噪有没有用」
    //   非降噪档（raw/hp/speech）→ 看「链路信噪比」本身，回答「这条链路够不够用」
    // 统一用一个口径会误导：speech 档本就不降噪，报「提升 0dB」会让人以为坏了。
    let verdict = '采样中';
    let advice = '按住开麦键说几句话，再静音几秒，面板会自动采样并给出判读。';
    if (s.m > 20 && v.n > 20 && s.pre > 0 && v.pre > 0 && this.mode !== 'full') {
      const link = r1(inSnr);
      const cut = db(s.pre, s.post);
      if (link >= 15) {
        verdict = '链路信噪比良好';
        advice = `当前档位「${this.mode === 'raw' ? '原始' : this.mode === 'hp' ? '只去低频' : '语音增强'}」不做降噪，` +
          `这里测的是链路本身：人声比底噪高 ${link}dB，底噪 ${silPost}。这个水平识别引擎能正常工作。`;
      } else if (link >= 8) {
        verdict = '链路信噪比一般';
        advice = `人声比底噪高 ${link}dB（底噪 ${silPost}）。识别通常可用；环境变吵或离远时可能掉字，靠近一点最有效。`;
      } else {
        verdict = '链路信噪比偏弱';
        advice = `人声只比底噪高 ${link}dB（底噪 ${silPost}）——这是麦克风拾音的限制，软件补不回来。` +
          `建议靠近说话，或改用蓝牙连接（实测蓝牙链路质量更好）。`;
      }
      if (cut > 3) advice += ` 当前档位顺带把底噪压了 ${cut}dB（去低频轰鸣的附带效果）。`;
    } else if (s.m > 20 && v.n > 20 && s.pre > 0 && v.pre > 0) {
      const cut = db(s.pre, s.post);
      if (snrGainDb >= 6) {
        verdict = '信噪比显著改善';
        advice = `人声比底噪清晰了 ${snrGainDb}dB（输入 ${r1(inSnr)}dB → 输出 ${r1(outSnr)}dB）。底噪压了 ${cut}dB、残余 ${silPost}。这个状态下识别应该明显好转。`;
      } else if (snrGainDb >= 2) {
        verdict = '信噪比略有改善';
        advice = `信噪比提升 ${snrGainDb}dB（输入 ${r1(inSnr)}dB → 输出 ${r1(outSnr)}dB）。底噪压了 ${cut}dB。提升有限——` +
          (cut < 6 ? '降噪力度可能不够，试试「离得远/环境吵」预设。' : '噪声可能不是稳态的，或输入信噪比本身太低。');
      } else {
        verdict = '信噪比几乎没改善';
        advice = `输入 ${r1(inSnr)}dB → 输出 ${r1(outSnr)}dB，仅提升 ${snrGainDb}dB。` +
          `底噪压了 ${cut}dB、人声压了 ${db(v.pre, v.post)}dB` +
          (cut > 8 ? '——两者接近，说明只是把整体音量调小，不是真降噪。' : '。噪声很可能不是稳态的（稳态噪声可开「稳态底噪扣除」）。');
      }
      // 输入 SNR 本身太低时，任何降噪都难有作为——这是物理限制，要说清楚
      if (inSnr < 8) {
        advice += ` 注意：原始信噪比只有 ${r1(inSnr)}dB（人声仅比底噪高一点），这是麦克风拾音的物理限制，软件能帮的很有限——靠近一点说话效果会明显好于任何调参。`;
      }
    }
    return {
      silence: { pre: silPre, post: silPost, cutDb: db(s.pre, s.post), samples: s.m },
      speech: { pre: spPre, post: spPost, cutDb: db(v.pre, v.post), samples: v.n },
      inSnrDb: r1(inSnr), outSnrDb: r1(outSnr), snrGainDb,
      verdict, advice,
    };
  }

  _denoiseBlock(blk) {
    // 升采样 ×3（线性插值）到 48kHz 域
    const up48 = new Float32Array(BLOCK * 3);
    let idx = 0, prev = this.lastUp;
    for (let i = 0; i < BLOCK; i++) {
      const x = blk[i];
      up48[idx++] = prev + (x - prev) / 3;
      up48[idx++] = prev + (x - prev) * 2 / 3;
      up48[idx++] = x;
      prev = x;
    }
    this.lastUp = prev;
    try {
      let vad;
      if (this.engine === 'df') {
        const snr = this.df.processFrame(up48);
        this.snrDb = snr; // 链路体检：远距说话时 SNR 应稳定在 10dB 以上
        vad = Math.max(0, Math.min(1, snr / 10)); // 局部 SNR 10dB 以上视为语音
      } else {
        const r = this.rnnoise.processFrame(up48);
        // RNNoise 输出在独立缓冲（_fout），必须回拷——只取 vad 会把降噪静默变透传
        up48.set(r.out);
        vad = r.vad;
      }
      // 降采样 ÷3：取中点样本。均值滤波会在 8k 处吃掉 ~3.5dB（s/sh 辅音能量区），
      // 源信号本就无 >8k 分量，无需抗混叠均值
      for (let i = 0; i < BLOCK; i++) blk[i] = up48[i * 3 + 1];
      this.vad = this.vad * 0.5 + vad * 0.5;
    } catch (e) {
      if (!this.denoiseFailLogged) {
        this.denoiseFailLogged = true;
        console.log('[mic] 降噪帧处理异常，旁路:', e.stack || e.message);
      }
      // 引擎进了坏状态：立即旁路（否则每帧重复抛异常空转），15s 后自动重试恢复
      this.engine = null;
      this._denoiseRetryAt = Date.now() + 15000;
    }
  }

  _gateAgc(blk) {
    const T = this.tune;
    let sumSq = 0;
    for (let i = 0; i < BLOCK; i++) sumSq += blk[i] * blk[i];
    const rms = Math.sqrt(sumSq / BLOCK);

    // VAD：优先用降噪引擎的语音概率（DFN=局部SNR映射 / RNNoise=原生VAD），
    // 未就绪时退化为底噪倍数启发式
    const speech = this.engine
      ? this.vad > 0.55 || rms > this.noiseFloor * T.gateOpenMul
      : rms > this.noiseFloor * T.gateOpenMul;

    // 底噪跟踪：只在非语音段收敛（full 档判定更准，仍用这个更保守的规则）
    if (!speech && rms > 20) this.noiseFloor += (rms - this.noiseFloor) * 0.03;

    // 门控：语音开、静音压到 -26dB；attack 快 release 慢不切字头尾
    const gTarget = speech ? 1 : (rms > this.noiseFloor * 4 ? 1 : T.gateFloor);
    this.gate += (gTarget - this.gate) * (gTarget > this.gate ? 0.5 : T.gateRelease);

    // AGC：仅语音段追目标响度；静音段增益缓慢回 1（不再放大底噪）
    if (speech && rms > 50) {
      const target = Math.min(T.agcMaxGain, Math.max(1, T.agcTarget / rms));
      this.gain += (target - this.gain) * 0.25;
    } else if (!speech) {
      this.gain += (1 - this.gain) * 0.02;
    }

    const k = this.gain * this.gate;
    // 压缩器参数（16k 域）：阈值 -14dBFS≈4000，2.5:1，attack 4ms / release 60ms
    const atk = 1 - Math.exp(-1 / (0.004 * 16000));
    const rel = 1 - Math.exp(-1 / (0.06 * 16000));
    let clipped = 0;
    for (let i = 0; i < BLOCK; i++) {
      let v = blk[i] * k;
      // 包络压缩：让送进识别引擎的电平平稳（ASR 对动态范围敏感）
      const a = Math.abs(v);
      this.compEnv += (a - this.compEnv) * (a > this.compEnv ? atk : rel);
      if (this.compEnv > 4000) v *= Math.pow(4000 / this.compEnv, 1 - 1 / 2.5);
      // 软膝限幅：22k 以上渐进压缩，替代硬 clamp 的爆音失真
      const m = Math.abs(v);
      if (m > 22000) v = Math.sign(v) * (22000 + (m - 22000) / (1 + (m - 22000) / 3000));
      if (v > 32767 || v < -32768) clipped++;
      blk[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    }
    // 削波率（滑动）：调参器的打分项，也是链路体检指标
    this.clipCount += clipped;
    this._clipWin = (this._clipWin || 0) + 1;
    if (this._clipWin >= 50) {
      this.clipRate = this.clipCount / (this._clipWin * BLOCK);
      this.clipCount = 0;
      this._clipWin = 0;
    }
    // 噪声谱学习控制：语音期不学（否则把人声当噪声学进去）
    if (this.noiseSub) this.noiseSub.setSpeech(speech);

    const outRms = Math.sqrt(blk.reduce((s, v) => s + v * v, 0) / BLOCK);
    this.level = this.level * 0.7 + outRms * 0.3;
    const buf = Buffer.alloc(BLOCK * 2);
    for (let i = 0; i < BLOCK; i++) buf.writeInt16LE(Math.round(blk[i]), i * 2);
    return buf;
  }
}

module.exports = { MicPipeline, loadDecoder };
