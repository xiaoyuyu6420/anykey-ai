// 桥接输出 worklet：从主线程收 int16 PCM，按块写入虚拟声卡
//
// 为什么不用 ScriptProcessor（v0.12.4 起替换）：
//   1) ScriptProcessor 已废弃，主线程忙时 onaudioprocess 直接不回调 → 丢帧断音
//   2) bufferSize=2048 在 16kHz 下是 128ms，主进程每 120ms 才推一帧，
//      一次回调永远凑不满 → 必然靠补零填满，欠载 28 次/次会话
//   worklet 跑在音频线程，bufferSize 可降到 256（16ms），与 120ms 批粒度错开

class MicBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];       // 待播 Float32 块（已转 float，值域 ±1）
    this.chunkOff = 0;     // 队首块内已播偏移
    this.underruns = 0;    // 欠载累计（统计上报主线程）
    this.feeding = false;  // 最近是否在收数据（纯静音期不算欠载）
    this.lastFeedAt = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'flush') { this.queue = []; this.chunkOff = 0; return; }
      if (d.type !== 'pcm') return;
      const bytes = d.bytes;
      const n = bytes.length >> 1;
      if (!n) return;
      const f = new Float32Array(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const v = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        f[i] = v / 32768;
      }
      this.queue.push({ data: f, peak });
      // 积压保护：上限 ~1s（120ms/帧 → 8 帧）。超限丢最旧并归零偏移
      // （偏移指向旧队首，不归零会从新队首中间开播 → 跳音）
      if (this.queue.length > 8) {
        this.queue.splice(0, this.queue.length - 8);
        this.chunkOff = 0;
      }
      this.lastFeedAt = currentTime;
      this.feeding = true;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    const buf = this._buf && this._buf.length === n ? this._buf : (this._buf = new Float32Array(n));
    let w = 0;
    while (w < n && this.queue.length) {
      const cur = this.queue[0];
      const take = Math.min(cur.data.length - this.chunkOff, n - w);
      buf.set(cur.data.subarray(this.chunkOff, this.chunkOff + take), w);
      this.chunkOff += take; w += take;
      if (this.chunkOff >= cur.data.length) { this.queue.shift(); this.chunkOff = 0; }
    }
    if (w < n) {
      buf.fill(0, w);
      // 欠载 = 下游录到空洞。只统计「音频刚流过」的窗口，纯静音期队列本就为空
      const since = currentTime - this.lastFeedAt;
      if (this.feeding && since < 2) {
        this.underruns++;
        if (this.underruns % 5 === 1) {
          this.port.postMessage({ type: 'underrun', count: this.underruns, gap: since });
        }
      }
    } else if (this.underruns) {
      this.underruns = 0; // 本次吃饱：清零累计，避免旧值误导
    }
    // 声道下混：信号源是单声道，虚拟声卡（CABLE In 16ch）按多声道接收。
    // 复制到所有输出声道，让系统混音器把单声道抬满整个输出——
    // 只填第 0 声道在多声道虚拟声卡上会只进一半。
    for (let c = 0; c < out.length; c++) out[c].set(buf);
    return true;
  }
}

registerProcessor('mic-bridge-processor', MicBridgeProcessor);
