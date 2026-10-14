// 离线 ASR 测识别错误率：用本地 sherpa-onnx（中文 Paraformer）给改造前后打分。
//
// 为什么需要它：频带占比、信噪比这些是「代理指标」，不能直接证明识别率变化。
// 有了本地 ASR，可以在**已知文本**的语音上数错字，得到真正的错误率数字。
//
// 用法：
//   node tools/asr-cer.js <wav>                 只识别，打印文本
//   node tools/asr-cer.js <wav> <参考文本文件>   识别并算字错率(CER)
//
// 参考文本（标准答案）的取法：先用无劣化的干净音频跑一遍，把它的输出当作
// 基准文本（干净音频的识别结果可近似为正确答案），再拿它去量劣化/补偿
// 之后的错误率。这样不需要人工听写。
const path = require('path');
const fs = require('fs');

const BASE = path.join(__dirname, 'asr-model');
const MODEL_DIR = path.join(BASE, 'sherpa-onnx-paraformer-zh-small-2024-03-09');
const ZF_DIR = path.join(BASE, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');
// 全尺寸双语 zipformer（encoder int8 182MB）——14M 那个太弱（基线 CER 55%+），
// 无法作为测量仪器；这个够强，可用来交叉验证 Paraformer 的结论
const ZF2_DIR = path.join(BASE, 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20');

// 支持两个不同架构的引擎，用于「交叉验证」结论是否只是某个模型的特性：
//   'paraformer'（默认）非自回归中文专用
//   'sensevoice'  多任务、抗噪设计（另一模型族）
function makeRecognizer(which = 'paraformer') {
  const sherpa = require('sherpa-onnx-node');
  // zipformer 是 transducer + 流式模型，需要 OnlineRecognizer（且要喂完再取结果）
  if (which === 'zipformer' || which === 'zipformer2') {
    const modelConfig = {
      transducer: {
        encoder: path.join(which === 'zipformer2' ? ZF2_DIR : ZF_DIR, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(which === 'zipformer2' ? ZF2_DIR : ZF_DIR, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(which === 'zipformer2' ? ZF2_DIR : ZF_DIR, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(which === 'zipformer2' ? ZF2_DIR : ZF_DIR, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
    };
    const rec = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search',
      enableEndpoint: false,
    });
    return { sherpa, rec, online: true };
  }
  let modelConfig;
  if (which === 'sensevoice') {
    modelConfig = { /* 已移除：tar 包下载不完整，模型加载原生崩溃 */ };
  } else {
    modelConfig = {
      paraformer: { model: path.join(MODEL_DIR, 'model.int8.onnx') },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
    };
  }
  const config = { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig };
  return { sherpa, rec: new sherpa.OfflineRecognizer(config) };
}

// 读 16bit 单声道 WAV（不依赖库自带 readWave，避免版本差异）
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV: ' + file);
  const ch = b.readUInt16LE(22);
  const sr = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  if (ch !== 1 || bits !== 16) throw new Error(`只支持 16bit 单声道（实际 ${ch}ch/${bits}bit）`);
  const n = (b.length - 44) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { sampleRate: sr, samples, seconds: n / sr };
}

function transcribe(rec, wav) {
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples });
  // 流式（transducer）需要显式结束输入并解到就绪为止；离线模型一次 decode 即可。
  // 注意：判断依据是**识别器**是否 online（rec.isReady 存在），不能看 stream
  // 有没有 inputFinished——离线流也有该方法，误判会报 isReady is not a function。
  if (typeof rec.isReady === 'function') {
    if (typeof stream.inputFinished === 'function') stream.inputFinished();
    let guard = 0;
    while (rec.isReady(stream) && guard++ < 100000) rec.decode(stream);
  } else {
    rec.decode(stream);
  }
  return rec.getResult(stream).text || '';
}

// 编辑距离（字符级）→ 字错率 CER
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

module.exports = { makeRecognizer, readWav, transcribe, editDistance, MODEL_DIR, ZF_DIR, BASE };

if (require.main === module) {
  const [wavFile, refFile] = process.argv.slice(2);
  if (!wavFile) {
    console.error('用法: node tools/asr-cer.js <wav> [参考文本文件]');
    process.exit(1);
  }
  const { rec } = makeRecognizer();
  const wav = readWav(wavFile);
  const t0 = Date.now();
  const text = transcribe(rec, wav);
  const ms = Date.now() - t0;
  console.log(`音频 ${wav.seconds.toFixed(2)}s  识别耗时 ${ms}ms  实时倍率 ${(wav.seconds / (ms / 1000)).toFixed(2)}x`);
  console.log('识别结果: ' + text);
  if (refFile) {
    const ref = fs.readFileSync(refFile, 'utf8').trim().replace(/\s/g, '');
    const hyp = text.trim().replace(/\s/g, '');
    const d = editDistance(ref, hyp);
    console.log(`参考文本: ${ref}`);
    console.log(`字错率 CER: ${(d / Math.max(1, ref.length) * 100).toFixed(1)}%  （${d} 处差异 / ${ref.length} 字）`);
  }
}
