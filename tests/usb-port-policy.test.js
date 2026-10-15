// USB 口读写权仲裁测试：watcher 独占抢读是「语音时灵时不灵」的根因（2026-08-30 实锤：
// watcher 持 8102 句柄期间会话 USB 握手 2.3 万次零成功，独占时秒通）
// 覆盖：握手失败后蓝牙优先、连续失败熔断让渡、手动重连推翻熔断、离线日志限频、
//       watcher 的 8102 挂起/接管（全 stub，零副作用）
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ FAIL:', name)); };

// ---- stub koffi（mac CI 防 CGEvent 真注入）----
try {
  const koffiPath = require.resolve('koffi', { paths: [ROOT] });
  require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };
} catch (_) { /* win32 无 koffi 依赖 */ }

// ---- 可变设备表（每个用例自设场景）----
const usbDev = { vendorId: 0x248a, productId: 0x8102, usagePage: 0xff12, usage: 0x1001, interface: 0, release: 0, path: 'usb-0' };
const btDev = { vendorId: 0x248a, productId: 0x8243, usagePage: 0xff12, usage: 0x1001, interface: -1, release: 0, path: 'bt-0' };
let devices = [];

class FakeHID {
  constructor(p) { this.path = p; FakeHID.instances.push(this); this.closeCalls = 0; this.written = []; this._handlers = {}; }
  write(buf) { this.written.push(buf); return buf.length; }
  read(cb) { FakeHID.pendingRead = cb; }
  close() { this.closeCalls++; this.closed = true; }
  on(ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); return this; } // watcher 事件式 API
}
FakeHID.instances = [];

const nodeHidStub = { HID: FakeHID, devices: () => devices };
const nodeHidPath = require.resolve('node-hid', { paths: [ROOT] });
require.cache[nodeHidPath] = { id: nodeHidPath, filename: nodeHidPath, loaded: true, exports: nodeHidStub };
// win32：kb-session.loadBinding 走 vendor mi-hid 而非 node-hid，指向同一份 stub
if (process.platform === 'win32') {
  const vendorPath = require.resolve(path.join(ROOT, 'vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node'));
  require.cache[vendorPath] = { id: vendorPath, filename: vendorPath, loaded: true, exports: nodeHidStub };
}

const { KeySession } = require('../src/main/kb-session.js');
const { KeyboardWatcher } = require('../src/main/hid.js');

const HB104 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 104, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]);
const R227 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 227, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]);

// 跳过真实重连定时器，立即重开
function reopenNow(s) {
  if (s.watchTimer) { clearTimeout(s.watchTimer); s.watchTimer = null; }
  s.triedPaths.clear();
  s._open();
}
// 模拟当前口握手超时（与 hsTimer 回调同路径）
function handshakeTimeout(s) { s._onDisconnect('handshake-timeout(' + s.transport + ')'); }

(async () => {
  console.log('[T1] USB 握手失败一轮后，蓝牙口优先');
  {
    FakeHID.instances = [];
    devices = [usbDev, btDev];
    const s = new KeySession();
    s.start();
    ok(FakeHID.instances[0].path === 'usb-0', '首轮默认选 USB 口');
    handshakeTimeout(s);
    ok(s._usbFailStreak === 1, 'USB 握手超时记账 streak=1');
    reopenNow(s);
    ok(s.devPath === 'bt-0', 'streak>0 时下一轮改试蓝牙（不再死等 4s）');
    s._onData(HB104);
    s._onData(R227);
    ok(s.connected && s.transport === '蓝牙', '蓝牙会话在线');
    ok(s._usbFailStreak === 1 && !s.usbBlocked(), '蓝牙成功不清 USB 账、不触发熔断');
    s.stop();
  }

  console.log('[T2] USB 会话打通清零失败账');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const s = new KeySession();
    s._usbFailStreak = 2; // 已失败 2 次的场景
    s.start();
    ok(s.devPath === 'usb-0', '蓝牙缺席时仍尝试 USB');
    s._onData(HB104);
    s._onData(R227);
    ok(s.connected && s.transport === 'USB', 'USB 会话在线');
    ok(s._usbFailStreak === 0, 'USB 握手成功清零 streak');
    s.stop();
  }

  console.log('[T3] 连续 3 次 USB 握手超时（蓝牙缺席，死窗场景）→ 熔断让渡');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const s = new KeySession();
    let blockEvents = [];
    s.on('usb-block', e => blockEvents.push(e));
    s.start();
    for (let i = 1; i <= 3; i++) {
      handshakeTimeout(s);
      ok(s._usbFailStreak === i, `第 ${i} 次超时记账`);
      if (i < 3) reopenNow(s);
    }
    ok(s.usbBlocked() === true, '3 次超时后进入熔断');
    ok(blockEvents.length === 1 && blockEvents[0].blocked === true, '发出 usb-block blocked=true');
    s.triedPaths.clear();
    devices = [usbDev, btDev];
    ok(s._pick([usbDev, btDev]) === btDev, '熔断期 _pick 剔除 USB 只剩蓝牙');
    devices = [usbDev];
    reopenNow(s);
    ok(!s.dev, '熔断期只有 USB 在场时不冒险开口（读写权在 watcher 手里）');
    s.stop();
  }

  console.log('[T4] 手动重连推翻熔断');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const s = new KeySession();
    let blockEvents = [];
    s.on('usb-block', e => blockEvents.push(e));
    s.start();
    for (let i = 0; i < 3; i++) {
      handshakeTimeout(s);
      if (i < 2) reopenNow(s);
    }
    ok(s.usbBlocked(), '前置：已熔断');
    s.reconnect();
    ok(!s.usbBlocked() && s._usbFailStreak === 0, '手动重连清熔断与失败账');
    ok(blockEvents.some(e => e.blocked === false), '发出 usb-block blocked=false（watcher 收回读权）');
    ok(FakeHID.instances[FakeHID.instances.length - 1].path === 'usb-0', '重连后立即重试 USB');
    s.stop();
  }

  console.log('[T5] 离线 state 60s 限频（防日志刷屏）');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const s = new KeySession();
    let offlineEmits = 0;
    s.on('state', ({ connected }) => { if (!connected) offlineEmits++; });
    s.start();
    for (let i = 0; i < 5; i++) { handshakeTimeout(s); reopenNow(s); }
    ok(offlineEmits === 1, `5 轮失败循环只发 ${offlineEmits} 次离线 state（旧行为 10 次）`);
    s._offlineEmitTs = 0; // 模拟 60s 窗口过后
    handshakeTimeout(s);
    reopenNow(s);
    ok(offlineEmits === 2, '窗口过后恢复发送');
    s.stop();
  }

  console.log('[T6] watcher 8102 挂起/接管');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const w = new KeyboardWatcher();
    let deviceEvents = [];
    w.on('device', e => deviceEvents.push(e));
    w.scan();
    ok(FakeHID.instances.length === 0, '默认挂起：不为 8102 开句柄（让给会话）');
    ok(w.usbPresent === true, '枚举级在线检测仍然生效');
    ok(deviceEvents.some(e => e.connected === true), '挂起期照常上报键盘在线');
    w.resumeUsb();
    ok(FakeHID.instances.length === 1 && FakeHID.instances[0].path === 'usb-0', '接管：立即打开 8102');
    w.suspendUsb();
    ok(FakeHID.instances[0].closed === true, '挂起：立即关闭句柄（报文读取权交还会话）');
    ok(deviceEvents.filter(e => e.connected === false).length === 0, '挂起切换不误报「键盘离线」');
    devices = [];
    w.scan();
    ok(w.usbPresent === false, '拔出后枚举检测转离线');
    w.stop();
  }

  console.log('[T7] 蓝牙重连的枚举级在线（8102 不在场）');
  {
    FakeHID.instances = [];
    devices = [usbDev];
    const w = new KeyboardWatcher();
    let deviceEvents = [];
    w.on('device', e => deviceEvents.push(e));
    w.scan(); // 基线：有线在场
    devices = [];
    w.scan();
    ok(deviceEvents.some(e => e.connected === false), '前置：有线拔出后上报离线');
    devices = [btDev];
    w.scan();
    ok(w.btPresent === true, '蓝牙/dongle 枚举可见被跟踪');
    ok(deviceEvents[deviceEvents.length - 1].connected === true, '蓝牙回来立即报在线（不等会话握手）');
    devices = [];
    w.scan();
    ok(deviceEvents[deviceEvents.length - 1].connected === false, '蓝牙再走恢复离线');
    w.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
