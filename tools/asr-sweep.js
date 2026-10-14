// 批量识别率实验：在全部测试音频 × 多个噪声种子 × 多档补偿量上聚合字错率。
//
// 为什么必须批量：单段 5 秒/28 字，差 1 个字就是 ±3.5% 的「改善」——
// 纯噪声。只有跨多段音频、多个噪声实现聚合，CER 差异才有意义。
const fs = require('fs');
const path = require('path');
const { makeRecognizer, readWav, transcribe, editDistance } = require('./asr-cer.js');

function highShelfCoeffs(fs_, f0, gainDb, S = 1) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / fs_, cw = Math.cos(w0);
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
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };

function shelf(sig, f0, gainDb, stages = 2) {
  if (gainDb === 0) return Float32Array.from(sig);
  const c = highShelfCoeffs(16000, f0, gainDb);
  const bs = []; for (let i = 0; i < stages; i++) bs.push(new Biquad(c));
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) { let v = sig[i]; for (const b of bs) v = b.process(v); out[i] = v; }
  return out;
}

const MODEL_DIR = path.join(__dirname, 'asr-model', 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const WAV_DIR = path.join(MODEL_DIR, 'test_wavs');
// 用普通话段（方言段的参考文本不可靠，排除）
const WAVS = ['0.wav', '1.wav'];

const { rec } = makeRecognizer();
const cases = [];
const cleanCache = new Map();
for (const w of WAVS) {
  const p = path.join(WAV_DIR, w);
  if (!fs.existsSync(p)) continue;
  const clean = readWav(p);
  const ref = transcribe(rec, clean).replace(/\s/g, '');
  cleanCache.set(w, { clean, ref });
  cases.push(w);
}
console.log(`测试音频: ${cases.length} 段，参考文本共 ${[...cleanCache.values()].reduce((s, c) => s + c.ref.length, 0)} 字`);
console.log();

const SEEDS = [1, 2, 3];
const SNRS = [7, 12];              // 7dB = 实测该麦的水平；12dB = 稍好
const BOOSTS = [0, 3, 6, 9];       // 补偿量（两级级联 → 实际 2×）

console.log('补偿量   平均CER    总错字/总字数    相对未补偿');
console.log('--------------------------------------------------');
const rows = [];
for (const boost of BOOSTS) {
  let totErr = 0, totRef = 0, cerSum = 0, n = 0;
  for (const w of cases) {
    const { clean, ref } = cleanCache.get(w);
    for (const snr of SNRS) {
      for (const seed of SEEDS) {
        // 模拟麦频响：-6dB 搁架 @2600Hz（两级 × -3dB）
        const miced = shelf(clean.samples, 2600, -3);
        // 低频为主的底噪
        const r = rng(seed * 1000 + snr);
        const white = new Float32Array(clean.samples.length);
        for (let i = 0; i < white.length; i++) white[i] = r() * 2 - 1;
        const nz = shelf(white, 1500, -6);
        const k = (rms(miced) / Math.pow(10, snr / 20)) / rms(nz);
        const deg = new Float32Array(miced.length);
        for (let i = 0; i < miced.length; i++) deg[i] = miced[i] + nz[i] * k;
        // 补偿
        const sig = boost > 0 ? shelf(deg, 2600, boost / 2) : deg;
        const txt = transcribe(rec, { sampleRate: 16000, samples: sig }).replace(/\s/g, '');
        const err = editDistance(ref, txt);
        totErr += err; totRef += ref.length; cerSum += err / Math.max(1, ref.length); n++;
      }
    }
  }
  const avgCer = cerSum / n * 100;
  rows.push({ boost, avgCer, totErr, totRef });
  const base = rows[0].totErr;
  const rel = base > 0 ? ((base - totErr) / base * 100) : 0;
  console.log(`+${(boost * 2).toString().padStart(2)}dB   ${avgCer.toFixed(2).padStart(7)}%   ${String(totErr).padStart(5)} / ${String(totRef).padStart(5)}      ` +
    (boost === 0 ? '（基准）' : `${rel > 0 ? '改善' : '变差'} ${Math.abs(rel).toFixed(1)}%`));
}
console.log();
const best = rows.reduce((a, b) => b.totErr < a.totErr ? b : a);
console.log(`★ 最优补偿量: +${best.boost * 2}dB（总错字 ${best.totErr}），未补偿为 ${rows[0].totErr}`);
