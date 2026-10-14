// 真采样率转换回归测试（v0.13.1）
//
// 背景：实测键盘音频流是 ~17129Hz，而代码按 16000Hz 处理 → 全部声音降调 7%。
// 这类「速率错配」不会报错、不会崩，只会让声音变闷、ASR 变差——必须靠数值断言守住。
//
//   R1 时长守恒：N 个输入样本 → N × (outRate/inRate) 个输出样本
//   R2 频率守恒：输入 1kHz 正弦，输出仍是 1kHz（这是「不降调」的直接证据）
//   R3 幅度守恒：通带内正弦幅度基本不变、不产生 NaN
//   R4 抗混叠：输入超过输出奈奎斯特的分量应被压低，而不是折回可听带
//   R5 分块无关性：任意分块大小结果一致（流式处理不能依赖分块）
//   R6 管线集成：MicPipeline 打开转换后，单位时间产出的样本数正确
const path = require('path');
const ROOT = path.join(__dirname, '..');

const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const { RateConverter } = require('../src/main/resample.js');
const { MicPipeline } = require('../src/main/mic.js');

const IN_RATE = 17129, OUT_RATE = 16000;

// 跑一段正弦通过转换器，返回输出数组
function run(rc, freq, seconds, chunk = 300) {
  const total = Math.round(IN_RATE * seconds);
  const acc = [];
  for (let o = 0; o < total; o += chunk) {
    const n = Math.min(chunk, total - o);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.sin(2 * Math.PI * freq * (o + i) / IN_RATE) * 10000;
    const r = rc.process(b, n);
    for (let i = 0; i < r.length; i++) acc.push(r[i]);
  }
  return acc;
}
const measureFreq = (a, skipSec = 1) => {
  const t = a.slice(Math.round(skipSec * OUT_RATE));
  let z = 0;
  for (let i = 1; i < t.length; i++) if (t[i - 1] < 0 && t[i] >= 0) z++;
  return z / (t.length / OUT_RATE);
};
const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };

console.log('[R1] 时长守恒（降调的直接检验）');
{
  const rc = new RateConverter(IN_RATE, OUT_RATE);
  const out = run(rc, 1000, 4);
  const inSec = 4, outSec = out.length / OUT_RATE;
  ok(Math.abs(inSec - outSec) < 0.02, `4.000s 输入 → ${outSec.toFixed(3)}s 输出（误差 ${Math.abs(inSec - outSec).toFixed(4)}s）`);
  // 若不做转换（按 16k 谎报），同样样本数会被算成 4×17129/16000 = 4.28s
  const wrongSec = 4 * IN_RATE / OUT_RATE;
  ok(wrongSec > 4.2, `对照：不转换会是 ${wrongSec.toFixed(2)}s（多出 ${((wrongSec / 4 - 1) * 100).toFixed(1)}%，即降调量）`);
}

console.log('[R2] 频率守恒：不降调');
{
  for (const f of [300, 1000, 3000]) {
    const rc = new RateConverter(IN_RATE, OUT_RATE);
    const m = measureFreq(run(rc, f, 3));
    ok(Math.abs(m - f) / f < 0.01, `${f}Hz → 输出 ${m.toFixed(1)}Hz（偏差 ${((m / f - 1) * 100).toFixed(2)}%）`);
  }
  // 对照：不做转换时"听感频率"会变成 f×16000/17129
  const would = 1000 * OUT_RATE / IN_RATE;
  ok(would < 940, `对照：不转换时 1000Hz 会被听成 ${would.toFixed(0)}Hz（降调 ${((1 - would / 1000) * 100).toFixed(1)}%）`);
}

console.log('[R3] 幅度守恒与数值健康');
{
  const rc = new RateConverter(IN_RATE, OUT_RATE);
  const out = run(rc, 1000, 3);
  const r = rms(out.slice(OUT_RATE));
  ok(Math.abs(r - 7071) / 7071 < 0.05, `输出 RMS ${r.toFixed(0)}（输入正弦理论 7071，偏差 <5%）`);
  ok(out.every(v => Number.isFinite(v)), '无 NaN/Infinity');
}

console.log('[R4] 抗混叠：超奈奎斯特分量被压掉而非折回');
{
  // 8300Hz 超过输出奈奎斯特(8000)，若不滤波会折回 7700Hz 变成刺耳杂音
  const rc = new RateConverter(IN_RATE, OUT_RATE);
  const out = run(rc, 8300, 3);
  const r = rms(out.slice(OUT_RATE));
  ok(r < 7071 * 0.25, `8300Hz 分量被压到 RMS ${r.toFixed(0)}（<25% 原幅度）——未折回可听带`);
}

console.log('[R5] 分块无关性（流式处理不能依赖分块大小）');
{
  const a = run(new RateConverter(IN_RATE, OUT_RATE), 1000, 2, 30);   // 单帧
  const b = run(new RateConverter(IN_RATE, OUT_RATE), 1000, 2, 300);  // 十帧
  const c = run(new RateConverter(IN_RATE, OUT_RATE), 1000, 2, 2400); // 大块
  ok(Math.abs(a.length - b.length) <= 2 && Math.abs(b.length - c.length) <= 2,
    `输出样本数一致：${a.length} / ${b.length} / ${c.length}`);
  let maxD = 0;
  const m = Math.min(a.length, b.length);
  for (let i = 2000; i < m; i++) maxD = Math.max(maxD, Math.abs(a[i] - b[i]));
  ok(maxD < 1e-3, `逐样本一致（最大偏差 ${maxD.toExponential(1)}）`);
}

console.log('[R6] 管线集成：转换后单位时间产出样本数正确');
{
  const mk = inRate => {
    const p = new MicPipeline({ bypass: true, inRate, noiseSubtract: false });
    const frames = 572;                       // 约 10 秒的真实帧数（571 帧/s）
    const buf = new Int16Array(30);
    let totalBytes = 0;
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < 30; i++) buf[i] = Math.round(3000 * Math.sin(2 * Math.PI * 440 * (f * 30 + i) / inRate));
      totalBytes += p.feed(buf, 30).length;
    }
    return totalBytes / 2;                    // 样本数
  };
  const withRs = mk(IN_RATE);
  const noRs = mk(16000);                     // 16000 = 关闭转换（见 config 注释）
  // 572 帧 = 17160 输入样本。注意产出按 BLOCK=160 成块给，余数留在 FIFO 里
  ok(Math.abs(withRs - 16000) < 1, `开转换：${withRs} 样本 = 100 个整块（余数 ${Math.round(17160 * 16000 / 17129) - 16000} 个样本留在 FIFO）`);
  ok(Math.abs(noRs - 17120) < 1, `关转换：${noRs} 样本 = 107 个整块（同一批帧被当成 16kHz 数据）`);
  // 关键：相同数量的输入帧，开转换后产出的样本必须更少（等价于播放不被拉长）
  const ratio = noRs / withRs;
  ok(ratio > 1.06 && ratio < 1.08, `样本数比 ${ratio.toFixed(3)}（应≈17129/16000=1.071）——即未转换时会多播 ${((ratio - 1) * 100).toFixed(1)}% 的时长`);
}

console.log('[R7] 采样率自动校准（不该硬编码链路速率）');
{
  // 以「真实 17129Hz」的节奏喂 ~4.3 秒数据，校准应测出接近值并采用。
  // 这条守的是：采样率是「链路+固件」的属性，换有线/换固件都可能不同，
  // 硬编码会在别的链路上引入新的降调。
  const p = new MicPipeline({ bypass: true, noiseSubtract: false, inRate: 17129 });
  const rate = 17129;
  const perTick = Math.round(rate / 20);          // 每 50ms 喂一次
  const buf = new Int16Array(perTick);
  const t0 = Date.now();
  let tick = 0;
  while (Date.now() - t0 < 4300) {
    for (let i = 0; i < perTick; i++) buf[i] = Math.round(1500 * Math.sin(2 * Math.PI * 440 * (tick * perTick + i) / rate));
    tick++;
    p.feed(buf, perTick);
    const target = t0 + tick * 50;
    const wait = target - Date.now();
    if (wait > 0) { const end = Date.now() + wait; while (Date.now() < end) { /* 忙等，保证节奏贴近真实 */ } }
  }
  const d = p.diagnostics();
  ok(d.inRateCalibrated === true, '4 秒后已执行校准');
  ok(Math.abs(d.inRateMeasured - rate) / rate < 0.15,
    `测出 ${d.inRateMeasured}Hz（真实 ${rate}，误差 ${((d.inRateMeasured / rate - 1) * 100).toFixed(1)}%）`);
  ok(d.resampling === true, '校准后仍启用重采样（17k≠16k）');
}
{
  // 异常值不采纳、也不锁定（v0.13.4 修复）：
  // 音频刚开始流动时样本数严重偏低，会测出荒谬速率（实测开局测到 1123Hz）。
  // 若此时就标记 done，就会一直用错误速率——比如把 16k 的蓝牙流按 17129
  // 重采样，凭空引入 7% 升调。正确行为：重试，连续 5 次异常才放弃。
  const p = new MicPipeline({ bypass: true, noiseSubtract: false, inRate: 17129 });
  const buf = new Int16Array(2000);
  const t0 = Date.now();
  while (Date.now() - t0 < 4200) p.feed(buf, 2000);   // 第 1 轮：极快灌入 → 异常速率
  const d1 = p.diagnostics();
  ok(d1.inRateMeasured > 19000, `测得异常高速率 ${d1.inRateMeasured}Hz`);
  ok(d1.inRateCalibrated === false, '异常值不锁定，保持可重试（这是修复的核心）');
  ok(d1.inRate === 17129, `异常值未采纳，保留配置值 ${d1.inRate}Hz`);
  // 继续跑到 5 次异常 → 放弃并锁定（不再无休止重试）
  const t1 = Date.now();
  while (Date.now() - t1 < 22000) p.feed(buf, 2000);
  ok(p.diagnostics().inRateCalibrated === true, '连续 5 次异常后放弃并锁定');
  ok(p.diagnostics().inRate === 17129, '锁定后仍保留配置值');
}
{
  // 显式 16000 = 1:1 测试模式：不校准、不转换（保证单测确定性）
  const p = new MicPipeline({ bypass: true, noiseSubtract: false, inRate: 16000 });
  const buf = new Int16Array(1000);
  const t0 = Date.now();
  while (Date.now() - t0 < 4200) p.feed(buf, 1000);
  const d = p.diagnostics();
  ok(d.inRateCalibrated === false, '1:1 模式下不触发校准');
  ok(d.resampling === false, '1:1 模式下不启用重采样');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
