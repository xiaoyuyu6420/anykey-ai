// 多算法识别率对比：一段真实录音 + 已知参考文本 → 每种前处理的字错率(CER)。
//
// 为什么这样测：这是唯一能同时满足三件事的实验——
//   ① 真实的麦克风（不是合成劣化）
//   ② 真实的处理链（跑项目自己的 MicPipeline 与各降噪模型）
//   ③ 真实的识别判定（本地 ASR 数错字，而非 PESQ 这类听感代理指标）
//
// 用法: node tools/algo-compare.js <录音.wav> <参考文本文件>
//
// 参考文本就是「朗读内容」——由用户在录音前确定，是唯一可靠的标准答案。
const fs = require('fs');
const path = require('path');
const { makeRecognizer, readWav, transcribe, editDistance } = require('./asr-cer.js');
const { OfflineSpeechDenoiser } = require('sherpa-onnx-node/non-streaming-speech-denoiser.js');
const { MicPipeline } = require('../src/main/mic.js');

const MODEL_DIR = path.join(__dirname, 'asr-model');
const BLK = 160;

const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length) * 32768; };

// 文本归一化：去标点空白 + 汉字数字与阿拉伯数字统一。
// 为什么必须做：ASR 可能把「123321」输出成「一二三三二一」，逐字比会误判成 6 个字错——
// 那是表示法差异，不是识别错误。
const CN_NUM = { '〇': '0', '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
                 '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
function normText(s) {
  return String(s)
    .replace(/[\s，。、！？：；""''（）,.!?;:()\[\]【】…—－-]/g, '')
    .replace(/[〇零一二两三四五六七八九]/g, c => CN_NUM[c]);
}

// 过一遍项目真实管线（模式可指定）
async function throughPipeline(sig, mode, hfBoost = 6) {
  const p = new MicPipeline({ inRate: 16000, autoRate: false, mode, hfBoostDb: hfBoost, noiseSubtract: false });
  await p.initDenoiser();
  const out = [];
  for (let o = 0; o < sig.length; o += BLK) {
    const n = Math.min(BLK, sig.length - o);
    const int16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = Math.round(sig[o + i] * 32768);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      int16[i] = v;
    }
    const res = p.feed(int16, n);
    for (let i = 0; i < res.length; i += 2) out.push(res.readInt16LE(i) / 32768);
  }
  return new Float32Array(out);
}

// sherpa-onnx 的独立降噪模型（GTCRN / DPDFNet）
function denoiseModel(sig, file, kind = 'gtcrn') {
  const cfg = { model: { numThreads: 4, provider: 'cpu' } };
  if (kind === 'gtcrn') cfg.model.gtcrn = { model: path.join(MODEL_DIR, file) };
  else cfg.model.dpdfnet = { model: path.join(MODEL_DIR, file) };
  const d = new OfflineSpeechDenoiser(cfg);
  return d.run({ samples: sig, sampleRate: 16000 }).samples;
}

// 高频搁架（与项目 speech 档同一套系数），用于「降噪后补辅音」
function shelf(sig, db, f0 = 2600) {
  if (!db) return Float32Array.from(sig);
  const A = Math.pow(10, db / 40), w0 = 2 * Math.PI * f0 / 16000, cw = Math.cos(w0);
  const al = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 - 1) + 2), sa = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cw + 2 * sa * al), b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  const b2 = A * ((A + 1) + (A - 1) * cw - 2 * sa * al);
  const a0 = (A + 1) - (A - 1) * cw + 2 * sa * al, a1 = 2 * ((A - 1) - (A + 1) * cw);
  const a2 = (A + 1) - (A - 1) * cw - 2 * sa * al;
  const c = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const o = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const v = c.b0 * sig[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = sig[i]; y2 = y1; y1 = v; o[i] = v;
  }
  return o;
}

// 按「语音段响度」归一化到同一目标，作为公平的比较基准。
// 为什么不用峰值归一化：原始录音的峰值常来自单个瞬态（爆音/齿音尖峰），
// 按峰值归一会让人声被压得很低——实测这会让原始版本的识别输出直接为空，
// 而峰值较低的降噪版本反而占便宜。用最响窗口的 RMS 对齐才是同响度比较。
function normalize(sig, targetRms = 0.05) {
  const W = Math.min(24000, sig.length);
  let best = 0, bE = 0;
  for (let o = 0; o + W <= sig.length; o += 4000) {
    let e = 0; for (let i = 0; i < W; i++) e += sig[o + i] * sig[o + i];
    if (e > bE) { bE = e; best = o; }
  }
  let speechRms = Math.sqrt(bE / Math.max(1, W));
  if (!(speechRms > 1e-6)) {
    // 没有明显语音段：退回整段 RMS
    let s = 0; for (const v of sig) s += v * v;
    speechRms = Math.sqrt(s / Math.max(1, sig.length));
  }
  if (!(speechRms > 1e-6)) return sig;
  const g = Math.min(64, Math.max(1 / 64, targetRms / speechRms));
  const o = new Float32Array(sig.length);
  let pk = 0;
  for (let i = 0; i < sig.length; i++) { const v = sig[i] * g; o[i] = v; const a = Math.abs(v); if (a > pk) pk = a; }
  // 归一化后若越界削顶，整体回退，避免制造削波失真污染对比
  if (pk > 0.99) { const k = 0.99 / pk; for (let i = 0; i < sig.length; i++) o[i] *= k; }
  return o;
}

(async () => {
  const [wavFile, refFile] = process.argv.slice(2);
  if (!wavFile || !refFile) {
    console.error('用法: node tools/algo-compare.js <录音.wav> <参考文本文件>');
    process.exit(1);
  }
  const { rec } = makeRecognizer('paraformer');
  const wav = readWav(wavFile);
  const ref = normText(fs.readFileSync(refFile, 'utf8').trim());
  console.log(`录音: ${path.basename(wavFile)}  ${(wav.samples.length / 16000).toFixed(1)}s  RMS ${rms(wav.samples).toFixed(0)}`);
  console.log(`参考文本 (${ref.length} 字): ${ref}`);
  console.log();

  // 各算法：名称 → 生成函数
  const algos = [
    ['0 原始（当前配置）', async s => normalize(s)],
    ['1 高通去低频', async s => normalize(await throughPipeline(s, 'hp'))],
    ['2 辅音补偿（项目当前档）', async s => normalize(await throughPipeline(s, 'speech', 6))],
    ['3 完整链 DFN3+AGC', async s => normalize(await throughPipeline(s, 'full', 6))],
  ];
  // 独立降噪模型（文件存在才加）
  // 只用 GTCRN：DPDFNet 的两个模型与当前 sherpa-onnx(1.13.8) 不兼容，
  // 实测输出恒为空并在原生层刷 Reshape 错误（已下载验证，勿再加入）
  for (const [name, file, kind] of [['4 GTCRN 0.5MB', 'gtcrn_simple.onnx', 'gtcrn']]) {
    if (fs.existsSync(path.join(MODEL_DIR, file))) {
      algos.push([name, async s => {
        try { return normalize(denoiseModel(s, file, kind)); }
        catch (e) { return null; }
      }]);
      algos.push([name + ' + 辅音补偿', async s => {
        try { return normalize(shelf(denoiseModel(s, file, kind), 6)); }
        catch (e) { return null; }
      }]);
    }
  }

  console.log('算法                          字数错/参考   CER     识别输出');
  console.log('----------------------------------------------------------------------');
  const rows = [];
  for (const [name, fn] of algos) {
    let sig;
    try { sig = await fn(wav.samples); } catch (e) { console.log(`${name.padEnd(28)} 失败: ${e.message}`); continue; }
    if (!sig || !sig.length) { console.log(`${name.padEnd(28)} 无输出（算法不可用）`); continue; }
    // 输出有效性检查：低于输入 1% 视为算法失效，否则 ASR 会在近乎静音上给出
    // 一个看似「错误很多」的分数，把结论带偏（DPDFNet 就是这样）
    const rIn = rms(wav.samples), rOut = rms(sig);
    if (rOut < rIn * 0.01) { console.log(`${name.padEnd(28)} 输出近乎静音（${rOut.toFixed(0)} vs 输入 ${rIn.toFixed(0)}），跳过`); continue; }
    let sSq = 0; for (const v of sig) sSq += v * v;
    const outRms = Math.sqrt(sSq / Math.max(1, sig.length)) * 32768;
    const hyp = normText(transcribe(rec, { sampleRate: 16000, samples: sig }));
    const d = editDistance(ref, hyp);
    const cer = d / Math.max(1, ref.length) * 100;
    rows.push({ name, d, cer, hyp });
    console.log(`${name.padEnd(28)} ${String(d).padStart(4)} / ${String(ref.length).padStart(3)}   ${cer.toFixed(1).padStart(5)}%  归一后RMS ${outRms.toFixed(0).padStart(5)}  ${hyp.slice(0, 20)}`);
  }
  console.log();
  if (rows.length) {
    const best = rows.reduce((a, b) => b.d < a.d ? b : a);
    console.log(`★ 错误最少: ${best.name}（${best.d} 处）`);
    const base = rows.find(r => r.name.startsWith('0 '));
    if (base && base.d !== best.d) {
      console.log(`  相对当前配置(原始) ${base.d} 处：${best.d < base.d ? '改善' : '变差'} ${Math.abs((base.d - best.d) / Math.max(1, base.d) * 100).toFixed(0)}%`);
    }
  }
  console.log();
  console.log('注：样本量只有一段录音，单次差 1~3 个字属噪声范围；读得越长结论越可靠。');
})();
