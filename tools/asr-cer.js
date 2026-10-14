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

const MODEL_DIR = path.join(__dirname, 'asr-model', 'sherpa-onnx-paraformer-zh-small-2024-03-09');

function makeRecognizer() {
  const sherpa = require('sherpa-onnx-node');
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(MODEL_DIR, 'model.int8.onnx') },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
    },
  };
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
  rec.decode(stream);
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

module.exports = { makeRecognizer, readWav, transcribe, editDistance, MODEL_DIR };

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
