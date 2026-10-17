// CFRunLoopRunInMode 返回值（CFRunLoop.h，2026-10-18 与 SDK 头文件核对）：
//   kCFRunLoopRunFinished = 1 —— source 全部失效，runloop 无活可干
//   kCFRunLoopRunStopped  = 2 —— 有人对该 runloop 调了 CFRunLoopStop
//   kCFRunLoopRunTimedOut = 3 / kCFRunLoopRunHandledSource = 4
// mac 事件钩子 worker（mousehook / ailayer）分片跑 runloop 时必须区分
// 「收到停止」与「tap source 被系统销毁」：02:07 事故（GPU/WindowServer 异常
// 连带会话级事件 tap 失效）里 Finished(1) 被当成 Stopped 处理，worker 以 code 0
// 静默退出——钩子死了无日志、无人重装，侧键说话从此无响应，重启应用才恢复。
const CF_RUNLOOP_RUN = { Finished: 1, Stopped: 2, TimedOut: 3, HandledSource: 4 };

// 分片循环每拍对返回值的裁决：
//   'stopped'  = CFRunLoopStop 到来（stop() 的兼容路径），正常收尾退出
//   'tap-lost' = tap 的 source 被系统销毁——worker 上报主进程重装钩子
//   'continue' = 正常一拍（含超时/处理过事件），继续分片
function runloopVerdict(r) {
  if (r === CF_RUNLOOP_RUN.Stopped) return 'stopped';
  if (r === CF_RUNLOOP_RUN.Finished) return 'tap-lost';
  return 'continue';
}

module.exports = { CF_RUNLOOP_RUN, runloopVerdict };
