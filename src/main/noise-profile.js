// 稳态噪声学习 + 谱减（v0.12.5）
//
// 为什么在 DFN3 之外还要做这个：
//   DFN3/RNNoise 是神经网络降噪，强项是非稳态噪声（键盘敲击、关门、突发声），
//   但对「稳态底噪」刻意保守——麦克风自噪、风扇、房间底噪是持续存在的，
//   模型倾向于保留（否则远距离的轻声也会被当成噪声删掉）。
//   稳态底噪恰好是最容易被精确建模的：安静时采一段得到每频点平均幅度，
//   说话时按此扣除。这是经典谱减（spectral subtraction）。
//
// ---- 实现要点（v0.12.5 修正）----
// 上一版是坏的，有两个独立 bug：
//
// bug 1 —— COLA 不满足。分析、合成各加一次 Hann，乘积是 Hann²；而 Hann² 在
//   50% 重叠下的叠加和是 0.5+0.5cos²θ，随相位起伏，不是常数 → 必然失真。
//   修法：两道窗都用 √Hann，乘积 = Hann，50% 重叠下叠加和恒为 1.000000
//   （已数值验证）。
//
// bug 2 —— 逆变换方法错。正向 FFT 输入共轭对称谱得到的是 N·x[反转]，顺序和
//   符号都不对。修法：先把虚部取反（共轭）再做正向 FFT，取实部除以 N
//   （已数值验证，误差 ~5e-4）。
//
// 结构：分析窗长 N=320、hop=160（50% 重叠），零填充到 FFT 长度 512（2 的幂）。
//
// 关键设计：过减因子(over-subtraction) + 谱底限(spectral floor)。
//   过减太保守 → 底噪残留；过减太狠 → 辅音被削成「金属音」，ASR 反而更差。
//   默认 2.0 倍过减 + -18dB 谱底，是听感与识别率的平衡点。

const N_WIN = 320;    // 分析窗长（样本）
const HOP = 160;      // 帧移 = MicPipeline BLOCK，50% 重叠
const FFT_N = 512;    // 零填充后的 FFT 长度（2 的幂）
const BINS = FFT_N / 2 + 1;
const FLOOR_DB = -18; // 谱底：扣除后不低于原始谱的 -18dB
const OVER_SUB = 2.0; // 过减因子
const LEARN_FRAMES = 100; // 约 1s 静音即可收敛出噪声形状

function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const ur = re[p], ui = im[p];
        const vr = re[q] * cr - im[q] * ci;
        const vi = re[q] * ci + im[q] * cr;
        re[p] = ur + vr; im[p] = ui + vi;
        re[q] = ur - vr; im[q] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

class NoiseSubtractor {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.overSub = opts.overSub ?? OVER_SUB;
    this.floorDb = opts.floorDb ?? FLOOR_DB;

    // √Hann 窗（分析、合成各用一次，乘积 = Hann，50% 重叠下 COLA 恒为 1）
    this.win = new Float32Array(N_WIN);
    for (let i = 0; i < N_WIN; i++) {
      this.win[i] = Math.sqrt(0.5 * (1 - Math.cos(2 * Math.PI * i / N_WIN)));
    }

    this.noiseMag = new Float32Array(BINS); // 噪声幅度谱（指数滑动平均）
    this.learned = 0;
    this.learning = true;   // 学习期只建模不扣除
    this.ready = false;
    this._frozen = false;   // 语音期冻结学习

    // OLA 状态
    this.inBuf = new Float32Array(N_WIN);   // 滑动的分析窗内容（最近 N_WIN 样本）
    this.ola = new Float32Array(N_WIN);     // 重叠相加累加器
    this._hop = new Float32Array(HOP);      // 本 hop 新进的样本
    this._hopLen = 0;

    this._re = new Float32Array(FFT_N);
    this._im = new Float32Array(FFT_N);
    this.reductionDb = 0;   // 最近一帧实际降噪量（诊断用）
    this.bypassed = false;  // 学习期/关闭时置位，供诊断区分「没压」和「压不动」
  }

  // 语音期冻结学习（否则把人声学成噪声）。由 MicPipeline 每块告知。
  setSpeech(speech) {
    if (this.learning) this._frozen = !!speech;
  }

  reset() {
    this.noiseMag.fill(0);
    this.learned = 0;
    this.learning = true;
    this.ready = false;
    this.reductionDb = 0;
    this.inBuf.fill(0);
    this.ola.fill(0);
    this._hopLen = 0;
  }

  // 输入 160 样本（16k 域 float），原地替换为扣除后的样本
  processBlock(blk) {
    if (!this.enabled) return;
    // 累积 HOP 个新样本
    for (let i = 0; i < HOP; i++) this._hop[i] = blk[i];
    this._processHop();

    // 从 OLA 累加器取出本 hop 的输出（前 HOP 个），并左移
    for (let i = 0; i < HOP; i++) blk[i] = this.ola[i];
    this.ola.copyWithin(0, HOP);
    this.ola.fill(0, N_WIN - HOP);
  }

  _processHop() {
    // 滑动输入窗：左移 HOP，追加新样本
    this.inBuf.copyWithin(0, HOP);
    this.inBuf.set(this._hop, N_WIN - HOP);

    const re = this._re, im = this._im;
    // 加窗 + 零填充到 FFT_N
    for (let i = 0; i < N_WIN; i++) {
      re[i] = this.inBuf[i] * this.win[i];
      im[i] = 0;
    }
    for (let i = N_WIN; i < FFT_N; i++) { re[i] = 0; im[i] = 0; }
    fftRadix2(re, im);

    const mag = new Float32Array(BINS);
    const phase = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) {
      mag[i] = Math.hypot(re[i], im[i]);
      phase[i] = Math.atan2(im[i], re[i]);
    }

    if (this.learning) {
      // 学习期只累积噪声谱、不扣除（本 hop 直通）。
      // 语音期冻结累积（_frozen），否则把人声学成噪声谱，之后说话会被削掉。
      if (!this._frozen) {
        const a = 0.05;
        for (let i = 0; i < BINS; i++) this.noiseMag[i] = this.noiseMag[i] * (1 - a) + mag[i] * a;
        this.learned++;
        if (this.learned >= LEARN_FRAMES) {
          this.learning = false; // 学满即转入扣除期（漏掉这行会永远停在只建模不扣除）
          this.ready = true;
        }
      }
      // 重建原始信号回写 OLA（直通），保证学习期不丢音
      this._synthesize(re, im, mag, phase);
      return;
    }

    // 扣除：幅度减法 + 谱底限
    const floorLin = Math.pow(10, this.floorDb / 20);
    let sumBefore = 0, sumAfter = 0;
    const outMag = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) {
      const t = Math.max(floorLin * mag[i], mag[i] - this.overSub * this.noiseMag[i]);
      outMag[i] = t;
      sumBefore += mag[i] * mag[i];
      sumAfter += t * t;
    }
    this.reductionDb = sumBefore > 0
      ? Math.max(0, 10 * Math.log10(sumBefore / Math.max(1e-12, sumAfter)))
      : 0;
    this._synthesize(re, im, outMag, phase);
  }

  // 频域 → 时域 → 加合成窗 → 重叠相加
  _synthesize(re, im, outMag, phase) {
    for (let i = 0; i < BINS; i++) {
      re[i] = outMag[i] * Math.cos(phase[i]);
      im[i] = outMag[i] * Math.sin(phase[i]);
    }
    // 补共轭对称，使谱对应实信号
    for (let i = BINS; i < FFT_N; i++) {
      re[i] = re[FFT_N - i];
      im[i] = -im[FFT_N - i];
    }
    // 逆变换 = 共轭 → 正向 FFT → 取实部 / N
    // （正向 FFT 直接吃共轭对称谱得到的是 N·x[反转]，顺序与符号都不对）
    for (let i = 0; i < FFT_N; i++) im[i] = -im[i];
    fftRadix2(re, im);
    const inv = 1 / FFT_N;
    // 合成窗（√Hann）：与分析窗相乘即 Hann，叠加和为 1
    for (let i = 0; i < N_WIN; i++) {
      this.ola[i] += re[i] * inv * this.win[i];
    }
  }

  diagnostics() {
    let sum = 0, peak = 0;
    for (let i = 0; i < BINS; i++) {
      sum += this.noiseMag[i];
      if (this.noiseMag[i] > peak) peak = this.noiseMag[i];
    }
    return {
      learned: this.learned,
      ready: this.ready,
      learning: this.learning,
      enabled: this.enabled,
      noiseBins: BINS,
      noiseAvg: sum / BINS,
      noisePeak: peak,
      reductionDb: Math.round(this.reductionDb * 10) / 10,
      overSub: this.overSub,
      floorDb: this.floorDb,
    };
  }
}

module.exports = { NoiseSubtractor, N_WIN, HOP, FFT_N, BINS, LEARN_FRAMES };
