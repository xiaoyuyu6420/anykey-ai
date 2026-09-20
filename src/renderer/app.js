// 设置页逻辑：键位列表 + 动作编辑 + 实时按键高亮标定

import { createKeyboard3D, setRenderPaused } from './kb3d.js';
import { animate, stagger } from '../../vendor/animejs/anime.esm.min.js';

const TYPES = [
  { value: 'none',    label: '不动作' },
  { value: 'app',     label: '启动程序' },
  { value: 'url',     label: '打开网址' },
  { value: 'hotkey',  label: '发送快捷键' },
  { value: 'macro',   label: '宏（录制按键）' },
  { value: 'sys',     label: '系统：循环切档' },
];

let state = null; // { keys, bindings, bindingsAi, settings, deviceConnected }
let currentMode = 'fn'; // 'fn' 普通模式 | 'ai' AI 模式（两套绑定独立配置）
let macroRecordingRow = null; // 正在录制宏的键行（超时自动停时回填）

init();

// ---------- 顶栏状态中心：●在线 · 通道 · RTT [重连] ----------
// 把会话层的自愈过程（探测/换口/劣化重连）从暗箱变成可见：断线原因人话化
const REASON_ZH = [
  [/^probing/, '正在寻找键盘…'],
  [/^no-cmd-interface/, '未发现键盘'],
  [/^open-failed.*(already open|exclusive)/i, '设备句柄被占用，重试中'],
  [/^open-failed/, '打开设备失败，重试中'],
  [/^handshake-timeout\((.+)\)/, m => `${m[1]} 口无回应，换口中`],
  [/^read-error|^read-throw/, '连接中断，重连中'],
  [/^write-failed/, '链路写入失败，重连中'],
  [/^heartbeat-lost/, '心跳丢失，重连中'],
  [/^link-degraded|^audio-degraded/, '链路劣化，自动重连'],
  [/^voice-stuck/, '语音流卡死，重连复位'],
  [/^manual-reconnect/, '手动重连中'],
];
function reasonZh(r) {
  if (!r) return '';
  for (const [re, zh] of REASON_ZH) {
    const m = r.match(re);
    if (m) return typeof zh === 'function' ? zh(m) : zh;
  }
  return r.length > 24 ? r.slice(0, 24) + '…' : r;
}

function initStatusPill() {
  const pill = document.getElementById('session-pill');
  const pillText = document.getElementById('session-pill-text');
  const btnReconnect = document.getElementById('session-reconnect');
  const detail = {
    online: !!state.sessionOnline, device: !!state.deviceConnected,
    transport: '', rtt: 0, reason: '',
  };
  const render = () => {
    const up = detail.online || detail.device;
    pill.classList.toggle('on', !!up);
    pill.classList.toggle('off', !up);
    if (detail.online) {
      const parts = ['在线'];
      if (detail.transport) parts.push(detail.transport);
      if (detail.rtt > 0) parts.push(`RTT ${detail.rtt}ms`);
      pillText.textContent = parts.join(' · ');
    } else if (detail.device) {
      pillText.textContent = '键盘已连接 · 会话离线';
    } else {
      pillText.textContent = reasonZh(detail.reason) || '键盘未连接';
    }
    pill.title = detail.reason ? `原始状态：${detail.reason}` : '键盘链路状态';
  };
  window.aikey.onDeviceStatus(c => { detail.device = !!c; render(); });
  window.aikey.onSessionStatus(on => { detail.online = !!on; render(); });
  window.aikey.onSessionDetail(d => { Object.assign(detail, d); render(); });
  btnReconnect.hidden = false; // 常显：蓝牙半死（在线但失灵）时 UI 直接重连，不用去托盘找
  btnReconnect.onclick = () => {
    btnReconnect.disabled = true;
    btnReconnect.textContent = '重连中…';
    window.aikey.reconnectSession();
    // 主进程 state/detail 事件到达时会刷新胶囊；这里只兜底恢复按钮
    setTimeout(() => { btnReconnect.disabled = false; btnReconnect.textContent = '重连'; }, 3000);
  };
  render();
}

async function init() {
  state = await window.aikey.getState();

  initStatusPill();

  const optAuto = document.getElementById('opt-autostart');
  optAuto.checked = !!state.settings.autostart;
  optAuto.onchange = () => window.aikey.setSettings({ autostart: optAuto.checked });

  renderList();
  initModeTabs();
  initProfiles();
  initPageNav();
  initHero();
  initModalShell();
  initReveal();

  initMicBridge();
  initSound();
  initStats();
  initAiLayer();

  // 托盘隐藏/最小化 → 停 3D 渲染循环（主进程同时会开页面节流，双保险省一个核以上）
  window.aikey.onAppVisibility(visible => setRenderPaused(!visible));

  // 宏 30s 超时自动停 → 回填正在录制的行
  window.aikey.onMacroRecorded(data => {
    const row = macroRecordingRow;
    macroRecordingRow = null;
    if (!row || !row.isConnected) return;
    row._recording = false;
    row._macroSteps = data.steps || [];
    if (row._rerenderFields) row._rerenderFields();
    toast(`录制超时自动停止，已录 ${(data.steps || []).length} 步`);
  });

  window.aikey.onKeyEvent(ev => {
    if (ev.phase !== 'down') return;
    // RK 键盘 AI/F 区按键走 HID 上报而非 DOM KeyboardEvent：捕获状态下在这里
    // 吃掉该事件填进捕获框，否则这类键（如 F10）永远捕获不到（PR#14 kaiwen743）
    const captureBtn = document.querySelector('button.capturing');
    if (captureBtn && captureBtn._captureInput && ev.keyId) {
      captureBtn._captureInput.value = String(ev.keyId).toLowerCase();
      stopCapture(captureBtn);
      return;
    }
    const row = document.querySelector(`.key-row[data-id="${ev.keyId}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 600);
  });
  console.log('[ui] init complete', state.profiles ? `档位 x${state.profiles.order.length}` : '');
}

// ---------- 顶层页面切换（按键映射 / 打字统计） ----------
function initPageNav() {
  const tabs = document.querySelectorAll('.page-tab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      if (tab.classList.contains('active')) return;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      document.getElementById('page-keys').hidden = tab.dataset.page !== 'keys';
      document.getElementById('page-stats').hidden = tab.dataset.page !== 'stats';
      if (tab.dataset.page === 'stats') { ensureStatsKb(); refreshStats(); } // 切进来立即刷新一次
    };
  });
}

// ---------- 模式 tab + 键盘当前模式徽章 ----------
function initModeTabs() {
  const badge = document.getElementById('kb-mode-badge');
  const setBadge = on => {
    badge.textContent = on ? '键盘：AI 模式' : '键盘：普通模式';
    badge.classList.toggle('ai', !!on);
  };
  window.aikey.onAiMode(setBadge);
  setBadge(!!state.aiMode);

  // 电池徽章（cmd=208 键盘主动上报）
  const bat = document.getElementById('battery-badge');
  window.aikey.onBattery(b => {
    bat.hidden = false;
    bat.textContent = `${b.charging ? '⚡' : '🔋'}${b.level}%`;
  });

  const tabs = document.querySelectorAll('.mode-tab');
  tabs.forEach(tab => {
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.title = '此模式下已自定义的键数';
    tab.appendChild(cnt);
    tab.onclick = () => {
      if (currentMode === tab.dataset.mode) return;
      currentMode = tab.dataset.mode;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      renderList();
    };
  });
  updateTabCounts();
}

// tab 上的「已自定义键数」角标：两个模式的配置分叉程度一眼可见
//（初次两份相同是迁移拷贝，之后各改各的，数字就开始不同）
function updateTabCounts() {
  const count = map => Object.values(map || {}).filter(b => b && b.type && b.type !== 'none').length;
  document.querySelector('#tab-fn .cnt').textContent = count(state.bindings) || '';
  document.querySelector('#tab-ai .cnt').textContent = count(state.bindingsAi) || '';
}

const bindingsOf = () => (currentMode === 'ai' ? state.bindingsAi : state.bindings) || {};

// ---------- 配置档（多套键位一键切换 + 前台应用自动切档） ----------
function initProfiles() {
  renderProfileChips();
  initAppRules();
  // 主进程切档（托盘/自动/按键循环/删档回落）→ 拉新投影整体刷新
  window.aikey.onProfileChanged(async d => {
    state = await window.aikey.getState();
    renderProfileChips();
    renderList();
    updateTabCounts();
    if (d.reason === 'del') toast(`档已删除，回落到「${d.name}」`);
    else if (d.reason !== 'manual') toast(`已切到「${d.name}」档`);
  });
}

function renderProfileChips() {
  const box = document.getElementById('profile-chips');
  const p = state.profiles || { order: ['default'], names: { default: '默认' }, activeId: 'default', max: 5 };
  box.innerHTML = '';
  for (const id of p.order) {
    const chip = document.createElement('button');
    chip.className = 'profile-chip' + (id === p.activeId ? ' active' : '');
    chip.title = id === p.activeId ? '当前档' : '点击切换到此档';
    const label = document.createElement('span');
    label.textContent = p.names[id] || id;
    chip.appendChild(label);
    if (id !== 'default') {
      const del = document.createElement('span');
      del.className = 'chip-del';
      del.textContent = '✕';
      del.title = '删除此档（默认档不可删）';
      del.onclick = async e => {
        e.stopPropagation();
        if (!confirm(`删除档「${p.names[id]}」？该档键位与关联的自动切档规则一并删除。`)) return;
        const r = await window.aikey.profileOp({ op: 'del', id });
        if (r && r.ok === false) toast(r.error, true);
      };
      chip.appendChild(del);
    }
    chip.onclick = async () => {
      if (id === p.activeId) return;
      const r = await window.aikey.profileOp({ op: 'set-active', id });
      if (r && r.ok) {
        state = await window.aikey.getState(); // bindings 已是新档投影
        renderProfileChips();
        renderList();
        updateTabCounts();
      } else if (r) toast(r.error, true);
    };
    chip.ondblclick = () => { // 行内重命名（Electron 无 window.prompt）
      chip.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = p.names[id] || '';
      chip.appendChild(input);
      input.focus(); input.select();
      const commit = async () => {
        const name = input.value.trim();
        if (name && name !== p.names[id]) {
          const r = await window.aikey.profileOp({ op: 'rename', id, name });
          if (r && r.ok) state.profiles = r.profiles;
        }
        renderProfileChips();
      };
      input.onblur = commit;
      input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = ''; input.blur(); } };
    };
    box.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'profile-chip add';
  add.textContent = '＋';
  add.title = p.order.length >= p.max ? `已达上限（${p.max} 档）` : '新增档（复制当前档键位，双击可改名）';
  add.disabled = p.order.length >= p.max;
  add.onclick = async () => {
    const r = await window.aikey.profileOp({ op: 'add', name: `档${p.order.length + 1}` });
    if (r && r.ok) {
      state.profiles = r.profiles;
      renderProfileChips();
      toast('已新增档（复制了当前档键位），双击档名可改');
    } else if (r) toast(r.error, true);
  };
  box.appendChild(add);
}

// 前台应用自动切档规则：进程名 → 档位
function initAppRules() {
  const box = document.getElementById('app-rules');
  const addBtn = document.getElementById('rule-add');
  if (state.profiles && state.profiles.fgSupported === false) {
    document.getElementById('fg-platform-hint').textContent = '（自动检测仅 Windows，此处规则在 mac 上不生效）';
  }

  const save = async () => {
    const p = state.profiles;
    const rules = [];
    box.querySelectorAll('.rule-row').forEach(row => {
      const name = row.querySelector('.rule-name').value.trim().toLowerCase();
      const profileId = row.querySelector('.rule-profile').value;
      if (name && p.order.includes(profileId)) rules.push({ profileId, name });
    });
    const r = await window.aikey.profileOp({ op: 'set-rules', rules });
    if (r && r.ok) state.profiles = r.profiles;
  };

  const renderRules = () => {
    const p = state.profiles;
    box.innerHTML = '';
    const rules = (p && p.appRules) || [];
    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      const name = document.createElement('input');
      name.className = 'rule-name';
      name.type = 'text';
      name.placeholder = '进程名，如 wechat.exe';
      name.value = rule.name;
      name.onblur = save;
      const sel = document.createElement('select');
      sel.className = 'rule-profile';
      for (const id of p.order) {
        const o = document.createElement('option');
        o.value = id; o.textContent = p.names[id] || id;
        sel.appendChild(o);
      }
      sel.value = rule.profileId;
      sel.onchange = save;
      const del = document.createElement('button');
      del.className = 'ghost-btn';
      del.textContent = '✕';
      del.onclick = () => { row.remove(); save(); };
      row.append(name, sel, del);
      box.appendChild(row);
    }
    if (!rules.length) {
      const empty = document.createElement('span');
      empty.className = 'none-hint';
      empty.textContent = '还没有规则——点「添加规则」选一个程序（或手填进程名如 game.exe），切到该程序时自动换键位档';
      box.appendChild(empty);
    }
  };

  addBtn.onclick = async () => {
    const p = state.profiles;
    let name = '';
    try {
      const path = await window.aikey.pickProgram();
      if (path) name = (path.split(/[\\/]/).pop() || '').toLowerCase();
    } catch (_) { /* 选择器失败走手填 */ }
    if (name) {
      const r = await window.aikey.profileOp({ op: 'set-rules', rules: [...(p.appRules || []), { profileId: p.activeId, name }] });
      if (r && r.ok) state.profiles = r.profiles;
      renderRules();
    } else {
      p.appRules = [...(p.appRules || []), { profileId: p.activeId, name: '' }];
      renderRules();
      const rows = box.querySelectorAll('.rule-row');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('.rule-name').focus();
    }
  };
  renderRules();
}


function renderList() {
  const list = document.getElementById('key-list');
  closeKeyModal(); // 列表重建前归还浮层借出的行（无 modal 时空操作）
  list.innerHTML = '';
  for (const key of state.keys) {
    const binding = bindingsOf()[key.id] || { type: 'none' };
    list.appendChild(buildRow(key, binding));
  }
  if (kb3d) kb3d.setConfigured(configuredIds());
}

function configuredIds() {
  return Object.entries(bindingsOf())
    .filter(([, b]) => b && b.type && b.type !== 'none')
    .map(([id]) => id);
}

// ---------- 3D 首屏（WebGL 不可用时自动降级为纯列表） ----------
let kb3d = null;
let introPlayed = false; // 渲染层进程与托盘常驻进程同生命周期：每次 App 启动只播一次
function initHero() {
  const host = document.getElementById('hero-canvas');
  const wantIntro = !introPlayed && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  introPlayed = true;
  try {
    kb3d = createKeyboard3D(host, { onKeyClick: openKeyModal, intro: wantIntro });
    kb3d.setConfigured(configuredIds());
    window.__kb3d = kb3d; // 调试/自动化验证钩子（projectKey/getConfigured/getRotation）
  } catch (e) {
    console.warn('[ui] 3D 首屏不可用，降级为列表', e);
    document.getElementById('hero3d').hidden = true;
    kb3d = null;
    return;
  }
  if (wantIntro) playIntro();
  const btn = document.getElementById('view-toggle');
  btn.onclick = () => {
    const hero = document.getElementById('hero3d');
    const hide = !hero.hidden;
    hero.hidden = hide;
    btn.textContent = hide ? '返回 3D 首屏' : '纯列表模式';
  };
}

// 开机时间线：标题逐字浮现（kb3d 内部同时做键帽逐键升起）
function playIntro() {
  const h2 = document.querySelector('#hero-title h2');
  const sub = document.querySelector('#hero-title p');
  if (!h2) return;
  h2.innerHTML = h2.textContent.split('').map(c => `<span class="ch">${c}</span>`).join('');
  animate('#hero-title .ch', {
    opacity: [0, 1], translateY: [16, 0], filter: ['blur(6px)', 'blur(0px)'],
    delay: stagger(40, { start: 150 }), duration: 650, ease: 'out(3)',
  });
  animate(sub, {
    opacity: [0, .9], translateY: [10, 0],
    delay: 700, duration: 600, ease: 'out(3)',
  });
  if (kb3d) kb3d.playIntro();
}

// ---------- 3D 键位点击 → 玻璃配置浮层（复用列表行 DOM，零逻辑重复） ----------
function initModalShell() {
  document.getElementById('modal-close').onclick = closeKeyModal;
  document.getElementById('key-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeKeyModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeKeyModal(); });
}

function openKeyModal(keyId) {
  const row = document.querySelector(`#key-list .key-row[data-id="${keyId}"]`);
  if (!row) return;
  row._modalReturn = { parent: row.parentNode, next: row.nextSibling };
  const def = state.keys.find(k => k.id === keyId);
  document.getElementById('modal-key-name').textContent = def ? def.label : keyId;
  document.getElementById('modal-row').appendChild(row);
  document.getElementById('key-modal').hidden = false;
}

function closeKeyModal() {
  const modal = document.getElementById('key-modal');
  if (modal.hidden) return;
  const row = document.querySelector('#modal-row .key-row');
  if (row && row._modalReturn) {
    row._modalReturn.parent.insertBefore(row, row._modalReturn.next);
    row._modalReturn = null;
  }
  modal.hidden = true;
}

function buildRow(key, binding) {
  const row = document.createElement('div');
  row.className = 'key-row';
  // 已配置的键带霓虹光点（与 3D 首屏「已配置发光」同一语言）
  if (binding.type && binding.type !== 'none') row.classList.add('configured');
  row.dataset.id = key.id;

  // 键名（双击改名）
  const name = document.createElement('div');
  name.className = 'key-name';
  name.innerHTML = `${escapeHtml(key.label)}<small>键码 ${key.code}</small>`;
  name.title = '双击修改备注名';
  name.ondblclick = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = key.label;
    name.innerHTML = '';
    name.appendChild(input);
    input.focus(); input.select();
    const commit = async () => {
      key.label = input.value.trim() || key.label;
      await window.aikey.setBinding('__label__:' + key.id, { label: key.label });
      name.innerHTML = `${escapeHtml(key.label)}<small>键码 ${key.code}</small>`;
    };
    input.onblur = commit;
    input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = key.label; input.blur(); } };
  };

  // 动作类型
  const typeSel = document.createElement('select');
  for (const t of TYPES) {
    const o = document.createElement('option');
    o.value = t.value; o.textContent = t.label;
    typeSel.appendChild(o);
  }
  typeSel.value = binding.type;

  const fields = document.createElement('div');
  fields.className = 'action-fields';

  const renderFields = () => {
    fields.innerHTML = '';
    const t = typeSel.value;
    if (t === 'none') {
      const span = document.createElement('span');
      span.className = 'none-hint';
      span.textContent = '此键位不触发任何动作，原按键功能完全保留';
      fields.appendChild(span);
      return;
    }
    if (t === 'app' || t === 'url') {
      const target = document.createElement('input');
      target.type = 'text';
      target.placeholder = t === 'app' ? 'C:\\...\\app.exe（要带参数请指向 .bat）' : 'https://...';
      target.value = binding.target || '';
      fields.appendChild(target);

      if (t === 'app') {
        const browse = document.createElement('button');
        browse.textContent = '浏览…';
        browse.className = 'fixed';
        browse.onclick = async () => {
          const p = await window.aikey.pickProgram();
          if (p) target.value = p;
        };
        fields.appendChild(browse);
      }

      const after = document.createElement('label');
      after.className = 'after-line';
      after.innerHTML = `启动后 <input type="number" min="0" step="100" value="${Number(binding.afterDelay ?? 800) || 800}" style="width:60px"/> ms 发 <input type="text" placeholder="可选" value="${escapeAttr(binding.afterHotkey || '')}"/> <button type="button" class="cap-after">捕获</button>`;
      attachCapture(after.querySelector('button.cap-after'), after.querySelector('input[type=text]'));
      fields.appendChild(after);
    }
    if (t === 'hotkey') {
      const combo = document.createElement('input');
      combo.type = 'text';
      combo.readOnly = false; // 允许手动输入：系统保留组合键（如 Win+G）页面收不到，只能手敲
      combo.addEventListener('keydown', e => e.stopPropagation()); // 输入不被全局键盘处理打断
      combo.placeholder = '点击「捕获」直接按组合键';
      combo.value = binding.combo || '';
      fields.appendChild(combo);
      const cap = document.createElement('button');
      cap.className = 'fixed';
      cap.textContent = '捕获';
      attachCapture(cap, combo);
      fields.appendChild(cap);
    }
    if (t === 'macro') {
      row._macroSteps = row._macroSteps || binding.steps || [];
      const box = document.createElement('div');
      box.className = 'macro-box';
      // 步骤预览（键名 + 与上步间隔）
      const list = document.createElement('div');
      list.className = 'macro-steps';
      const steps = row._macroSteps || [];
      if (steps.length) {
        const show = steps.slice(0, 14);
        for (const s of show) {
          const item = document.createElement('span');
          item.className = 'macro-step';
          item.textContent = `${s.down ? '↓' : '↑'}${keyLabel(s.name)}${s.dt > 60 ? ` +${Math.round(s.dt)}ms` : ''}`;
          list.appendChild(item);
        }
        if (steps.length > show.length) {
          const more = document.createElement('span');
          more.className = 'macro-step more';
          more.textContent = `…共 ${steps.length} 步`;
          list.appendChild(more);
        }
      } else {
        const empty = document.createElement('span');
        empty.className = 'none-hint';
        empty.textContent = '未录制';
        list.appendChild(empty);
      }
      box.appendChild(list);
      // 控制按钮
      const ctrl = document.createElement('div');
      ctrl.className = 'macro-ctrl';
      const recBtn = document.createElement('button');
      recBtn.className = 'fixed';
      recBtn.onclick = async () => {
        if (!row._recording) {
          const r = await window.aikey.macroOp({ op: 'start' });
          if (!r.ok) { toast(r.error, true); return; }
          row._recording = true;
          macroRecordingRow = row;
          toast('录制中… 直接按键（最长 30 秒，再点「停止」结束）');
        } else {
          const r = await window.aikey.macroOp({ op: 'stop' });
          row._recording = false;
          macroRecordingRow = null;
          if (r.ok) {
            row._macroSteps = r.steps || [];
            toast(`已录 ${row._macroSteps.length} 步，记得点「保存」`);
          } else toast(r.error, true);
          renderFields();
          return;
        }
        recBtn.textContent = '■ 停止';
        recBtn.classList.add('recording');
      };
      recBtn.textContent = row._recording ? '■ 停止' : '● 录制';
      recBtn.classList.toggle('recording', !!row._recording);
      const playBtn = document.createElement('button');
      playBtn.textContent = '▶ 试听';
      playBtn.onclick = async () => {
        if (!row._macroSteps || !row._macroSteps.length) { toast('宏为空，先录制', true); return; }
        const r = await window.aikey.testAction({ type: 'macro', steps: row._macroSteps });
        if (r && r.ok === false) toast(r.error, true);
      };
      const clearBtn = document.createElement('button');
      clearBtn.textContent = '清除';
      clearBtn.onclick = () => { row._macroSteps = []; renderFields(); };
      ctrl.append(recBtn, playBtn, clearBtn);
      box.appendChild(ctrl);
      const hint = document.createElement('div');
      hint.className = 'none-hint';
      hint.textContent = '录制期间键盘绑定动作暂停执行、原按键照常透传（可在目标输入框实时看到）；只录标准系统键，AI 扩展键位不进录制。';
      box.appendChild(hint);
      fields.appendChild(box);
    }
    if (t === 'sys') {
      const span = document.createElement('span');
      span.className = 'none-hint';
      span.textContent = '按下此键在全部键位档之间循环切换';
      fields.appendChild(span);
    }
    // 透传开关：仅对有「原按键功能」的键（F1-F12/PrtSc）显示；AI 键/扩展键位无原功能
    if (/^(f\d{1,2}|prtsc)$/.test(key.id)) {
      const pass = document.createElement('label');
      pass.className = 'pass-line';
      pass.innerHTML = '<input type="checkbox"/> 同时保留原按键功能（透传：如 F10 输入法语音、亮度/音量键照常生效）';
      pass.querySelector('input').checked = binding.passthrough === true;
      pass.title = '不勾 = 绑定动作后独占此键，原功能屏蔽；勾选 = 动作和原功能同时触发';
      fields.appendChild(pass);
    }
  };
  renderFields();
  typeSel.onchange = renderFields;

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const testBtn = document.createElement('button');
  testBtn.textContent = '测试';
  testBtn.onclick = () => runRow(row, { silentFailToast: true });
  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary'; // 霓虹主按钮：全页唯一强彩色操作
  saveBtn.textContent = '保存';
  saveBtn.onclick = () => runRow(row, { save: true });
  actions.append(testBtn, saveBtn);

  // 从当前行 DOM 收集 action
  function collect() {
    const t = typeSel.value;
    const input = fields.querySelector('input[type=text]');
    const action = { type: t };
    if (t === 'app' || t === 'url') action.target = input.value.trim();
    if (t === 'hotkey') action.combo = input.value.trim();
    if (t === 'macro') action.steps = row._macroSteps || [];
    if (t === 'sys') action.op = 'profile-cycle';
    if (t === 'app' || t === 'url') {
      const nums = fields.querySelectorAll('input[type=number]');
      const texts = fields.querySelectorAll('label.after-line input[type=text]');
      if (nums[0]) action.afterDelay = Number(nums[0].value) || 0;
      if (texts[0] && texts[0].value.trim()) action.afterHotkey = texts[0].value.trim();
    }
    const passCb = fields.querySelector('label.pass-line input');
    if (passCb && passCb.checked) action.passthrough = true; // 不勾/不可透传键 = 屏蔽（默认）
    return action;
  }

  row.collect = collect;
  row._rerenderFields = renderFields; // 宏超时自动停时从外部重渲染本行
  row.append(name, typeSel, fields, actions);
  return row;
}

async function runRow(row, { save = false } = {}) {
  const action = row.collect();
  if (save) {
    await window.aikey.setBinding(row.dataset.id, action, currentMode);
    bindingsOf()[row.dataset.id] = action;
    row.classList.toggle('configured', !!(action.type && action.type !== 'none'));
    if (kb3d) kb3d.setConfigured(configuredIds()); // 3D 键盘同步发光
    updateTabCounts();
    toast(`已保存「${row.dataset.id}」（${currentMode === 'ai' ? 'AI 模式' : '普通模式'}）`);
    return; // 保存只保存，不执行；想看效果点「测试」
  }
  const r = await window.aikey.testAction(action);
  if (r && r.ok === false) toast('失败: ' + r.error, true);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- 快捷键点击捕获（按钮进入捕获态，直接按组合键填入） ----------
// DOM code → 本应用键名（与 actions.js vkOf 同一套，macOS 上 Win 显示名即 Cmd）
const DOM_CODE_MAP = {
  Space:'space', Enter:'enter', Tab:'tab', Escape:'esc', Backspace:'backspace',
  Delete:'delete', Insert:'insert', ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  Home:'home', End:'end', PageUp:'pgup', PageDown:'pgdn', PrintScreen:'printscreen',
  CapsLock:'capslock', NumLock:'numlock', Minus:'minus', Equal:'equal', Comma:'comma',
  Period:'period', Slash:'slash', Backquote:'backtick', BracketLeft:'lbracket',
  BracketRight:'rbracket', Backslash:'backslash', Semicolon:'semicolon', Quote:'quote',
};
function domCodeToName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return 'f' + code.slice(1);
  if (/^Numpad\d$/.test(code)) return code.slice(6); // 小键盘数字按主键盘数字发
  return DOM_CODE_MAP[code] || null;
}
let captureHandlerInstalled = false;
function ensureCaptureHandler() {
  if (captureHandlerInstalled) return;
  captureHandlerInstalled = true;
  document.addEventListener('keydown', e => {
    const btn = document.querySelector('button.capturing');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(btn, true); return; }
    const name = domCodeToName(e.code);
    if (!name) return; // 只按了修饰键，继续等主键
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    // Win 键在部分 Windows 构建上第二键时 metaKey 为 false，用 getModifierState 兜底
    if (e.metaKey || e.getModifierState?.('Meta') || e.key === 'Meta' ||
        e.code === 'MetaLeft' || e.code === 'MetaRight') mods.push('Win');
    btn._captureInput.value = mods.length ? mods.join('+') + '+' + name : name;
    stopCapture(btn);
  }, true);
}
function stopCapture(btn, restore = false) {
  if (restore && btn._captureInput && btn._origValue !== undefined) btn._captureInput.value = btn._origValue;
  if (btn._captureInput) btn._captureInput.readOnly = false; // 任何结束路径都不能留下只读输入框
  btn.classList.remove('capturing');
  btn.textContent = '捕获';
}
function attachCapture(btn, input) {
  ensureCaptureHandler();
  btn._captureInput = input;
  input.readOnly = false;
  btn.onclick = () => {
    const on = !btn.classList.contains('capturing');
    document.querySelectorAll('button.capturing').forEach(stopCapture);
    if (on) {
      btn._origValue = input.value; // Esc 取消时回填
      btn.classList.add('capturing');
      btn.textContent = '按组合键…(Esc停)';
      input.readOnly = true; // 组合键已写入捕获框，别让最后一个键的字符再漏进输入框
      input.value = '';
      input.focus();
    }
  };
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 键盘麦克风 → 虚拟声卡桥接 ----------
// 主进程把解码后的 PCM（int16 LE @16kHz 单声道，约 120ms 一批）发过来，
// 这里经 WebAudio 播到用户选的输出设备（虚拟声卡的播放端，如 CABLE Input）。
const bridge = { ctx: null, node: null, queue: [], chunkOff: 0, enabled: false, sinkId: '', underruns: 0, _logTs: 0, _undLogTs: 0 };
// 桥接日志（限频 5s，force 绕过）经主进程落盘：微信输入法「唤不起/录到静音」类问题的唯一观测面
function bridgeLog(msg, force) {
  const now = Date.now();
  if (!force && now - bridge._logTs < 5000) return;
  bridge._logTs = now;
  try { window.aikey.log('[bridge] ' + msg); } catch (_) {}
}
let micLevelTimer = null;

async function initMicBridge() {
  const optBridge = document.getElementById('opt-mic-bridge');
  const selSink = document.getElementById('mic-sink');
  const badge = document.getElementById('mic-state-badge');
  const bar = document.getElementById('mic-level-bar');

  // 按住说话键（可设置，默认 F10 + AI 键）
  const triggerBox = document.getElementById('mic-trigger-keys');
  const shortName = id =>
    id === 'ai_key' ? 'AI' : id === 'prtsc' ? 'PrtSc' :
    /^f\d+$/.test(id) ? id.toUpperCase() :
    id.startsWith('ext_') ? '扩' + id.slice(4) : id;
  const triggerSet = new Set(state.settings.micTriggerKeys || ['f10', 'ai_key']);
  for (const k of state.keys) {
    const label = document.createElement('label');
    label.className = 'tk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = triggerSet.has(k.id);
    cb.onchange = async () => {
      cb.checked ? triggerSet.add(k.id) : triggerSet.delete(k.id);
      state.settings.micTriggerKeys = [...triggerSet];
      await window.aikey.setSettings({ micTriggerKeys: [...triggerSet] });
    };
    label.append(cb, document.createTextNode(shortName(k.id)));
    triggerBox.appendChild(label);
  }

  // 透传修饰键（仅 Windows：微信输入法「按住说话」强制组合键）
  if (navigator.userAgent.includes('Windows')) {
    const modRow = document.getElementById('mic-pass-mod-row');
    const modSel = document.getElementById('mic-pass-mod');
    modRow.hidden = false;
    modSel.value = state.settings.micPassMod || 'none';
    modSel.onchange = async () => {
      state.settings.micPassMod = modSel.value;
      await window.aikey.setSettings({ micPassMod: modSel.value });
    };

    // 远控防串键：语音键主键改发冷门键 F13，微信里配 Ctrl+F13，
    // 远程机器上的语音快捷键永远不会被串触
    const rsRow = document.getElementById('mic-remote-safe-row');
    const rsCb = document.getElementById('mic-remote-safe');
    let rsHint = null;
    const updateRsHint = () => {
      const on = rsCb.checked;
      const modOk = ['ctrl', 'alt', 'shift'].includes(modSel.value);
      const text = on
        ? `已开启：语音键实际发送 ${modSel.value.toUpperCase()}+F13${modOk ? '' : '（⚠ 上方透传修饰键选了「无」，不生效——请先选 Ctrl）'}。` +
          '在微信输入法里把「按住说话」配成 Ctrl+F13：打开它的快捷键录制框后按一次语音键即可自动录上。' +
          '远程机器不会误触自己的语音键；UU远程「设置→键盘→仅控制端响应的快捷键」加一条 F13 可彻底不转发。'
        : '';
      if (!text) { if (rsHint) { rsHint.remove(); rsHint = null; } return; }
      if (!rsHint) {
        rsHint = document.createElement('p');
        rsHint.className = 'sub';
        rsRow.after(rsHint);
      }
      rsHint.textContent = text;
    };
    rsRow.hidden = false;
    rsCb.checked = !!state.settings.remoteSafeMode;
    updateRsHint();
    rsCb.onchange = async () => {
      state.settings.remoteSafeMode = rsCb.checked;
      await window.aikey.setSettings({ remoteSafeMode: rsCb.checked });
      updateRsHint();
    };
    modSel.addEventListener('change', updateRsHint);
  }

  optBridge.checked = !!state.settings.micBridgeEnabled;
  optBridge.onchange = async () => {
    state.settings.micBridgeEnabled = optBridge.checked;
    await window.aikey.setSettings({ micBridgeEnabled: optBridge.checked });
    applyBridge();
  };

  selSink.onchange = async () => {
    state.settings.micSinkId = selSink.value;
    await window.aikey.setSettings({ micSinkId: selSink.value });
    applyBridge();
  };
  document.getElementById('mic-refresh').onclick = () => refreshSinks();

  window.aikey.onMicState(on => {
    badge.textContent = on ? '采集中' : '静音';
    badge.classList.toggle('on', !!on);
    if (!on) bar.style.width = '0%';
  });

  // 会话状态徽章 + 手动开麦按钮
  const btnMic = document.getElementById('mic-toggle');
  window.aikey.onSessionStatus(online => {
    badge.classList.toggle('offline', !online);
    if (btnMic) {
      btnMic.disabled = !online;
      btnMic.textContent = online ? '开始说话' : '会话离线';
    }
  });
  if (btnMic) {
    btnMic.disabled = !state.sessionOnline;
    btnMic.textContent = state.sessionOnline ? '开始说话' : '会话离线';
    let speaking = false;
    btnMic.onclick = async () => {
      speaking = !speaking;
      const r = await window.aikey.micControl(speaking);
      if (!r.ok) { speaking = false; }
      btnMic.textContent = speaking ? '停止' : '开始说话';
    };
    window.aikey.onMicState(on => {
      if (!on && speaking) { speaking = false; btnMic.textContent = '开始说话'; }
    });
  }

  window.aikey.onMicPcm(bytes => {
    if (!bridge.enabled || !bytes.length) {
      // 桥未就绪但主进程还在推 PCM：语音「录到静音」的直接证据，留痕
      if (bytes.length) bridgeLog(`PCM 丢弃：桥未就绪（enabled=${bridge.enabled}）`, true);
      return;
    }
    // int16 LE → float32
    const n = bytes.length >> 1;
    const f = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16;
      f[i] = v / 32768;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    bridge.queue.push(f);
    bridge.lastFeed = Date.now();
    // 防积压：超 5 帧（每帧 120ms 批 ≈ 600ms 缓冲）丢最旧。队首被丢弃时
    // chunkOff 必须归零——它指向的是旧队首的内部偏移，不重置会从新队首中间开始播（跳音）
    if (bridge.queue.length > 5) {
      bridge.queue.splice(0, bridge.queue.length - 5);
      bridge.chunkOff = 0;
    }
    // 电平条（限频刷新）
    if (peak > 0 && !micLevelTimer) {
      micLevelTimer = setTimeout(() => {
        micLevelTimer = null;
        bar.style.width = Math.min(100, peak / 327) + '%';
      }, 100);
    }
  });

  async function refreshSinks() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter(d => d.kind === 'audiooutput');
    selSink.innerHTML = '';
    for (const d of outs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      const label = d.label || `设备 ${d.deviceId.slice(0, 8)}`;
      opt.textContent = label + (/[ck][ai]?ble/i.test(label) ? '   ← 虚拟声卡' : '');
      selSink.appendChild(opt);
    }
    // 默认选中：保存过的 / 自动探测虚拟声卡（Windows VB-CABLE / macOS BlackHole）/ 默认设备
    const saved = state.settings.micSinkId;
    if (saved && outs.some(d => d.deviceId === saved)) {
      selSink.value = saved;
    } else {
      const cable = outs.find(d => /cable|blackhole|virtual|loopback/i.test(d.label || ''));
      if (cable) selSink.value = cable.deviceId;
      // 探测不到虚拟声卡时保持默认设备，但提示用户（否则语音进音箱、输入侧无声）
      else toast('未找到虚拟声卡（BlackHole/VB-CABLE），请手动选择播放设备', true);
    }
    bridge.sinkId = selSink.value;
    applyBridge();
  }

  function stopBridge() {
    if (bridge.node) { try { bridge.node.disconnect(); } catch (_) {} }
    if (bridge.ctx) { try { bridge.ctx.close(); } catch (_) {} }
    bridge.ctx = bridge.node = null;
    bridge.queue = [];
    bridge.chunkOff = 0; // 指向旧队首的内部偏移，不归零则重建后首帧从中间开始播（跳音）
    bridge.enabled = false;
  }

  function applyBridge() {
    stopBridge();
    if (!state.settings.micBridgeEnabled) return;
    try {
      const opts = { sampleRate: 16000 };
      if (bridge.sinkId && bridge.sinkId !== 'default') opts.sinkId = bridge.sinkId;
      bridge.ctx = new AudioContext(opts);
      const sinkLabel = selSink.selectedOptions[0] ? selSink.selectedOptions[0].textContent : bridge.sinkId;
      bridgeLog(`启动：请求 16k 实际 ${bridge.ctx.sampleRate}Hz，sink=${sinkLabel}`, true);
      bridge.ctx.onstatechange = () => bridgeLog(`AudioContext 状态 → ${bridge.ctx.state}`, true);
      const sp = bridge.ctx.createScriptProcessor(2048, 0, 1);
      sp.onaudioprocess = e => {
        const out = e.outputBuffer.getChannelData(0);
        let w = 0;
        while (w < out.length && bridge.queue.length) {
          const chunk = bridge.queue[0];
          const take = Math.min(chunk.length - bridge.chunkOff, out.length - w);
          out.set(chunk.subarray(bridge.chunkOff, bridge.chunkOff + take), w);
          bridge.chunkOff += take; w += take;
          if (bridge.chunkOff >= chunk.length) { bridge.queue.shift(); bridge.chunkOff = 0; }
        }
        if (w < out.length) {
          out.fill(0, w); // 欠载时补静音
          // 欠载=输入法录到空洞。仅统计「音频刚流过」的窗口——纯静音期队列本就为空
          if (bridge.lastFeed && Date.now() - bridge.lastFeed < 2000) {
            bridge.underruns++;
            if (Date.now() - bridge._undLogTs > 5000) {
              bridge._undLogTs = Date.now();
              bridgeLog(`缓冲欠载 ×${bridge.underruns}（队列=${bridge.queue.length}）`);
            }
          }
        }
      };
      sp.connect(bridge.ctx.destination);
      bridge.node = sp;
      bridge.enabled = true;
      if (bridge.ctx.state === 'suspended') bridge.ctx.resume();
    } catch (e) {
      bridgeLog(`桥接启动失败: ${e.message}`, true);
      toast('桥接启动失败: ' + e.message, true);
    }
  }

  await refreshSinks();
}

// ---------- 打字音效 ----------
function initSound() {
  const opt = document.getElementById('opt-sound');
  const packSel = document.getElementById('sound-pack');
  const vol = document.getElementById('sound-volume');
  const dirBtn = document.getElementById('sound-dir-btn');
  const dirName = document.getElementById('sound-dir-name');

  const syncCustom = () => {
    const custom = packSel.value === 'custom';
    dirBtn.hidden = !custom;
    dirName.hidden = !custom || !state.settings.soundCustomDir;
    dirName.textContent = state.settings.soundCustomDir || '';
  };

  opt.checked = !!state.settings.soundEnabled;
  packSel.value = state.settings.soundPack || 'blue';
  vol.value = Math.round((state.settings.soundVolume ?? 0.5) * 100);
  syncCustom();

  opt.onchange = async () => {
    state.settings.soundEnabled = opt.checked;
    await window.aikey.setSettings({ soundEnabled: opt.checked });
    if (opt.checked) toast('音效已开启，打几个字试试');
  };
  packSel.onchange = async () => {
    state.settings.soundPack = packSel.value;
    await window.aikey.setSettings({ soundPack: packSel.value });
    syncCustom();
  };
  dirBtn.onclick = async () => {
    const d = await window.aikey.pickDir();
    if (!d) return;
    state.settings.soundCustomDir = d;
    await window.aikey.setSettings({ soundCustomDir: d });
    syncCustom();
    toast('已设为自定义音色目录');
  };
  vol.onchange = async () => {
    state.settings.soundVolume = Number(vol.value) / 100;
    await window.aikey.setSettings({ soundVolume: Number(vol.value) / 100 });
  };
  document.getElementById('sound-test').onclick = async () => {
    if (!opt.checked) { toast('先勾「启用」', true); return; }
    const r = await window.aikey.soundTest();
    if (r && r.ok === false) toast('音效页未就绪', true);
  };
}

// ---------- AI 层：任意键盘 触发键+F1~F12 → 12 个动作槽位 ----------
let aiLayerConfig = null; // 主进程侧规范化后的配置（保存后以返回值为准）

async function initAiLayer() {
  const card = document.getElementById('ailayer-card');
  let st;
  try {
    st = await window.aikey.aiLayerOp({ op: 'get' });
  } catch (e) {
    console.log('[ailayer-ui] 初始化失败（卡片保持隐藏）:', e && e.message);
    return;
  }
  if (!st.supported) return; // 仅 Windows：卡片保持隐藏（RK 完整模式不受影响）
  card.hidden = false;
  console.log('[ailayer-ui] AI 层卡片已显示，触发键', st.config && st.config.trigger);
  aiLayerConfig = st.config || { enabled: false, trigger: 'ctrlalt', slots: {} };
  const slotKeys = st.slotKeys || [];

  const optEn = document.getElementById('opt-ailayer');
  const selTrigger = document.getElementById('ailayer-trigger');
  const status = document.getElementById('ailayer-status');
  const slotsEl = document.getElementById('ailayer-slots');

  const syncStatus = () => {
    status.textContent = aiLayerConfig.enabled ? '监听中' : '未启用';
    status.classList.toggle('on', !!aiLayerConfig.enabled);
  };

  const save = async patch => {
    const r = await window.aikey.aiLayerOp({ op: 'set', config: { ...aiLayerConfig, ...patch } });
    if (r && r.ok) { aiLayerConfig = r.config; syncStatus(); }
    else toast((r && r.error) || '保存失败', true);
  };

  optEn.onchange = () => save({ enabled: optEn.checked });
  selTrigger.onchange = () => save({ trigger: selTrigger.value });

  document.getElementById('ailayer-preset').onclick = async () => {
    const r = await window.aikey.aiLayerOp({ op: 'preset' });
    if (r && r.ok) {
      aiLayerConfig = r.config;
      syncStatus();
      renderSlots();
      toast('已填入 Coding 预设：F1 Claude · F2 ChatGPT · F3 Gemini · F4 语音输入 · F5 截图 · F6 记事本');
    }
  };

  const PLACEHOLDER = { app: 'C:/path/程序.exe', url: 'https://…', hotkey: 'Ctrl+Shift+S' };
  const SLOT_TYPES = [['none', '不动作'], ['app', '启动程序'], ['url', '打开网址'], ['hotkey', '快捷键']];
  function renderSlots() {
    slotsEl.innerHTML = '';
    for (const key of slotKeys) {
      const action = (aiLayerConfig.slots && aiLayerConfig.slots[key]) || { type: 'none' };
      const row = document.createElement('div');
      row.className = 'ailayer-row';

      const name = document.createElement('span');
      name.className = 'ailayer-key';
      name.textContent = key.toUpperCase();

      const sel = document.createElement('select');
      for (const [v, label] of SLOT_TYPES) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      // 高级动作（宏/系统等本编辑器不展开的类型）保留为选项，避免一渲染就被改写
      if (action.type && !SLOT_TYPES.some(([v]) => v === action.type)) {
        const o = document.createElement('option');
        o.value = action.type; o.textContent = `保留：${action.type}`;
        sel.appendChild(o);
      }
      sel.value = action.type || 'none';

      const input = document.createElement('input');
      input.value = action.target || action.combo || '';
      const syncInput = () => {
        input.hidden = sel.value === 'none';
        input.placeholder = PLACEHOLDER[sel.value] || '';
      };
      syncInput();

      // AI 直达：app/url 动作可带「启动后延时补发快捷键」，唤起/聚焦 AI 输入框
      let afterEl = null;
      const syncAfter = () => {
        const need = sel.value === 'app' || sel.value === 'url';
        if (need && !afterEl) {
          afterEl = document.createElement('div');
          afterEl.className = 'ailayer-after';
          afterEl.innerHTML = `<span>AI 直达：启动后</span><input type="number" min="0" step="100"/>` +
            `<span>ms 发</span><input type="text" placeholder="快捷键，如 Ctrl+L（留空关闭）"/>`;
          // 初始渲染时 row 还没挂上 DOM，等循环尾部统一插入
          if (row.isConnected) slotsEl.insertBefore(afterEl, row.nextSibling);
        } else if (!need && afterEl) {
          afterEl.remove();
          afterEl = null;
        }
        if (afterEl) {
          const [delayIn, hkIn] = afterEl.querySelectorAll('input');
          delayIn.value = Number(action.afterDelay ?? 800) || 800;
          hkIn.value = action.afterHotkey || '';
        }
      };
      syncAfter();

      const commit = () => {
        const v = input.value.trim();
        let a;
        if (sel.value === 'none') a = { type: 'none' };
        else if (sel.value === 'hotkey') a = { type: 'hotkey', combo: v };
        else {
          a = { type: sel.value, target: v };
          if (afterEl) {
            const [delayIn, hkIn] = afterEl.querySelectorAll('input');
            const hk = hkIn.value.trim();
            if (hk) { a.afterHotkey = hk; a.afterDelay = Number(delayIn.value) || 800; }
          }
        }
        // 同类型编辑时保留本 UI 不认知的字段（如手配的宏 steps），换类型才重置；
        // after* 由上面的输入框显式管理，不参与合并（否则清空关闭不生效）
        if (action.type === sel.value) {
          for (const [k, val] of Object.entries(action)) {
            if (k in a || k === 'afterHotkey' || k === 'afterDelay') continue;
            a[k] = val;
          }
        }
        save({ slots: { ...aiLayerConfig.slots, [key]: a } });
      };
      sel.onchange = () => {
        if (!SLOT_TYPES.some(([v]) => v === sel.value)) { sel.value = action.type || 'none'; return; }
        syncInput(); syncAfter(); commit();
      };
      input.onchange = commit;
      if (afterEl) for (const inp of afterEl.querySelectorAll('input')) inp.onchange = commit;

      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.textContent = '试';
      btn.title = '立即执行一次该动作';
      btn.onclick = async () => {
        commit();
        const r = await window.aikey.aiLayerOp({ op: 'test', key });
        if (r && r.ok === false) toast(r.error || '执行失败', true);
      };

      row.append(name, sel, input, btn);
      slotsEl.appendChild(row);
      if (afterEl && !afterEl.isConnected) slotsEl.insertBefore(afterEl, row.nextSibling);
    }
  }

  optEn.checked = !!aiLayerConfig.enabled;
  selTrigger.value = aiLayerConfig.trigger || 'ctrlalt';
  syncStatus();
  renderSlots();
}

// ---------- 打字统计 ----------
// 主进程轮询系统键状态计数，这里每 2 秒拉一次摘要渲染（窗口可见时才拉）。
const KEY_LABELS = {
  space: '空格', enter: '回车', backspace: '退格', tab: 'Tab', esc: 'Esc',
  up: '↑', down: '↓', left: '←', right: '→',
  home: 'Home', end: 'End', pgup: 'PgUp', pgdn: 'PgDn', delete: 'Del', insert: 'Ins',
  minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backtick: '`',
  lbracket: '[', rbracket: ']', backslash: '\\', semicolon: ';', quote: "'",
  ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win', fn: 'Fn',
};
function keyLabel(name) {
  if (KEY_LABELS[name]) return KEY_LABELS[name];
  if (/^[a-z0-9]$/.test(name) || /^f\d+$/.test(name)) return name.toUpperCase();
  return name;
}

let statsTimer = null;
// ---------- 打字统计页 ----------
let heatMode = 'today'; // 热力图数据源：today=今日 | life=累计寿命
let tkSort = 'count';   // 今日键位列表排序：count=按次数 | recent=按最近使用

function relTime(ts) {
  const dt = Date.now() - ts;
  if (!(dt >= 0)) return '';
  if (dt < 60e3) return '刚刚';
  if (dt < 3600e3) return Math.floor(dt / 60e3) + ' 分钟前';
  if (dt < 86400e3) return Math.floor(dt / 3600e3) + ' 小时前';
  return Math.floor(dt / 86400e3) + ' 天前';
}

function tkRow(name, count, max, countText) {
  const row = document.createElement('div');
  row.className = 'tk-row';
  const nm = document.createElement('span');
  nm.className = 'tk-name';
  nm.textContent = keyLabel(name);
  const bar = document.createElement('div');
  bar.className = 'tk-bar';
  bar.style.width = Math.max(3, Math.round(count / max * 100)) + '%';
  const ct = document.createElement('span');
  ct.className = 'tk-count';
  ct.textContent = countText != null ? countText : count;
  ct.title = `${count.toLocaleString()} 次`;
  row.append(nm, bar, ct);
  return row;
}

function initStats() {
  const opt = document.getElementById('opt-stats');
  opt.checked = state.settings.statsEnabled !== false;
  opt.onchange = async () => {
    state.settings.statsEnabled = opt.checked;
    await window.aikey.setSettings({ statsEnabled: opt.checked });
    refreshStats();
  };
  // 远控模式：暂停按键统计与轴体寿命累计（远控转发的按键不算本机实打字）
  const optRemote = document.getElementById('opt-remote');
  optRemote.checked = !!state.settings.remoteStatsPause;
  optRemote.onchange = () => {
    state.settings.remoteStatsPause = optRemote.checked;
    window.aikey.setSettings({ remoteStatsPause: optRemote.checked });
    toast(optRemote.checked ? '远控模式：按键统计已暂停' : '已恢复按键统计');
    refreshStats();
  };
  // 每日打字报告：canvas 绘制分享卡片 → 保存 PNG
  document.getElementById('stats-report').onclick = async () => {
    let s;
    try { s = await window.aikey.statsGet(); } catch (_) {}
    if (!s || s.supported === false) { toast('当前平台不支持统计', true); return; }
    const r = await window.aikey.saveReportPng(drawReport(s).toDataURL('image/png'));
    if (r && r.ok) toast('报告已保存');
  };
  // 疲劳提醒（连续打字满阈值弹系统通知）
  const optFat = document.getElementById('opt-fatigue');
  const fatMin = document.getElementById('fatigue-min');
  optFat.checked = state.settings.fatigueEnabled !== false;
  fatMin.value = state.settings.fatigueMinutes || 25;
  optFat.onchange = () => {
    state.settings.fatigueEnabled = optFat.checked;
    window.aikey.setSettings({ fatigueEnabled: optFat.checked });
  };
  fatMin.onchange = () => {
    const v = Math.max(5, Math.min(120, Number(fatMin.value) || 25));
    fatMin.value = v;
    state.settings.fatigueMinutes = v;
    window.aikey.setSettings({ fatigueEnabled: optFat.checked });
  };
  // 迷你分段切换：热力图数据源（今日/累计寿命）与键位列表排序（次数/最近）
  const wireMiniTabs = (id, set) => {
    const btns = document.querySelectorAll(`#${id} .mini-tab`);
    btns.forEach(b => {
      b.onclick = () => {
        set(b);
        btns.forEach(x => x.classList.toggle('active', x === b));
        refreshStats();
      };
    });
  };
  wireMiniTabs('heat-mode', b => { heatMode = b.dataset.m; });
  wireMiniTabs('tk-sort', b => { tkSort = b.dataset.s; });
  if (statsTimer) clearInterval(statsTimer);
  // 统计页可见时才轮询（切到统计页时会立即手动刷一次）
  statsTimer = setInterval(() => {
    if (!document.hidden && !document.getElementById('page-stats')?.hidden) refreshStats();
  }, 2000);
  refreshStats();
}

async function refreshStats() {
  let s;
  try { s = await window.aikey.statsGet(); } catch (_) { return; }
  const body = document.getElementById('stats-body');
  const unsup = document.getElementById('stats-unsupported');
  if (!s || s.supported === false) {
    body.hidden = true;
    unsup.hidden = false;
    return;
  }
  unsup.hidden = true;
  body.hidden = false;
  body.classList.toggle('dim', !s.enabled);

  // 今日总数
  document.getElementById('stats-today').textContent = (s.today.total || 0).toLocaleString();

  // 今日键位列表：按次数（Top5）或按最近使用（最近按过的排最前，附相对时间）
  const topBox = document.getElementById('stats-topkeys');
  topBox.innerHTML = '';
  if (tkSort === 'recent') {
    const lastTs = s.today.lastTs || {};
    const recent = Object.entries(s.today.keys || {})
      .filter(([n]) => lastTs[n])
      .sort((a, b) => (lastTs[b[0]] || 0) - (lastTs[a[0]] || 0))
      .slice(0, 5);
    const rmax = Math.max(1, ...recent.map(([, c]) => c));
    for (const [n, c] of recent) topBox.appendChild(tkRow(n, c, rmax, relTime(lastTs[n])));
    if (!recent.length) {
      const empty = document.createElement('span');
      empty.className = 'none-hint';
      empty.textContent = '今天还没有按键记录';
      topBox.appendChild(empty);
    }
  } else {
    const top = (s.today.topKeys || []).slice(0, 5);
    const max = top.length ? top[0].count : 0;
    for (const k of top) topBox.appendChild(tkRow(k.name, k.count, max));
    if (!top.length) {
      const empty = document.createElement('span');
      empty.className = 'none-hint';
      empty.textContent = '今天还没有按键记录';
      topBox.appendChild(empty);
    }
  }

  // 键位热力：3D 键盘逐键点亮（惰性创建：首次切到统计页才建 WebGL 上下文）。
  // 数据源可切：今日计数 / 累计寿命（lifetime.keys 全历史计数）
  if (kbStats) kbStats.setHeat(heatMode === 'life' ? (s.lifetime.keys || {}) : (s.today.keys || {}));

  // 轴体寿命（累计 ÷ 单键 5000 万次额定寿命，趣味估算）
  renderSwitchLife(s.lifetime);

  // 近 7 天柱状图
  const weekBox = document.getElementById('stats-week');
  weekBox.innerHTML = '';
  const wmax = Math.max(1, ...s.week.map(d => d.total || 0));
  const now = new Date(); // 主进程按本地时区记日，这里同样取本地日期
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const d of s.week) {
    const col = document.createElement('div');
    col.className = 'sw-col' + (d.date === todayStr ? ' today' : '');
    const slot = document.createElement('div');
    slot.className = 'sw-slot';
    const bar = document.createElement('div');
    bar.className = 'sw-bar';
    bar.style.height = Math.round((d.total || 0) / wmax * 100) + '%';
    bar.title = `${d.date}：${(d.total || 0).toLocaleString()} 次`;
    slot.appendChild(bar);
    const label = document.createElement('span');
    label.className = 'sw-label';
    label.textContent = d.date.slice(5); // MM-DD
    col.append(slot, label);
    weekBox.appendChild(col);
  }
}

// ---------- 每日打字报告：canvas 分享卡片 ----------
// 今日/本周/本月总数 + Top3 键 + 7 天柱图 + 轴体寿命 + 日期落款（纯按需生成）
function drawReport(s) {
  const W = 800, H = 1000, X = 56;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
  g.beginPath(); g.roundRect(24, 24, W - 48, H - 48, 20);
  g.fillStyle = '#171a21'; g.fill();
  let y = 100;

  // 标题 + 落款日期
  g.fillStyle = '#e8eaf0'; g.font = '600 32px system-ui, sans-serif';
  g.fillText('AnyKey AI · 打字报告', X, y);
  const now = new Date();
  g.fillStyle = '#8b93a3'; g.font = '15px system-ui, sans-serif';
  g.fillText(`${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`, X, y + 30);
  y += 86;

  // 三大数字：今日 / 本周 / 本月
  const sum = arr => (arr || []).reduce((a, d) => a + (d.total || 0), 0);
  const bigs = [
    ['今日', s.today.total || 0],
    ['本周（近 7 天）', sum(s.week)],
    ['本月（近 30 天）', sum(s.month)],
  ];
  const colW = (W - X * 2) / 3;
  bigs.forEach(([label, val], i) => {
    const cx = X + i * colW;
    g.fillStyle = '#8b93a3'; g.font = '14px system-ui, sans-serif';
    g.fillText(label, cx, y);
    g.fillStyle = '#4f8cff'; g.font = '600 44px system-ui, sans-serif';
    g.fillText(val.toLocaleString(), cx, y + 54);
  });
  y += 110;
  g.strokeStyle = '#2a2f3a'; g.beginPath(); g.moveTo(X, y); g.lineTo(W - X, y); g.stroke();
  y += 48;

  // 今日 Top3 键
  g.fillStyle = '#e8eaf0'; g.font = '600 20px system-ui, sans-serif';
  g.fillText('今日最爱按', X, y);
  y += 20;
  const top3 = (s.today.topKeys || []).slice(0, 3);
  if (top3.length) {
    const max = top3[0].count;
    top3.forEach((k, i) => {
      const ry = y + 22 + i * 52;
      g.fillStyle = '#8b93a3'; g.font = '15px system-ui, sans-serif';
      g.fillText(keyLabel(k.name), X, ry + 16);
      const barMax = W - X * 2 - 220;
      g.fillStyle = '#2a2f3a'; g.beginPath(); g.roundRect(X + 90, ry, barMax, 22, 11); g.fill();
      g.fillStyle = '#4f8cff'; g.beginPath();
      g.roundRect(X + 90, ry, Math.max(22, barMax * k.count / max), 22, 11); g.fill();
      g.fillStyle = '#e8eaf0'; g.font = '600 15px system-ui, sans-serif';
      g.fillText(k.count.toLocaleString(), X + 90 + barMax + 16, ry + 16);
    });
    y += 22 + top3.length * 52;
  } else {
    g.fillStyle = '#8b93a3'; g.font = '14px system-ui, sans-serif';
    g.fillText('今天还没有记录', X, y + 24);
    y += 46;
  }
  y += 42;

  // 近 7 天柱图
  g.fillStyle = '#e8eaf0'; g.font = '600 20px system-ui, sans-serif';
  g.fillText('近 7 天', X, y);
  y += 20;
  const wmax = Math.max(1, ...(s.week || []).map(d => d.total || 0));
  const bw = (W - X * 2 - 6 * 14) / 7;
  (s.week || []).forEach((d, i) => {
    const bx = X + i * (bw + 14);
    const bh = Math.round((d.total || 0) / wmax * 160);
    g.fillStyle = '#2a2f3a'; g.beginPath(); g.roundRect(bx, y + 190 - 160, bw, 160, 6); g.fill();
    if (bh > 0) {
      g.fillStyle = i === 6 ? '#7ee0a3' : '#4f8cff';
      g.beginPath(); g.roundRect(bx, y + 190 - bh, bw, bh, 6); g.fill();
    }
    g.fillStyle = '#8b93a3'; g.font = '12px system-ui, sans-serif';
    g.fillText(d.date.slice(5), bx + bw / 2 - 16, y + 210);
  });
  y += 262;

  // 轴体寿命：Top3 各自一条进度（每键 5000 万次额定寿命）
  const life = s.lifetime || { total: 0, keys: {} };
  const hardTop3 = Object.entries(life.keys || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  g.fillStyle = '#e8eaf0'; g.font = '600 20px system-ui, sans-serif';
  g.fillText('轴体寿命', X, y);
  g.fillStyle = '#8b93a3'; g.font = '14px system-ui, sans-serif';
  g.fillText(`累计 ${life.total.toLocaleString()} 次`, X, y + 28);
  y += 54;
  const barMax = W - X * 2 - 220;
  for (const [name, count] of hardTop3) {
    const pct = count / 50e6 * 100;
    g.fillStyle = '#8b93a3'; g.font = '15px system-ui, sans-serif';
    g.fillText(keyLabel(name), X, y + 16);
    g.fillStyle = '#2a2f3a'; g.beginPath(); g.roundRect(X + 90, y, barMax, 22, 11); g.fill();
    g.fillStyle = '#4f8cff'; g.beginPath();
    g.roundRect(X + 90, y, Math.max(22, barMax * pct / 100), 22, 11); g.fill();
    g.fillStyle = '#e8eaf0'; g.font = '600 15px system-ui, sans-serif';
    g.fillText(`${count.toLocaleString()} (${pct.toFixed(3)}%)`, X + 90 + barMax + 16, y + 16);
    y += 52;
  }
  y += 18;

  // 底部落款
  g.fillStyle = '#555c6b'; g.font = '13px system-ui, sans-serif';
  g.fillText('由 AnyKey AI 本机生成 · 数据仅存本机（保留 90 天）', X, H - 60);
  return cv;
}

// 轴体寿命：每个键各自算（单键 5000 万次额定寿命），按使用量排前 5 名
const SWITCH_LIFE = 50e6;
function renderSwitchLife(life) {
  const box = document.getElementById('switch-life');
  if (!box) return;
  box.innerHTML = '';
  const total = (life && life.total) || 0;
  const cap = document.createElement('div');
  cap.className = 'lifetime-total';
  cap.textContent = total ? `累计 ${total.toLocaleString()} 次` : '暂无累计数据（开始打字后出现）';
  box.appendChild(cap);
  const entries = Object.entries(life?.keys || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!entries.length) return;
  for (const [name, count] of entries) {
    const pct = count / SWITCH_LIFE * 100;
    const row = document.createElement('div');
    row.className = 'tk-row';
    const nm = document.createElement('span');
    nm.className = 'tk-name';
    nm.textContent = keyLabel(name);
    const bar = document.createElement('div');
    bar.className = 'tk-bar';
    bar.style.width = Math.max(3, Math.min(100, pct)) + '%';
    const val = document.createElement('span');
    val.className = 'tk-count';
    val.textContent = `${count.toLocaleString()} 次 · ${pct.toFixed(3)}%`;
    row.append(nm, bar, val);
    box.appendChild(row);
  }
}

// 今日键位热力：惰性创建的 3D 键盘（首次切到统计页才占 WebGL 上下文）
let kbStats = null;
function ensureStatsKb() {
  if (kbStats) return;
  const host = document.getElementById('stats-kb3d');
  if (!host) return;
  try {
    kbStats = createKeyboard3D(host, {}); // 只读展示：不接 onKeyClick
  } catch (e) {
    console.warn('[ui] 统计页 3D 热力不可用', e);
    host.hidden = true;
  }
}

function renderHeatmap(keys) {
  if (kbStats) kbStats.setHeat(keys);
}

// ---------- 滚动入场编排：区块进入视口时加 .in 浮现（reduced-motion 直接显示） ----------
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }
  }, { threshold: .12 });
  els.forEach(el => io.observe(el));
}
