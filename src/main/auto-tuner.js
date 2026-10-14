// 自动调参器（v0.12.6）——闭环搜索：自动采样 → 打分 → 改参数 → 迭代收敛。
//
// ---- 为什么不用神经网络来调参 ----
// 调参的瓶颈不是「决策模型不够聪明」，而是「没有一个可靠的反馈信号」。
// ASR 最终识别率在本项目测不到（识别外包给第三方输入法），所以需要代理指标。
//
// ---- v0.12.6 关键修复：打分函数曾有致命缺陷 ----
// 旧打分只奖励「信号强」（电平高、增益大），**没有任何噪声惩罚项**。
// 结果：调参器发现「少降噪 + 多放大」能让分数变高，于是把 attenLim 调到 1dB
// （几乎不降噪）、把增益拉满——分数显示提升，实际识别效果反而更差。
// 这是典型的奖励函数设计错误：优化了可测量的量，而不是真正想要的量。
//
// 现在改用降噪探针量出的**输出信噪比**做主项：
//   outputSNR = 20·log10(语音段残余 / 静音段残余)
// 它直接对应「人声比底噪高多少」——ASR 真正在意的就是这个量，
// 而它同时对「不降噪」和「过度降噪」双向惩罚：
//   · 不降噪 → 静音段残余高 → SNR 低 → 低分
//   · 过度降噪 → 语音段被一起削 → SNR 也低 → 低分
// 这样最优解才落在真正的平衡点上。
//
// 搜索策略：逐参数坐标下降。每档先重置探针、采够语音+静音样本再读数，
// 避免读到历史累积值。迟滞 3% 防震荡。参数走 setTune 不重建引擎。

// 调参网格。注意 attenLimDb 不含 0——libdf 把 0 当「无限制」而非「不降噪」，
// 混进网格会破坏单调性假设，让坐标下降做出错误判断。
const DEFAULT_GRID = {
  attenLimDb: [2, 4, 6, 8, 12],
  gateRelease: [0.1, 0.25, 0.5],
  gateOpenMul: [2, 2.5, 3, 4],
  agcTarget: [2400, 3000, 3600, 4200],
  agcMaxGain: [8, 16, 32, 64],
};

const MIN_SAMPLES = 25;   // 每个桶至少这么多块才认为采样可信
const SAMPLE_MS = 2500;   // 单调采样窗口
const MAX_SAMPLE_MS = 9000; // 采样不足时的上限（等用户说话）

// 打分：输出 SNR 为主，电平甜区为辅，削波惩罚
function scoreOf(metrics) {
  if (!metrics) return -Infinity;
  const clip = Math.max(0, Math.min(1, metrics.clipRate || 0));
  // 电平进甜区（800~8000 视为理想）
  const lv = metrics.level || 0;
  const levelN = lv <= 0 ? 0
    : lv < 800 ? lv / 800                    // 不够响，线性给分
      : lv <= 8000 ? 1                       // 甜区
        : Math.max(0, 1 - (lv - 8000) / 12000); // 过响

  const p = metrics.probe;
  let snrN = 0, outSnr = 0;
  if (p && p.speech.samples >= MIN_SAMPLES && p.silence.samples >= MIN_SAMPLES) {
    // 语音段残余 vs 静音段残余 —— 降噪后真正送给 ASR 的信噪比
    outSnr = 20 * Math.log10((p.speech.post + 1) / (p.silence.post + 1));
    snrN = Math.max(0, Math.min(1, (outSnr - 2) / 22)); // 2dB→0，24dB→1
  }
  // 采样不足时不给 SNR 分（低分），促使调参器等到有效数据
  return 1.2 * snrN + 0.3 * levelN - 0.5 * clip;
}

class AutoTuner {
  constructor(pipeline, opts = {}) {
    this.pipe = pipeline;
    this.grid = opts.grid || DEFAULT_GRID;
    this.sampleMs = opts.sampleMs || SAMPLE_MS;
    this.improveEps = 0.03;                  // 需超基线 3% 才接受（迟滞防震荡）
    this.running = false;
    this.cancelled = false;
    this.params = Object.keys(this.grid);
    this.progress = {
      stage: 'idle', param: null, trial: 0, totalTrials: 0,
      best: null, score: null, baseline: null, lastSnr: null,
    };
    this._baselineSnapshot = null;
    this._timer = null;
    this._resolveWait = null;
  }

  // 等待窗口结束。cancel() 必须能唤醒它——只 clearTimeout 会让这个 Promise
  // 永远不 settle，start() 的 .then 永不触发（Promise 泄漏）
  _wait(ms) {
    return new Promise(resolve => {
      this._resolveWait = resolve;
      this._timer = setTimeout(() => {
        this._timer = null;
        this._resolveWait = null;
        resolve();
      }, ms);
    });
  }

  // 采一档参数的效果：先重置探针，再等到语音/静音样本都够——
  // 否则读到的是上一档的残留统计，坐标下降会基于错位的反馈做判断
  async _sample() {
    if (this.pipe.resetProbe) this.pipe.resetProbe();
    const start = Date.now();
    let m = this.pipe.diagnostics();
    while (!this.cancelled) {
      const p = m && m.probe;
      const enough = p && p.speech.samples >= MIN_SAMPLES && p.silence.samples >= MIN_SAMPLES;
      const elapsed = Date.now() - start;
      if (enough && elapsed >= this.sampleMs) break;
      if (elapsed >= MAX_SAMPLE_MS) break; // 用户一直不说话：不无限等，用现有数据
      await this._wait(250);
      m = this.pipe.diagnostics();
    }
    return m;
  }

  async start() {
    if (this.running) return this.progress;
    this.running = true;
    this.cancelled = false;
    this._baselineSnapshot = { ...this.pipe.tune };

    // 基线：当前参数下的表现
    this.progress.stage = 'baseline';
    const baseline = await this._sample();
    const baseScore = scoreOf(baseline);
    this.progress.baseline = { ...baseline, score: Math.round(baseScore * 1000) / 1000 };
    this.progress.lastSnr = this._snrOf(baseline);
    if (this.cancelled) return this._finish();

    let bestTune = { ...this.pipe.tune };
    let bestScore = baseScore;

    for (const param of this.params) {
      if (this.cancelled) break;
      const values = this.grid[param];
      let paramBest = this.pipe.tune[param];
      let paramBestScore = bestScore;

      for (let i = 0; i < values.length; i++) {
        if (this.cancelled) break;
        const v = values[i];
        if (Math.abs(v - paramBest) < 1e-6) continue;
        this.progress.stage = 'trial';
        this.progress.param = param;
        this.progress.trial = i + 1;
        this.progress.totalTrials = values.length;

        this.pipe.setTune({ [param]: v });
        const m = await this._sample();
        const s = scoreOf(m);
        this.progress.lastSnr = this._snrOf(m);

        // 迟滞：需显著超过当前最佳才接受
        if (s > bestScore * (1 + this.improveEps)) {
          bestScore = s;
          paramBest = v;
          paramBestScore = s;
          bestTune[param] = v;
        }
      }
      this.pipe.setTune({ [param]: paramBest });
    }

    if (!this.cancelled) {
      this.pipe.setTune(bestTune);
      this.progress.best = { ...bestTune };
      this.progress.score = Math.round(bestScore * 1000) / 1000;
      this.progress.stage = 'done';
    }
    return this._finish();
  }

  _snrOf(m) {
    const p = m && m.probe;
    if (!p || !p.speech.samples || !p.silence.samples) return null;
    return Math.round(20 * Math.log10((p.speech.post + 1) / (p.silence.post + 1)) * 10) / 10;
  }

  cancel() {
    this.cancelled = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    // 唤醒正在 await 的 _wait，否则 start() 的 Promise 永不 settle
    if (this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
      r();
    }
    this.progress.stage = 'cancelled';
  }

  rollback() {
    if (this._baselineSnapshot) this.pipe.setTune(this._baselineSnapshot);
    return this._baselineSnapshot;
  }

  _finish() {
    this.running = false;
    this._timer = null;
    return this.progress;
  }
}

module.exports = { AutoTuner, DEFAULT_GRID, scoreOf, MIN_SAMPLES };
