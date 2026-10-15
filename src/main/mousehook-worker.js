// 鼠标侧键钩子线程（worker_threads）：
// WH_MOUSE_LL 低级钩子的回调由系统在**安装线程**处理消息时同步调用——
// Node 主线程没有 Win32 消息循环，必须在本线程跑 GetMessage（同 ailayer-worker
// 的线程模型）。回调里只做两件事：postMessage 通知主线程、返回 1 拦截
// （或 CallNextHookEx 放行）。动作全部回主线程执行。
// 严禁在回调里做慢操作：LowLevelHooksTimeout（默认 300ms）超时系统会跳过钩子。
const { parentPort, workerData } = require('worker_threads');

const WH_MOUSE_LL = 14;
const WM_XBUTTONDOWN = 0x020b;
const WM_XBUTTONUP = 0x020c;

// koffi 加载失败与「钩子被占用」是两类故障，分开上报（同 ailayer-worker）
let koffi;
try {
  koffi = require('koffi');
} catch (e) {
  parentPort.postMessage({ type: 'koffi-failed', error: e.message });
  process.exit(1);
}

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// MSLLHOOKSTRUCT（x64）：pt(8) mouseData(4) flags(4) time(4) pad(4) dwExtraInfo(8)
const MSLL = koffi.struct('MOUSEHOOK_MSLL', {
  x: 'int32', y: 'int32',
  mouseData: 'uint32',   // 高 16 位：XBUTTON1=1 / XBUTTON2=2
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uint64',
});
// x64 MSG 布局：hwnd(8) message(4)+pad(4) wParam(8) lParam(8) time(4)+pad(4) pt(8)
const MSG = koffi.struct('MOUSEHOOK_MSG', {
  hwnd: 'void *',
  message: 'uint32',
  wParam: 'uint64',
  lParam: 'int64',
  time: 'uint32',
  x: 'int32',
  y: 'int32',
});

// 回调收到的指针参数是 koffi 外部对象（koffi ≥2.2 不自动解码）；
// 用 koffi.decode 按结构体布局解出 mouseData；透传给 CallNextHookEx 时原样回传
// ——koffi 保证同一类型的外部指针可以原样传给下一个 C 函数（指针透传）
const HOOKPROC = koffi.proto('int64 __stdcall MouseHookProc(int nCode, uint64 wParam, void *lParam)');
const SetWindowsHookExW = user32.func('void *__stdcall SetWindowsHookExW(int idHook, MouseHookProc *lpfn, void *hmod, uint32 dwThreadId)');
const CallNextHookEx = user32.func('int64 __stdcall CallNextHookEx(void *hhk, int nCode, uint64 wParam, void *lParam)');
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)');
// GetMessage 往缓冲区里**写**：必须 koffi.alloc + koffi.decode 读回（同 ailayer-worker）
const GetMessageW = user32.func('int __stdcall GetMessageW(MOUSEHOOK_MSG *pMsg, void *hWnd, uint32 min, uint32 max)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const GetLastError = kernel32.func('uint32 GetLastError()');

const buttons = Array.isArray(workerData && workerData.buttons) && workerData.buttons.length
  ? workerData.buttons : ['x1'];
const block = !workerData || workerData.block !== false;

// 注册成持久回调（防 GC）；钩子整个生命周期复用同一个
const hookProc = koffi.register((nCode, wParam, lParam) => {
  try {
    if (nCode >= 0) {
      const msg = Number(wParam);
      if (msg === WM_XBUTTONDOWN || msg === WM_XBUTTONUP) {
        const ms = koffi.decode(lParam, 'MOUSEHOOK_MSLL');
        const xb = (Number(ms.mouseData) >>> 16) & 0xffff;
        const btn = xb === 1 ? 'x1' : xb === 2 ? 'x2' : null;
        if (btn && buttons.includes(btn)) {
          parentPort.postMessage({ type: 'xbutton', button: btn, phase: msg === WM_XBUTTONDOWN ? 'down' : 'up' });
          if (block) return 1; // 非零 = 吞掉：浏览器前进/后退等原功能不触发
        }
      }
    }
  } catch (_) { /* 回调里绝不抛出（异常会沿原生栈上窜） */ }
  return CallNextHookEx(null, nCode, wParam, lParam);
}, 'MouseHookProc *');

// WH_MOUSE_LL 不注入 DLL、回调在装钩子的进程里执行：hMod 传 NULL 即可；
// dwThreadId=0 = 全局（桌面所有线程）
const hook = SetWindowsHookExW(WH_MOUSE_LL, hookProc, null, 0);
if (!hook) {
  parentPort.postMessage({ type: 'hook-failed', error: `SetWindowsHookExW 失败 GetLastError=${GetLastError()}` });
  process.exit(1);
}
parentPort.postMessage({ type: 'ready', threadId: GetCurrentThreadId() });

const buf = koffi.alloc('MOUSEHOOK_MSG', 1);
while (true) {
  const r = GetMessageW(buf, null, 0, 0);
  if (r <= 0) break; // 0=WM_QUIT（主线程 stop 投递），-1=错误
}
try { UnhookWindowsHookEx(hook); } catch (_) { /* 线程死亡时系统也会清钩子 */ }
try { koffi.unregister(hookProc); } catch (_) {}
process.exit(0);
