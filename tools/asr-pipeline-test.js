// 决定性实验：把模拟劣化后的语音过一遍**项目真实的 MicPipeline**，
// 逐档测识别错误率，直接回答「哪一档识别率最高」。
//
// 与前一个脚本的区别：那个只测「搁架补偿」这一条线性滤波；
// 这个跑完整链路（高通 / DFN3 神经网络降噪 / 稳态谱减 / 门控 / AGC / 辅音补偿），
// 也就是用户实际会听到、会送进识别引擎的东西。
//
// 参考文本 = 干净音频的识别结果（干净音频可近似为正确答案）。
const fs = require('fs');
const path = require('path');
const { makeRecognizer, readWav, transcribe, editDistance } = require('./asr-cer.js');

// 屏蔽真实 dll 加载（与项目单测一致的做法，走 RNNoise 或旁路）——
// 这里刻意**不屏蔽**，因为要测真实降噪效果：直接 require 真 df.dll。
const { MicPipeline } = require('../src/main/mic.js');

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

// 过一遍真实管线，返回 int16 样本数组
async function throughPipeline(p, floatSamples) {
  const BLK = 160;
  const out = [];
  for (let o = 0; o < floatSamples.length; o += BLK) {
    const n = Math.min(BLK, floatSamples.length - o);
    const int16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = Math.round(floatSamples[o + i] * 32768);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      int16[i] = v;
    }
    const res = p.feed(int16, n);
    for (let i = 0; i < res.length; i += 2) out.push(res.readInt16LE(i) / 32768);
  }
  return new Float32Array(out);
}

const MODEL_DIR = path.join(__dirname, 'asr-model', 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const WAV_DIR = path.join(MODEL_DIR, 'test_wavs');
const WAVS = ['0.wav', '1.wav'];

(async () => {
  const ENGINE = process.argv[2] || 'paraformer';
  const NOISE = process.argv[3] || 'lf';    // lf 稳态低频 / click 脉冲敲键 / white 宽带
  const { rec } = makeRecognizer(ENGINE);
  console.log(`ASR 引擎: ${ENGINE}   噪声类型: ${NOISE}`);

  // 参考文本
  const cleanMap = new Map();
  for (const w of WAVS) {
    const p = path.join(WAV_DIR, w);
    if (!fs.existsSync(p)) continue;
    const clean = readWav(p);
    cleanMap.set(w, { clean, ref: transcribe(rec, clean).replace(/\s/g, '') });
  }
  const totalChars = [...cleanMap.values()].reduce((s, c) => s + c.ref.length, 0);
  console.log(`测试音频 ${cleanMap.size} 段，参考文本共 ${totalChars} 字`);

  // 干净基准
  let cleanErr = 0;
  for (const [, c] of cleanMap) cleanErr += editDistance(c.ref, transcribe(rec, c.clean).replace(/\s/g, ''));
  console.log(`干净音频基准: ${cleanErr} 处错（参考文本取自它自身，故≈0）`);
  console.log();

  // 初始化管线（含 DFN3）
  const mkPipe = async (mode, hfBoost, noiseSub) => {
    const p = new MicPipeline({ inRate: 16000, autoRate: false, mode, hfBoostDb: hfBoost, noiseSubtract: noiseSub });
    const eng = await p.initDenoiser();
    return { p, eng };
  };
  const probe = await mkPipe('full', 6, false);
  console.log(`降噪引擎: ${probe.eng || '旁路(未就绪)'}`);
  console.log();

  const CONFIGS = [
    { name: 'raw 原始',        mode: 'raw',    hf: 0, ns: false },
    { name: 'hp 去低频',       mode: 'hp',     hf: 0, ns: false },
    { name: 'speech 补偿',     mode: 'speech', hf: 6, ns: false },
    { name: 'full 完整',       mode: 'full',   hf: 0, ns: false },
    { name: 'full+补偿 定稿',  mode: 'full',   hf: 6, ns: false },
    { name: 'full+补偿+谱减',  mode: 'full',   hf: 6, ns: true  },
  ];
  const SEEDS = [1, 2, 3, 4, 5, 6];
  // 输入电平维度：实测键盘麦送来的语音 RMS 仅 600~1300（标准录音约 2900），
  // 差 10~14dB。AGC 的价值可能正体现在这里——补上这个维度才能公平评价。
  const LEVELS = [0, -14];

  console.log('配置               输入电平   总错字/总字数   平均CER    相对原始');
  console.log('--------------------------------------------------------------------');
  const rows = [];
  for (const cfg of CONFIGS) {
   for (const lvlDb of LEVELS) {
    let totErr = 0, totRef = 0, cerSum = 0, n = 0;
    for (const [, c] of cleanMap) {
      for (const snr of [7, 12]) {
        for (const seed of SEEDS) {
          const miced = shelf(c.clean.samples, 2600, -3);
          const r = rng(seed * 1000 + snr);
          const white = new Float32Array(c.clean.samples.length);
          for (let i = 0; i < white.length; i++) white[i] = r() * 2 - 1;
          // 噪声类型：稳态低频（实测该麦的底噪）/ 脉冲（模拟敲键盘）/ 宽带
          let nz;
          if (NOISE === 'click') {
            nz = new Float32Array(white.length);
            const step = Math.round(16000 * (0.09 + r() * 0.12));   // 每 90~210ms 一次
            for (let t = step; t < nz.length; t += step) {
              const len = 300 + Math.round(r() * 500);
              const amp = 0.25 + r() * 0.5;
              for (let i = 0; i < len && t + i < nz.length; i++) {
                nz[t + i] += (r() * 2 - 1) * amp * Math.exp(-i / 120);  // 指数衰减脉冲
              }
            }
          } else if (NOISE === 'white') {
            nz = white;
          } else {
            nz = shelf(white, 1500, -6);
          }
          const k = (rms(miced) / Math.pow(10, snr / 20)) / rms(nz);
          const g = Math.pow(10, lvlDb / 20);      // 整体电平缩放（模拟远距/小声）
          const deg = new Float32Array(miced.length);
          for (let i = 0; i < miced.length; i++) deg[i] = (miced[i] + nz[i] * k) * g;

          const { p } = await mkPipe(cfg.mode, cfg.hf, cfg.ns);
          const proc = await throughPipeline(p, deg);
          const txt = transcribe(rec, { sampleRate: 16000, samples: proc }).replace(/\s/g, '');
          const err = editDistance(c.ref, txt);
          totErr += err; totRef += c.ref.length; cerSum += err / Math.max(1, c.ref.length); n++;
        }
      }
    }
    rows.push({ cfg: cfg.name, lvlDb, totErr, totRef, cer: cerSum / n * 100 });
    const baseRow = rows.find(r => r.cfg === 'raw 原始' && r.lvlDb === lvlDb);
    const rel = baseRow && baseRow.totErr > 0 ? ((baseRow.totErr - totErr) / baseRow.totErr * 100) : 0;
    console.log(`${cfg.name.padEnd(18)} ${String(lvlDb).padStart(5)}dB   ${String(totErr).padStart(4)} / ${String(totRef).padStart(4)}     ${(cerSum / n * 100).toFixed(2).padStart(6)}%    ` +
      (cfg.mode === 'raw' ? '（基准）' : `${rel > 0 ? '改善' : '变差'} ${Math.abs(rel).toFixed(1)}%`));
   }
  }
  console.log();
  const best = rows.reduce((a, b) => b.totErr < a.totErr ? b : a);
  console.log(`★ 识别错误最少: ${best.cfg} @ ${best.lvlDb}dB 输入（${best.totErr} 处错）`);
  console.log(`  样本量: ${totalChars} 字 × 2 信噪比 × 6 噪声实现 = ${totalChars * 12} 字次/配置`);
  console.log('  注：单次差 1~3 个字仍在噪声范围内，只有成比例的差异才可信');
})();
