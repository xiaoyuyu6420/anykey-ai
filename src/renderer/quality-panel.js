// 音频质量可视化面板（v0.12.4）
//
// 数据源刻意选主进程推来的 PCM —— 与最终送进 ASR 的是同一份数据，
// 所以这里看到的波形/频谱就是识别引擎真正收到的东西，不做二次处理美化。
//
// 三个视图各回答一个问题：
//   波形   —— 有没有断音（空洞）/ 削波（贴顶贴底）
//   指标   —— AGC 有没有在工作、底噪高不高、电平是否落在 ASR 甜区
//   频谱   —— 噪声集中在哪段频率，降噪有没有把该压的压下去
//
// 渲染节奏：PCM 每 120ms 一批，但画布只需 ~25fps 重绘，指标 ~4Hz 采样。
// 频谱用 512 点 Hann 窗 FFT（自实现，无依赖）。

const FFT_N = 512;
// 未归一化 FFT 的单音峰值幅度 ≈ (N/2)·A·coherentGain，Hann 窗 coherentGain≈0.5，
// 合计 N/4。不除的话频谱 dB 会整体偏高 20log10(N/4)≈48dB，显示的不是真实 dBFS。
const FFT_SCALE = 4 / FFT_N;

// ---- 极小 FFT（radix-2 迭代版，输入输出均为 Float32Array(FFT_N)） ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function dbfs(v) {
  return v > 0 ? Math.max(0, 20 * Math.log10(v / 32768)) : -Infinity;
}

class QualityPanel {
  constructor() {
    this.canvas = document.getElementById('qc-canvas');
    if (!this.canvas) return;
    this.ctx2d = this.canvas.getContext('2d');
    this.legend = document.getElementById('qc-legend');
    this.verdictEl = document.getElementById('qc-verdict');
    this.hintEl = document.getElementById('qc-hint');
    this.metricsEl = document.getElementById('qc-metrics');
    this.view = 'wave';
    this.tabEls = Array.from(document.querySelectorAll('.qc-tab'));

    // 滚动波形缓冲：环形存最近 8 秒的包络（约 64 个 120ms 包）
    this.envCap = 64;
    this.env = new Float32Array(this.envCap);      // 每包 RMS
    this.peakCap = 64;
    this.pk = new Float32Array(this.peakCap);       // 每包峰值
    this.head = 0; this.filled = 0;

    // 频谱（dB，0~8kHz 对应 16k 采样率）
    this.spec = new Float32Array(FFT_N / 2);
    this.specSmooth = new Float32Array(FFT_N / 2);
    this.fftRe = new Float32Array(FFT_N);
    this.fftIm = new Float32Array(FFT_N);
    this.hann = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) this.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));

    // 指标历史（sparkline），各 60 点 ≈ 15s @4Hz
    this.hist = { snr: [], gain: [], level: [], noise: [] };
    this.histCap = 60;
    this.last = null;
    this._lastMetricsAt = 0;
    this._lastDrawAt = 0;
    this._raf = null;
    this._specDirty = false;
    this._lastSpecAt = 0;
    this._seenAudio = false;
    this._clipEvents = 0;

    this._bindTabs();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._loop();
    this._pollMetrics();
    this._setLegend();
  }

  _bindTabs() {
    for (const t of this.tabEls) {
      t.onclick = () => {
        for (const o of this.tabEls) o.classList.toggle('on', o === t);
        this.view = t.dataset.view;
        const isMetric = this.view === 'metric';
        this.metricsEl.hidden = !isMetric;
        this.canvas.parentElement.hidden = isMetric;
        this._setLegend();
        this._draw();
      };
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 132;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.dpr = dpr;
    this.cw = w; this.ch = h;
  }

  _setLegend() {
    if (!this.legend) return;
    const sets = {
      wave: `<span><i class="qc-dot" style="background:#4f8cff"></i>波形包络</span>
             <span><i class="qc-dot" style="background:#ff5d6c"></i>削波区（贴顶/贴底）</span>
             <span><i class="qc-dot" style="background:#8a93a8"></i>空洞=断音</span>`,
      spectrum: `<span><i class="qc-dot" style="background:#3ecf8e"></i>0–8kHz 频谱</span>
             <span><i class="qc-dot" style="background:#ffb224"></i>300Hz 以下=环境低频噪声</span>`,
      metric: '',
    };
    this.legend.innerHTML = sets[this.view] || '';
    this.legend.style.display = this.view === 'metric' ? 'none' : '';
  }

  // ---- PCM 入口：与送进 worklet 的同一批数据 ----
  push(bytes) {
    if (!this.canvas || !bytes || !bytes.length) return;
    const n = bytes.length >> 1;
    let sum = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const v = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / n);
    this.env[this.head] = rms;
    this.pk[this.head] = peak;
    this.head = (this.head + 1) % this.envCap;
    if (this.filled < this.envCap) this.filled++;
    this._seenAudio = true;
    if (peak > 32000) this._clipEvents++;

    // 频谱：仅在切换到频谱视图时才算，省掉无谓开销
    if (this.view === 'spectrum' && performance.now() - this._lastSpecAt > 80) {
      this._lastSpecAt = performance.now();
      this._computeSpectrum(bytes, n);
    }
  }

  _computeSpectrum(bytes, n) {
    // 取尾部 FFT_N 个样本，不足则补零
    const off = Math.max(0, n - FFT_N);
    const len = n - off;
    for (let i = 0; i < FFT_N; i++) {
      const s = i < len ? (bytes[(off + i) * 2] | (bytes[(off + i) * 2 + 1] << 8)) << 16 >> 16 : 0;
      this.fftRe[i] = (s / 32768) * this.hann[i];
      this.fftIm[i] = 0;
    }
    fft(this.fftRe, this.fftIm);
    for (let i = 0; i < FFT_N / 2; i++) {
      const mag = Math.hypot(this.fftRe[i], this.fftIm[i]) * FFT_SCALE;
      const db = 20 * Math.log10(mag + 1e-9);
      // 时间平滑（0.7 旧 + 0.3 新），避免谱线跳动难读
      this.specSmooth[i] = this.specSmooth[i] * 0.7 + db * 0.3;
    }
  }

  // ---- 指标轮询：主进程 DSP 快照 ----
  async _pollMetrics() {
    if (!window.aikey || typeof window.aikey.micDiagnostics !== 'function') return;
    try {
      const d = await window.aikey.micDiagnostics();
      if (d) this.setMetrics(d);
    } catch (_) {}
    setTimeout(() => this._pollMetrics(), 250);
  }

  setMetrics(d) {
    this.last = d;
    const pushH = (k, v) => { const a = this.hist[k]; a.push(v); if (a.length > this.histCap) a.shift(); };
    pushH('snr', d.snrDb); pushH('gain', d.gain); pushH('level', d.level); pushH('noise', d.noiseFloor);

    const set = (id, txt, pct, color, bandPct) => {
      const v = document.getElementById(id);
      if (v) v.textContent = txt;
    };
    // SNR：0~40dB 映射 0~100%，10dB 为语音判定线
    set('m-snr', d.snrDb, null);
    set('m-gain', d.gain, null);
    set('m-level', d.level, null);
    set('m-noise', d.noiseFloor, null);
    const fill = (id, pct, color) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.width = Math.max(0, Math.min(100, pct)) + '%';
      el.style.background = color;
    };
    fill('f-snr', d.snrDb / 40 * 100, d.snrDb >= 10 ? 'var(--ok)' : d.snrDb >= 5 ? 'var(--warn)' : 'var(--err)');
    fill('f-gain', d.gain / 16 * 100, d.gain >= 1.5 ? 'var(--accent)' : 'var(--muted)');
    fill('f-level', d.level / 12000 * 100, (d.level > 800 && d.level < 8000) ? 'var(--ok)' : 'var(--warn)');
    fill('f-noise', d.noiseFloor / 400 * 100, d.noiseFloor > 300 ? 'var(--err)' : 'var(--muted)');
    // 甜区标记
    const band = (id, l, r) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.left = l + '%'; el.style.width = (r - l) + '%';
    };
    band('b-snr', 25, 100);   // ≥10dB
    band('b-gain', 9, 100);   // ≥1.5×
    band('b-level', 7, 67);   // 800~8000
    band('b-noise', 0, 25);   // <100

    this._spark('spark-snr', this.hist.snr, -20, 40);
    this._spark('spark-gain', this.hist.gain, 0, 16);
    this._spark('spark-level', this.hist.level, 0, 12000);
    this._spark('spark-noise', this.hist.noise, 0, 400);

    this._verdict(d);
    this._renderDiag(d);
    if (this.view === 'metric') this._draw();
  }

  // 底噪诊断：把探针的「降噪前/后/压制/信噪比提升」摆出来，替用户下结论。
  // 关键指标是「信噪比提升」——降噪量好看但人声被一起压掉等于白压（实测教训）
  _renderDiag(d) {
    const p = d.probe;
    const el = (id) => document.getElementById(id);
    const vEl = el('diag-verdict'), advEl = el('diag-advice');
    const preEl = el('diag-pre'), postEl = el('diag-post');
    const cutEl = el('diag-cut'), snrEl = el('diag-snr');
    if (!p || !vEl || !preEl || !postEl || !cutEl || !snrEl || !advEl) return;
    const s = p.silence;
    preEl.innerHTML = `${s.pre}<small>RMS</small>`;
    postEl.innerHTML = `${s.post}<small>RMS</small>`;
    cutEl.innerHTML = `${s.cutDb}<small>dB</small>`;
    const g = p.snrGainDb;
    snrEl.innerHTML = `<span style="color:${g >= 6 ? 'var(--ok)' : g >= 2 ? 'var(--warn)' : 'var(--err)'}">${g > 0 ? '+' : ''}${g}<small>dB</small></span>`;
    vEl.textContent = p.verdict;
    vEl.className = 'qc-verdict ' + (
      p.verdict === '信噪比显著改善' ? 'ok'
        : p.verdict === '信噪比略有改善' ? 'warn'
          : p.verdict === '信噪比几乎没改善' ? 'err' : ''
    );
    advEl.textContent = p.advice;
  }

  _spark(id, arr, min, max) {
    const cv = document.getElementById(id);
    if (!cv || !arr.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 120, h = 34;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const n = Math.min(arr.length, this.histCap);
    g.strokeStyle = '#4f8cff';
    g.lineWidth = 1.4;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (this.histCap - 1)) * w;
      const v = Math.max(min, Math.min(max, arr[arr.length - n + i]));
      const y = h - ((v - min) / (max - min)) * h;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }

  _verdict(d) {
    if (!this.verdictEl) return;
    const problems = [];
    if (d.engine === 'none') problems.push('降噪未就绪');
    if (d.snrDb > 0 && d.snrDb < 5) problems.push('SNR 偏低');
    if (d.gain <= 1.05 && d.level > 200) problems.push('增益未工作');
    if (d.level > 12000) problems.push('电平过高');
    if (this._clipEvents > 3) problems.push('削波');
    let cls = 'ok', txt = '链路正常';
    if (problems.length) {
      cls = problems.length > 2 ? 'err' : 'warn';
      txt = problems.join(' · ');
    }
    this.verdictEl.textContent = txt;
    this.verdictEl.className = 'qc-verdict ' + cls;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    if (now - this._lastDrawAt < 40) return; // ~25fps
    this._lastDrawAt = now;
    this._draw();
  }

  _draw() {
    if (!this.canvas || this.view === 'metric') return;
    const g = this.ctx2d;
    const w = this.cw, h = this.ch;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (this.view === 'wave') this._drawWave(g, w, h);
    else this._drawSpectrum(g, w, h);
  }

  _drawWave(g, w, h) {
    const mid = h / 2;
    // 0dB 参考线与 -6dB 线
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      g.beginPath(); g.moveTo(0, h * frac); g.lineTo(w, h * frac); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.1)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();

    if (!this.filled) {
      g.fillStyle = 'rgba(138,147,168,.7)';
      g.font = '11px "Segoe UI", sans-serif';
      g.fillText('等待音频…按住开麦键说话', 10, mid + 4);
      return;
    }

    const n = this.filled;
    const dw = w / (this.envCap - 1);
    const scale = (h / 2 - 4) / 32768;
    // 包络（对称 RMS）
    g.strokeStyle = '#4f8cff';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.envCap) % this.envCap;
      const y = this.env[idx] * scale;
      const x = (i + (this.envCap - n)) * dw;
      g.moveTo(x, mid - y); g.lineTo(x, mid + y);
    }
    g.stroke();
    // 峰值线
    g.strokeStyle = 'rgba(126,224,163,.75)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.envCap) % this.envCap;
      const y = this.pk[idx] * scale;
      const x = (i + (this.envCap - n)) * dw;
      g.moveTo(x, mid - y); g.lineTo(x, mid + y);
    }
    g.stroke();
    // 削波区（贴顶/贴底红条）
    g.fillStyle = 'rgba(255,93,108,.55)';
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.envCap) % this.envCap;
      if (this.pk[idx] > 32000) {
        const x = (i + (this.envCap - n)) * dw;
        g.fillRect(x, 0, Math.max(1, dw), 3);
        g.fillRect(x, h - 3, Math.max(1, dw), 3);
      }
    }
  }

  _drawSpectrum(g, w, h) {
    const N = FFT_N / 2;
    const maxHz = 8000;
    g.fillStyle = 'rgba(138,147,168,.7)';
    g.font = '10px "Segoe UI", sans-serif';
    g.fillText('0', 2, h - 3);
    g.fillText('4k', w / 2 - 6, h - 3);
    g.fillText('8kHz', w - 22, h - 3);
    // 300Hz 以下低频噪声带
    const x300 = (300 / maxHz) * w;
    g.fillStyle = 'rgba(255,178,36,.07)';
    g.fillRect(0, 0, x300, h);
    g.strokeStyle = 'rgba(255,178,36,.35)';
    g.beginPath(); g.moveTo(x300, 0); g.lineTo(x300, h); g.stroke();

    let maxDb = -100;
    for (let i = 1; i < N; i++) if (this.specSmooth[i] > maxDb) maxDb = this.specSmooth[i];
    if (maxDb < -99) {
      g.fillStyle = 'rgba(138,147,168,.7)';
      g.fillText('等待音频…', 10, h / 2);
      return;
    }
    // 纵轴固定为 dBFS：顶 0dB、底 -80dB（低于 -80 基本是静音，抬高只会压缩动态范围）
    const top = 0, bot = -80;
    // 0dBFS 参考线
    const y0 = h - ((0 - bot) / (top - bot)) * h;
    g.strokeStyle = 'rgba(255,93,108,.25)';
    g.beginPath(); g.moveTo(0, y0); g.lineTo(w, y0); g.stroke();
    g.strokeStyle = '#3ecf8e';
    g.lineWidth = 1.3;
    g.beginPath();
    for (let i = 1; i < N; i++) {
      const x = (i / (N - 1)) * w;
      const db = this.specSmooth[i];
      const y = h - ((db - bot) / (top - bot)) * h;
      i === 1 ? g.moveTo(x, Math.max(0, Math.min(h, y))) : g.lineTo(x, Math.max(0, Math.min(h, y)));
    }
    g.stroke();
    // 纵轴刻度：-20 / -40 / -60 dBFS
    g.fillStyle = 'rgba(138,147,168,.55)';
    g.font = '9px "Segoe UI", sans-serif';
    for (const dbv of [-20, -40, -60]) {
      const y = h - ((dbv - bot) / (top - bot)) * h;
      g.fillText(`${dbv}`, 2, y + 3);
    }
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

let qualityPanel = null;
function initQualityPanel() {
  if (!document.getElementById('qc-panel')) return;
  qualityPanel = new QualityPanel();
  return qualityPanel;
}

// app.js 的 PCM 入口调用：与送进 worklet 的同一批字节，面板显示的就是 ASR 收到的
function pushQualitySample(bytes) {
  if (qualityPanel) qualityPanel.push(bytes);
}

export { initQualityPanel, pushQualitySample };
