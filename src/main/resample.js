// 真采样率转换（v0.13.1）
//
// ---- 为什么需要它 ----
// 实测（墙上时钟法）：键盘有线口实际输出约 17129 Hz——30.00 秒收到 17132 帧、
// 每帧 30 样本 = 513960 样本。而协议文档与代码一直按 16000 Hz 处理。
// 偏差 7.05%，后果是整条链路的声音被降调降速约 1.1 个半音：
//   · 听感「闷、糊」——这是用户反馈「原声音就好糊」的直接来源
//   · 劣化 ASR——识别模型收到的是变调语音
// 早期文档里「帧率×样本数=16kHz 已验证」的结论是错的（当时没对墙上时钟，
// 而是拿代码自己的假设去验证自己，属循环论证）。
//
// ---- 为什么在入口重采样，而不是改输出端的采样率 ----
// 若只在输出端声明 17129Hz，则下游全错位：
//   · DFN3 需要真 48kHz，会收到 51387Hz（按 ×3 上采样算）
//   · 高通/谱减/门控的系数都按 16kHz 标定
// 在管线入口转成真 16kHz，之后每个环节都在自己该在的采样率上工作。
//
// ---- 实现 ----
// 输出点位置以输入样本为单位推进（step = inRate/outRate）。用线性插值 +
// 抗混叠低通（4 阶，截止取输出奈奎斯特的 95%）。线性插值在 0.934 这种接近 1
// 的比值下引入的误差很小（比源头 32kbps 有损编码小得多），换来的是零依赖、
// 无延迟抖动、可逐样本验证的确定性行为。

// RBJ cookbook 二阶低通（Q=0.707 Butterworth），两级级联 = 4 阶 24dB/oct
function lowpassCoeffs(fs, f0, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cw = Math.cos(w0);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
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

class RateConverter {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;   // 每个输出样本推进多少「输入样本」
    this.pos = 1;                   // 下一个输出点在 [prev, cur] 内的位置
    this.prev = 0;
    this.primed = false;
    // 抗混叠：截止取输出奈奎斯特的 95%，在输入域
    const cut = outRate / 2 * 0.95;
    this.lp1 = new Biquad(lowpassCoeffs(inRate, cut));
    this.lp2 = new Biquad(lowpassCoeffs(inRate, cut));
    this.out = new Float32Array(0);   // 复用输出缓冲（按输入规模增长）
  }

  // 输入 n 个样本，返回本次产出的样本数组。
  // 缓冲必须 >= 2n+2：每个输入样本最多产出 2 个输出（step<2 时成立），
  // 缓冲给小了会静默截断，导致样本丢失、相位错乱（踩过一次）
  process(input, n) {
    const need = 2 * n + 4;
    if (this.out.length < need) this.out = new Float32Array(need);
    let w = 0;
    const out = this.out;
    for (let i = 0; i < n; i++) {
      const s = this.lp2.process(this.lp1.process(input[i]));
      if (!this.primed) { this.prev = s; this.primed = true; continue; }
      while (this.pos < 1) {
        out[w++] = this.prev + (s - this.prev) * this.pos;
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = s;
    }
    // 返回视图：调用方须立即消费（下次 process 会覆盖）
    return w === out.length ? out : out.subarray(0, w);
  }

  // 切换输入采样率（运行时可调，用户可据此试不同假设值）
  setInRate(inRate) {
    this.inRate = inRate;
    this.step = inRate / this.outRate;
    const cut = this.outRate / 2 * 0.95;
    this.lp1 = new Biquad(lowpassCoeffs(inRate, cut));
    this.lp2 = new Biquad(lowpassCoeffs(inRate, cut));
  }
}

module.exports = { RateConverter, lowpassCoeffs, Biquad };
