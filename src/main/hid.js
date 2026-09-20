// HID 设备监听：检测 R87 Pro AI 的厂商自定义接口，解析按键报文
// 协议见 docs/protocol.md（逆向自官方 RK-AI）

const HID = require('node-hid');
const { EventEmitter } = require('events');
const { lookupKey } = require('./keymap');

const TARGETS = [
  { vid: 0x248a, pid: 0x8102, name: 'R87 Pro AI (有线)' },
  // 蓝牙口(8243)专留给 KeySession（kb-session.js）——多句柄抢读会掐断命令会话
];
const BT_PID = 0x8243; // 蓝牙/dongle 命令口：本模块只枚举不开口（抢读会掐死会话）

// USB 口(8102)默认挂起：会话与 watcher 抢读同一厂商接口时，Windows 把输入报文
// 只投给其中一个句柄（2026-08-30 实锤：watcher 持句柄期间会话 USB 握手 4 万次
// 零成功，同脚本独占时秒通）——会话永远握不上手。默认由 KeySession 独占 8102，
// 仅当会话报 usb-block（连续握手失败，疑似固件不支持 USB 会话）才由 watcher 接管。
const USB_PID = 0x8102;

class KeyboardWatcher extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // path -> HID instance
    this.timer = null;
    this.pressed = new Set(); // 去重：只认边沿触发
    this.lastEvent = { code: -1, ts: 0 }; // 双连接(USB+BT同时活)去重
    // 音频流去重：双连接可能重复推流，记录 (seq, 净荷头) 短窗口
    this.audioDedup = [];
    this.micOn = false;
    this.audioWatchdog = null;
    this.usbSuspended = true; // 默认让 8102 给 KeySession（见文件头注释）
    this.usbPresent = false;  // 枚举级在线检测（挂起期间也算，供托盘/UI 显示）
    this._pathInfo = new Map(); // path -> 枚举信息（suspendUsb 按 pid 定向关句柄）
    this.vendorPresent = false; // 任一厂商接口（8102+8243）枚举可见（边沿事件源）
    this._vendorInit = false;
  }

  // 挂起=不新开 8102 且立即关掉已开句柄（把报文读取权整个让给会话）
  suspendUsb() {
    if (this.usbSuspended) return;
    this.usbSuspended = true;
    for (const [path, dev] of this.devices) {
      const info = this._pathInfo.get(path);
      if (info && info.productId === USB_PID) this.drop(path);
    }
  }

  // 接管=立即扫描并打开 8102（会话连续握手失败退让后调用，保住有线键监听）
  resumeUsb() {
    if (!this.usbSuspended) return;
    this.usbSuspended = false;
    this.scan();
  }

  _feedAudioWatchdog() {
    if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
    this.audioWatchdog = setTimeout(() => {
      if (this.micOn) {
        this.micOn = false;
        this.emit('mic', { on: false });
      }
    }, 400);
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), 2000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
    for (const [path, dev] of this.devices) {
      try { dev.close(); } catch (_) {}
    }
    this.devices.clear();
    this._pathInfo.clear();
  }

  scan() {
    let list = [];
    try { list = HID.devices(); } catch (_) { return; }

    const wanted = new Set();
    for (const d of list) {
      // 只认厂商自定义 usage 页（和官方软件同样的过滤逻辑）
      if (!(d.usagePage >= 0xff00 && d.usage >= 0x1000)) continue;
      const t = TARGETS.find(t => t.vid === d.vendorId && t.pid === d.productId);
      if (!t) continue;
      this._pathInfo.set(d.path, d);
      if (d.productId === USB_PID && this.usbSuspended) { wanted.add(d.path); continue; }
      if (this.devices.has(d.path)) { wanted.add(d.path); continue; }
      try {
        const dev = new HID.HID(d.path);
        dev.on('data', buf => this.onData(d.path, buf));
        dev.on('error', err => {
          console.log(`[hid] ${d.path} 错误:`, err.message);
          this.drop(d.path);
        });
        this.devices.set(d.path, dev);
        wanted.add(d.path);
        console.log(`[hid] 已打开 ${t.name} ${d.path}`);
        this.emit('device', { connected: true, name: t.name });
      } catch (e) {
        console.log(`[hid] 打开失败 ${d.path}:`, e.message);
      }
    }

    // 清理已拔出的设备
    for (const [path, dev] of this.devices) {
      if (!wanted.has(path)) this.drop(path);
    }
    this._emitPresence(list);
    this._emitVendorPresence(list);
  }

  // 厂商接口在线边沿（8102 有线 + 8243 蓝牙/dongle）：只枚举不开口。会话离线期间
  // 键盘一回来（枚举可见）就发 vendor-online，由 index.js 叫醒 KeySession 立即重连，
  // 免等 60s 轮询——长断连恢复体感的关键路径（2026-09-06）
  _emitVendorPresence(list) {
    const present = list.some(d =>
      d.vendorId === TARGETS[0].vid && (d.productId === USB_PID || d.productId === BT_PID) &&
      d.usagePage >= 0xff00);
    if (!this._vendorInit) {
      this._vendorInit = true; // 首轮扫描只建基线不触发（boot 时会话自己会开口）
      this.vendorPresent = present;
      return;
    }
    if (present === this.vendorPresent) return;
    this.vendorPresent = present;
    if (present) this.emit('vendor-online');
  }

  // 枚举级在线检测：与句柄解耦——8102 挂起期间托盘/设置页照样能显示「键盘已连接」
  _emitPresence(list) {
    const present = list.some(d =>
      d.vendorId === TARGETS[0].vid && d.productId === USB_PID && d.usagePage >= 0xff00);
    if (present !== this.usbPresent) {
      this.usbPresent = present;
      this.emit('device', { connected: present || this.devices.size > 0, name: TARGETS[0].name });
    }
  }

  drop(path) {
    const dev = this.devices.get(path);
    if (dev) {
      try { dev.close(); } catch (_) {}
      this.devices.delete(path);
      // usbPresent 兜底：挂起切换产生的 drop 不应把「键盘在线」误报成离线
      this.emit('device', { connected: this.devices.size > 0 || this.usbPresent });
    }
  }

  onData(path, buf) {
    // 音频流报文（实测：reportId=0x1B，[0x1B, seq, ...60B 净荷]，15ms/包）
    // 键盘语音键按住时固件自动开麦推流（伴随 cmd=106/107 状态上报）
    if (buf[0] === 0x1b) {
      const seq = buf[1];
      const key = seq * 256 + (buf[2] + buf[3] * 256);
      const now = Date.now();
      this.audioDedup = this.audioDedup.filter(e => now - e.ts < 120);
      if (this.audioDedup.some(e => e.key === key)) return;
      this.audioDedup.push({ key, ts: now });
      if (!this.micOn) {
        this.micOn = true;
        this.emit('mic', { on: true });
      }
      this._feedAudioWatchdog();
      this.emit('audio', buf);
      return;
    }

    const frame = decodeFrame(buf);
    if (!frame) return;

    // 麦克风开关状态上报（键盘语音键触发，非主机命令应答）
    if (frame.cmd === 106) {
      this._feedAudioWatchdog();
      if (!this.micOn) {
        this.micOn = true;
        this.emit('mic', { on: true });
      }
      return;
    }
    if (frame.cmd === 107) {
      if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
      if (this.micOn) {
        this.micOn = false;
        this.emit('mic', { on: false });
      }
      return;
    }

    // AI 模式切换键：独立命令 cmd=209(0xD1)。kaiwen743 实机（PR#14）：0=AI 模式 / 1=普通
    // 模式，与初版「1=进入」标定相反——疑似硬件批次差异；若再现相反批次，弃用此位、
    // 改以厂商码报文（cmd=159）有无推断真实模式
    if (frame.cmd === 209 && frame.dataLen === 1) {
      this.pressed.clear(); // 切换瞬间边沿状态作废：按住中的键不会再有对应抬起码
      this.emit('ai-mode', { on: frame.data[0] === 0 });
      return;
    }

    if (frame.cmd !== 159 || frame.dataLen !== 1) return;
    const code = frame.data[0];

    // 按下/抬起由键码表判定（keymap 里每个键位有 code/up 两个码）
    const key = lookupKey(code);
    if (!key) return;

    const now = Date.now();
    // 同一键 60ms 内的重复报文视为双连接重复，丢弃
    if (this.lastEvent.code === code && now - this.lastEvent.ts < 60) return;
    this.lastEvent = { code, ts: now };

    if (key.phase === 'down') {
      if (this.pressed.has(key.id)) return; // 长按重复报文，只触发一次
      this.pressed.add(key.id);
      this.emit('key', { code, keyId: key.id, phase: 'down' });
    } else {
      this.pressed.delete(key.id);
      this.emit('key', { code, keyId: key.id, phase: 'up' });
    }
  }
}

// 帧解析：两种通道前缀 + RK 变体，见 docs/protocol.md 第 2 节
function decodeFrame(e) {
  const reportId = e[0];
  try {
    if (reportId === 0x05) {
      let n;
      if (e[1] === 0xfe) {
        n = 2; // 通道 0: [05 FE C0 ...]
      } else if (e[1] === 0xff && (e[2] === 0xf1 || e[2] === 0xf0) && e[3] === 0xfe) {
        n = 4; // 通道 1/2: [05 FF Fx FE ...]
      } else {
        return null;
      }
      if (e[n] !== 0xc0) return null;
      const cmd = e[n + 1];
      const len = e[n + 2];
      if (n + 3 + len >= e.length) return null;
      if (e[n + 3 + len] !== 0xef) return null;
      return { cmd, dataLen: len, data: e.slice(n + 3, n + 3 + len) };
    }
    if (reportId === 0x01) {
      // RK 变体: [01 FA F2 FE C1 ...]
      if (e[1] !== 0xfa || e[2] !== 0xf2 || e[3] !== 0xfe || e[4] !== 0xc1) return null;
      const cmd = e[5];
      const len = e[6];
      if (7 + len >= e.length || e[7 + len] !== 0xef) return null;
      return { cmd, dataLen: len, data: e.slice(7, 7 + len) };
    }
  } catch (_) {
    return null;
  }
  return null;
}

module.exports = { KeyboardWatcher, decodeFrame, TARGETS };
