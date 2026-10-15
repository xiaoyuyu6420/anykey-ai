// 语音活动测量单测（锁定看门狗的输入信号）：
// setSpeechWatch(on) 才开始测；lastSpeechTs 在语音块刷新、静音块不刷新
const { MicPipeline } = require('../src/main/mic');
const BLOCK = 160;

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const mk = amp => { const b = new Int16Array(BLOCK); for (let i = 0; i < BLOCK; i++) b[i] = Math.round(amp * Math.sin(i * 0.1)); return b; };

console.log('[T1] 开关语义');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, mode: 'raw', noiseSubtract: false });
  ok(p.lastSpeechTs === 0 && p._speechWatch === false, '初始：未测量');
  p.feed(mk(5000), BLOCK);
  ok(p.lastSpeechTs === 0, '未开开关：大声块也不更新（常态零副作用）');
  p.setSpeechWatch(true);
  const t0 = p.lastSpeechTs;
  ok(t0 > 0, '开启瞬间视为有活动（静音计时起点）');
  p.setSpeechWatch(false);
  ok(p._speechWatch === false, '可关闭');
}

console.log('[T2] 语音刷新 / 静音不刷新（raw 档）');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, mode: 'raw', noiseSubtract: false });
  p.setSpeechWatch(true);
  // 喂静音块把起点顶旧
  for (let i = 0; i < 50; i++) p.feed(mk(30), BLOCK);
  const tQuiet = p.lastSpeechTs;
  p.feed(mk(6000), BLOCK);
  ok(p.lastSpeechTs > tQuiet, '大声块刷新 lastSpeechTs');
  const tSp = p.lastSpeechTs;
  for (let i = 0; i < 50; i++) p.feed(mk(30), BLOCK);
  ok(p.lastSpeechTs === tSp, '纯静音块不再刷新（静音计时得以累积）');
}

console.log('[T3] 底噪自适应：噪声底较高的链路不误报语音');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, mode: 'raw', noiseSubtract: false });
  p.setSpeechWatch(true);
  // 持续 300 RMS 的「高底噪」环境：_trackNoiseFloor 收敛后不应再判语音
  for (let i = 0; i < 300; i++) p.feed(mk(300), BLOCK);
  const t = p.lastSpeechTs;
  for (let i = 0; i < 50; i++) p.feed(mk(300), BLOCK);
  ok(p.lastSpeechTs <= t, '底噪收敛后同电平不再判语音（防高噪环境永不超时）');
  ok(p.noiseFloor > 150, 'noiseFloor 确实收敛上去了: ' + Math.round(p.noiseFloor));
}

console.log('[T4] diagnostics 暴露 speechAgoMs');
{
  const p = new MicPipeline({ inRate: 16000, autoRate: false, mode: 'raw', noiseSubtract: false });
  ok(p.diagnostics().speechAgoMs === -1, '未测量时 = -1');
  p.setSpeechWatch(true);
  ok(p.diagnostics().speechAgoMs >= 0, '测量中 ≥ 0');
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
