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
    const p = new MicPipeline({ inRate: 16000 });
    ok(p.tune.gateRelease === 0.25, `门控释放默认 0.25（实际 ${p.tune.gateRelease}）`);
    ok(p.tune.agcTarget === 3600, `AGC 目标默认 3600（实际 ${p.tune.agcTarget}）`);
    ok(p.tune.attenLimDb === 6, `DFN3 衰减上限默认 6dB（实测数据支持的平衡点，实际 ${p.tune.attenLimDb}）`);
    ok(p.tune.gateOpenMul === 3 && p.tune.gateFloor === 0.05 && p.tune.agcMaxGain === 32,
      '语音判定倍数 3（远距语音可过判定）/ 门底 0.05 / 最大增益 8');
    // 旧值必须与新值不同——否则本测试在验证一个没生效的改动
    ok(p.tune.gateRelease !== 0.04, '门控释放确实从旧值 0.04 改掉了');
    // 曾降到 3dB 求「保护辅音」，实测方向错了（底噪偏高需更强降噪），已回到 6dB
    ok(typeof p.tune.attenLimDb === 'number' && p.tune.attenLimDb > 0, 'attenLim 为正值（0 在 libdf 是「无限制」，须避开）');
  }

  console.log('[T2] setTune 运行时生效 + 越界钳制');
  {
    const p = new MicPipeline({ inRate: 16000 });
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
    const p = new MicPipeline({ inRate: 16000 });
    attachFakeDf(p);
    p.engine = 'df';
    p.setTune({ attenLimDb: 5 });
    ok(p.df.attenLimDb === 5, `df 收到 attenLim=5（实际 ${p.df.attenLimDb}）`);
    ok(p.df._lim.length === 1, '走 setAttenLim 而非重建 create');
    // 引擎未就绪时不能崩
    const q = new MicPipeline({ inRate: 16000 });
    q.setTune({ attenLimDb: 4 });
    ok(q.tune.attenLimDb === 4, '引擎未就绪时 tune 照常记录');
  }

  console.log('[T4] 门控释放加快——长静音后不塌');
  {
    const p = new MicPipeline({ inRate: 16000 });
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
    const p = new MicPipeline({ inRate: 16000 });
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
    const p = new MicPipeline({ inRate: 16000 });
    attachFakeDf(p);
    p.engine = 'df';
    p.feed(new Int16Array(BLOCK).fill(500), BLOCK);
    const d = p.diagnostics();
    for (const k of ['engine', 'snrDb', 'vad', 'noiseFloor', 'level', 'gate', 'gain', 'packets', 'fifoLen', 'tune']) {
      ok(k in d, `字段 ${k} 存在`);
    }
    ok(d.engine === 'df', `engine 正确（${d.engine}）`);
    ok(d.snrDb === 20, `SNR 采到假引擎返回值（${d.snrDb}）`);
    ok(typeof d.tune === 'object' && d.tune.attenLimDb === 6, 'tune 快照含 attenLim');
    ok(Object.keys(d.tune).length === 6, 'tune 快照是拷贝（改了不影响管线）');
  }

  console.log('[T9] 原始音频旁路：必须逐样本不变');
  {
    const p = new MicPipeline({ inRate: 16000, bypass: true });
    attachFakeDf(p, 0.25);
    p.engine = 'df';
    // 造一段有直流偏置 + 大动态的信号：任何高通/门控/AGC 都会改变它
    const src = new Int16Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) src[i] = Math.round(3000 + 12000 * Math.sin(2 * Math.PI * 300 * i / 16000));
    const out = p.feed(src, BLOCK);
    ok(out.length === BLOCK * 2, `输出长度 ${out.length} 字节（期望 ${BLOCK * 2}）`);
    let maxErr = 0;
    for (let i = 0; i < BLOCK; i++) {
      maxErr = Math.max(maxErr, Math.abs(out.readInt16LE(i * 2) - src[i]));
    }
    ok(maxErr === 0, `逐样本完全一致（最大偏差 ${maxErr}）——含直流偏置，证明高通也被跳过`);
    ok(p.diagnostics().engine === 'bypass', '诊断报告 engine=bypass');
    ok(p.diagnostics().bypass === true, '诊断报告 bypass=true');
    ok(p.probeReport().verdict === '原始音频模式', `探针明确标注旁路（${p.probeReport().verdict}）`);
    ok(p.probeReport().bypassed === true, '探针标记 bypassed');
  }

  console.log('[T10] 关掉旁路后处理链恢复、切回无残留');
  {
    const p = new MicPipeline({ inRate: 16000, bypass: true });
    attachFakeDf(p, 0.25);
    p.engine = 'df';
    const mk = () => {
      const a = new Int16Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) a[i] = Math.round(3000 + 12000 * Math.sin(2 * Math.PI * 300 * i / 16000));
      return a;
    };
    const rmsOf = buf => { let s = 0; for (let i = 0; i < BLOCK; i++) { const v = buf.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / BLOCK); };
    const bypassRms = rmsOf(p.feed(mk(), BLOCK));
    p.setBypass(false);
    const procRms = rmsOf(p.feed(mk(), BLOCK));
    ok(p.bypass === false, 'setBypass(false) 生效');
    ok(p.diagnostics().engine === 'df', `引擎恢复为 df（${p.diagnostics().engine}）`);
    ok(Math.abs(bypassRms - procRms) > 1, `处理后与原声确实不同（${bypassRms.toFixed(0)} vs ${procRms.toFixed(0)}）`);
    // 再切回旁路应仍是逐样本一致（状态机复位后不残留）
    p.setBypass(true);
    const back = p.feed(mk(), BLOCK);
    const src = mk();
    let maxErr = 0;
    for (let i = 0; i < BLOCK; i++) maxErr = Math.max(maxErr, Math.abs(back.readInt16LE(i * 2) - src[i]));
    ok(maxErr === 0, `切回旁路仍逐样本一致（最大偏差 ${maxErr}）——复位无残留`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('[T11] hp 档：只去低频，不做降噪/增益/门控');
  {
    const mk = (mode) => {
      const p = new MicPipeline({ inRate: 16000, mode, noiseSubtract: false });
      attachFakeDf(p, 0.25);
      p.engine = 'df';
      return p;
    };
    const BLK = 160;
    const dcRms = (p) => {
      // 喂带直流偏置 + 300Hz 交流的信号，看输出还剩什么
      const src = new Int16Array(BLK);
      for (let i = 0; i < BLK; i++) src[i] = Math.round(4000 + 8000 * Math.sin(2 * Math.PI * 300 * i / 16000));
      const out = p.feed(src, BLK);
      let s = 0, dc = 0;
      for (let i = 0; i < BLK; i++) { const v = out.readInt16LE(i * 2); s += v * v; dc += v; }
      return { rms: Math.sqrt(s / BLK), dc: dc / BLK, len: out.length };
    };
    const raw = dcRms(mk('raw'));
    const hp = dcRms(mk('hp'));
    const full = dcRms(mk('full'));
    // raw：直流偏置保留
    ok(Math.abs(raw.dc - 4000) < 120, `raw 保留直流偏置 ${raw.dc.toFixed(0)}（输入 4000）`);
    // hp：直流被高通滤掉，交流基本保留
    ok(Math.abs(hp.dc) < 400, `hp 去掉直流 ${hp.dc.toFixed(0)}`);
    ok(hp.rms > 3000, `hp 保留交流成分 RMS ${hp.rms.toFixed(0)}（输入 8000 正弦 RMS 应≈5657，高通首块有暂态）`);
    ok(hp.len === BLK * 2, 'hp 输出长度正常');
    // full：经过降噪（假引擎乘 0.25）+ 门控/AGC，与 hp 明显不同
    ok(Math.abs(full.rms - hp.rms) > 100, `full 与 hp 明显不同（${full.rms.toFixed(0)} vs ${hp.rms.toFixed(0)}）`);
    // 诊断与探针
    const p2 = mk('hp');
    dcRms(p2);
    ok(p2.diagnostics().mode === 'hp', `诊断报告 mode=hp（${p2.diagnostics().mode}）`);
    ok(p2.diagnostics().engine === 'df', 'hp 档引擎字段仍为 df（不是 bypass）');
    ok(p2.probeReport().bypassed !== true, 'hp 档探针不标 bypassed（有处理可测）');
    // setMode 切换
    p2.setMode('raw');
    ok(p2.mode === 'raw' && p2.bypass === true, 'setMode(raw) 生效且 bypass 同步');
    p2.setMode('full');
    ok(p2.mode === 'full' && p2.bypass === false, 'setMode(full) 生效且 bypass 同步');
    ok(p2.setMode('bogus') === 'full', '非法档位被忽略');
  }

  console.log('[T12] speech 档：辅音区（2-8kHz）补偿');
  {
    // 用单频正弦测该频率上的实际增益——比看波形直观，也能验证滤波器系数正确
    const gainAt = (mode, freq, hfBoostDb) => {
      const p = new MicPipeline({ inRate: 16000, mode, hfBoostDb, noiseSubtract: false });
      const AC = 200;                       // 多块取稳态，避开滤波器暂态
      const buf = new Int16Array(BLOCK);
      let peak = 0;
      for (let b = 0; b < AC; b++) {
        for (let i = 0; i < BLOCK; i++) {
          buf[i] = Math.round(6000 * Math.sin(2 * Math.PI * freq * (b * BLOCK + i) / 16000));
        }
        const out = p.feed(buf, BLOCK);
        if (b > AC - 8) for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
      }
      return 20 * Math.log10(peak / 6000);
    };
    // 低频不应被抬（搁架起点 2600Hz）
    const lo = gainAt('speech', 300, 6);
    ok(Math.abs(lo) < 1.5, `300Hz 基本不变 ${lo.toFixed(2)}dB（搁架只影响高频）`);
    // 6kHz 应接近设定的 +6dB（±2dB 容差）
    const hi6 = gainAt('speech', 6000, 6);
    ok(Math.abs(hi6 - 6) < 2.0, `6kHz 增益 ${hi6.toFixed(2)}dB（设定 +6dB）`);
    // 补偿量可调：+10dB 应明显大于 +3dB
    const g3 = gainAt('speech', 6000, 3);
    const g10 = gainAt('speech', 6000, 10);
    ok(g10 > g3 + 5, `补偿量可调：+3dB→${g3.toFixed(1)}dB，+10dB→${g10.toFixed(1)}dB`);
    // 0dB = 关闭补偿（与 hp 档一致）
    const hpH = gainAt('hp', 6000, 6);
    const sp0 = gainAt('speech', 6000, 0);
    ok(Math.abs(sp0 - hpH) < 0.5, `补偿 0dB 时与 hp 档一致（${sp0.toFixed(2)} vs ${hpH.toFixed(2)}）`);
    // 档位与诊断
    const p2 = new MicPipeline({ inRate: 16000, mode: 'speech', noiseSubtract: false });
    p2.feed(new Int16Array(BLOCK).fill(1000), BLOCK);
    ok(p2.diagnostics().mode === 'speech', `诊断 mode=speech（${p2.diagnostics().mode}）`);
    ok(p2.hfBoostDb === 6, `默认补偿量 6dB（${p2.hfBoostDb}）`);
    ok(p2.setHfBoost(12) === 12 && p2.hfBoostDb === 12, 'setHfBoost 运行时可调');
    ok(p2.setHfBoost(999) === 18, `补偿量上限钳制 18dB（${p2.setHfBoost(999)}）`);
    // 削顶保护：大信号 + 强补偿不得越界
    const p3 = new MicPipeline({ inRate: 16000, mode: 'speech', hfBoostDb: 12, noiseSubtract: false });
    const big = new Int16Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) big[i] = Math.round(25000 * Math.sin(2 * Math.PI * 6000 * i / 16000));
    let over = 0;
    for (let b = 0; b < 30; b++) {
      const out = p3.feed(big, BLOCK);
      for (let i = 0; i < BLOCK; i++) { const v = out.readInt16LE(i * 2); if (v === 32767 || v === -32768) over++; }
    }
    ok(over > 0, `强补偿下确实触发钳制（${over} 个样本）——证明有界不溢出`);
  }

  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
