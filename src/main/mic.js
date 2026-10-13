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
    //   attenLimDb —— DFN3 最大衰减。默认 3dB（原 6dB），远距弱语音保护辅音
    //   gateOpenMul —— 语音判定倍数（底噪倍数）。关键修复：原值 5 对远距说话是
    //     「越远越听不清」的直接元凶——实测键盘麦底噪 RMS≈150，阈值 750，
    //     而远距离语音 RMS 只有 600~900，永远判不出语音，AGC 不启动、
    //     电平不被抬起，ASR 自然听不清。降到 3（阈值 450）后弱语音能过判定，
    //     距底噪仍有 3 倍余量，纯噪段门控照常闭合
    this.tune = {
      gateRelease: opts.gateRelease ?? 0.25,
      agcTarget: opts.agcTarget ?? 3600,
      attenLimDb: opts.attenLimDb ?? 3,
      gateOpenMul: opts.gateOpenMul ?? 3,
      gateFloor: opts.gateFloor ?? 0.05,
      agcMaxGain: opts.agcMaxGain ?? 8,
    };

    this.hp1 = new Biquad(highpassCoeffs(16000, 100));
    this.hp2 = new Biquad(highpassCoeffs(16000, 100));
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
      engine: this.engine || 'none',
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
    for (let i = 0; i < n; i++) {
      if (this.fifoLen >= FIFO_CAP) break; // 积压保护：丢新保旧
      this.fifo[this.fifoLen++] = samples[i];
    }
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
    // 1) 陡高通（16k 域）
    for (let i = 0; i < BLOCK; i++) blk[i] = this.hp2.process(this.hp1.process(blk[i]));

    // 1.5) 引擎此前抛异常被旁路：冷却期到后自动重试恢复（用户补齐 dll/模型也生效）
    if (!this.engine && this.denoiseWanted && this._denoiseRetryAt && Date.now() >= this._denoiseRetryAt) {
      this._denoiseRetryAt = 0;
      this.initDenoiser().then(e => { if (e) console.log('[mic] 降噪引擎重试恢复:', e); }).catch(() => {});
    }

    // ★ 诊断探针（降噪前）：在降噪链入口测 RMS。
    // 位置刻意选在高通之后、降噪之前、AGC 之前——AGC 会按语音段动态改增益，
    // 测在 AGC 之后就分不清「降噪压了多少」和「增益抬了多少」。
    const preDenoiseRms = this._probeOn ? rmsOf(blk, BLOCK) : 0;

    // 2) 升采样 ×3 → DFN3/RNNoise 降噪（原地写回）→ 取中点降采样
    if (this.engine) this._denoiseBlock(blk);

    // 2.5) 稳态噪声扣除（v0.12.5）：放在神经网络之后、门控之前。
    // 顺序有讲究——DFN3/RNNoise 处理完非稳态噪声（键盘声、突发声），
    // 剩下的是它刻意保留的稳态底噪（麦自噪、风扇、房间底噪），
    // 这部分正好被噪声谱建模扣除。各司其职，不重复处理。
    if (this.noiseSub) this.noiseSub.processBlock(blk);

    // ★ 诊断探针（降噪后）：与 preDenoiseRms 同一点位、同一算法，差值即降噪量
    if (this._probeOn) this._updateProbe(preDenoiseRms, rmsOf(blk, BLOCK));

    // 3) VAD 门控 + AGC + 压缩器 + 软限幅（16k 域逐样本状态机，块间无缝）
    return this._gateAgc(blk);
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

  // 探针读数 + 判读结论
  probeReport() {
    const s = this._probeSilence, v = this._probeSpeech;
    // pre/post 是 RMS（幅度量），幅度比转 dB 必须用 20·log10。
    // 用 10·log10 会把所有降噪量报成实际值的一半（12dB 显示成 6dB）。
    const db = (pre, post) => (pre > 0 && post > 0 ? Math.round(20 * Math.log10(pre / post) * 10) / 10 : 0);
    const silPre = Math.round(s.pre), silPost = Math.round(s.post);
    const spPre = Math.round(v.pre), spPost = Math.round(v.post);
    // 判读：静音段（底噪）的降噪表现决定「软件还能不能救」
    let verdict = '采样中', advice = '按住开麦键说几句话，再静音几秒，让面板采满数据。';
    if (s.m > 20 && s.pre > 0) {
      const cut = db(s.pre, s.post);
      if (cut >= 6) {
        verdict = '降噪正常工作';
        advice = `底噪已被压低 ${cut}dB（${silPre} → ${silPost}）。残留 ${silPost} 是降噪后的残余，若仍嫌吵可加大降噪强度。`;
      } else if (cut >= 2) {
        verdict = '降噪偏保守';
        advice = `底噪只压低 ${cut}dB（${silPre} → ${silPost}）。attenLim（衰减上限）限制了降噪力度，可上调试试。`;
      } else {
        verdict = '降噪几乎没工作';
        advice = `底噪 ${silPre} → ${silPost}（仅 ${cut}dB）。降噪未生效——要么引擎在旁路，要么 attenLim 太低，属可修问题而非换麦问题。`;
      }
      if (spPre > 0 && db(spPre, spPost) > cut + 3) {
        advice += ` 注意：语音段也被压了 ${db(spPre, spPost)}dB，可能伤到人声，降噪强度别再加了。`;
      }
    }
    return {
      silence: { pre: silPre, post: silPost, cutDb: db(s.pre, s.post), samples: s.m },
      speech: { pre: spPre, post: spPost, cutDb: db(v.pre, v.post), samples: v.n },
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

    // 底噪跟踪：只在非语音段收敛
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
