// 鼠标侧键监听：按住侧键 = 按住说话键。
//   Windows: WH_MOUSE_LL 低级钩子必须挂在带消息循环的线程上——与 ailayer 同款
//     worker_threads 方案：钩子回调只做 postMessage，动作回主线程执行。
//   macOS:  CGEventTap 会话级鼠标事件钩子（otherMouseDown/Up 掩码），回调跑在
//     worker 线程的 CFRunLoop，退出由主线程跨线程 CFRunLoopStop（同 ailayer-worker-mac）。
// 侧键事件转成合成 keyId（mouse_x1 / mouse_x2）送进与键盘说话键完全相同的
// micTrigger 链路：开麦/关麦、长按锁定、输入法组合键透传全部复用。
// 默认拦截侧键原功能（前进/后退）专键专用；设置里可关掉拦截（语音与原功能并行）。

const { Worker } = require('worker_threads');
const path = require('path');
const { createExitSignal } = require('./mac-worker-exit');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SUPPORTED = IS_WIN || IS_MAC;

let worker = null;
let workerTid = 0;      // [win] worker 的 Win32 线程 ID（PostThreadMessage 用，见 ailayer.js 注释）
let workerRunloop = 0n; // [mac] worker 的 CFRunLoopRef（CFRunLoopStop 用）
let workerExit = null;  // [mac] 停止握手（等 worker 死透再放行主进程退出，见 mac-worker-exit.js）
let onEvent = null;
let lastCfg = null;     // 最近一次 start 的入参：tap 被系统销毁时自动重装要用
let lastCb = null;
let reinstallTs = [];   // 自动重装时刻（60s 滑窗，防 tap 反复失效造成重装风暴）

const WM_QUIT = 0x0012;
let postQuit = null;
function ensurePostQuit() {
  if (postQuit !== null) return postQuit;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    postQuit = user32.func('int __stdcall PostThreadMessageW(uint32, uint32, uint64, int64)');
  } catch (_) { postQuit = null; }
  return postQuit;
}

// [mac] 优雅退出：主线程跨线程 CFRunLoopStop（同 ailayer.js 的 stop 路径）
let cfStop = null;
function ensureRunLoopStop() {
  if (cfStop !== null) return cfStop;
  try {
    const koffi = require('koffi');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    cfStop = cf.func('void CFRunLoopStop(uintptr_t)');
  } catch (_) { cfStop = null; }
  return cfStop;
}

function running() { return !!worker; }

// cfg: { button: 'x1'|'x2'|'both', block: bool }；cb(keyId, phase) 在主线程执行
function start(cfg, cb) {
  if (!SUPPORTED) return { ok: false, error: '鼠标侧键说话仅支持 Windows / macOS' };
  stop(); // 幂等：先清旧 worker（win=WM_QUIT / mac=CFRunLoopStop，见 ailayer.js 注释）
  onEvent = cb;
  lastCfg = cfg ? { ...cfg } : cfg;
  lastCb = cb;
  const buttons = cfg && cfg.button === 'both' ? ['x1', 'x2'] : [cfg && cfg.button === 'x2' ? 'x2' : 'x1'];
  const block = !cfg || cfg.block !== false;
  const workerFile = IS_MAC ? 'mousehook-worker-mac.js' : 'mousehook-worker.js';
  workerExit = IS_MAC ? createExitSignal() : null;
  const w = new Worker(path.join(__dirname, workerFile), {
    workerData: { buttons, block, stopSab: workerExit ? workerExit.sab : undefined },
  });
  worker = w;
  w.on('message', m => {
    if (m && m.type === 'ready') {
      if (IS_MAC) {
        // runloop 是 uintptr_t（BigInt），CFRunLoopStop 原样回传；
        // 显式放行 worker 进 runloop（竞态处理同 ailayer.js：stop 先于 ready 时改发 'stop'）
        workerRunloop = typeof m.runloop === 'bigint' ? m.runloop : 0n;
        const stopped = !!w._stopRequested;
        if (worker === w) console.log(`[mousehook] 事件监听已建立（${buttons.join('+')}${block ? '，拦截原功能' : '，原功能保留'}）`);
        w.postMessage(stopped ? 'stop' : 'run');
      } else {
        // 注意存的是 Win32 线程 ID（GetCurrentThreadId 的返回值），不是 Worker.threadId
        workerTid = Number(m.threadId) || 0;
        console.log(`[mousehook] 侧键钩子已安装（${buttons.join('+')}${block ? '，拦截原功能' : '，原功能保留'}）`);
      }
    } else if (m && m.type === 'hook-failed') {
      console.log('[mousehook] 钩子安装失败:', m.error);
    } else if (m && m.type === 'tap-lost') {
      // 系统级事件（GPU/WindowServer 异常、会话切换等）会销毁会话级事件 tap 的
      // source——worker 已按「tap 失效」收尾，这里重装钩子（2026-10-18 02:07 事故：
      // 无此路径时钩子静默死亡，侧键说话直到重启应用都无响应）
      console.log('[mousehook] 事件 tap 被系统销毁，自动重装');
      autoReinstall();
    } else if (m && m.type === 'koffi-failed') {
      console.log('[mousehook] koffi 加载失败，侧键说话不可用:', m.error);
    } else if (m && m.type === 'xbutton') {
      const keyId = m.button === 'x2' ? 'mouse_x2' : 'mouse_x1';
      if (onEvent) {
        try { onEvent(keyId, m.phase); } catch (e) { console.log('[mousehook] 回调异常:', e.message); }
      }
    }
  });
  w.on('error', e => {
    if (worker === w) worker = null; // 崩溃后别让 running() 误报「还在监听」
    console.log('[mousehook] worker 异常退出:', e.message);
  });
  w.on('exit', code => {
    if (worker !== w) return; // stop() 换代或已清理
    worker = null;
    workerTid = 0;
    workerRunloop = 0n;
    // 退出必须留痕（code 0 也打）：02:07 事故里 worker 静默退出版本无任何痕迹，
    // 排查只能靠采样线程栈。钩子装不上多是环境问题（mac 缺辅助功能授权或安全软件
    // 拦截），失败码提示手动重装；正常收尾交给 tap-lost 的自动重装
    console.log(`[mousehook] worker 退出(code=${code})${code === 0 ? '' : '——重新勾选侧键说话可重装钩子'}`);
  });
  return { ok: true };
}

// 停止 = 按平台优雅退出（win 投 WM_QUIT 让消息循环自然返回、钩子随循环退出卸载；
// mac 跨线程 CFRunLoopStop）；mac 侧随后有界等待 worker 死透（≤500ms，防主进程
// 在 worker 原生清理窗口内退出 → SIGABRT/挂死，见 mac-worker-exit.js）；
// 超时再 terminate 兜底（fire-and-forget 不悬挂）。
function stop() {
  if (worker) {
    const w = worker;
    const tid = workerTid;     // 先取平台句柄，再清状态
    const rl = workerRunloop;
    const exitSig = workerExit;
    worker = null;
    workerTid = 0;
    workerRunloop = 0n;
    workerExit = null;
    if (IS_MAC) {
      if (rl) {
        // 停止双保险：共享标志（worker 的 50ms 自停 timer 读到后自停，跨线程唯一可靠
        // 路径，见 mac-worker-exit.js）+ CFRunLoopStop（runloop 刚被事件唤醒的窗口内
        // 立即生效）。随后同步等 worker 死透（通常几 ms）
        if (exitSig) exitSig.markStop();
        const stopFn = ensureRunLoopStop();
        if (stopFn) {
          try { stopFn(rl); } catch (_) { /* 标志路径已兜底 */ }
        }
        if (exitSig) exitSig.waitStopped(500);
      } else {
        w._stopRequested = true; // worker 尚未 ready：ready 时改发 'stop'，不进 runloop
        if (exitSig) exitSig.waitStopped(500); // 该路径无原生帧，但同样等死透再返回
      }
    } else {
      const post = ensurePostQuit();
      if (post && tid) {
        try { post(tid, WM_QUIT, 0, 0); } catch (_) { /* 优雅路径失败走兜底 */ }
      }
    }
    const t = setTimeout(() => { try { w.terminate(); } catch (_) { /* 已退出 */ } }, 1000);
    if (t.unref) t.unref();
  }
  onEvent = null;
}

// tap 被系统销毁后的自动重装：复用最近一次 start 入参。60s 滑窗最多 3 次——
// 若系统持续销毁 tap（极端环境），限流防重装风暴，之后留给用户手动重开
function autoReinstall() {
  const now = Date.now();
  reinstallTs = reinstallTs.filter(t => now - t < 60000);
  if (reinstallTs.length >= 3) {
    console.log('[mousehook] 60s 内已自动重装 3 次，暂停自动重装（请在设置里重开鼠标侧键说话）');
    return;
  }
  reinstallTs.push(now);
  const cfg = lastCfg, cb = lastCb;
  if (!cfg || !cb) return;
  setTimeout(() => {
    if (!running()) start(cfg, cb);
  }, 500);
}

module.exports = { start, stop, running };
