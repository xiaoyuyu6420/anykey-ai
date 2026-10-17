// 鼠标侧键监听线程（macOS 版，与 mousehook-worker.js 的 WH_MOUSE_LL 对应）：
// CGEventTapCreate(kCGSessionEventTap, Default=可拦截, otherMouseDown/Up 掩码) 建
// 会话级鼠标事件钩子，命中配置的侧键 postMessage 回主线程；block 时返回 NULL 吞掉
// 事件（浏览器前进/后退等原功能不触发），未命中放行。
//
// 线程模型与 ailayer-worker-mac.js 完全一致：回调跑在本线程的 CFRunLoop（原生阻塞），
// 退出由主线程跨线程 CFRunLoopStop；进入 runloop 前等主进程显式放行（run/stop 二选一，
// CFRunLoopStop 对尚未进入 runloop 的线程不生效——实测踩坑）；退出补 process.exit
// （parentPort 有监听器时事件循环不自然清空）。
//
// 前提：系统设置>隐私与安全性>辅助功能 授权宿主应用；未授权 CGEventTapCreate 返回
// null，上报 hook-failed（与 win 的钩子安装失败同型，主进程/日志处理复用）。

const { parentPort, workerData } = require('worker_threads');

let koffi;
try {
  koffi = require('koffi');
} catch (e) {
  parentPort.postMessage({ type: 'koffi-failed', error: e.message });
  process.exit(1);
}

const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

// CGEventType / CGEventField（CGEventTypes.h）
const kCGEventOtherMouseDown = 25, kCGEventOtherMouseUp = 26;
const kCGEventTapDisabledByTimeout = 0xFFFFFFFE, kCGEventTapDisabledByUserInput = 0xFFFFFFFF;
const kCGMouseEventButtonNumber = 3;   // 0 左 / 1 右 / 2 中 / 3 侧键4(后退) / 4 侧键5(前进)
const kCGHeadInsertEventTap = 0, kCGSessionEventTap = 1, kCGEventTapOptionDefault = 0;
const kCFStringEncodingUTF8 = 0x08000100;

// koffi 2.16：回调经全签名 proto 注册，func 声明与 register 的类型参数都要带 '*'
const TapProto = koffi.proto('uintptr_t ANYKEY_MOUSE_CB(void *proxy, uint32_t type, uintptr_t event, void *info)');
const CGEventTapCreate = CG.func('uintptr_t CGEventTapCreate(int32_t, int32_t, int32_t, uint64_t, ANYKEY_MOUSE_CB *, void *)');
const CGEventTapEnable = CG.func('void CGEventTapEnable(uintptr_t, bool)');
const CGEventGetIntegerValueField = CG.func('int64_t CGEventGetIntegerValueField(uintptr_t, uint32_t)');
const CFMachPortCreateRunLoopSource = CF.func('uintptr_t CFMachPortCreateRunLoopSource(void *, uintptr_t, int64_t)');
const CFMachPortInvalidate = CF.func('void CFMachPortInvalidate(uintptr_t)');
const CFRelease = CF.func('void CFRelease(uintptr_t)');
const CFStringCreateWithCString = CF.func('uintptr_t CFStringCreateWithCString(void *, const char *, uint32_t)');
const CFRunLoopGetCurrent = CF.func('uintptr_t CFRunLoopGetCurrent()');
const CFRunLoopAddSource = CF.func('void CFRunLoopAddSource(uintptr_t, uintptr_t, uintptr_t)');
const CFRunLoopRemoveSource = CF.func('void CFRunLoopRemoveSource(uintptr_t, uintptr_t, uintptr_t)');
const CFRunLoopRun = CF.func('void CFRunLoopRun()');

const buttons = Array.isArray(workerData && workerData.buttons) && workerData.buttons.length
  ? workerData.buttons : ['x1'];
const block = !workerData || workerData.block !== false;
// 物理侧键号：3 = X1（后退）/ 4 = X2（前进），与 win 的 XBUTTON1/2 对齐
const BY_CODE = { 3: 'x1', 4: 'x2' };

let tap = 0n;
// 掩码只挂 otherMouseDown/Up：其余鼠标事件（移动/滚轮/左右键）完全不进回调，零开销
const mask = (1n << 25n) | (1n << 26n);

// 回调跑在 runloop 线程（本线程），必须快：查表 + postMessage 即返回
const tapCb = koffi.register((proxy, type, event, info) => {
  if (process.env.MOUSE_DBG) console.log(`[mdbg] type=${type} ev=${!!event}`);
  if (type === kCGEventTapDisabledByTimeout || type === kCGEventTapDisabledByUserInput) {
    if (tap) CGEventTapEnable(tap, true); // 过慢被系统禁用：重新启用
    return event;
  }
  if (event && (type === kCGEventOtherMouseDown || type === kCGEventOtherMouseUp)) {
    const code = Number(CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber));
    const btn = BY_CODE[code];
    if (btn && buttons.includes(btn)) {
      parentPort.postMessage({ type: 'xbutton', button: btn, phase: type === kCGEventOtherMouseDown ? 'down' : 'up' });
      if (block) return 0n; // NULL：吞掉，前进/后退等原功能不触发
    }
  }
  return event;
}, 'ANYKEY_MOUSE_CB *');

const created = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, tapCb, null);
if (!created) {
  parentPort.postMessage({
    type: 'hook-failed',
    error: '无法创建鼠标事件监听（CGEventTapCreate 返回 null）。请在 系统设置 > 隐私与安全性 > 辅助功能 中授权本应用，然后重新启用鼠标侧键说话',
  });
  process.exit(1);
}
tap = created;

const src = CFMachPortCreateRunLoopSource(null, tap, 0);
const mode = CFStringCreateWithCString(null, 'kCFRunLoopDefaultMode', kCFStringEncodingUTF8);
const runloop = CFRunLoopGetCurrent();
CFRunLoopAddSource(runloop, src, mode);
CGEventTapEnable(tap, true); // 双保险：Default tap 创建即启用，系统禁用后也可由此恢复

// runloop 地址给主线程：stop() 跨线程 CFRunLoopStop。
// 进入 runloop 前等主进程显式放行（run/stop 二选一），竞态处理同 ailayer-worker-mac.js
function cleanup() {
  try {
    CFRunLoopRemoveSource(runloop, src, mode);
    CFMachPortInvalidate(tap);
    CFRelease(src);
    CFRelease(tap);
  } catch (_) { /* 线程退出路径，失败不再重试 */ }
  koffi.unregister(tapCb);
}
let goOrStop = null;
let entered = false;
parentPort.on('message', m => {
  if (m !== 'run' && m !== 'stop') return;
  goOrStop = m;
  if (m === 'stop' && entered) CFRunLoopStop(runloop); // 已在 runloop 中：跨线程停止
});
parentPort.postMessage({ type: 'ready', runloop, failed: [] });
const waitGo = () => {
  if (!goOrStop) return setTimeout(waitGo, 10); // 未放行：留在事件循环里继续等
  if (goOrStop === 'run') {
    entered = true;
    CFRunLoopRun(); // 阻塞直到主线程 CFRunLoopStop
  }
  cleanup();
  process.exit(0);
};
waitGo();
