// 长按锁定状态机单测（纯函数）：按住说话 / 长按锁定 / 再按结束 / 多触发源交错
const { createLatchState, latchEvent, resetLatch } = require('../src/main/mic-latch');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

console.log('[T1] 正常按住说话（短按，未达阈值）');
{
  const st = createLatchState();
  const d = latchEvent(st, 'f10', 'down', 1000, 5000);
  ok(d.inject === 'down' && d.mic === 'start' && !d.latch, 'down → 开麦 + 注入 down');
  const u = latchEvent(st, 'f10', 'up', 3000, 5000);
  ok(u.inject === 'up' && u.mic === 'stop' && !u.latch, 'up（2s < 5s）→ 关麦 + 注入 up');
  ok(st.latched === null && st.holds.size === 0, '状态清空');
}

console.log('[T2] 长按 ≥ 阈值 → 锁定；再按一下 → 结束');
{
  const st = createLatchState();
  latchEvent(st, 'f10', 'down', 1000, 5000);
  const u = latchEvent(st, 'f10', 'up', 7000, 5000); // 6s ≥ 5s
  ok(u.latch === 'on' && !u.inject && !u.mic, '长按抬起 → 锁定（不抬键不关麦）');
  ok(st.latched === 'f10', '锁定态记录 keyId');
  // 再按一下同一个键
  const d2 = latchEvent(st, 'f10', 'down', 9000, 5000);
  ok(d2.latch === 'off' && d2.mic === 'stop' && d2.inject === 'up' && d2.injectKey === 'f10',
    '再按 → 结束锁定：关麦 + 抬起被锁定键');
  const u2 = latchEvent(st, 'f10', 'up', 9500, 5000);
  ok(Object.keys(u2).length === 0, '结束锁定那次按压的 up 被消费，不再动作');
  ok(st.latched === null && st.holds.size === 0 && st.consumed.size === 0, '状态清空');
}

console.log('[T3] 锁定时按**另一个**说话键结束（键盘锁、鼠标抬）');
{
  const st = createLatchState();
  latchEvent(st, 'f10', 'down', 1000, 5000);
  latchEvent(st, 'f10', 'up', 8000, 5000); // 锁定在 f10
  const d = latchEvent(st, 'mouse_x1', 'down', 10000, 5000);
  ok(d.latch === 'off' && d.mic === 'stop' && d.inject === 'up' && d.injectKey === 'f10',
    '鼠标侧键按下 → 结束锁定，抬起的是 f10 的注入');
  const u = latchEvent(st, 'mouse_x1', 'up', 10500, 5000);
  ok(Object.keys(u).length === 0, '侧键抬起的尾巴被消费');
}

console.log('[T4] latchMs=0（关闭）永远不锁定');
{
  const st = createLatchState();
  latchEvent(st, 'f10', 'down', 1000, 0);
  const u = latchEvent(st, 'f10', 'up', 99000, 0);
  ok(u.mic === 'stop' && u.inject === 'up' && st.latched === null, '按再久也正常关麦');
}

console.log('[T5] 杂散事件鲁棒性');
{
  const st = createLatchState();
  ok(Object.keys(latchEvent(st, 'f10', 'up', 1000, 5000)).length === 0, '无 down 的孤儿 up 忽略');
  latchEvent(st, 'f10', 'down', 1000, 5000);
  latchEvent(st, 'f10', 'up', 9000, 5000); // 锁定
  ok(Object.keys(latchEvent(st, 'f10', 'up', 9200, 5000)).length === 0, '锁定键的杂散 up 忽略（不二次动作）');
}

console.log('[T6] 双键同按：一个锁定后另一个短按释放——麦保持（由锁定键负责）');
{
  const st = createLatchState();
  latchEvent(st, 'f10', 'down', 1000, 5000);
  latchEvent(st, 'mouse_x1', 'down', 2000, 5000);
  latchEvent(st, 'f10', 'up', 8000, 5000);   // f10 锁定（7s ≥ 5s）
  const u = latchEvent(st, 'mouse_x1', 'up', 4000 + 5000, 5000); // 侧键按住 7s？
  // 侧键按住 2000→9000 = 7s ≥ 5s，但它到时锁定位已被占 → 正常抬键、麦保持
  ok(u.inject === 'up' && u.mic === null, '锁定位被占时另一个键抬起：只抬注入键，不关麦');
  ok(st.latched === 'f10', '锁定仍在 f10');
  const d = latchEvent(st, 'mouse_x1', 'down', 12000, 5000);
  ok(d.latch === 'off' && d.injectKey === 'f10', '再按结束锁定，抬起 f10');
}

console.log('[T7] resetLatch 兜底（断线/手动停麦）');
{
  const st = createLatchState();
  latchEvent(st, 'f10', 'down', 1000, 5000);
  latchEvent(st, 'f10', 'up', 9000, 5000);
  ok(resetLatch(st) === 'f10', '返回被锁定键（调用方补抬注入）');
  ok(st.latched === null && st.holds.size === 0, '状态清空');
  ok(resetLatch(st) === null, '未锁定时返回 null');
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
