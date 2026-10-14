// stub 隔离测试：验证 v0.8.1 修复的关键行为（koffi/node-hid 全 stub，零副作用）
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

// ---- stub koffi（防 CGEvent 真注入）----
const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

// ---- stub node-hid ----
class FakeHID {
  constructor(p) { this.path = p; FakeHID.instances.push(this); this.closeCalls = 0; this.written = []; }
  write(buf) { this.written.push(buf); return buf.length; }
  read(cb) { FakeHID.pendingRead = cb; }
  close() {
    this.closeCalls++;
    if (this.closeCalls <= FakeHID.failFirstN) throw new TypeError('read is still running');
    this.closed = true;
  }
}
FakeHID.instances = [];
FakeHID.failFirstN = 0;
const nodeHidPath = require.resolve('node-hid', { paths: [ROOT] });
require.cache[nodeHidPath] = {
  id: nodeHidPath, filename: nodeHidPath, loaded: true,
  exports: { HID: FakeHID, devices: () => [{ vendorId: 0x248a, productId: 0x8243, usagePage: 0xff12, interface: -1, path: 'bt-0', release: 0 }] },
};
// win32：kb-session.loadBinding 走 vendor mi-hid 而非 node-hid（见 kb-session.js），
// 不 stub 会打开真实键盘命令口
if (process.platform === 'win32') {
  const vendorPath = require.resolve(path.join(ROOT, 'vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node'));
  require.cache[vendorPath] = { id: vendorPath, filename: vendorPath, loaded: true, exports: require.cache[nodeHidPath].exports };
}

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ FAIL:', name)); };

const { KeySession } = require('../src/main/kb-session.js');
const kbdInject = require('../src/main/kbd-inject.js');

const HB104 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 104, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]);

(async () => {
  console.log('[T1/T2] RTT 劣化检测豁免');
  {
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances[0];
    s._onData(HB104);
    s._onData(Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 227, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]));
    ok(s.connected, '会话在线');
    for (let i = 0; i < 10; i++) {
      s.lastAudioTs = Date.now();
      s._hbTs = Date.now() - 900;
      s._onData(HB104);
    }
    ok(s.connected && s.rttBad === 0, '音频活跃时 10 次高 RTT 不累计不断线');
    s.lastAudioTs = Date.now() - 5000;
    for (let i = 0; i < 5; i++) {
      s._hbTs = Date.now() - 900;
      s._onData(HB104);
    }
    ok(!s.connected, '音频停后 5 次高 RTT 仍触发强制重连');
    s.stop();
  }

  console.log('[T3] close 泄漏修复');
  {
    FakeHID.instances.length = 0;
    FakeHID.failFirstN = 2;
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances.at(-1);
    s._onDisconnect('test');
    ok(s.dev === null, '断线后 this.dev 立即置空');
    await new Promise(r => setTimeout(r, 150 + 200 * 3 + 100));
    ok(dev.closed && dev.closeCalls === 3, `close 抛异常后延迟重试成功（${dev.closeCalls} 次后关闭）`);
    s.stop();
    FakeHID.failFirstN = 0;
  }

  console.log('[T4] 语音期心跳降频');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances.at(-1);
    const hb = () => dev.written.filter(b => b[5] === 5 && b[2] === 0xf1).length;
    const b1 = hb();
    await new Promise(r => setTimeout(r, 3200));
    const idle = hb() - b1;
    s.lastAudioTs = Date.now();
    const b2 = hb();
    await new Promise(r => setTimeout(r, 3200));
    const audio = hb() - b2;
    ok(idle >= 2 && idle <= 4, `空闲心跳 ~1/s（${idle}/3.2s）`);
    ok(audio <= 2, `语音期心跳 ≤1/3s（${audio}/3.2s）`);
    s.stop();
  }

  // T5 测 kbd-inject（mac CGEvent 回注）；win32 无此路径（feedKeyboardReport 直接短路）
  if (process.platform !== 'darwin') {
    console.log('[T5] 跳过：kbd-inject 仅 mac 有回注路径');
  } else {
  console.log('[T5] ErrorRollOver 不误抬 + autorepeat 熔断');
  {
    const mkRpt = (mod, ...keys) => Buffer.from([2, mod, 0, ...keys].slice(0, 9));
    kbdInject.reset();
    const before = kbdInject.getDiag().postOk;
    kbdInject.feedKeyboardReport(mkRpt(0, 4, 0, 0, 0, 0, 0)); // A down
    const afterDown = kbdInject.getDiag().postOk;
    ok(afterDown - before === 1, 'A down 注入 1 个事件');
    kbdInject.feedKeyboardReport(Buffer.from([2, 0, 0, 1, 1, 1, 1, 1, 1])); // ErrorRollOver
    const afterRO = kbdInject.getDiag().postOk;
    ok(afterRO === afterDown, 'ErrorRollOver 帧零注入（不抬起已按住的键）');
    // 熔断：真等 REPEAT_FUSE(6s)+余量。注意 autorepeat 补发是内联 CG 调用
    //（不经 postKey/postOk 计数），所以这里只应看到 1 个事件 = 熔断抬起
    console.log('  …等 7s 验证熔断…');
    await new Promise(r => setTimeout(r, 7000));
    const afterFuse = kbdInject.getDiag().postOk;
    ok(afterFuse - afterRO === 1, `6s 后恰好 1 个熔断抬起事件（Δ=${afterFuse - afterRO}）`);
    // 熔断后再喂全零帧不应产生多余事件（状态已干净）
    const b3 = kbdInject.getDiag().postOk;
    kbdInject.feedKeyboardReport(mkRpt(0, 0, 0, 0, 0, 0, 0));
    ok(kbdInject.getDiag().postOk === b3, '熔断后状态干净（全零帧零事件）');
    kbdInject.reset();
  }
  }

  // [T6] 电量解析：cmd=156（查询回应）/ cmd=208（主动上报）。stub 设备 interface=-1
  // → isBluetoothHid=true → transport='蓝牙'，恰好覆盖「蓝牙口取真实电量」分支
  console.log('[T6] 电量解析 cmd=156/208');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const emitted = [];
    s.on('battery', b => emitted.push({ ...b }));
    ok(s.transport === '蓝牙', `测试会话为蓝牙口（实得 ${s.transport}）`);

    // cmd=156（len≥11，payload[4]=电量）：蓝牙取真实值
    const f156 = Buffer.alloc(20);
    f156[5] = 156; f156[6] = 11; f156[11] = 73;
    s._onData(f156);
    ok(s.battery && s.battery.level === 73 && s.battery.charging === false,
      `156: 蓝牙口取真实电量 payload[4]=73（实得 ${s.battery && s.battery.level}）`);
    ok(emitted.length === 1, '首次上报 emit battery');
    s._onData(Buffer.from(f156));
    ok(emitted.length === 1, '同电量去重不重复 emit');
    const f156b = Buffer.from(f156); f156b[11] = 72;
    s._onData(f156b);
    ok(emitted.length === 2 && emitted[1].level === 72, '电量变化重新 emit');

    // cmd=208（len≥2，payload[0]=充电标志、payload[1]=电量）：官方反向语义 0==充电中
    const mk208 = (flag, level) => { const b = Buffer.alloc(12); b[5] = 208; b[6] = 2; b[7] = flag; b[8] = level; return b; };
    s._onData(mk208(0, 88));
    ok(s.battery.level === 88 && s.battery.charging === true, '208: payload[0]==0 → 充电中');
    s._onData(mk208(1, 87));
    ok(s.battery.level === 87 && s.battery.charging === false, '208: payload[0]!=0 → 未充电');

    // len<2 短帧不进解析、不改状态
    const short = Buffer.alloc(10); short[5] = 208; short[6] = 1; short[7] = 1;
    s._onData(short);
    ok(s.battery.level === 87 && s.battery.charging === false, 'len<2 短帧忽略');
    s.stop();
  }

  // [T7] 固件自开麦补发 cmd=3：物理语音键触发而主机没来得及应答时，固件等不到
  // 官方软件回应会注入「Win+R + rkgaming 下载网址」引流——收到自开麦信号立即补发
  console.log('[T7] 自开麦补发 cmd=3（防固件下载引导）');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances.at(-1);
    s._onData(HB104); // 握手两步：104 + 227 后才 connected（否则 askVoice 因离线拒发）
    s._onData(Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 227, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]));
    const asks = () => dev.written.filter(b => b[5] === 3).length;
    const mkCmd = c => { const b = Buffer.alloc(12); b[5] = c; b[6] = 0; return b; };

    // A：无主机请求，固件自开麦（106 到达）→ 恰好补发一条 cmd=3
    s._onData(mkCmd(106));
    ok(asks() === 1, `固件自开麦 → 补发 cmd=3（实得 ${asks()} 条）`);
    ok(s.hostVoiceWanted === false, '补发不改 hostVoiceWanted（幽灵推流看护仍兜底关麦）');

    // B：按住期间固件重复上报 106 → 边沿去重不重复补发
    s._onData(mkCmd(106));
    ok(asks() === 1, `重复 106 不重复补发（实得 ${asks()} 条）`);

    // C：关麦（107）复位后，主机主动 askVoice 的 106 回应不追加补发
    s._onData(mkCmd(107));
    ok(s.micOn === false, '107 复位 micOn');
    s.askVoice();
    const base = asks(); // askVoice 自己那一条
    s._onData(mkCmd(106));
    ok(asks() === base, `主机发起的开麦回应不追加（实得 ${asks()}/${base}）`);
    ok(s.hostVoiceWanted === true, '主机发起的 106 保持 hostVoiceWanted=true');
    s.stop();
  }

  console.log('[T8] USB 口(8102) 会话：候选/通道分类 + 0x1C 音频帧');
  {
    const nodeHidExports = require.cache[nodeHidPath].exports;
    const origDevices = nodeHidExports.devices;
    nodeHidExports.devices = () => [
      { vendorId: 0x248a, productId: 0x8102, usagePage: 0xff12, interface: 1, release: 256, path: 'usb-0' },
    ];
    FakeHID.instances.length = 0;
    const s = new KeySession();
    const audioFrames = [];
    s.on('audio', b => audioFrames.push(b));
    s.start();
    ok(s.transport === 'USB', `transport=USB（实得 ${s.transport}）`);
    ok(s.channel === 0xf1, `通道前缀 0xF1（实得 0x${s.channel.toString(16)}）`);
    const dev = FakeHID.instances.at(-1);
    ok(dev && dev.path === 'usb-0', '选中 USB 厂商接口');
    ok(dev.written.some(b => b[0] === 5 && b[2] === 0xf1), '初始心跳带 0xF1 前缀');
    const pkt = Buffer.alloc(64); pkt[0] = 0x1c; pkt[1] = 7;
    s._onData(pkt);
    ok(audioFrames.length === 1 && audioFrames[0][1] === 7, '0x1C 64B 帧原样 emit audio');
    s._onData(pkt.subarray(0, 40));
    ok(audioFrames.length === 1, '<64B 的 0x1C 短帧丢弃');
    s.stop();
    nodeHidExports.devices = origDevices;
  }

  console.log('[T9] mic.js USB PCM 直通 + DSP 链');
  {
    const { MicPipeline } = require('../src/main/mic.js');
    const p = new MicPipeline({ inRate: 16000, autoRate: false });
    const mk = amp => { const b = Buffer.alloc(64); b[0] = 0x1c; for (let i = 0; i < 30; i++) b.writeInt16LE(amp, 4 + i * 2); return b; };

    // A：管线按 160 样本块出数——30 样本/帧，第 6 帧才凑满第一块
    let out = Buffer.alloc(0);
    let framesFed = 0;
    while (!out.length && framesFed < 20) { out = p.pushWiredFrame(mk(3000)); framesFed++; }
    ok(framesFed === 6, `第 6 帧产出首块（实得第 ${framesFed} 帧）`);
    ok(out.length === 320, `160 样本 → 320B（实得 ${out.length}B）`);

    // B：降噪引擎初始化（DFN3 主力，dll/模型缺失时回退 RNNoise）
    const engine = await p.initDenoiser();
    ok(engine === 'df' || engine === 'rnnoise', `降噪引擎就绪（实得 ${engine}）`);

    // C：低频隆隆被陡高通压制（50Hz 正弦输出 RMS 应远小于输入）
    const p2 = new MicPipeline({ inRate: 16000, autoRate: false });
    await p2.initDenoiser();
    let inRms = 0, inN = 0, outRmsAfterWarmup = 0, outN = 0;
    for (let k = 0; k < 100; k++) {
      const b = Buffer.alloc(64);
      for (let i = 0; i < 30; i++) {
        const t = (k * 30 + i) / 16000;
        b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 50 * t) * 8000), 4 + i * 2);
      }
      const o = p2.pushWiredFrame(b);
      if (k < 10) continue; // 滤波器warm-up
      for (let i = 4; i < 64; i += 2) { inRms += 8000 * 8000; inN++; }
      for (let i = 0; i + 1 < o.length; i += 2) { const v = o.readInt16LE(i); outRmsAfterWarmup += v * v; outN++; }
    }
    const ratio = Math.sqrt(outRmsAfterWarmup / (outN || 1)) / Math.sqrt(inRms / inN);
    ok(ratio < 0.5, `50Hz 分量衰减 >50%（实测保留 ${(ratio * 100).toFixed(1)}%）`);

    // D：限幅不炸——大信号输出有界且无 NaN
    let clipped = false;
    for (let k = 0; k < 40; k++) {
      const o = p2.pushWiredFrame(mk(32000));
      for (let i = 0; i + 1 < o.length; i += 2) {
        const v = o.readInt16LE(i);
        if (!Number.isFinite(v) || Math.abs(v) > 32767) clipped = true;
      }
    }
    ok(!clipped, '软限幅输出有界');

    // E：静音段被门控压低（喂底噪，输出 RMS 应显著低于输入）
    const p3 = new MicPipeline({ inRate: 16000, autoRate: false });
    await p3.initDenoiser();
    let gIn = 0, gOut = 0, gN = 0;
    for (let k = 0; k < 150; k++) { // 1.5s 底噪让门控收敛
      const b = Buffer.alloc(64);
      for (let i = 0; i < 30; i++) b.writeInt16LE(((k * 31 + i * 7) % 200) - 100, 4 + i * 2); // ~±100 小噪声
      const o = p3.pushWiredFrame(b);
      gIn += 100 * 100;
      for (let i = 0; i + 1 < o.length; i += 2) { const v = o.readInt16LE(i); gOut += v * v; }
      gN++;
    }
    const gRatio = Math.sqrt(gOut / (gN * 320)) / 100;
    ok(gRatio < 0.6, `静音段门控压低（实测保留 ${(gRatio * 100).toFixed(1)}%）`);
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
