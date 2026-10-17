// AI 层热键监听线程（macOS 版，与 ailayer-worker.js 的 Win32 RegisterHotKey 对应）：
// CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
// keyDown 掩码, 回调) 建会话级事件钩子，命中「触发键修饰+F1~F12」的 keyDown 返回 NULL
// 吞掉（等效 RegisterHotKey 的系统级拦截，不串前台应用），未命中原样放行——F 键保持原样。
//
// 前提：系统设置>隐私与安全性>辅助功能 授权宿主应用；未授权 CGEventTapCreate 返回 null，
// 上报 tap-failed 由主进程给出可操作提示（与「组合键被占用」一样是环境故障，不混入键列表）。
//
// 线程模型：tap 回调投递到挂载它的 CFRunLoop，worker 线程用 CFRunLoopRunInMode
// 分片驱动（每拍 ≤50ms 必回 JS）——不用阻塞版 CFRunLoopRun：跨线程 CFRunLoopStop
// 对空转中的 runloop 实测无效（栈采样证实 worker 仍卡 mach_msg），分片让停止变成
// 纯 JS 层判断。进入分片循环前等主进程显式放行（run/stop 二选一，见文件尾 waitGo）。
// 退出后自然退线不 process.exit：koffi 清理刚完成时强退进程会 SIGABRT/挂死
// （2026-10-17 踩坑），且主线程 stop() 经 SAB 握手等 worker 死透再返回。
//
// koffi 指针全部用 uintptr_t 整型承载：koffi 的 opaque 指针对象不能 structured-clone
// 跨线程传给主线程，整型（BigInt）可以，且 ABI 上与指针同宽同寄存器，无兼容性问题。

const { parentPort, workerData } = require('worker_threads');
const { signalExit, stopRequested } = require('./mac-worker-exit');

let koffi;
try {
  koffi = require('koffi');
} catch (e) {
  parentPort.postMessage({ type: 'koffi-failed', error: e.message });
  process.exit(1);
}

const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

// CGEventType / CGEventField / CGEventTapCreate 参数（CGEventTypes.h）
const kCGEventKeyDown = 10;
const kCGEventTapDisabledByTimeout = 0xFFFFFFFE;   // 系统判定 tap 回调过慢自动禁用
const kCGEventTapDisabledByUserInput = 0xFFFFFFFF;
const kCGKeyboardEventKeycode = 9;
const kCGKeyboardEventAutorepeat = 8;
const kCGHeadInsertEventTap = 0, kCGSessionEventTap = 1, kCGEventTapOptionDefault = 0;
// 修饰键 flags（CGEventFlags）：要求精确匹配（多按 Shift 不触发，对齐 RegisterHotKey 语义）
const FLAG_SHIFT = 0x20000, FLAG_CONTROL = 0x40000, FLAG_ALTERNATE = 0x80000, FLAG_COMMAND = 0x100000;
const MODS_ALL = FLAG_SHIFT | FLAG_CONTROL | FLAG_ALTERNATE | FLAG_COMMAND;
const kCFStringEncodingUTF8 = 0x08000100;

// koffi 2.16：回调经 koffi.proto 全签名注册，func 声明与 register 的类型参数都要带 '*'
const TapProto = koffi.proto('uintptr_t ANYKEY_TAP_CB(void *proxy, uint32_t type, uintptr_t event, void *info)');
const CGEventTapCreate = CG.func('uintptr_t CGEventTapCreate(int32_t, int32_t, int32_t, uint64_t, ANYKEY_TAP_CB *, void *)');
const CGEventTapEnable = CG.func('void CGEventTapEnable(uintptr_t, bool)');
const CGEventGetIntegerValueField = CG.func('int64_t CGEventGetIntegerValueField(uintptr_t, uint32_t)');
const CGEventGetFlags = CG.func('uint64_t CGEventGetFlags(uintptr_t)');
const CFMachPortCreateRunLoopSource = CF.func('uintptr_t CFMachPortCreateRunLoopSource(void *, uintptr_t, int64_t)');
const CFMachPortInvalidate = CF.func('void CFMachPortInvalidate(uintptr_t)');
const CFRelease = CF.func('void CFRelease(uintptr_t)');
const CFStringCreateWithCString = CF.func('uintptr_t CFStringCreateWithCString(void *, const char *, uint32_t)');
const CFRunLoopGetCurrent = CF.func('uintptr_t CFRunLoopGetCurrent()');
const CFRunLoopAddSource = CF.func('void CFRunLoopAddSource(uintptr_t, uintptr_t, uintptr_t)');
const CFRunLoopRemoveSource = CF.func('void CFRunLoopRemoveSource(uintptr_t, uintptr_t, uintptr_t)');
const CFRunLoopRunInMode = CF.func('int32_t CFRunLoopRunInMode(uintptr_t, double, bool)');

const hotkeys = Array.isArray(workerData && workerData.hotkeys) ? workerData.hotkeys : [];
const byCode = new Map(hotkeys.map(h => [h.code, h]));
const mask = (BigInt(1) << BigInt(kCGEventKeyDown)); // 只截 keyDown；触发动作不需要 keyUp/flagsChanged

let tap = 0n;
const TAP_DEBUG = !!process.env.ANYKEY_AI_TAP_DEBUG; // 排障开关：打印每个进入 tap 的事件
// 回调跑在 runloop 线程（本线程），必须快：查表 + postMessage 即返回，动作全部在主线程执行
const tapCb = koffi.register((proxy, type, event, info) => {
  if (TAP_DEBUG && event) {
    console.log(`[tap-dbg] type=${type} code=${CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)} ` +
      `flags=0x${CGEventGetFlags(event).toString(16)}`);
  }
  if (type === kCGEventTapDisabledByTimeout || type === kCGEventTapDisabledByUserInput) {
    if (tap) CGEventTapEnable(tap, true); // 过慢被系统禁用：重新启用，继续拦
    return event;
  }
  if (type !== kCGEventKeyDown || !event) return event;
  const h = byCode.get(Number(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)));
  if (!h) return event;
  if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return event; // 按住重复不重触发
  if ((Number(CGEventGetFlags(event)) & MODS_ALL) !== h.mods) return event;
  if (TAP_DEBUG) console.log(`[tap-dbg] 命中 ${h.key}，postMessage id=${h.id}`);
  parentPort.postMessage({ type: 'hotkey', id: h.id });
  return 0n; // NULL：吞掉事件，不会串进前台应用
}, 'ANYKEY_TAP_CB *');

const created = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, tapCb, null);
if (!created) {
  parentPort.postMessage({
    type: 'tap-failed',
    error: '无法创建事件监听（CGEventTapCreate 返回 null）。请在 系统设置 > 隐私与安全性 > 辅助功能 中授权本应用，然后重新启用 AI 层',
  });
  process.exit(1);
}
tap = created;

const src = CFMachPortCreateRunLoopSource(null, tap, 0);
const mode = CFStringCreateWithCString(null, 'kCFRunLoopDefaultMode', kCFStringEncodingUTF8);
const runloop = CFRunLoopGetCurrent();
CFRunLoopAddSource(runloop, src, mode);
CGEventTapEnable(tap, true); // 双保险：Default tap 创建即启用，系统禁用后也可由此恢复

// 分片跑 runloop：CFRunLoopRunInMode 每拍最多 50ms 必回 JS 检查停止标志。
// 不用阻塞版 CFRunLoopRun——跨线程 CFRunLoopStop 对空转中的 runloop 实测无效
// （栈采样证实），分片循环让停止变成纯 JS 层判断，事件到达仍即时处理
//（tap 源唤醒当拍即处理，「上界 50ms」只对无事件空转存在）。
// 进入分片循环前等主进程显式放行（run/stop 二选一）：避免 stop 抢在 ready/run
// 之间到达导致的时序歧义，必须由本线程先收到指令再进。
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
parentPort.on('message', m => {
  if (m !== 'run' && m !== 'stop') return;
  goOrStop = m;
});
parentPort.postMessage({ type: 'ready', runloop, failed: [] });
const waitGo = () => {
  if (!goOrStop) return setTimeout(waitGo, 10); // 未放行：留在事件循环里继续等
  if (goOrStop === 'run') {
    while (goOrStop !== 'stop') {
      if (stopRequested(workerData && workerData.stopSab)) break; // 主线程 markStop
      const r = CFRunLoopRunInMode(mode, 0.05, false);
      if (r === 1) break; // kCFRunLoopRunStopped：外部 CFRunLoopStop（兼容路径）
    }
  }
  cleanup();
  // 自然退线（不 process.exit）：刚从 CFRunLoopRun 原生帧返回、koffi 清理刚做完，
  // 此时强退进程实测会 SIGABRT/挂死（2026-10-17 踩坑，同 mousehook-worker-mac）。
  // 摘掉消息监听 + 关端口后事件循环无待处理句柄，线程自然退出，w.on('exit') 照常触发
  try { parentPort.removeAllListeners('message'); parentPort.close(); } catch (_) {}
  signalExit(workerData && workerData.stopSab); // 最后一步：通知 stop() 已死透（防主进程退出竞态）
};
waitGo();
