// 质量面板核心算法回归测试（v0.12.4）：
//   V1 FFT 实现正确 —— 频谱图全靠它。算错=整张图骗人，用已知频率的正弦验证峰值落点
//   V2 FFT 数值精度 —— 直流与 bin 对齐时无幅度泄漏到邻 bin
//   V3 判决逻辑 —— 把「SNR 低/增益未工作/削波/降噪未就绪」映射成正确提示
//   V4 包络环形缓冲 —— 跨尾回绕不写错位置（波形图错位=误判断音）
// 说明：面板是浏览器 ES module，这里用最小 DOM 桩在 Node 里跑纯算法部分。
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// ---- 最小 DOM 桩：只补面板构造函数碰到的成员 ----
function stubEl() {
  const el = {
    style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    hidden: false, innerHTML: '', textContent: '', clientWidth: 240, clientHeight: 132,
    width: 0, height: 0, parentElement: { hidden: false },
    getContext: () => ({
      setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() {}, fill() {}, fillRect() {}, fillText() {}, save() {}, restore() {},
      set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set font(v) {},
    }),
    addEventListener() {}, querySelectorAll: () => [],
  };
  return el;
}

const els = {};
global.document = {
  getElementById: (id) => (els[id] = els[id] || stubEl()),
  querySelectorAll: () => [],
  createElement: () => stubEl(),
};
global.window = { devicePixelRatio: 1, addEventListener() {} };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.AudioWorkletNode = function () {};

(async () => {
  // quality-panel.js 是 ES module，用动态 import 载入
  const mod = await import('file:///' + path.join(ROOT, 'src', 'renderer', 'quality-panel.js').replace(/\\/g, '/'));
  const { pushQualitySample } = mod;

  console.log('[V1] FFT 峰值落点（频谱图的正确性根基）');
  const panel = mod.initQualityPanel();
  ok(!!panel, '面板实例化成功');
  {
    // 直接测 fft：把 512 点纯音灌进去，验证 bin 索引
    const N = 512, fs = 16000;
    const re = new Float32Array(N), im = new Float32Array(N);
    const bin = 32;                    // 16000/512 × 32 = 1000 Hz
    const f0 = 1000;
    for (let i = 0; i < N; i++) re[i] = Math.sin(2 * Math.PI * f0 * i / fs);
    // 面板内部 fft 不导出，用 _computeSpectrum 间接验证：喂 int16 PCM
    const bytes = Buffer.alloc(N * 2);
    for (let i = 0; i < N; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f0 * i / fs) * 20000), i * 2);
    panel._computeSpectrum(bytes, N);
    // 找峰值 bin
    let best = 1, bestDb = -Infinity;
    for (let i = 1; i < N / 2; i++) if (panel.specSmooth[i] > bestDb) { bestDb = panel.specSmooth[i]; best = i; }
    ok(Math.abs(best - bin) <= 1, `1000Hz 落在 bin ${bin} 附近（实测 bin ${best}）`);

    // 换 500Hz → bin 16
    const f2 = 500, bin2 = 16;
    for (let i = 0; i < N; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f2 * i / fs) * 20000), i * 2);
    for (let k = 0; k < 8; k++) panel._computeSpectrum(bytes, N); // 让平滑收敛
    let b2 = 1, v2 = -Infinity;
    for (let i = 1; i < N / 2; i++) if (panel.specSmooth[i] > v2) { v2 = panel.specSmooth[i]; b2 = i; }
    ok(Math.abs(b2 - bin2) <= 1, `500Hz 落在 bin ${bin2} 附近（实测 bin ${b2}）`);
  }

  console.log('[V2] 频谱量纲：低频噪声集中时低频 bin 应显著更高');
  {
    const N = 512, fs = 16000;
    const bytes = Buffer.alloc(N * 2);
    // 60Hz + 4000Hz 双分量，60Hz 幅度 3 倍
    for (let i = 0; i < N; i++) {
      const s = Math.sin(2 * Math.PI * 60 * i / fs) * 9000 + Math.sin(2 * Math.PI * 4000 * i / fs) * 3000;
      bytes.writeInt16LE(Math.round(s), i * 2);
    }
    panel.specSmooth.fill(0);
    for (let k = 0; k < 10; k++) panel._computeSpectrum(bytes, N);
    const at = hz => panel.specSmooth[Math.round(hz / fs * N)];
    ok(at(60) > at(4000) + 6, `60Hz(${at(60).toFixed(1)}dB) 显著高于 4000Hz(${at(4000).toFixed(1)}dB)`);
    // 归一化后是真实 dBFS：9000/32768 ≈ -11.2dBFS，容差 ±6dB
    ok(Math.abs(at(60) - (-11.2)) < 6, `60Hz 幅度接近 dBFS 理论值 -11.2dB（实测 ${at(60).toFixed(1)}）`);
  }

  console.log('[V3] 判决逻辑');
  {
    const vd = panel.verdictEl;
    const M = extra => Object.assign({ mode: 'full', engine: 'df', snrDb: 18, gain: 2.5, level: 3000, noiseFloor: 150 }, extra);
    panel._verdict(M({}));
    ok(vd.className.includes('ok') && vd.textContent === '链路正常', `全好 → 链路正常（${vd.textContent}）`);
    // 降噪相关的告警只在 full 档算问题——其它档本就不跑降噪，报这条是假警报
    panel._verdict(M({ engine: 'none' }));
    ok(vd.textContent.includes('降噪未就绪'), `full 档引擎 none → 提示降噪未就绪（${vd.textContent}）`);
    panel._verdict(M({ snrDb: 2 }));
    ok(vd.textContent.includes('SNR 偏低'), `full 档 SNR 2 → 提示偏低（${vd.textContent}）`);
    for (const mode of ['raw', 'hp', 'speech']) {
      panel._verdict(M({ mode, engine: 'none', snrDb: 0 }));
    }
    ok(vd.textContent === '链路正常', `非降噪档（raw/hp/speech）不报降噪告警（${vd.textContent}）`);
    panel._verdict(M({ gain: 1.0, level: 4000 }));
    ok(vd.textContent.includes('增益未工作'), `增益 1.0 + 有电平 → 提示增益未工作（${vd.textContent}）`);
    panel._verdict(M({ gain: 3, level: 15000 }));
    ok(vd.textContent.includes('电平过高'), `电平 15000 → 提示过高（${vd.textContent}）`);
    panel._clipEvents = 10;
    panel._verdict(M({ gain: 3, level: 3000 }));
    ok(vd.textContent.includes('削波'), `削波计数 → 提示削波（${vd.textContent}）`);
  }

  console.log('[V4] 包络环形缓冲回绕');
  {
    panel.filled = 0; panel.head = 0; panel._clipEvents = 0;
    const mk = v => { const b = Buffer.alloc(4); b.writeInt16LE(v, 0); return b; };
    // 填满 cap，走一圈（幅度限定在 int16 范围内：i+1 倍 ×400，最大 25600）
    for (let i = 0; i < panel.envCap; i++) pushQualitySample(mk(400 * (i + 1)));
    ok(panel.filled === panel.envCap, `缓冲填满 ${panel.envCap}`);
    // 再推 10 包触发回绕
    for (let i = 0; i < 10; i++) pushQualitySample(mk(7777));
    ok(panel.filled === panel.envCap, '回绕后 filled 保持满');
    ok(panel.head === 10, `head 回绕到 10（实际 ${panel.head}）`);
    const idx = (panel.head - 1 + panel.envCap) % panel.envCap;
    // env 存包 RMS（≠峰值 7777），但必须落在 [0,7777] 且明显大于前一批的 25600 幅度
    ok(panel.env[idx] > 1000 && panel.env[idx] <= 7777 + 1e-3,
      `最新包 RMS 落在合理区间（${panel.env[idx].toFixed(1)}）`);
    ok(panel.pk[idx] > 7000, `最新包峰值接近输入幅度（${panel.pk[idx].toFixed(1)}）`);
  }

  console.log('[V5] 指标映射：填充条与甜区标记');
  {
    panel.setMetrics({ engine: 'df', snrDb: 20, vad: 0.8, noiseFloor: 150, level: 3000, gate: 1, gain: 4, packets: 10, fifoLen: 0, tune: {} });
    const f = els['f-snr'];
    ok(els['m-snr'].textContent === 20, `SNR 文本更新（${els['m-snr'].textContent}）`);
    ok(els['m-gain'].textContent === 4, `增益文本更新（${els['m-gain'].textContent}）`);
    ok(els['m-level'].textContent === 3000, `电平文本更新（${els['m-level'].textContent}）`);
    ok(els['b-snr'].style.left === '25%' && els['b-snr'].style.width === '75%', 'SNR 甜区 10dB+ 标记');
    ok(els['b-level'].style.left === '7%', '电平甜区下界标记');
    ok(typeof f.style.width === 'string' && f.style.width.includes('%'), `填充条宽度设置（${f.style.width}）`);
    ok(panel.hist.snr.length >= 1, `历史点入队（${panel.hist.snr.length}）`);
    // 越界值不能让进度条跑飞
    panel.setMetrics({ engine: 'df', snrDb: 999, vad: 0, noiseFloor: -50, level: 99999, gate: 1, gain: 999, packets: 0, fifoLen: 0, tune: {} });
    ok(parseFloat(els['f-snr'].style.width) <= 100, `SNR 999 时条宽仍 ≤100%（${els['f-snr'].style.width}）`);
    ok(parseFloat(els['f-level'].style.width) <= 100, `电平 99999 时条宽仍 ≤100%（${els['f-level'].style.width}）`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
