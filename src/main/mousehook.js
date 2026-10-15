// 鼠标侧键监听（仅 win32）：按住侧键 = 按住说话键。
// WH_MOUSE_LL 低级钩子必须挂在带消息循环的线程上——与 ailayer 同款
// worker_threads 方案：钩子回调只做 postMessage，动作回主线程执行。
// 侧键事件转成合成 keyId（mouse_x1 / mouse_x2）送进与键盘说话键完全相同的
// micTrigger 链路：开麦/关麦、长按锁定、输入法组合键透传全部复用。
// 默认拦截侧键原功能（前进/后退）专键专用；设置里可关掉拦截（语音与原功能并行）。

const { Worker } = require('worker_threads');
const path = require('path');

let worker = null;
let workerTid = 0;   // worker 的 Win32 线程 ID（PostThreadMessage 用，见 ailayer.js 注释）
let onEvent = null;

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

function running() { return !!worker; }

// cfg: { button: 'x1'|'x2'|'both', block: bool }；cb(keyId, phase) 在主线程执行
function start(cfg, cb) {
  if (process.platform !== 'win32') return { ok: false, error: '鼠标侧键说话仅支持 Windows' };
  stop(); // 幂等：先清旧 worker（WM_QUIT 优雅退出 → 钩子随循环退出卸载）
  onEvent = cb;
  const buttons = cfg && cfg.button === 'both' ? ['x1', 'x2'] : [cfg && cfg.button === 'x2' ? 'x2' : 'x1'];
  const block = !cfg || cfg.block !== false;
  const w = new Worker(path.join(__dirname, 'mousehook-worker.js'), { workerData: { buttons, block } });
  worker = w;
  w.on('message', m => {
    if (m && m.type === 'ready') {
      // 注意存的是 Win32 线程 ID（GetCurrentThreadId 的返回值），不是 Worker.threadId
      workerTid = Number(m.threadId) || 0;
      console.log(`[mousehook] 侧键钩子已安装（${buttons.join('+')}${block ? '，拦截原功能' : '，原功能保留'}）`);
    } else if (m && m.type === 'hook-failed') {
      console.log('[mousehook] 钩子安装失败:', m.error);
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
    if (code !== 0) {
      // 钩子装不上多是环境问题（权限/安全软件拦截），不做自动重启风暴——
      // 在设置里重新勾一次「鼠标侧键说话」即可重装
      console.log(`[mousehook] worker 退出(code=${code})——重新勾选侧键说话可重装钩子`);
    }
  });
  return { ok: true };
}

// 停止 = 投 WM_QUIT 让消息循环自然返回（worker 侧卸载钩子后退出）；
// 1 秒后仍不退再 terminate 兜底（fire-and-forget 不悬挂）。
function stop() {
  if (worker) {
    const w = worker;
    const tid = workerTid;
    worker = null;
    workerTid = 0;
    const post = ensurePostQuit();
    if (post && tid) {
      try { post(tid, WM_QUIT, 0, 0); } catch (_) { /* 优雅路径失败走兜底 */ }
    }
    const t = setTimeout(() => { try { w.terminate(); } catch (_) { /* 已退出 */ } }, 1000);
    if (t.unref) t.unref();
  }
  onEvent = null;
}

module.exports = { start, stop, running };
