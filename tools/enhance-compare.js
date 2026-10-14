// 语音增强对比：把同一段真实录音分别过 GTCRN / DPDFNet，输出可试听的 WAV。
//
// 用途：用户要「听感」对比。GTCRN 只有 48.2K 参数（0.5MB），实测 0.07 实时率；
// DPDFNet 是 2025 年那篇「Boosting DeepFilterNet2 via Dual-Path RNN」的实现，
// 论文称全面超越 DeepFilterNet2/3。
//
// 注意（已由实测与文献确认）：独立增强模型的客观指标提升**不保证**转化为
// 更高的识别率——Sony 论文标题即「提升字错率 ≠ 拥有干净语音」，
// DeepFilterNet 自己的论文也说两者未必同向。本脚本只服务「听感」这个目的。
const fs = require('fs');
const path = require('path');
const { OfflineSpeechDenoiser } = require('sherpa-onnx-node/non-streaming-speech-denoiser.js');

const MODEL_DIR = path.join(__dirname, 'asr-model');
const OUT_DIR = path.join(__dirname, 'enhance-out');

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV: ' + file);
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  const n = (b.length - 44) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { sampleRate: sr, samples, channels: ch, bits };
}
function writeWav(file, samples, sr = 16000) {
  const n = samples.length;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n * 2, 40);
  const d = Buffer.alloc(n * 2);
  let clip = 0;
  for (let i = 0; i < n; i++) {
    let v = Math.round(samples[i] * 32768);
    if (v > 32767) { v = 32767; clip++; } else if (v < -32768) { v = -32768; clip++; }
    d.writeInt16LE(v, i * 2);
  }
  fs.writeFileSync(file, Buffer.concat([h, d]));
  return clip;
}
const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length) * 32768; };

// 频带占比（只统计有语音的最响段，避免被静音稀释）
function bandShare(samples) {
  const n = samples.length;
  const W = Math.min(24000, n);
  let best = 0, bE = 0;
  for (let o = 0; o + W <= n; o += 4000) {
    let e = 0; for (let i = 0; i < W; i++) e += samples[o + i] * samples[o + i];
    if (e > bE) { bE = e; best = o; }
  }
  const N = 1024;
  const re = new Float32Array(N), im = new Float32Array(N);
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const p = i + k, q = p + len / 2;
          const ur = re[p], ui = im[p];
          const vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr;
          re[p] = ur + vr; im[p] = ui + vi; re[q] = ur - vr; im[q] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const acc = new Float64Array(N / 2 + 1);
  for (let o = best; o + N <= Math.min(best + W, n); o += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = samples[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i <= N / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
  }
  let tot = 0; for (let i = 0; i <= N / 2; i++) tot += acc[i];
  const bd = (lo, hi) => {
    const a = Math.round(lo / 8000 * N / 2), c = Math.round(hi / 8000 * N / 2);
    let e = 0; for (let i = a; i < c; i++) e += acc[i];
    return e / tot * 100;
  };
  return { b200_1k: bd(200, 1000), b1k_2k: bd(1000, 2000), b2k_8k: bd(2000, 8000), speechRms: Math.sqrt(bE / W) * 32768 };
}

function makeDenoiser(kind) {
  const cfg = { model: { numThreads: 4, provider: 'cpu' } };
  if (kind === 'gtcrn') cfg.model.gtcrn = { model: path.join(MODEL_DIR, 'gtcrn_simple.onnx') };
  else cfg.model.dpdfnet = { model: path.join(MODEL_DIR, `${kind}.onnx`) };
  return new OfflineSpeechDenoiser(cfg);
}

const input = process.argv[2];
if (!input) { console.error('用法: node tools/enhance-compare.js <wav>'); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const wav = readWav(input);
console.log(`输入: ${path.basename(input)}  ${(wav.samples.length / wav.sampleRate).toFixed(1)}s  ${wav.sampleRate}Hz  语音段RMS ${bandShare(wav.samples).speechRms.toFixed(0)}`);

// 原样重写一份（统一格式，便于对比播放）
writeWav(path.join(OUT_DIR, '0-original.wav'), wav.samples, wav.sampleRate);
const b0 = bandShare(wav.samples);
console.log(`  原始       : 语音RMS ${b0.speechRms.toFixed(0)}  200-1k ${b0.b200_1k.toFixed(1)}%  1k-2k ${b0.b1k_2k.toFixed(1)}%  2-8k ${b0.b2k_8k.toFixed(2)}%`);

for (const kind of ['gtcrn', 'dpdfnet_baseline', 'dpdfnet2']) {
  try {
    const t0 = Date.now();
    const d = makeDenoiser(kind);
    const out = d.run({ samples: wav.samples, sampleRate: wav.sampleRate });
    const ms = Date.now() - t0;
    const sr = out.sampleRate || wav.sampleRate;
    const clip = writeWav(path.join(OUT_DIR, `1-${kind}.wav`), out.samples, sr);
    const b = bandShare(out.samples);
    const rtf = (wav.samples.length / sr) / (ms / 1000);
    console.log(`  ${kind.padEnd(16)}: 语音RMS ${b.speechRms.toFixed(0)}  200-1k ${b.b200_1k.toFixed(1)}%  1k-2k ${b.b1k_2k.toFixed(1)}%  2-8k ${b.b2k_8k.toFixed(2)}%  用时 ${ms}ms (${rtf.toFixed(1)}x实时)${clip ? ` 削顶${clip}` : ''}`);
  } catch (e) {
    console.log(`  ${kind.padEnd(16)}: 失败 ${e.message}`);
  }
}
console.log();
console.log(`输出目录: ${OUT_DIR}`);
console.log('听感对比要点：底噪是否更干净、人声是否更自然、有没有「水声/金属声」这类处理伪影');
