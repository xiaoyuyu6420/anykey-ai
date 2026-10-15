// 说话键「长按锁定」状态机（纯函数，无依赖，单测覆盖）：
//   正常：按下开麦、抬起关麦（按住说话）
//   长按 ≥ latchMs 后抬起：不关麦不抬注入键——保持说话状态（锁定）
//   锁定中再按一下任意说话键：结束锁定（关麦 + 抬起被锁定键的注入）
//
// 本模块只做判定不碰副作用；index.js 按返回的指令执行：
//   inject: 'down'        —— 注入该键 down
//   inject: 'up'          —— 注入该键 up（injectKey 指定目标，默认=keyId；
//                            结束锁定时被抬起的可能是另一个键）
//   mic:    'start'/'stop'—— 固件开麦/关麦
//   latch:  'on'/'off'    —— 状态变化（日志/UI 用）
//
// state = { latched, holds, consumed }：
//   latched  —— 当前锁定的 keyId（null=未锁定）
//   holds    —— Map<keyId, 按下时刻>
//   consumed —— 「结束锁定」的那次按压；它的 up 不再触发任何动作

function createLatchState() {
  return { latched: null, holds: new Map(), consumed: new Set() };
}

function latchEvent(st, keyId, phase, now, latchMs) {
  if (phase === 'down') {
    if (st.latched) {
      // 再按一下 = 结束锁定；本次按压消耗掉（随后的 up 忽略）
      const rel = st.latched;
      st.latched = null;
      st.holds.delete(rel);
      st.consumed.add(keyId);
      return { inject: 'up', injectKey: rel, mic: 'stop', latch: 'off' };
    }
    st.holds.set(keyId, now);
    return { inject: 'down', mic: 'start' };
  }
  // up
  if (st.consumed.delete(keyId)) return {};       // 「结束锁定」按压的尾巴
  if (st.latched === keyId) return {};            // 锁定键的杂散 up（去重漏网等）
  const t0 = st.holds.get(keyId);
  if (t0 == null) return {};                      // 无 down 记录的孤儿 up
  st.holds.delete(keyId);
  // 长按达标 → 锁定：不抬注入键、不关麦
  if (!st.latched && latchMs > 0 && now - t0 >= latchMs) {
    st.latched = keyId;
    return { latch: 'on' };
  }
  // 正常抬起：抬注入键；另有别的键处于锁定态时麦保持（它负责后续的 stop）
  return { inject: 'up', mic: st.latched ? null : 'stop' };
}

// 断线/手动停麦兜底：清空状态，返回需要补抬注入键的 keyId（无则 null）。
// 调用方负责：若返回非 null 且该键注入过（ptDecision 有记录），补发 up。
function resetLatch(st) {
  const rel = st.latched;
  st.latched = null;
  st.holds.clear();
  st.consumed.clear();
  return rel;
}

module.exports = { createLatchState, latchEvent, resetLatch };
