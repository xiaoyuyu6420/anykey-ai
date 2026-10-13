// 远距识别优化回归测试（v0.12.4）：
//   T1 DSP 可调参数默认值 —— 远距优化后的默认档位必须落到位
//   T2 setTune 运行时生效 + 越界钳制（设置页滑块不能把管线打进坏状态）
//   T3 attenLimDb 走 df_set_atten_lim（不重建引擎——重建会丢 30ms 帧状态）
//   T4 门控释放加快：长静音后恢复到接近 1（旧 0.04 会卡在低位把下一句话切掉）
//   T5 AGC 目标下压后电平落在 ASR 甜区（不过冲、不放大底噪）
//   T6 diagnostics 快照字段齐全（链路体检面板依赖）
// 注意：本测试绕过真实 df.dll，构造假引擎驱动 DSP 链。
const path = require('path');
const ROOT = path.join(__dirname, '..');

const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const { MicPipeline } = require('../src/main/mic.js');
const BLOCK = 160;

// 假 DF 引擎：init 成功、processFrame 写入固定 SNR
function attachFakeDf(p, snr = 20) {
  p.df = {
    ready: true, attenLimDb: null, _lim: [],
    init(db) { this.attenLimDb = db; return true; },
    setAttenLim(db) { this.attenLimDb = db; this._lim.push(db); return true; },
    processFrame(f) { f.fill(0.001); return snr; },
  };
}

(async () => {
  console.log('[T1] 远距优化默认参数落位');
  {
    const p = new MicPipeline();
    ok(p.tune.gateRelease === 0.25, `门控释放默认 0.25（实际 ${p.tune.gateRelease}）`);
    ok(p.tune.agcTarget === 3600, `AGC 目标默认 3600（实际 ${p.tune.agcTarget}）`);
    ok(p.tune.attenLimDb === 3, `DFN3 衰减上限默认 3dB（实际 ${p.tune.attenLimDb}）`);
    ok(p.tune.gateOpenMul === 3 && p.tune.gateFloor === 0.05 && p.tune.agcMaxGain === 8,
      '语音判定倍数 3（远距语音可过判定）/ 门底 0.05 / 最大增益 8');
    // 旧值必须与新值不同——否则本测试在验证一个没生效的改动
    ok(p.tune.gateRelease !== 0.04, '门控释放确实从旧值 0.04 改掉了');
    ok(p.tune.attenLimDb !== 6, 'attenLim 确实从旧值 6dB 改掉了');
  }

  console.log('[T2] setTune 运行时生效 + 越界钳制');
  {
    const p = new MicPipeline();
    const r = p.setTune({ gateRelease: 0.5, agcTarget: 2000, agcMaxGain: 12 });
    ok(r.gateRelease === 0.5 && r.agcTarget === 2000 && r.agcMaxGain === 12, '合法值生效');
    p.setTune({ gateRelease: 99, agcTarget: 999999, attenLimDb: -5, gateFloor: 3, agcMaxGain: 0 });
    ok(p.tune.gateRelease === 1, `gateRelease 钳到 1（实际 ${p.tune.gateRelease}）`);
    ok(p.tune.agcTarget === 8000, `agcTarget 钳到 8000（实际 ${p.tune.agcTarget}）`);
    ok(p.tune.attenLimDb === 0, `attenLimDb 钳到 0（实际 ${p.tune.attenLimDb}）`);
    ok(p.tune.gateFloor === 1, `gateFloor 钳到 1（实际 ${p.tune.gateFloor}）`);
    ok(p.tune.agcMaxGain === 1, `agcMaxGain 钳到 1（实际 ${p.tune.agcMaxGain}）`);
    p.setTune({ gateRelease: NaN, agcTarget: 'x', attenLimDb: null });
    ok(p.tune.gateRelease === 1 && p.tune.agcTarget === 8000, 'NaN/字符串/null 不污染已有值');
  }

  console.log('[T3] attenLim 走 setAttenLim，不重建引擎');
  {
    const p = new MicPipeline();
    attachFakeDf(p);
    p.engine = 'df';
    p.setTune({ attenLimDb: 5 });
    ok(p.df.attenLimDb === 5, `df 收到 attenLim=5（实际 ${p.df.attenLimDb}）`);
    ok(p.df._lim.length === 1, '走 setAttenLim 而非重建 create');
    // 引擎未就绪时不能崩
    const q = new MicPipeline();
    q.setTune({ attenLimDb: 4 });
    ok(q.tune.attenLimDb === 4, '引擎未就绪时 tune 照常记录');
  }

  console.log('[T4] 门控释放加快——长静音后不塌');
  {
    const p = new MicPipeline();
    p.engine = null;
    p.noiseFloor = 150;
    // 先喂 1.2s 低电平噪声，让 speech 恒假、门控落到低位
    const noise = new Int16Array(BLOCK);
    for (let b = 0; b < 120; b++) {
      for (let i = 0; i < BLOCK; i++) noise[i] = 200 + ((i * 37) % 41) - 20;
      p.feed(noise, BLOCK);
    }
    const lowGate = p.gate;
    ok(lowGate < 0.3, `长静音后门控压低（实际 ${lowGate.toFixed(3)}）`);
    // 新语音到来：attack 0.5，一块就应显著回升
    const speech = new Int16Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) speech[i] = 3000 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    p.feed(speech, BLOCK);
    p.feed(speech, BLOCK);
    ok(p.gate > lowGate * 2, `新语音块后门控回升（${lowGate.toFixed(3)} → ${p.gate.toFixed(3)}）`);
  }

  console.log('[T5] AGC 目标下压——语音电平进 ASR 甜区且不过冲');
  {
    const p = new MicPipeline();
    p.engine = null;
    p.noiseFloor = 150;
    // 远距弱语音 RMS≈900：旧目标 4200 会把增益拉到 4.7×，新目标 3600 → 4×
    const weak = new Int16Array(BLOCK);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) { weak[i] = 900 * Math.sin((2 * Math.PI * 300 * i) / 16000); sum += weak[i] * weak[i]; }
    const inRms = Math.sqrt(sum / BLOCK);
    for (let b = 0; b < 40; b++) p.feed(weak, BLOCK);
    const outRms = p.level;
    ok(p.gain <= p.tune.agcMaxGain + 1e-6, `增益受 agcMaxGain 约束（${p.gain.toFixed(2)}）`);
    ok(outRms > inRms, `弱语音被放大（${inRms.toFixed(0)} → ${outRms.toFixed(0)}）`);
    ok(outRms <= 32767, `输出不溢出（${outRms.toFixed(0)}）`);
    // 静音段不应再被拉起（旧噪声门失效的回归防线）
    const quiet = new Int16Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) quiet[i] = 160 + ((i * 17) % 23) - 11;
    for (let b = 0; b < 200; b++) p.feed(quiet, BLOCK);
    let sq = 0;
    for (let i = 0; i < BLOCK; i++) sq += quiet[i] * quiet[i];
    ok(p.gain < 1.5, `静音段增益回落（${p.gain.toFixed(2)}）`);
  }

  console.log('[T6] diagnostics 快照字段齐全');
  {
    const p = new MicPipeline();
    attachFakeDf(p);
    p.engine = 'df';
    p.feed(new Int16Array(BLOCK).fill(500), BLOCK);
    const d = p.diagnostics();
    for (const k of ['engine', 'snrDb', 'vad', 'noiseFloor', 'level', 'gate', 'gain', 'packets', 'fifoLen', 'tune']) {
      ok(k in d, `字段 ${k} 存在`);
    }
    ok(d.engine === 'df', `engine 正确（${d.engine}）`);
    ok(d.snrDb === 20, `SNR 采到假引擎返回值（${d.snrDb}）`);
    ok(typeof d.tune === 'object' && d.tune.attenLimDb === 3, 'tune 快照含 attenLim');
    ok(Object.keys(d.tune).length === 6, 'tune 快照是拷贝（改了不影响管线）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
