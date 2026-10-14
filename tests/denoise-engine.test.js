// 降噪引擎回归测试：
//   D1 RNNoise 兜底路径的输出必须回拷（历史上只取 vad，降噪静默变透传——打包版
//      DFN3 加载失败回退 RNNoise 时整条降噪链失效）
//   D2 setDenoise 运行时开关：off 立即旁路；on 重新预热
//   D3 帧异常 → 引擎置空旁路 + 冷却后自动重试恢复
const path = require('path');
const ROOT = path.join(__dirname, '..');

// stub koffi（防 df.js 真加载 dll——本测试用假引擎控制初始化路径）
const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { MicPipeline } = require('../src/main/mic.js');

const BLOCK = 160;
const MAGIC = 1234.5;

function fakeEngines() {
  return {
    df: { init() { throw new Error('stub: 无 df.dll'); }, processFrame() { throw new Error('unreachable'); } },
    rnnoise: { async init() { return true; }, processFrame() { return { out: new Float32Array(BLOCK * 3).fill(MAGIC), vad: 0.9 }; } },
  };
}

(async () => {
  console.log('[D1] RNNoise 输出回拷（修复前 blk 保持原值 = 降噪失效）');
  {
    const p = new MicPipeline({ inRate: 16000 });
    const fakes = fakeEngines();
    p.df = fakes.df;
    p.rnnoise = fakes.rnnoise;
    p.engine = 'rnnoise';
    const blk = new Float32Array(BLOCK).fill(7.7);
    p._denoiseBlock(blk);
    ok(blk[0] === MAGIC && blk[BLOCK - 1] === MAGIC, `blk 被降噪输出覆盖（${blk[0]}）`);
    ok(Math.abs(p.vad - 0.45) < 1e-9, 'vad 照常传递（EMA 平滑：0×0.5+0.9×0.5）');
  }

  console.log('[D2] setDenoise 运行时开关');
  {
    const p = new MicPipeline({ inRate: 16000, denoise: true });
    const fakes = fakeEngines();
    p.df = fakes.df;
    p.rnnoise = fakes.rnnoise;
    p.setDenoise(false);
    ok(p.denoiseWanted === false && p.engine === null, 'off → 立即旁路');
    await sleep(20);
    p.setDenoise(true);
    await sleep(20); // initDenoiser 异步（rnnoise.init 是 async）
    ok(p.engine === 'rnnoise', `on → 重新预热引擎（实得 ${p.engine}）`);
    // off 再来一次：engine 清空
    p.setDenoise(false);
    ok(p.engine === null, '再次 off → 引擎再次旁路');
  }

  console.log('[D3] 帧异常 → 旁路 + 冷却重试恢复');
  {
    const p = new MicPipeline({ inRate: 16000 });
    const boom = { init() { throw new Error('no dll'); }, processFrame() { throw new Error('native boom'); } };
    const good = fakeEngines();
    p.df = boom;
    p.rnnoise = good.rnnoise;
    await p.initDenoiser();
    ok(p.engine === 'rnnoise', '初始引擎 rnnoise');
    // 换成抛异常的实现模拟坏状态
    p.rnnoise = { async init() { return true; }, processFrame() { throw new Error('frame boom'); } };
    const blk = new Float32Array(BLOCK).fill(3.3);
    p._denoiseBlock(blk);
    ok(p.engine === null, '帧异常后引擎置空（不再每帧空转抛）');
    ok(p._denoiseRetryAt > 0, '冷却重试时刻已排定');
    // 冷却期到 → processBlock 自动重试（df 仍炸 → rnnoise 恢复）
    p._denoiseRetryAt = Date.now() - 1;
    const out = p.processBlock(new Float32Array(BLOCK).fill(0));
    await sleep(20);
    ok(p.engine === 'rnnoise', `冷却后自动重试恢复（实得 ${p.engine}）`);
    ok(out.length === BLOCK * 2, 'processBlock 照常出块');
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
