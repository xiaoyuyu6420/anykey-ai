// macOS 适配探针：验证 koffi 能否加载 objc / CoreGraphics，以及 CGEventTapCreate 的权限状态
// 用法：node tools/probe-mac-foundation.js
// 预期：无辅助功能授权时 CGEventTapCreate 返回 0（tap=null），有授权时返回非 0
const path = require('path');
const koffi = require(path.join(__dirname, '..', 'node_modules', 'koffi'));

// 1) libobjc 加载方式探测
let objc = null;
for (const p of ['/usr/lib/libobjc.A.dylib', '/usr/lib/libobjc.dylib']) {
  try { objc = koffi.load(p); console.log('[objc] 加载成功:', p); break; } catch (e) { console.log('[objc] 加载失败:', p, e.message); }
}
if (!objc) {
  try { objc = koffi.load('/System/Library/Frameworks/Foundation.framework/Foundation'); console.log('[objc] 经 Foundation 加载成功'); } catch (e) { console.log('[objc] Foundation 加载失败:', e.message); }
}
if (objc) {
  try {
    // NSWorkspace 在 AppKit：裸 node 进程里未加载，显式 dlopen 保证类已注册
    try { koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit'); } catch (_) { /* Electron 进程内已加载 */ }
    const getClass = objc.func('void *objc_getClass(const char *)');
    const sel = objc.func('void *sel_registerName(const char *)');
    const msgSend = objc.func('void *objc_msgSend(void *, void *)');
    const cls = getClass('NSWorkspace');
    console.log('[objc] NSWorkspace class =', cls ? 'OK' : 'null');
    if (cls) {
      const ws = msgSend(cls, sel('sharedWorkspace'));
      console.log('[objc] sharedWorkspace =', ws ? 'OK' : 'null');
      if (ws) {
        const app = msgSend(ws, sel('frontmostApplication'));
        console.log('[objc] frontmostApplication =', app ? 'OK' : 'null（桌面空闲时可为 null，属正常）');
        if (app) {
          const url = msgSend(app, sel('executableURL'));
          const nsPath = url ? msgSend(url, sel('path')) : null;
          const msgSendStr = objc.func('const char *objc_msgSend(void *, void *)');
          const p = nsPath ? msgSendStr(nsPath, sel('UTF8String')) : null;
          console.log('[objc] 前台应用可执行文件路径 =', p || '(未知)');
        }
      }
    }
  } catch (e) { console.log('[objc] NSWorkspace 调用失败:', e.message); }
}

// 2) CGEventTapCreate 权限探测
try {
  const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  // koffi 2.16：回调经全签名 proto 注册，func 声明与 register 的类型参数都要带 '*'
  const proto = koffi.proto('uintptr_t PROBE_TAP_CB(void *proxy, uint32_t type, uintptr_t event, void *info)');
  const cb = koffi.register((proxy, type, event, info) => event, 'PROBE_TAP_CB *');
  const create = CG.func('uintptr_t CGEventTapCreate(int32_t, int32_t, int32_t, uint64_t, PROBE_TAP_CB *, void *)');
  const enable = CG.func('void CGEventTapEnable(uintptr_t, bool)');
  const rlSrc = CF.func('uintptr_t CFMachPortCreateRunLoopSource(void *, uintptr_t, int64_t)');
  const mkstr = CF.func('uintptr_t CFStringCreateWithCString(void *, const char *, uint32_t)');
  const rlCur = CF.func('uintptr_t CFRunLoopGetCurrent()');
  const rlAdd = CF.func('void CFRunLoopAddSource(uintptr_t, uintptr_t, uintptr_t)');
  const rlStop = CF.func('void CFRunLoopStop(uintptr_t)');
  const rlRun = CF.func('void CFRunLoopRun()');
  const tap = create(1 /*kCGSessionEventTap*/, 0, 0 /*Default=可拦截*/, 0x400n /*keyDown*/, cb, null);
  console.log('[tap] CGEventTapCreate(kCGSessionEventTap, 拦截) =', tap ? 'OK(已授权辅助功能)' : 'NULL(缺辅助功能授权)');
  if (tap) {
    const src = rlSrc(null, tap, 0);
    const mode = mkstr(null, 'kCFRunLoopDefaultMode', 0x08000100);
    const rl = rlCur();
    rlAdd(rl, src, mode);
    enable(tap, true);
    // 本探针是单线程脚本：先标记 stop 再进 runloop，验证 CFRunLoopRun/Stop API 链路
    // 即刻返回（真实监听在 worker 线程，由主线程跨线程 CFRunLoopStop，见 ailayer-worker-mac.js）
    rlStop(rl);
    rlRun();
    console.log('[tap] runloop source 挂载 OK（事件 tap 全链路可用），CFRunLoopRun→Stop 优雅退出 OK');
  }
  koffi.unregister(cb);
} catch (e) { console.log('[tap] 探测失败:', e.message); }
