// AI 层：把任意键盘的 F 键区变成 12 个 AI 快捷键（无需 RK 键盘）
// 平台后端：
//   Windows: RegisterHotKey 线程级热键，WM_HOTKEY 投到 worker 线程的消息队列（ailayer-worker.js）
//   macOS:   CGEventTap 会话级事件钩子，回调跑在 worker 线程的 CFRunLoop（ailayer-worker-mac.js）
// 两者同为「系统级拦截」：命中触发组合的事件被系统吞掉，不会串进前台应用；不启用则
// 完全不注册，F 键保持原样——（Copilot 键抢 Right Ctrl 骂声两年的教训：绝不默认抢占常用键）
//
// 线程模型：两平台的监听都是原生阻塞调用（GetMessage / CFRunLoopRun），放 worker_threads
// 里跑，不卡主线程事件循环。停止路径不同：
//   Windows: PostThreadMessage(WM_QUIT) 让 GetMessage 返回 0、线程真正死亡、热键随之释放。
//     terminate() 对阻塞在原生调用的线程无效且 Promise 悬挂（实测：旧线程不死、热键不放、
//     新 worker 注册必失败 → 改配置后热键坏死），只作 1s 兜底。
//   macOS:   主线程跨线程 CFRunLoopStop（CoreFoundation 文档保证跨线程合法），runloop 返回
//     后 worker 自行清理 tap 退出。JS 侧 setTimeout 在原生阻塞期间停摆（实测踩坑），
//     同窗 1s 兜底 terminate。
// mac 授权：CGEventTapCreate 需 系统设置>隐私与安全性>辅助功能 授权宿主应用，未授权时
// worker 上报 tap-failed（环境故障，与「组合键被占用」分列，不混入键列表）。
// 仅 win32/darwin；其他平台 supported=false，UI 隐藏。

const { Worker } = require('worker_threads');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SUPPORTED = IS_WIN || IS_MAC;

// ---- 平台常量 ----
// Windows: RegisterHotKey 修饰符（winuser.h）
const MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_NOREPEAT = 0x4000;
// macOS: CGEventFlags（CGEventTypes.h）
const FLAG_CONTROL = 0x40000, FLAG_ALTERNATE = 0x80000;

const SLOT_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
// Windows VK 码 F1=0x70…F12=0x7B
const VK_WIN = {};
for (let i = 1; i <= 12; i++) VK_WIN[`f${i}`] = 0x70 + i - 1;
// macOS HIToolbox 虚拟键码（Events.h）：F 行码位不连续，逐个列
const VK_MAC = { f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };

// 触发键方案。skip 列出的槽位不注册（Alt 方案必须保留 Alt+F4 给系统，mac 同语义保留）
const TRIGGERS = {
  ctrlalt: { label: IS_MAC ? 'Control+⌥ Option + F1~F12' : 'Ctrl+Alt + F1~F12', skip: [] },
  alt: { label: IS_MAC ? '⌥ Option + F1~F12' : 'Alt + F1~F12', skip: ['f4'] },
};
// 触发组合的平台修饰符。win 的 Alt 即 mac 的 Option；win 带 MOD_NOREPEAT（按住不重触发），
// mac 由 worker 过滤 autorepeat 事件达到同样效果。mac 要求修饰键精确匹配（多按 Shift 不触发，
// 对齐 RegisterHotKey 的组合语义）。
const TRIGGER_MODS = {
  win32: { ctrlalt: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, alt: MOD_ALT | MOD_NOREPEAT },
  darwin: { ctrlalt: FLAG_CONTROL | FLAG_ALTERNATE, alt: FLAG_ALTERNATE },
};

// Coding 预设（一键填入，用户可再改）：AI 直达/常用工具的组合示例。
// 动作形状与「按键映射」完全一致（actions.run 直接执行）。按平台给本地化预设。
const CODING_PRESET = IS_MAC ? {
  f1: { type: 'url', target: 'https://claude.ai' },
  f2: { type: 'url', target: 'https://chatgpt.com' },
  f3: { type: 'url', target: 'https://gemini.google.com' },
  f4: { type: 'app', target: '/System/Applications/Notes.app' }, // 快速记事
  f5: { type: 'hotkey', combo: 'Cmd+Shift+4' },                  // 截图（存到桌面）
  f6: { type: 'hotkey', combo: 'Cmd+Space' },                    // 聚焦搜索
} : {
  f1: { type: 'url', target: 'https://claude.ai' },
  f2: { type: 'url', target: 'https://chatgpt.com' },
  f3: { type: 'url', target: 'https://gemini.google.com' },
  f4: { type: 'hotkey', combo: 'Win+H' },        // Windows 系统语音输入（任意输入框可用）
  f5: { type: 'hotkey', combo: 'Win+Shift+S' },  // 截图
  f6: { type: 'app', target: 'C:/Windows/notepad.exe' }, // 快速记事（E2E 也用它验证）
};

const ACTION_TYPES = ['none', 'app', 'url', 'hotkey', 'macro', 'sys'];

// 配置规范化：任何来源（旧配置/手改 JSON/IPC）进来的 aiLayer 都收敛成安全形状
function normalizeAiLayer(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const trigger = raw.trigger === 'off' || TRIGGERS[raw.trigger] ? raw.trigger : 'ctrlalt';
  const slotsIn = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
  const slots = {};
  for (const k of SLOT_KEYS) {
    const a = slotsIn[k];
    slots[k] = a && typeof a === 'object' && ACTION_TYPES.includes(a.type) ? a : { type: 'none' };
  }
  return { enabled: raw.enabled === true, trigger, slots };
}

// 触发键 → 热键注册表。id = F 序号（1..12），alt 方案缺 f4（id 4 永不注册）。
// platform 决定键码与修饰符形状：win32 → { vk }（VK 码），darwin → { code }（mac 虚拟键码）。
// 默认 win32：单测固定断言 win 语义（VK 码/MOD_* 位），跨平台行为显式传参。
function buildHotkeys(triggerName, platform = 'win32') {
  const t = TRIGGERS[triggerName];
  if (!t) return [];
  const mods = (TRIGGER_MODS[platform] || TRIGGER_MODS.win32)[triggerName];
  if (!mods) return [];
  return SLOT_KEYS
    .filter(k => !t.skip.includes(k))
    .map(k => (platform === 'darwin'
      ? { id: SLOT_KEYS.indexOf(k) + 1, key: k, code: VK_MAC[k], mods }
      : { id: SLOT_KEYS.indexOf(k) + 1, key: k, vk: VK_WIN[k], mods }));
}

// 槽位的人类可读热键名（UI/日志用）
function slotLabel(triggerName, key) {
  const t = TRIGGERS[triggerName] || TRIGGERS.ctrlalt;
  return `${t.label.split(' ')[0]}+${key.toUpperCase()}`;
}

function triggerOptions() {
  return Object.entries(TRIGGERS).map(([value, t]) => ({ value, label: t.label, skip: t.skip }));
}

// ---------- 运行态 ----------
let worker = null;
let workerTid = 0;          // [win] worker 的 Win32 线程 ID（ready 消息上报，PostThreadMessage 用）
let workerRunloop = 0n;     // [mac] worker 的 CFRunLoopRef（uintptr_t，CFRunLoopStop 用）
let hotkeyMap = new Map();  // id -> 'f1'.. 'f12'
let onTrigger = null;       // (key) => void
let lastFailed = [];
let lastError = '';         // 环境级故障（mac 辅助功能未授权等），UI 可操作提示用
let permissionBlocked = false; // 本次启动因授权失败：重启无用，退出后不再自愈重试
let restartCount = 0, lastStartAt = 0; // 自愈限次：防退出风暴

// 优雅退出（win）用：PostThreadMessage(WM_QUIT) 让 GetMessageW 返回 0、线程真正死亡、
// 热键随之释放（见文件头「停止路径」）。
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

// 优雅退出（mac）用：主线程跨线程 CFRunLoopStop 停掉 worker 的 runloop（见文件头）
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
function failedKeys() { return lastFailed.slice(); }
function lastErrorText() { return lastError; }
function supported() { return SUPPORTED; }

// 启动监听。trigger: 'ctrlalt'|'alt'；cb 在主线程执行（动作分发由调用方做）
function start(trigger, cb) {
  if (!SUPPORTED) return { ok: false, error: 'AI 层仅支持 Windows / macOS' };
  // 键码形状必须与 worker 匹配：mac worker 读 h.code（mac 虚拟键码），win worker 读 h.vk
  const hotkeys = buildHotkeys(trigger, IS_MAC ? 'darwin' : 'win32');
  if (!hotkeys.length) return { ok: false, error: `未知触发键方案 ${trigger}` };
  stop(); // 幂等：先清旧 worker（win=WM_QUIT / mac=CFRunLoopStop，见文件头）
  onTrigger = cb;
  hotkeyMap = new Map(hotkeys.map(h => [h.id, h.key]));
  lastError = '';
  permissionBlocked = false;
  const workerFile = IS_MAC ? 'ailayer-worker-mac.js' : 'ailayer-worker.js';
  const w = new Worker(path.join(__dirname, workerFile), { workerData: { hotkeys } });
  worker = w;
  lastStartAt = Date.now();
  w.on('message', m => {
    if (m && m.type === 'ready') {
      lastFailed = Array.isArray(m.failed) ? m.failed : [];
      if (IS_MAC) {
        // 显式放行 worker 进 runloop：CFRunLoopStop 对尚未进入 runloop 的线程不生效
        //（实测踩坑），快速开关时 stop 可能抢在 ready 前后——由本 handler 二选一放行。
        // ready 晚于 stop() 到达时（换代 worker），只发 'stop' 不写运行态（runloop 是旧线程的）
        const stopped = !!w._stopRequested;
        if (worker === w) {
          // runloop 是 uintptr_t（BigInt，structured-clone 原生支持），CFRunLoopStop 原样回传
          workerRunloop = typeof m.runloop === 'bigint' ? m.runloop : 0n;
          console.log(`[ailayer] 事件监听已建立（${hotkeys.length} 键，${TRIGGERS[trigger] ? TRIGGERS[trigger].label : trigger}）`);
        }
        w.postMessage(stopped ? 'stop' : 'run');
      } else {
        // 注意存的是 Win32 线程 ID（GetCurrentThreadId 的返回值）；Worker.threadId 是
        // Node 层的小整数递增 id，拿它 PostThreadMessage 会投错线程（WM_QUIT 无效）
        workerTid = Number(m.threadId) || 0;
        const okN = hotkeys.length - lastFailed.length;
        console.log(`[ailayer] 已注册 ${okN}/${hotkeys.length} 个热键（${TRIGGERS[trigger] ? TRIGGERS[trigger].label : trigger}）` +
          (lastFailed.length ? `；注册失败（重试后仍被占用）: ${lastFailed.join(', ')}` : ''));
      }
    } else if (m && m.type === 'koffi-failed') {
      // 与「组合键被占用」是两类故障：这是环境坏了（AI 层整体不可用），别混进键列表
      lastError = `运行库加载失败: ${m.error}`;
      console.log(`[ailayer] koffi 加载失败，AI 层不可用: ${m.error}`);
    } else if (m && m.type === 'tap-failed') {
      // [mac] 辅助功能未授权：CGEventTapCreate 返回 null。环境故障，重启无用，
      // 给可操作提示（UI 据此引导授权），退出后不自愈重试
      permissionBlocked = true;
      lastError = m.error || '无法创建事件监听（可能缺少辅助功能授权）';
      console.log(`[ailayer] ${lastError}`);
    } else if (m && m.type === 'hotkey') {
      const key = hotkeyMap.get(Number(m.id));
      if (key && onTrigger) {
        try { onTrigger(key); } catch (e) { console.log('[ailayer] 触发回调异常:', e.message); }
      }
    }
  });
  w.on('error', e => {
    if (worker === w) worker = null; // 崩溃后别让 running() 误报“还在监听”
    console.log('[ailayer] worker 异常退出，监听已全部注销:', e.message);
  });
  w.on('exit', code => {
    if (worker !== w) return; // stop() 换代或已清理，无需处理
    worker = null;
    workerTid = 0;
    workerRunloop = 0n;
    if (permissionBlocked) {
      console.log('[ailayer] 缺少授权，放弃监听——授权后重新启用 AI 层即可');
      return;
    }
    console.log(`[ailayer] worker 意外退出(code=${code})，监听已全部注销`);
    // 自愈限次：10 秒窗口内最多自动重启 3 次，超过视为环境问题放弃
    if (Date.now() - lastStartAt > 10000) restartCount = 0;
    if (++restartCount <= 3) {
      console.log(`[ailayer] 自动重启 worker（第 ${restartCount} 次）...`);
      start(trigger, cb);
    } else {
      console.log('[ailayer] worker 反复退出，放弃自动重启——AI 层热键失效');
    }
  });
  return { ok: true, count: hotkeys.length };
}

// 停止 = 按平台优雅退出（win 投 WM_QUIT / mac 跨线程 CFRunLoopStop，见文件头）；
// 1 秒后仍不退再 terminate 兜底（对阻塞线程多半无效，但 fire-and-forget 不悬挂）。
function stop() {
  if (worker) {
    const w = worker;
    const tid = workerTid;     // 先取平台句柄，再清状态
    const rl = workerRunloop;
    worker = null;
    workerTid = 0;
    workerRunloop = 0n;
    if (IS_MAC) {
      if (rl) {
        const stopFn = ensureRunLoopStop();
        if (stopFn) {
          try { stopFn(rl); } catch (_) { /* 优雅路径失败走兜底 */ }
        }
      } else {
        w._stopRequested = true; // worker 尚未 ready：ready 时改发 'stop'，不进 runloop
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
  hotkeyMap = new Map();
  onTrigger = null;
  lastFailed = [];
  lastError = '';
}

module.exports = {
  start, stop, running, failedKeys, lastErrorText, supported,
  SLOT_KEYS, TRIGGERS, CODING_PRESET,
  buildHotkeys, normalizeAiLayer, slotLabel, triggerOptions,
};
