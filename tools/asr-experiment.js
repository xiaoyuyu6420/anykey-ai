// 客观识别率实验：模拟「键盘麦克风的频响缺陷」，量补偿前后的识别错误率。
//
// 为什么这样设计：
//   ① 直接拿你的录音做 A/B 缺「标准答案」（不知道你说了什么），无法数错字。
//   ② 用模型自带测试音频 + 本地 ASR，就有已知文本，能量化错误率。
//   ③ 实测该键盘麦的缺陷是「2-8kHz 频响跌落约 5dB」（说话段该带仅占 1.33%，
//      正常语音 4~5%），而它的底噪同样是低频为主（3kHz 以上几乎无能量）。
//      → 这是一个**线性频响问题**，不是「高频被噪声淹没」，因此可以被反向补偿。
//
// 实验：干净语音 → 施加 -6dB 搁架（模拟麦的跌落）→ 加低频为主的噪声（模拟底噪）
//       → 变体 A：原样送识别（≈现状）
//       → 变体 B：施加 +6dB 搁架补偿（本项目的 speech/full 档做法）
//       → 对比两者的字错率(CER)，参考文本取干净音频的识别结果
const fs = require('fs');
const path = require('path');
const { makeRecognizer, readWav, transcribe, editDistance } = require('./asr-cer.js');

// ---- RBJ biquad（与 src/main/mic.js 同式，保证实验与实际实现一致）----
function highShelfCoeffs(fs, f0, gainDb, S = 1) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0);
  const alpha = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2), sa = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cw + 2 * sa * alpha), b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  const b2 = A * ((A + 1) + (A - 1) * cw - 2 * sa * alpha);
  const a0 = (A + 1) - (A - 1) * cw + 2 * sa * alpha, a1 = 2 * ((A - 1) - (A + 1) * cw);
  const a2 = (A + 1) - (A - 1) * cw - 2 * sa * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
class Biquad {
  constructor(c) { this.c = c; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
// 确定性伪随机（实验可复现）
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };

// 施加两级搁架（级联 = 2×gainDb），模拟频响变化
function shelf(sig, f0, gainDb, stages = 2) {
  const c = highShelfCoeffs(16000, f0, gainDb);
  const bs = []; for (let i = 0; i < stages; i++) bs.push(new Biquad(c));
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) { let v = sig[i]; for (const b of bs) v = b.process(v); out[i] = v; }
  return out;
}

function writeWav(file, samples) {
  const n = samples.length;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n * 2, 40);
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = Math.round(samples[i] * 32768);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    d.writeInt16LE(v, i * 2);
  }
  fs.writeFileSync(file, Buffer.concat([h, d]));
}

// ---- 实验主体 ----
const WAV = path.join(__dirname, 'asr-model', 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'test_wavs', '0.wav');
const OUT = path.join(__dirname, 'asr-experiment');
fs.mkdirSync(OUT, { recursive: true });

const { rec } = makeRecognizer();
const clean = readWav(WAV);
const cleanRms = rms(clean.samples);
console.log(`干净语音: ${clean.seconds.toFixed(2)}s  RMS=${(cleanRms * 32768).toFixed(0)}`);

// 参考文本 = 干净音频的识别结果（干净音频可近似为正确答案）
const ref = transcribe(rec, clean).replace(/\s/g, '');
console.log(`参考文本（${ref.length} 字）: ${ref}`);
console.log();

// 模拟键盘麦：-6dB 搁架 @2600Hz（实测该麦 2-8kHz 比正常低约 5-6dB）
const miced = shelf(clean.samples, 2600, -3);   // 两级 × -3dB = -6dB
// 加低频为主的噪声（实测底噪 38% 能量在 200Hz 以下；3kHz 以上几乎无能量）
const r = rng(20261014);
const noiseWhite = new Float32Array(clean.samples.length);
for (let i = 0; i < noiseWhite.length; i++) noiseWhite[i] = r() * 2 - 1;
const noiseShaped = shelf(noiseWhite, 1500, -6);  // 两级 × -6dB = -12dB 高频，低频为主
// 混到约 7dB 信噪比（实测：说话 1300 / 底噪 250）
const targetSnr = 7;
const speechRms = rms(miced);
let noiseRms = rms(noiseShaped);
const wantNoise = speechRms / Math.pow(10, targetSnr / 20);
const k = wantNoise / noiseRms;
const degraded = new Float32Array(miced.length);
let clip = 0;
for (let i = 0; i < miced.length; i++) {
  let v = miced[i] + noiseShaped[i] * k;
  if (v > 1) { v = 1; clip++; } else if (v < -1) { v = -1; clip++; }
  degraded[i] = v;
}
console.log(`模拟劣化: -6dB 搁架@2600Hz + 低频噪声(信噪比 ${targetSnr}dB)  削顶 ${clip} 样本`);
writeWav(path.join(OUT, '1-degraded.wav'), degraded);

// 变体 A：劣化后原样（≈ 现状）
const textA = transcribe(rec, { sampleRate: 16000, samples: degraded }).replace(/\s/g, '');
// 变体 B：补偿 +6dB @2600Hz（本项目做法，两级 × +3dB）
const comp = shelf(degraded, 2600, 3);
writeWav(path.join(OUT, '2-compensated.wav'), comp);
const textB = transcribe(rec, { sampleRate: 16000, samples: comp }).replace(/\s/g, '');

const cer = t => editDistance(ref, t) / Math.max(1, ref.length) * 100;
const errA = editDistance(ref, textA), errB = editDistance(ref, textB);
console.log();
console.log('=== 识别结果对比 ===');
console.log(`A 劣化未补偿 (${errA} 处错): ${textA}`);
console.log(`B 劣化+补偿   (${errB} 处错): ${textB}`);
console.log();
console.log(`字错率 CER   A: ${cer(textA).toFixed(1)}%    B: ${cer(textB).toFixed(1)}%`);
const rel = errA > 0 ? ((errA - errB) / errA * 100) : 0;
console.log(`错误减少: ${errA - errB} 处   相对改善 ${rel.toFixed(1)}%`);
