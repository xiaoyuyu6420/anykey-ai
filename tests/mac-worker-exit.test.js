// mac-worker-exit 单测：停止握手 SAB 语义。
// 回归点：markEntered（「已进入分片 runloop」）与 signalExit（「已死透」）曾共用
// 同一个 cell——waitStopped 在 worker 刚进入 runloop 时就误判「已死透」提前放行，
// 退出 join 竞态复活。修复后 entered 在 cell 2、死透在 cell 1，互不干扰。
const { createExitSignal, markEntered, signalExit, stopRequested } = require('../src/main/mac-worker-exit');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

console.log('[T1] markEntered 不得置「已死透」位');
{
  const ex = createExitSignal();
  markEntered(ex.sab);
  ok(ex.waitStopped(1) === false, '仅 markEntered：waitStopped 必须超时（worker 还活着）');
}

console.log('[T2] signalExit 才是死透信号');
{
  const ex = createExitSignal();
  markEntered(ex.sab);
  signalExit(ex.sab);
  ok(ex.waitStopped(500) === true, 'signalExit 后 waitStopped 立即返回 true');
}

console.log('[T3] 停止标志与死透标志互相独立');
{
  const ex = createExitSignal();
  ex.markStop();
  ok(stopRequested(ex.sab) === true, 'markStop 后 stopRequested 为 true');
  ok(ex.waitStopped(1) === false, 'markStop 不影响死透位（worker 仍活着）');
  signalExit(ex.sab);
  ok(ex.waitStopped(1) === true, '死透位置位后 waitStopped 返回 true');
}

console.log('[T4] 容错');
{
  ok(createExitSignal().waitStopped(1) === false, '无人置位：超时返回 false');
  markEntered(undefined); signalExit(undefined); // 不应抛
  ok(true, 'sab 为 undefined 时 no-op 不抛');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
