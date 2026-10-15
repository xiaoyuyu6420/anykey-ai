// 前台应用检测（配置档自动切换的事件源）
// Win：GetForegroundWindow → OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)
//      → QueryFullProcessImageNameW，取 exe 基名小写；koffi FFI，无轮询开销之外的依赖
// mac：NSWorkspace.sharedWorkspace.frontmostApplication → executableURL 取基名小写
//      （libobjc objc_msgSend 直调 + koffi FFI；NSWorkspace 在 AppKit，需先 dlopen 注册类）。
//      返回值与 Win 对齐（进程可执行名小写，如 "chrome"），规则匹配逻辑两侧通用。
// 规则匹配在 index.js 侧做，本模块只报「前台进程名变化」。
// 1s 轮询仅微秒级 API 调用；取进程失败（提权/锁屏等）跳过本轮，保持上一个进程名，
// 避免权限噪音把状态抖来抖去。

class FgWatcher {
  constructor() {
    this.supported = process.platform === 'win32' || process.platform === 'darwin';
    this.timer = null;
    this.lastProc = null;   // 当前认知的前台进程名（可执行名基名小写）
    this.onChange = null;   // (proc, prev)
    if (this.supported) this._init();
  }

  _init() {
    try {
      if (process.platform === 'darwin') return this._initMac();
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const kernel32 = koffi.load('kernel32.dll');
      this._getFg = user32.func('void *GetForegroundWindow()');
      this._getPid = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *, void *)');
      this._open = kernel32.func('void *OpenProcess(uint32, int, uint32)');
      this._qname = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *, uint32, void *, void *)');
      this._close = kernel32.func('int CloseHandle(void *)');
      this._pidBuf = koffi.alloc('uint32_t');
      this._nameBuf = koffi.alloc('uint16_t[512]');
      this._sizeBuf = koffi.alloc('uint32_t');
    } catch (_) {
      this.supported = false;
    }
  }

  // [mac] objc 运行时准备：objc_msgSend 按固定签名声明（ABI 上定参与变参调用同形，
  // koffi 不支持变参）；选择器只在 init 注册一次，轮询路径零字符串开销
  _initMac() {
    const koffi = require('koffi');
    // NSWorkspace 在 AppKit：裸进程未加载，显式 dlopen 保证类已注册（Electron 进程内已加载，无害）
    try { koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit'); } catch (_) { /* 已加载 */ }
    // 新系统 /usr/lib/libobjc.A.dylib 不落盘（dyld 共享缓存），dlopen 虚拟路径仍有效
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    this._getClass = objc.func('void *objc_getClass(const char *)');
    this._sel = objc.func('void *sel_registerName(const char *)');
    this._msgSend = objc.func('void *objc_msgSend(void *, void *)');
    this._msgSendStr = objc.func('const char *objc_msgSend(void *, void *)');
    this._wsClass = this._getClass('NSWorkspace');
    this._poolCls = this._getClass('NSAutoreleasePool');
    if (!this._wsClass || !this._poolCls) throw new Error('AppKit 类未注册');
    this._selShared = this._sel('sharedWorkspace');
    this._selFront = this._sel('frontmostApplication');
    this._selUrl = this._sel('executableURL');
    this._selPath = this._sel('path');
    this._selName = this._sel('localizedName');
    this._selUtf8 = this._sel('UTF8String');
    this._selAlloc = this._sel('alloc');
    this._selInit = this._sel('init');
    this._selDrain = this._sel('drain');
  }

  // [mac] 取当前前台进程可执行名；失败返回 null（调用方保持原状态）。
  // 属性读取返回 autoreleased 对象：逐 tick 建/排 autorelease pool，防跨 tick 堆积
  _currentProcessMac() {
    const pool = this._msgSend(this._msgSend(this._poolCls, this._selAlloc), this._selInit);
    try {
      const ws = this._msgSend(this._wsClass, this._selShared);
      const app = ws ? this._msgSend(ws, this._selFront) : null; // 锁屏/无前台时为 null
      if (!app) return null;
      const url = this._msgSend(app, this._selUrl);
      const nsPath = url ? this._msgSend(url, this._selPath) : null;
      if (nsPath) {
        const p = this._msgSendStr(nsPath, this._selUtf8);
        if (p) return (String(p).split('/').pop() || '').toLowerCase();
      }
      // executableURL 拿不到（沙盒应用等）退回显示名，匹配语义稍宽但可用
      const nsName = this._msgSend(app, this._selName);
      if (nsName) {
        const n = this._msgSendStr(nsName, this._selUtf8);
        if (n) return String(n).toLowerCase();
      }
      return null;
    } finally {
      this._msgSend(pool, this._selDrain);
    }
  }

  // 取当前前台进程名；失败返回 null（调用方保持原状态）
  currentProcess() {
    if (!this.supported) return null;
    try {
      if (process.platform === 'darwin') return this._currentProcessMac();
      const koffi = require('koffi');
      const hwnd = this._getFg();
      if (!hwnd) return null;
      koffi.encode(this._pidBuf, 'uint32_t', 0);
      this._getPid(hwnd, this._pidBuf);
      const pid = koffi.decode(this._pidBuf, 'uint32_t');
      if (!pid) return null;
      const h = this._open(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
      if (!h) return null;
      koffi.encode(this._sizeBuf, 'uint32_t', 512);
      const ok = this._qname(h, 0, this._nameBuf, this._sizeBuf);
      this._close(h);
      if (!ok) return null;
      const arr = koffi.decode(this._nameBuf, 'uint16_t[512]');
      const zero = arr.indexOf(0);
      const full = String.fromCharCode.apply(null, zero >= 0 ? arr.slice(0, zero) : arr);
      return (full.split(/[\\/]/).pop() || '').toLowerCase();
    } catch (_) {
      return null;
    }
  }

  start() {
    if (!this.supported || this.timer) return false;
    this.lastProc = this.currentProcess(); // 建基线：启动时已在前台的进程不触发切换
    this.timer = setInterval(() => this.tick(), 1000);
    return true;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastProc = null;
  }

  tick() {
    const proc = this.currentProcess();
    if (proc === null || proc === this.lastProc) return;
    const prev = this.lastProc;
    this.lastProc = proc;
    if (this.onChange) {
      try { this.onChange(proc, prev); } catch (_) { /* 回调异常不中断轮询 */ }
    }
  }
}

module.exports = { FgWatcher };
