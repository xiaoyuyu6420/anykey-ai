// 稳态噪声扣除 + 自动调参器 回归测试（v0.12.5）：
//   N1 学习期只建模不扣（不会一开始就把信号削掉）
//   N2 学完后的稳态噪声被显著压低（这是「底噪偏高」的核心诉求）
//   N3 语音段不被误伤（谱底限保护 + 学习期避开语音）
//   N4 过减系数越大压得越狠，且有上界（不能把信号全削没）
//   N5 relearn 重置学习状态
//   A1 打分函数：SNR 高分、削波扣分
//   A2 坐标下降能收敛到更优组合，且不震荡（迟滞生效）
//   A3 取消/回滚安全
const path = require('path');
const ROOT = path.join(__dirname, '..');

const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const { NoiseSubtractor } = require('../src/main/noise-profile.js');
const { AutoTuner, scoreOf } = require('../src/main/auto-tuner.js');
const BLOCK = 160;

// 确定性伪随机（保证测试可复现）
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 稳态噪声：白噪 + 60Hz 交流声（模拟麦自噪 + 电源哼声）
function makeNoise(seed, amp = 300) {
  const rnd = mulberry(seed);
  const n = BLOCK;
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = (rnd() * 2 - 1) * amp * 0.4;
    const h = Math.sin(2 * Math.PI * 60 * i / 16000) * amp * 0.6;
    b[i] = w + h;
  }
  return b;
}

// 语音：300Hz 基频 + 谐波，包络起伏
function makeSpeech(seed, amp = 4000, blocks = BLOCK) {
  const rnd = mulberry(seed);
  const b = new Float32Array(blocks);
  for (let i = 0; i < blocks; i++) {
    const t = i / 16000;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    b[i] = env * amp * (
      0.5 * Math.sin(2 * Math.PI * 300 * t) +
      0.3 * Math.sin(2 * Math.PI * 700 * t) +
      0.2 * Math.sin(2 * Math.PI * 1300 * t) +
      0.05 * (rnd() * 2 - 1)
    );
  }
  return b;
}

const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

(async () => {
  console.log('[N1] 学习期只建模不扣除');
  {
    const ns = new NoiseSubtractor();
    const before = [];
    for (let b = 0; b < 100; b++) { const blk = makeNoise(1000 + b); before.push(rms(blk)); ns.processBlock(blk); }
    const d = ns.diagnostics();
    ok(d.ready === true, `学满 ${d.learned} 帧后 ready（${d.ready}）`);
    ok(d.noisePeak > 0, `噪声谱非空（peak=${d.noisePeak.toFixed(1)}）`);
    ok(d.reductionDb === 0, '学习期内不做扣除（reductionDb=0）');
  }

  console.log('[N2] 稳态噪声被显著压低（核心诉求）');
  {
    const ns = new NoiseSubtractor();
    for (let b = 0; b < 150; b++) ns.processBlock(makeNoise(2000 + b)); // 预学习
    const inRms = [], outRms = [];
    for (let b = 0; b < 40; b++) {
      const blk = makeNoise(3000 + b);
      inRms.push(rms(blk));
      ns.processBlock(blk);
      outRms.push(rms(blk));
    }
    const ri = rms(inRms), ro = rms(outRms);
    ok(ro < ri * 0.6, `底噪压到 ${(ro / ri * 100).toFixed(0)}%（${ri.toFixed(0)} → ${ro.toFixed(0)}）`);
    const d = ns.diagnostics();
    ok(d.reductionDb > 2, `报告降噪量 ${d.reductionDb}dB`);
  }

  console.log('[N3] 语音段不被误伤');
  {
    const ns = new NoiseSubtractor();
    // 学底噪
    for (let b = 0; b < 150; b++) { const blk = makeNoise(4000 + b); ns.processBlock(blk); }
    // 语音+噪声混合进来
    const inRms = [], outRms = [];
    let seed = 99;
    for (let b = 0; b < 30; b++) {
      const sp = makeSpeech(seed++, 4000);
      const nz = makeNoise(5000 + b, 300);
      const mix = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) mix[i] = sp[i] + nz[i];
      inRms.push(rms(mix));
      ns.processBlock(mix);
      outRms.push(rms(mix));
    }
    const ri = rms(inRms), ro = rms(outRms);
    ok(ro > ri * 0.5, `语音+噪声混合信号保留 ${(ro / ri * 100).toFixed(0)}%（不塌）`);
    ok(ro > 1000, `语音段电平仍充足（${ro.toFixed(0)}）`);
  }

  console.log('[N4] 过减系数单调且有界');
  {
    const mk = overSub => {
      const ns = new NoiseSubtractor({ overSub });
      for (let b = 0; b < 150; b++) ns.processBlock(makeNoise(6000 + b));
      const outs = [];
      for (let b = 0; b < 20; b++) { const blk = makeNoise(7000 + b); ns.processBlock(blk); outs.push(rms(blk)); }
      return rms(outs);
    };
    const r1 = mk(1), r3 = mk(3), r6 = mk(6);
    ok(r3 < r1, `过减 3 < 过减 1（${r3.toFixed(0)} < ${r1.toFixed(0)}）`);
    ok(r6 < r3, `过减 6 < 过减 3（${r6.toFixed(0)} < ${r3.toFixed(0)}）`);
    ok(r6 > 0, `过减 6 不把信号全削没（${r6.toFixed(0)}）`);
    // 谱底限保护：floorDb 越大（如 -6dB）下限越高 → 压得越少 → 残留越多；
    // floorDb 越小（如 -40dB）能压更狠 → 残留越少
    const ns2 = new NoiseSubtractor({ floorDb: -40 });
    for (let b = 0; b < 150; b++) ns2.processBlock(makeNoise(8000 + b));
    const outs2 = [];
    for (let b = 0; b < 20; b++) { const blk = makeNoise(9000 + b); ns2.processBlock(blk); outs2.push(rms(blk)); }
    const ns3 = new NoiseSubtractor({ floorDb: -6 });
    for (let b = 0; b < 150; b++) ns3.processBlock(makeNoise(8000 + b));
    const outs3 = [];
    for (let b = 0; b < 20; b++) { const blk = makeNoise(9000 + b); ns3.processBlock(blk); outs3.push(rms(blk)); }
    ok(rms(outs2) < rms(outs3), `谱底 -40dB 压得更狠（残留 ${rms(outs2).toFixed(0)} < 谱底 -6dB 的 ${rms(outs3).toFixed(0)}）`);
  }

  console.log('[N5] relearn 重置');
  {
    const ns = new NoiseSubtractor();
    for (let b = 0; b < 150; b++) ns.processBlock(makeNoise(100 + b));
    ok(ns.diagnostics().ready === true, '预置为已学习');
    ns.reset();
    const d = ns.diagnostics();
    ok(d.learned === 0 && d.ready === false && d.learning === true, 'reset 后回到学习期');
  }

  console.log('[A1] 打分函数');
  {
    const good = scoreOf({ snrDb: 20, level: 3000, gate: 1, gain: 4, clipRate: 0 });
    const bad = scoreOf({ snrDb: 3, level: 200, gate: 0.1, gain: 1, clipRate: 0 });
    const clip = scoreOf({ snrDb: 20, level: 3000, gate: 1, gain: 4, clipRate: 0.3 });
    ok(good > bad, `好配置分更高（${good.toFixed(2)} > ${bad.toFixed(2)}）`);
    ok(clip < good, `削波扣分（${clip.toFixed(2)} < ${good.toFixed(2)}）`);
    ok(scoreOf(null) === -Infinity, 'null → -Infinity');
  }

  console.log('[A2] 坐标下降收敛到更优组合');
  {
    // 假管线：metrics 由 tune 的「理想值」驱动——越接近 target 分数越高
    const target = { attenLimDb: 2, gateRelease: 0.25, gateOpenMul: 3, agcTarget: 3600, agcMaxGain: 8 };
    const fake = {
      tune: { attenLimDb: 6, gateRelease: 0.04, gateOpenMul: 5, agcTarget: 4200, agcMaxGain: 8 },
      _st: null,
      setTune(p) { Object.assign(this.tune, p); return this.tune; },
      diagnostics() {
        // 距离 target 越近，SNR 越高（模拟真实相关性）
        let d = 0;
        for (const k of Object.keys(target)) d += Math.abs(Math.log((this.tune[k] + 1) / (target[k] + 1)));
        return { snrDb: Math.max(0, 25 - d * 8), level: 3000, gate: 1, gain: this.tune.agcMaxGain / 2, clipRate: 0 };
      },
    };
    const tuner = new AutoTuner(fake, { sampleMs: 1 });
    const prog = await tuner.start();
    ok(prog.stage === 'done', `跑完（${prog.stage}）`);
    ok(prog.score > prog.baseline.score, `分数提升（${prog.baseline.score} → ${prog.score}）`);
    ok(fake.tune.attenLimDb === 2, `attenLim 收敛到 ${fake.tune.attenLimDb}（目标 2）`);
    ok(fake.tune.gateRelease === 0.25, `gateRelease 收敛到 ${fake.tune.gateRelease}（目标 0.25）`);
    ok(fake.tune.gateOpenMul === 3, `gateOpenMul 收敛到 ${fake.tune.gateOpenMul}（目标 3）`);
    ok(fake.tune.agcTarget === 3600, `agcTarget 收敛到 ${fake.tune.agcTarget}（目标 3600）`);
  }

  console.log('[A3] 取消与回滚');
  {
    const fake = {
      tune: { attenLimDb: 3, gateRelease: 0.25, gateOpenMul: 3, agcTarget: 3600, agcMaxGain: 8 },
      setTune(p) { Object.assign(this.tune, p); return this.tune; },
      diagnostics() { return { snrDb: 15, level: 3000, gate: 1, gain: 2, clipRate: 0 }; },
    };
    const tuner = new AutoTuner(fake, { sampleMs: 1 });
    const p = tuner.start();
    tuner.cancel();
    await p;
    ok(tuner.running === false, '取消后 running=false');
    const before = { ...fake.tune };
    fake.tune.attenLimDb = 9;
    const rb = tuner.rollback();
    ok(fake.tune.attenLimDb === before.attenLimDb, `回滚恢复 attenLim=${rb.attenLimDb}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
