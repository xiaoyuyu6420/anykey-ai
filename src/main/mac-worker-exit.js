// mac 事件钩子 worker（CGEventTap 系）的停止握手。
// 背景 ①：worker 线程从 CFRunLoop 原生帧返回后要做 koffi/CF 清理，主进程若在
// 这个窗口内 process.exit/Electron quit，实测会 SIGABRT 或挂死（2026-10-17 踩坑）。
// 背景 ②：跨线程 CFRunLoopStop 不可靠——实测 runloop 空转（mach_msg 等待）时调用
// 无效（栈采样证实）；CFRunLoopTimer 自停方案也未按预期触发。
// 最终方案：worker 用 CFRunLoopRunInMode(mode, 0.05) 分片跑 runloop——每 50ms 必回
// JS 检查停止标志，事件到达照常即时处理；停止 = JS 层循环退出，无跨线程停止语义。
// SAB 布局：[0]=停止标志（主线程置 1），[1]=worker 已死透标志（signalExit 置 1，
// 主线程 Atomics.wait 有界等待，防退出 join 竞态）。

// worker 侧：标记「已进入分片 runloop」
function markEntered(sab) {
  if (!sab) return;
  try { const ia = new Int32Array(sab); Atomics.store(ia, 1, 1); Atomics.notify(ia, 1); } catch (_) {}
}

// worker 侧：最后一步置位并唤醒主线程（其后不得再碰任何原生资源）
function signalExit(sab) {
  if (!sab) return;
  try { const ia = new Int32Array(sab); Atomics.store(ia, 1, 1); Atomics.notify(ia, 1); } catch (_) {}
}

// worker 侧：分片循环每拍查停止标志（Atomics 要求 Int32Array 视图，不能裸传 SAB）
function stopRequested(sab) {
  try { return new Int32Array(sab)[0] === 1; } catch (_) { return false; }
}

// 主进程侧：创建配对的 SAB；waitStopped(ms) 同步等 worker 置位（返回是否等到）
function createExitSignal() {
  const sab = new SharedArrayBuffer(8);
  const ia = new Int32Array(sab);
  return {
    sab,
    markStop() {
      try { Atomics.store(ia, 0, 1); Atomics.notify(ia, 0); } catch (_) {}
    },
    waitStopped(timeoutMs = 500) {
      try {
        if (ia[1] === 1) return true; // worker 已死透
        return Atomics.wait(ia, 1, 0, timeoutMs) === 'ok';
      } catch (_) { return false; } // 主线程不可阻塞等环境（理论不发生）：走兜底
    },
  };
}

module.exports = { markEntered, signalExit, stopRequested, createExitSignal };
