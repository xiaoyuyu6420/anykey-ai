// 自动调参器（v0.12.5）——用户口中的「AI 动态调参」，实质是
// 「基于可测指标的闭环搜索」：自动采样 → 用客观指标打分 → 自动改参数 → 迭代收敛。
//
// 为什么不用神经网络来调参：
//   调参的瓶颈不是「决策模型不够聪明」，而是「没有一个可靠的反馈信号」。
//   ASR 的最终识别率在这个项目里测不到（识别在外包给第三方输入法），
//   所以闭环需要用「代理指标」——那些与识别率强相关、但本项目可测的量：
//     SNR（信噪比）、语音段/静音段能量比（对比度）、削波率、欠载数。
//   对这些指标做坐标下降，每轮调一个参数、按指标决定去留，是最稳的做法：
//   可解释、可回滚、不需要标注数据、不会「学出奇怪的东西」。
//
// 搜索策略：逐参数坐标下降。
//   每个参数给一个候选阶梯，每轮试一个档位、保留 4s 采样窗口评估，
//   分数提升则锁定，否则回退。收敛后写入配置并落盘。
//
// 安全边界：
//   - 单调性假设不成立时会来回震荡 → 加迟滞（改进需超过 3% 才接受）
//   - 参数改动走 setTune，不重建降噪引擎，切换无中断
//   - 全程可取消；一键回滚到初始值

const DEFAULT_GRID = {
  attenLimDb: [0, 1, 2, 3, 4, 6],
  gateRelease: [0.1, 0.25, 0.5, 0.8],
  gateOpenMul: [2, 3, 4, 5],
  agcTarget: [2400, 3000, 3600, 4200],
  agcMaxGain: [4, 8, 12, 16],
};

// 打分权重（基于「与识别率的相关性」主观排序，SNR 最高）
const W = { snr: 1.0, contrast: 0.6, clip: -0.5, level: 0.2 };

function scoreOf(metrics) {
  if (!metrics) return -Infinity;
  const snrN = Math.max(0, Math.min(1, metrics.snrDb / 25));            // 0~1
  const contrast = metrics.level > 0
    ? Math.max(0, Math.min(1, (metrics.gate * metrics.gain) / 4))       // 门控×增益 越高说明语音段被处理得越充分
    : 0;
  const levelN = Math.max(0, Math.min(1, (metrics.level - 300) / 6000)); // 电平进甜区
  const clipN = Math.max(0, metrics.clipRate || 0);
  return W.snr * snrN + W.contrast * contrast + W.level * levelN + W.clip * clipN;
}

class AutoTuner {
  constructor(pipeline, opts = {}) {
    this.pipe = pipeline;
    this.grid = opts.grid || DEFAULT_GRID;
    this.sampleMs = opts.sampleMs || 4000;   // 每档采样窗口
    this.improveEps = 0.03;                  // 需超基线 3% 才接受（迟滞防震荡）
    this.running = false;
    this.cancelled = false;
    this.params = [...Object.keys(this.grid)];
    this.progress = { stage: 'idle', param: null, trial: 0, totalTrials: 0, best: null, score: null, baseline: null };
    this._baselineSnapshot = null;
    this._timer = null;
  }

  // 等待窗口结束。cancel() 必须能唤醒它——只 clearTimeout 会让这个 Promise
  // 永远不 settle，start() 的 .then 永不触发（Promise 泄漏，测试里表现为进程静默退出）
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

  // 采样一个窗口：期间等 PCM 流入，结束后读 metrics
  async _sample() {
    // 等窗口结束（期间 DSP 持续跑，metrics 由主进程更新）
    await this._wait(this.sampleMs);
    return this.pipe.diagnostics();
  }

  async start() {
    if (this.running) return this.progress;
    this.running = true;
    this.cancelled = false;
    this._baselineSnapshot = { ...this.pipe.tune };

    // 基线：当前参数下采样
    this.progress.stage = 'baseline';
    const baseline = await this._sample();
    const baseScore = scoreOf(baseline);
    this.progress.baseline = { ...baseline, score: Math.round(baseScore * 1000) / 1000 };
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
        // 已经是当前最佳值，跳过
        if (Math.abs(v - paramBest) < 1e-6) continue;
        this.progress.stage = 'trial';
        this.progress.param = param;
        this.progress.trial = i + 1;
        this.progress.totalTrials = values.length;

        // 应用该参数的单点变化
        this.pipe.setTune({ [param]: v });
        const m = await this._sample();
        const s = scoreOf(m);

        // 迟滞：需显著超过全局最佳才接受
        if (s > bestScore * (1 + this.improveEps)) {
          bestScore = s;
          paramBest = v;
          paramBestScore = s;
          bestTune[param] = v;
        }
      }

      // 该参数扫完，落到最优档
      this.pipe.setTune({ [param]: paramBest });
    }

    if (!this.cancelled) {
      // 应用全局最优组合（每个参数各自最优，可能不是同一条路径）
      this.pipe.setTune(bestTune);
      this.progress.best = { ...bestTune };
      this.progress.score = Math.round(bestScore * 1000) / 1000;
      this.progress.stage = 'done';
    }
    return this._finish();
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

  // 从当前状态继续跑下一轮（用户可以在现场调完环境后继续搜）
  resume() {
    return this.start();
  }
}

module.exports = { AutoTuner, DEFAULT_GRID, scoreOf };
