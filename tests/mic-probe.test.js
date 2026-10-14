// 降噪探针对比测试（v0.12.5）——回答「底噪高是降噪没工作，还是物理底噪」
//
//   P1 探针测出的降噪量与真实降噪倍数一致（用已知增益的假引擎验证）
//   P2 引擎旁路时判读为「降噪几乎没工作」（这是「有 bug 要修」的信号）
//   P3 语音段/静音段分开统计（判读依据：静音段反映底噪，语音段反映有没有伤到人声）
//   P4 探针在 AGC 之前测量（否则增益会污染读数——这是探针位置的关键约束）
//
// 测试信号用语音频段正弦（300~1000Hz）。上一版用近直流恒定电平，属退化信号：
// 高通会把直流滤掉，残余只剩数值噪声，测出的比例无意义。
const path = require('path');
const ROOT = path.join(__dirname, '..');

const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const { MicPipeline } = require('../src/main/mic.js');
const BLOCK = 160;

// 假 DF 引擎：48k 域整体乘 gain（模拟降噪衰减）。
// SNR 与输入电平相关（贴近 DFN3 真实行为：有信号才报高 SNR），
// 恒定返回高 SNR 会把静音段也判成语音，导致分段统计错位。
function attachDf(p, gain, snrLoud = 25, snrQuiet = 0.5) {
  p.df = {
    ready: true, attenLimDb: 6,
    init() { return true; },
    setAttenLim() { return true; },
    processFrame(f) {
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      const rms = Math.sqrt(s / f.length);
      for (let i = 0; i < f.length; i++) f[i] *= gain;
      return rms > 1500 ? snrLoud : snrQuiet;
    },
  };
}

// 连续相位正弦（跨块连续，避免块边界不连续引入高频）
function runTone(p, freq, amp, blocks, collector) {
  const buf = new Int16Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++) {
      buf[i] = Math.round(amp * Math.sin(2 * Math.PI * freq * (b * BLOCK + i) / 16000));
    }
    p.feed(buf, BLOCK);
    if (collector) collector();
  }
}

console.log('[P1] 探针降噪量与真实倍数一致');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, noiseSubtract: false });
  attachDf(p, 0.25);         // 0.25 倍 → 20·log10(4) = 12.04dB
  p.engine = 'df';
  runTone(p, 300, 300, 200);  // 静音段（低于语音判定）
  runTone(p, 300, 8000, 400); // 语音段
  const r = p.probeReport();
  ok(r.silence.samples > 50 && r.speech.samples > 50,
    `两段都采到（静音 ${r.silence.samples} / 语音 ${r.speech.samples}）`);
  ok(Math.abs(r.silence.cutDb - 12.04) < 1.5, `静音段降噪量 ≈12.04dB（实测 ${r.silence.cutDb}）`);
  ok(Math.abs(r.speech.cutDb - 12.04) < 1.5, `语音段降噪量 ≈12.04dB（实测 ${r.speech.cutDb}）`);
  ok(r.silence.post < r.silence.pre, `post < pre（${r.silence.pre} → ${r.silence.post}）`);
  ok(typeof r.verdict === 'string' && r.verdict !== '采样中', `产出判读：[${r.verdict}]`);
  ok(Math.abs(r.snrGainDb) < 1.5, `探针按同比例压 pre/post，SNR 提升应≈0（实测 ${r.snrGainDb}dB）`);
  ok(r.advice.length > 0, `建议非空（${r.advice.slice(0, 36)}…）`);
}

console.log('[P2] 引擎旁路 → 判读为降噪几乎没工作');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, noiseSubtract: false });
  p.engine = null;
  runTone(p, 300, 300, 200);  // 静音段
  runTone(p, 300, 8000, 200); // 语音段
  const r = p.probeReport();
  ok(r.silence.cutDb < 2, `无降噪时静音段降噪量≈0（${r.silence.cutDb}dB）`);
  ok(/没改善/.test(r.verdict), `判读指向降噪无效：[${r.verdict}]`);
  ok(Math.abs(r.snrGainDb) < 1.5, `无降噪时 SNR 提升 ≈0（${r.snrGainDb}dB）`);
}

console.log('[P3] 语音段与静音段分开统计');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, noiseSubtract: false });
  attachDf(p, 0.5);          // 0.5 倍 → 6.02dB
  p.engine = 'df';
  runTone(p, 300, 300, 250);   // 弱信号 → 静音桶
  runTone(p, 300, 8000, 250);  // 强信号 → 语音桶
  const r = p.probeReport();
  ok(r.silence.samples > 50, `静音段统计到 ${r.silence.samples} 块`);
  ok(r.speech.samples > 50, `语音段统计到 ${r.speech.samples} 块`);
  ok(Math.abs(r.silence.cutDb - 6.02) < 1.5, `静音段降噪量 ≈6.02dB（实测 ${r.silence.cutDb}）`);
  ok(Math.abs(r.speech.cutDb - 6.02) < 1.5, `语音段降噪量 ≈6.02dB（实测 ${r.speech.cutDb}）`);
}

console.log('[P4] 探针在 AGC 之前测量（增益不污染读数）');
{
  const mk = agcTarget => {
    const p = new MicPipeline({ inRate: 16000, autoRate: false, noiseSubtract: false, agcTarget });
    attachDf(p, 0.5);
    p.engine = 'df';
    runTone(p, 300, 300, 200);
    runTone(p, 300, 8000, 400);
    return p.probeReport();
  };
  const a = mk(1200);   // AGC 会大幅抬增益
  const b = mk(6000);   // AGC 增益接近 1
  ok(Math.abs(a.speech.cutDb - b.speech.cutDb) < 1.0,
    `不同 AGC 目标下读数一致（${a.speech.cutDb} vs ${b.speech.cutDb}）——测量点在 AGC 之前`);
  ok(Math.abs(a.speech.cutDb - 6.02) < 1.5, `读数仍是引擎真实衰减 6.02dB（${a.speech.cutDb}）`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
