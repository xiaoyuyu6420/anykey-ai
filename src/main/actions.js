// 动作执行器：启动程序 / 打开网址 / 发送快捷键
// - 快捷键：
//     Windows: Win32 SendInput（koffi FFI，NAPI 预编译，无需构建工具）
//     macOS:   CoreGraphics CGEvent（koffi FFI）；需在 系统设置>隐私与安全>辅助功能 里授权本应用
// - 启动程序走 Electron shell.openPath + 扩展名白名单，不经 child_process、不拼接命令行
//   （需要带参数的脚本：Windows 写成 .bat；macOS 写成 .command）
// - 配置只来自本机用户自己的设置界面，无任何远程输入

const path = require('path');
const { shell } = require('electron');

const IS_MAC = process.platform === 'darwin';

// ---------- Windows: user32 SendInput ----------
let user32Dll = null;
function ensureUser32() {
  if (user32Dll) return user32Dll;
  const koffi = require('koffi');
  user32Dll = koffi.load('user32.dll');
  return user32Dll;
}
let SendInput = null;
function ensureSendInput() {
  if (SendInput) return;
  const koffi = require('koffi'); // 局部 require：ensureUser32 里的 koffi 是它的函数局部变量
  const user32 = ensureUser32();
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64',
  });
  const INPUT = koffi.struct('KINPUT', {
    type: 'uint32', _pad: 'uint32', ki: KEYBDINPUT, _pad2: 'uint64',
  });
  // koffi 2.16：struct 不再可 new，指针参数直接传 JS 对象由 koffi marshal
  SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, KINPUT *pInputs, int cbSize)');
}

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
// E0 前缀扩展扫描码键（导航/编辑区、Win、Apps、PrtSc、小键盘除号、右侧修饰）：
// 注入时不带 EXTENDEDKEY 标志，读扫描码的程序（游戏/DirectInput/部分 RDP）收不到，
// NumLock 关闭时方向键还会被解析成小键盘键
const EXTENDED_VK = new Set([
  0x21, 0x22, 0x23, 0x24, // PgUp PgDn End Home
  0x25, 0x26, 0x27, 0x28, // Left Up Right Down
  0x2c, 0x2d, 0x2e,       // PrintScreen Insert Delete
  0x5b, 0x5c, 0x5d,       // LWin RWin Apps
  0x6f,                    // NumpadDiv
  0xa3, 0xa5,              // RControl RMenu
]);

// ---------- macOS: CoreGraphics CGEvent ----------
let CG = null;
function ensureCGEvent() {
  if (CG) return;
  const koffi = require('koffi');
  const lib = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  CG = {
    sourceCreate: lib.func('void *CGEventSourceCreate(uint32_t)'),
    createKey: lib.func('void *CGEventCreateKeyboardEvent(void *, uint16_t, bool)'),
    setFlags: lib.func('void CGEventSetFlags(void *, uint64_t)'),
    post: lib.func('void CGEventPost(uint32_t, void *)'),
    release: lib.func('void CFRelease(void *)'),
  };
  CG.source = CG.sourceCreate(0); // kCGEventSourceStateCombinedSessionState
}
const kCGHIDEventTap = 0;
const kCGEventFlagMask = { shift: 0x20000, control: 0x40000, alternate: 0x80000, command: 0x100000, secondaryFn: 0x800000 };

// 只允许启动这几类可执行文件
const LAUNCHABLE_EXT = IS_MAC
  ? ['.app', '.command', '.exe', '.bat', '.cmd', '.lnk']
  : ['.exe', '.bat', '.cmd', '.lnk'];

function validateTarget(target) {
  const t = String(target || '').trim();
  if (!t) return null;
  const ext = path.extname(t).toLowerCase();
  if (!LAUNCHABLE_EXT.includes(ext)) return null;
  return t;
}

// ---------- 键码表 ----------
// Windows: 常用 VK 码；macOS: HIToolbox 虚拟键码（Events.h）
const VK_WIN = {
  ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b,
  enter: 0x0d, esc: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08,
  delete: 0x2e, insert: 0x2d,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22,
  printscreen: 0x2c, capslock: 0x14, numlock: 0x90,
  minus: 0xbd, equal: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf,
  backtick: 0xc0, lbracket: 0xdb, rbracket: 0xdd, backslash: 0xdc, semicolon: 0xba, quote: 0xde,
};
for (let i = 1; i <= 24; i++) VK_WIN[`f${i}`] = 0x70 + i - 1;
for (let i = 0; i <= 9; i++) VK_WIN[`${i}`] = 0x30 + i;
for (let i = 0; i < 26; i++) VK_WIN[String.fromCharCode(97 + i)] = 0x41 + i; // a-z

// macOS 修饰键名映射：win→Cmd（Mac 上语义等同），alt→Option
const VK_MAC = {
  ctrl: 59, shift: 56, alt: 58, option: 58, win: 55, cmd: 55, command: 55, fn: 63,
  enter: 36, esc: 53, tab: 48, space: 49, backspace: 51,
  delete: 117, insert: 114,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pgup: 116, pgdn: 121,
  printscreen: 105, capslock: 57, numlock: 47,
  minus: 27, equal: 24, comma: 43, period: 47, slash: 44,
  backtick: 50, lbracket: 33, rbracket: 30, backslash: 42, semicolon: 41, quote: 39,
};
// 功能键（kVK_F1=122…顺序与 PC 不同，逐个列）
const VK_MAC_F = { f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90 };
Object.assign(VK_MAC, VK_MAC_F);
for (let i = 0; i <= 9; i++) VK_MAC[`${i}`] = { 0: 29, 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25 }[i];
const MAC_LETTERS = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46 };
Object.assign(VK_MAC, MAC_LETTERS);

const VK = IS_MAC ? VK_MAC : VK_WIN;

// macOS 修饰键 flags（发给主键事件，应用普遍以 flags 为准）
const MAC_MOD_FLAG = { ctrl: kCGEventFlagMask.control, shift: kCGEventFlagMask.shift, alt: kCGEventFlagMask.alternate, option: kCGEventFlagMask.alternate, win: kCGEventFlagMask.command, cmd: kCGEventFlagMask.command, command: kCGEventFlagMask.command, fn: kCGEventFlagMask.secondaryFn };

// mac 合成组合键用：修饰键名 → CGEventFlags（sendHotkey 内部同款映射，透传
// 合成 Ctrl+F10 等组合时需把修饰 flags 并到主键事件上——mac 应用普遍以
// 事件 flags 判修饰，孤立修饰键按下不构成组合）
function macModFlag(name) {
  return MAC_MOD_FLAG[String(name || '').trim().toLowerCase()] || 0;
}

function vkOf(name) {
  const n = name.trim().toLowerCase();
  return VK[n] !== undefined ? VK[n] : null;
}

// ---------- Windows 发键 ----------
function pressKeyWin(vk, up) {
  ensureSendInput();
  const flags = (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
  const inp = { type: 1, _pad: 0, ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 }, _pad2: 0 };
  const n = SendInput(1, inp, 40);
  if (n !== 1) {
    // UIPI 拦截（目标是管理员权限窗口）等：留诊断线索，前 5 次打印（防刷屏）
    if ((pressKeyWin._fails = (pressKeyWin._fails || 0) + 1) <= 5) {
      console.log(`[inject] SendInput 失败 vk=0x${vk.toString(16)} ${up ? 'up' : 'down'}（目标可能是管理员窗口）`);
    }
    return false;
  }
  return true;
}

// ---------- macOS 发键 ----------
function postMac(code, down, flags) {
  ensureCGEvent();
  const ev = CG.createKey(CG.source, code, down);
  if (!ev) throw new Error('CGEventCreateKeyboardEvent 返回 null');
  if (flags) CG.setFlags(ev, flags);
  CG.post(kCGHIDEventTap, ev);
  CG.release(ev);
}

function sendHotkey(combo) {
  const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
  const names = parts.map(p => p.trim().toLowerCase());
  const keys = names.map(vkOf);
  if (keys.some(k => k === null)) {
    return { ok: false, error: `无法识别的按键: ${parts[keys.indexOf(null)]}` };
  }
  const modNames = names.slice(0, -1);
  const main = keys[keys.length - 1];
  try {
    if (IS_MAC) {
      const flags = modNames.reduce((f, n) => f | (MAC_MOD_FLAG[n] || 0), 0);
      for (let i = 0; i < modNames.length; i++) postMac(keys[i], true, 0);
      postMac(main, true, flags);
      postMac(main, false, flags);
      for (let i = modNames.length - 1; i >= 0; i--) postMac(keys[i], false, 0);
    } else {
      for (let i = 0; i < modNames.length; i++) pressKeyWin(keys[i], false);
      pressKeyWin(main, false);
      pressKeyWin(main, true);
      for (let i = modNames.length - 1; i >= 0; i--) pressKeyWin(keys[i], true);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 透传回注：按平台发一个原始 down/up 键事件（与 sendHotkey 不同，不自动抬键）。
// 功能键透传需要 down 与 up 严格配对（长按场景），由调用方保证时序。
// mac 可带修饰键 flags（从回注模块取当前物理修饰键状态，保证 Shift+F10 等组合正确）。
function postRawKey(name, down, flags) {
  const vk = vkOf(name);
  if (vk === null) return false;
  try {
    if (IS_MAC) postMac(vk, down, flags || 0);
    else pressKeyWin(vk, !down);
    return true;
  } catch (e) {
    console.log(`[action] postRawKey(${name}) 异常:`, e.message);
    return false;
  }
}

// 异步键状态查询（远控探针用）：LL 钩子吞掉的事件不会更新异步键状态表，
// 注入后状态从未翻转 ⇒ 键盘流正被远程软件接管。仅 win32，非 win 恒 false。
let getAsyncKeyState = null;
function asyncKeyDown(vk) {
  if (IS_MAC) return false;
  try {
    if (!getAsyncKeyState) {
      getAsyncKeyState = ensureUser32().func('int16 __stdcall GetAsyncKeyState(int vKey)');
    }
    return (getAsyncKeyState(vk) & 0x8000) !== 0;
  } catch (_) {
    return false;
  }
}

// action 形状（config.json bindings 的值）：
//   { type:'none' }
//   { type:'app',    target:'C:/path/app.exe 或 xxx.bat', afterHotkey?, afterDelay? }
//   { type:'url',    target:'https://...', afterHotkey?, afterDelay? }
//   { type:'hotkey', combo:'Ctrl+Shift+S' }
//   { type:'sys',    op:'profile-cycle' }  // 系统动作（主进程注入执行体）
//   { type:'macro',  steps:[{ name, down, dt }] }  // 宏（录制于设置页，回放注入执行体）
let sysHandler = null;
function setSysHandler(fn) { sysHandler = fn; }
let macroRunner = null;
function setMacroRunner(fn) { macroRunner = fn; }

function run(action) {
  if (!action || !action.type || action.type === 'none') return { ok: true, skipped: true };
  switch (action.type) {
    case 'app': {
      const target = validateTarget(action.target);
      if (!target) {
        return { ok: false, error: `无效的程序路径（仅支持 ${LAUNCHABLE_EXT.join('/')}）` };
      }
      const p = shell.openPath(target); // 失败时 resolve 错误字符串而非 reject
      Promise.resolve(p).then(err => { if (err) console.log('[action] openPath:', err); });
      scheduleAfter(action);
      return { ok: true };
    }
    case 'url': {
      const u = String(action.target || '').trim();
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: '无效的网址' };
      shell.openExternal(u).catch(() => {});
      scheduleAfter(action);
      return { ok: true };
    }
    case 'hotkey':
      return sendHotkey(action.combo);
    case 'sys':
      if (sysHandler) return sysHandler(action.op || '');
      return { ok: false, error: '系统动作未初始化' };
    case 'macro':
      if (macroRunner) return macroRunner(Array.isArray(action.steps) ? action.steps : []);
      return { ok: false, error: '宏执行器未初始化' };
    default:
      return { ok: false, error: `未知动作类型 ${action.type}` };
  }
}

// AI 入口支持：启动后再发一个聚焦/唤起快捷键
function scheduleAfter(action) {
  if (!action.afterHotkey) return;
  const delay = Number(action.afterDelay) || 800;
  setTimeout(() => sendHotkey(action.afterHotkey), delay);
}

// VK_KEYNAMES：按平台选好的「键名→键码」表（打字统计用它构建反向轮询表）
module.exports = { run, sendHotkey, postRawKey, asyncKeyDown, vkOf, macModFlag, setSysHandler, setMacroRunner, VK_KEYNAMES: VK };
