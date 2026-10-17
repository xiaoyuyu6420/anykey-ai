// cf-runloop 单测：CFRunLoopRunInMode 返回值裁决表。
// 常量必须与 macOS SDK 的 CFRunLoop.h 一致——2026-10-18 02:07 事故的根因就是
// 把 kCFRunLoopRunFinished(1) 当成 kCFRunLoopRunStopped(2)（tap 被系统销毁后
// worker 静默退出，钩子死了无日志）。此测试钉死这组常量，防止再错。
const { CF_RUNLOOP_RUN, runloopVerdict } = require('../src/main/cf-runloop');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

console.log('[T1] 常量与 SDK 头文件一致（CFRunLoop.h CFRunLoopRunResult）');
ok(CF_RUNLOOP_RUN.Finished === 1, 'kCFRunLoopRunFinished = 1（source 失效，不是停止！）');
ok(CF_RUNLOOP_RUN.Stopped === 2, 'kCFRunLoopRunStopped = 2（CFRunLoopStop 到来）');
ok(CF_RUNLOOP_RUN.TimedOut === 3, 'kCFRunLoopRunTimedOut = 3');
ok(CF_RUNLOOP_RUN.HandledSource === 4, 'kCFRunLoopRunHandledSource = 4');

console.log('[T2] runloopVerdict 裁决表');
ok(runloopVerdict(2) === 'stopped', 'Stopped(2) → stopped（正常收尾退出）');
ok(runloopVerdict(1) === 'tap-lost', 'Finished(1) → tap-lost（上报主进程重装，绝不当成停止）');
ok(runloopVerdict(3) === 'continue', 'TimedOut(3) → continue');
ok(runloopVerdict(4) === 'continue', 'HandledSource(4) → continue');
ok(runloopVerdict(0) === 'continue', '异常值 0 → continue（保守：继续跑）');
ok(runloopVerdict(undefined) === 'continue', 'undefined → continue');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
