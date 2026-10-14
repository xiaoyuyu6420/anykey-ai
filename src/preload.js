const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aikey', {
  // AudioWorklet 模块的 file:// URL。
  // 渲染进程 preload 在沙箱里跑，不能 require('path')/'url'（sandbox 下会
  // module not found: path 导致整个 preload 加载失败、设置页白屏），
  // 故由主进程算好 file:// URL 再通过 IPC 传过来。
  micWorkletUrl: () => ipcRenderer.invoke('mic-worklet-url'),
  getState: () => ipcRenderer.invoke('get-state'),
  setBinding: (keyId, action, mode) => ipcRenderer.invoke('set-binding', keyId, action, mode),
  setSettings: s => ipcRenderer.invoke('set-settings', s),
  testAction: a => ipcRenderer.invoke('test-action', a),
  pickProgram: () => ipcRenderer.invoke('pick-program'),
  onKeyEvent: cb => ipcRenderer.on('key-event', (_e, data) => cb(data)),
  onDeviceStatus: cb => ipcRenderer.on('device-status', (_e, connected) => cb(connected)),
  // 键盘麦克风桥接
  onMicPcm: cb => ipcRenderer.on('mic-pcm', (_e, buf) => cb(new Uint8Array(buf))),
  onMicState: cb => ipcRenderer.on('mic-state', (_e, on) => cb(on)),
  onSessionStatus: cb => ipcRenderer.on('session-status', (_e, on) => cb(on)),
  // 会话详情（状态条：在线/通道/RTT/离线原因）+ 手动重连
  onSessionDetail: cb => ipcRenderer.on('session-detail', (_e, d) => cb(d)),
  reconnectSession: () => ipcRenderer.invoke('session-reconnect'),
  onAiMode: cb => ipcRenderer.on('ai-mode', (_e, on) => cb(on)),
  onBattery: cb => ipcRenderer.on('battery', (_e, b) => cb(b)),
  micControl: on => ipcRenderer.invoke('mic-control', on),
  // 录音测试：把送进 ASR 的音频存 WAV（判断问题在音频还是识别引擎）
  saveWav: arr => ipcRenderer.invoke('save-wav', arr),
  // 麦克风链路体检（DSP 实时快照：SNR/底噪/门控/增益/电平 + 降噪前后探针）
  micDiagnostics: () => ipcRenderer.invoke('mic-diagnostics'),
  // 稳态噪声扣除（学习式谱减，专治持续底噪）
  noiseRelearn: () => ipcRenderer.invoke('noise-relearn'),
  noiseProfileSet: patch => ipcRenderer.invoke('noise-profile-set', patch),
  // 自动调参（闭环搜索）
  autotuneStart: opts => ipcRenderer.invoke('autotune-start', opts),
  autotuneStatus: () => ipcRenderer.invoke('autotune-status'),
  autotuneCancel: () => ipcRenderer.invoke('autotune-cancel'),
  autotuneRollback: () => ipcRenderer.invoke('autotune-rollback'),
  // 打字音效
  soundTest: () => ipcRenderer.invoke('sound-test'),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  // 配置档（多套键位 + 前台应用自动切档）
  profileOp: payload => ipcRenderer.invoke('profile-op', payload),
  onProfileChanged: cb => ipcRenderer.on('profile-changed', (_e, data) => cb(data)),
  // 宏录制
  macroOp: payload => ipcRenderer.invoke('macro-op', payload),
  onMacroRecorded: cb => ipcRenderer.on('macro-recorded', (_e, data) => cb(data)),
  // 打字统计
  statsGet: () => ipcRenderer.invoke('stats-get'),
  saveReportPng: dataUrl => ipcRenderer.invoke('save-report', dataUrl),
  // 渲染端日志落盘（桥接等静默链路的观测，进主进程 app.log）
  log: msg => ipcRenderer.send('renderer-log', String(msg).slice(0, 300)),
  // AI 层（任意键盘：触发键+F1~F12 → 动作槽位）
  aiLayerOp: payload => ipcRenderer.invoke('ailayer-op', payload),
  // 窗口可见性（托盘隐藏/最小化 = false）：渲染端据此停 3D 渲染循环
  onAppVisibility: cb => ipcRenderer.on('app-visibility', (_e, visible) => cb(!!visible)),
});
