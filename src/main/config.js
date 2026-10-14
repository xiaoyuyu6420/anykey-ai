// 配置读写：userData/config.json，无第三方依赖
// 0.9.0 起支持多配置档（profiles）：bindingsByProfile 是唯一真源，
// 顶层 bindings/bindingsAi 是 active 档内部对象的引用投影（同一对象引用），
// 主进程读写 cfg.bindings 即读写 active 档，旧代码零改动。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_PROFILES = 5;

// AI 层（任意键盘：触发键+F1~F12 → 动作槽位）默认关闭：
// 热键不注册则 F 键零影响（不启用绝不抢占，见 ailayer.js 头注释）
const AI_LAYER_DEFAULT = { enabled: false, trigger: 'ctrlalt', slots: {} };

const DEFAULTS = {
  // 顶层 bindings/bindingsAi 由 projectActive() 投影生成（= active 档的引用）
  profiles: { order: ['default'], activeId: 'default', names: { default: '默认' } },
  bindingsByProfile: { default: { bindings: {}, bindingsAi: {} } },
  appRules: [], // [{ profileId, name }]（按前台进程 exe 基名小写匹配，仅 Windows）
  settings: {
    triggerOnUp: false,       // 预留：在抬起时触发（默认按下即触发）
    micBridgeEnabled: false,  // 键盘麦克风 → 虚拟声卡桥接
    micSinkId: '',            // 桥接播放设备（虚拟声卡播放端，如 CABLE Input）
    micTriggerKeys: ['f10', 'ai_key'], // 按住即开麦的键（可设置）
    micPassMod: 'none',      // 语音键透传附加修饰键（none/ctrl/alt/shift；Windows 微信输入法
                             // 「按住说话」强制要求组合键，纯 F10 配不进去 → 选 ctrl 后在
                             // 微信里配 Ctrl+F10。仅 win32 生效，mac 无此限制）
    remoteSafeMode: false,   // 远控防串键（仅 win32，需配合 micPassMod）：语音键透传主键改发
                             // 冷门键码 F13（普通键盘没有此键），微信里配 Ctrl+F13。转发到
                             // 被控端后修饰键退化也只可能是 F13，打不中远端任何常见配置；
                             // UU远程「仅控制端响应的快捷键」白名单只收单键，加一条 F13 即可
                             // 彻底不转发。仅影响语音触发键，其他绑定键透传不变
    // 原始音频旁路（v0.12.9）：跳过全部 DSP——高通/降噪/谱减/门控/AGC/压缩/限幅，
    // 直接输出键盘麦原样声音。用途是做基准对比：如果原始听着比处理后更清楚，
    // 说明这套算法在帮倒忙而非帮忙。
    // 默认先开（用户要先听原始版本），确认后再决定是否关掉。
    // 处理档位（v0.13.2）：raw=全跳过 / hp=只去低频轰鸣 / full=完整处理链。
    // hp 档的由来：实测底噪 38% 能量在 200Hz 以下，这部分低频除了「闷」，
    // 还会让廉价耳机/音箱非线性失真而听感「刺」——需要一个独立档位验证
    micMode: 'speech',
    // 辅音区补偿量（dB，mode='speech' 时生效，单级搁架 @2600Hz，0=关闭）。
    // 实测该键盘麦说话段 2-8kHz 仅占 1.33%（正常语音 4~5%）——辅音区弱约 5dB，
    // 而 s/sh/t/k/f 等决定可懂度的音全在该频段，ASR 对此高度敏感。
    // 离线用真实语音扫描：+6dB 把该带提到 6.02%，最接近正常人声分布
    micHfBoost: 6,
    micBypass: true,
    // 键盘音频流的真实采样率（v0.13.1）。实测 17129Hz——墙上时钟法：
    // 30.00s 收到 17132 帧 × 每帧 30 样本。协议文档曾按 16000Hz 处理，
    // 导致全部声音被降调降速 7%（听感「闷/糊」，同时劣化 ASR）。
    // 改动前请重新测量：麦克风开着的状态下，用面板「录音测试」录 15 秒以上，
    // 用 (样本数 ÷ 墙上秒数) 反推。填 16000 可关闭转换。
    // 注意：这只是「初值」。运行时按「样本数÷墙上时钟」自动校准（4 秒），
    // 因为采样率是链路+固件的属性——实测 2.4G 链路 17129Hz，
    // 有线直连可能不同、固件升级也可能变，硬编码会在别的链路上引入新的降调。
    micInputRate: 17129,
    // 默认关闭（v0.16.0，实测结论）：用本地 ASR 在 648 字次/配置上测字错率，
    // 完整链（DFN3 降噪 + AGC + 门控）让识别错误从 176 增到 240~242 处
    // （+19%~+53%），是所有配置里最差的；简单的 raw/hp/speech 三者等效且都更好。
    // 推测原因：该麦输入信噪比仅约 7dB，DFN3 在此低信噪比下近乎不提升信噪比
    // （实测 +0.1dB），却会削掉语音成分；重度 AGC 又把噪声一起抬起来。
    denoiseEnabled: false,
    // 远距识别优化（DSP 可调参数，设置页改即时生效）。默认值即优化后取值：
    //   gateRelease 0.25 —— 门控释放（原 0.04 太慢，句中换气被持续压低导致断句漏字）
    //   agcTarget  3600  —— AGC 目标 RMS -19dBFS（原 4200 偏激进，底噪被一起抬起）
    //   attenLimDb 6     —— DFN3 最大衰减。实测（工具 CDP 扫描真实麦克风）：
    //     越低降噪越弱——2dB→16.2dB 降噪量、6dB→20.8dB。曾一度降到 3dB 以求
    //     「保护辅音」，实测方向错了：底噪偏高需要更强降噪，调低反而压不住底噪、
    //     电平被门控吃掉。注意 libdf 把 0 当「无限制」而非「不降噪」，是 API 陷阱
    //   （attenLim 越大降噪越强，24dB 后收益递减；6dB 是收益/风险平衡点）
    //   gateOpenMul 3  —— 语音判定倍数（原 5）。远距语音 RMS 600~900 低于原阈值 750，
    //     永远判不出语音导致 AGC 不启动——这是「越远越听不清」的直接元凶
    //   agcMaxGain 8 → 32 —— 实测发现：降噪后语音 RMS 只剩 25（底噪 12），
    //     AGC 目标 3600 需要约 140× 才能把电平推到 ASR 甜区（800+），
    //     而旧上限把增益卡在 12×，导致送进识别引擎的电平只有 114。
    //     提高上限让 AGC 在弱信号时补得够，SNR 不变但电平进甜区（ASR 对绝对电平敏感）
    //   gateFloor 0.05 —— 沿用原值
    micTune: {
      gateRelease: 0.25,
      agcTarget: 3600,
      attenLimDb: 6,
      gateOpenMul: 3,
      gateFloor: 0.05,
      agcMaxGain: 32,
    },
    micDiag: false,          // 链路体检：欠载/SNR/电平实时落盘 app.log（排查用，日常关）
    // 稳态噪声扣除（v0.12.5）：针对「底噪偏高」——麦自噪/风扇/房间底噪是持续稳态的，
    // 神经网络会刻意保留（否则远处轻声也被删），故学习噪声谱做谱减。
    // overSub 过减系数（越大压得越狠，过大削辅音）；floorDb 谱底限。
    // 默认开启（CDP 实测 A/B 结论）：
    //   关闭时 SNR 提升仅 +0.7dB（神经网络在低信噪比下几乎分不出人声与噪声）
    //   开启后 SNR 提升 +9.2dB、残余底噪 85→22
    // 原理：稳态噪声（麦自噪/风扇/房间底噪）是持续存在的，可被精确建模扣除；
    // 而神经网络对稳态噪声刻意保守（否则远处轻声也被删），两层互补。
    // 需静音约 1 秒完成噪声谱学习。
    noiseSubtractEnabled: false,
    overSub: 2.0,
    floorDb: -18,
    statsEnabled: true,      // 打字统计（只记每键计数与每日总数，纯本地 stats.json）
    statsScope: 'all',       // 统计范围：all=所有键盘（系统级键状态，任何键盘都算）| rk=仅 RK 键盘接入时计数
    fatigueEnabled: true,    // 疲劳提醒（连续打字满阈值弹系统通知）
    fatigueMinutes: 25,      // 疲劳提醒阈值（分钟）
    soundEnabled: false,     // 打字音效（隐藏页 Web Audio 播放，关闭时窗口不创建零开销）
    soundPack: 'blue',       // 音色：blue 青轴 / membrane 薄膜 / typewriter 打字机 / custom 自选目录
    soundVolume: 0.5,        // 音量 0-1
    soundCustomDir: '',      // 自选 wav 目录（soundPack=custom 时生效，目录内 wav 随机播放）
  },
  aiLayer: AI_LAYER_DEFAULT, // 形状见 ailayer.normalizeAiLayer：{ enabled, trigger, slots }
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 旧格式（无 profiles 字段）→ 新格式。纯函数，跑 N 次结果一致（幂等）。
function migrateRaw(raw) {
  raw = raw || {};
  if (raw.profiles && Array.isArray(raw.profiles.order) && raw.profiles.order.length) {
    // 新格式：防御性补齐（幽灵档过滤 / activeId 回落 / names 兜底）
    const stored = raw.bindingsByProfile || {};
    const order = raw.profiles.order.filter(id => stored[id]);
    if (!order.includes('default')) order.unshift('default');
    const bindingsByProfile = {};
    for (const id of order) {
      const p = stored[id] || {};
      bindingsByProfile[id] = { bindings: p.bindings || {}, bindingsAi: p.bindingsAi || {} };
    }
    let activeId = raw.profiles.activeId;
    if (!order.includes(activeId)) activeId = 'default';
    const names = { default: '默认' };
    for (const id of order) {
      names[id] = (raw.profiles.names && raw.profiles.names[id]) || (id === 'default' ? '默认' : id);
    }
    return {
      profiles: { order, activeId, names },
      bindingsByProfile,
      appRules: Array.isArray(raw.appRules)
        ? raw.appRules.filter(r => r && r.profileId && r.name && order.includes(r.profileId))
        : [],
    };
  }
  // 旧格式：现有键位整体拷入 default 档（bindingsAi 兜底逻辑与历史 load 行为一致）
  return {
    profiles: { order: ['default'], activeId: 'default', names: { default: '默认' } },
    bindingsByProfile: {
      default: {
        bindings: raw.bindings || {},
        bindingsAi: raw.bindingsAi || raw.bindings || {},
      },
    },
    appRules: [],
  };
}

// 投影：让顶层 bindings/bindingsAi 指向 active 档内部对象（引用共享，写即同步）
function projectActive(cfg) {
  const id = cfg.bindingsByProfile[cfg.profiles.activeId] ? cfg.profiles.activeId : 'default';
  cfg.profiles.activeId = id;
  cfg.bindings = cfg.bindingsByProfile[id].bindings;
  cfg.bindingsAi = cfg.bindingsByProfile[id].bindingsAi;
}

// 迁移前备份（仅首次：.bak 不存在才写）
function backupOnce() {
  try {
    const p = configPath();
    if (fs.existsSync(p) && !fs.existsSync(p + '.bak')) fs.copyFileSync(p, p + '.bak');
  } catch (_) { /* 备份失败不阻塞迁移（load 有 .corrupt 兜底） */ }
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 首次启动无配置文件：静默走默认，不算「损坏」
      const cfg1 = JSON.parse(JSON.stringify(DEFAULTS));
      projectActive(cfg1);
      return cfg1;
    }
    // 损坏（写一半崩溃/磁盘错误）时留证并重建，避免用户绑定静默清零无法排查
    try { fs.renameSync(configPath(), configPath() + '.corrupt'); } catch (_) {}
    console.log('[config] 读取失败已重建（原文件存为 .corrupt）:', e.message);
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    projectActive(cfg);
    return cfg;
  }
  const legacy = !(raw.profiles && Array.isArray(raw.profiles.order) && raw.profiles.order.length);
  if (legacy) backupOnce();
  const cfg = {
    ...migrateRaw(raw),
    labels: { ...(raw.labels || {}) },
    settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    aiLayer: {
      ...DEFAULTS.aiLayer,
      ...(raw.aiLayer || {}),
      slots: { ...(raw.aiLayer && raw.aiLayer.slots || {}) },
    },
  };
  projectActive(cfg);
  return cfg;
}

function save(cfg) {
  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写临时文件再 rename 替换，避免写一半崩溃导致配置损坏
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath());
}

// ---------- 档操作（纯数据操作，供 IPC 层调用） ----------

function addProfile(cfg, name) {
  if (cfg.profiles.order.length >= MAX_PROFILES) return null;
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  cfg.profiles.order.push(id);
  cfg.profiles.names[id] = String(name || '').slice(0, 12) || `档${cfg.profiles.order.length}`;
  // 新档复制当前档键位（常见诉求：在现有基础上微调）
  cfg.bindingsByProfile[id] = JSON.parse(JSON.stringify({
    bindings: cfg.bindings,
    bindingsAi: cfg.bindingsAi,
  }));
  return id;
}

function renameProfile(cfg, id, name) {
  if (!cfg.bindingsByProfile[id]) return false;
  cfg.profiles.names[id] = String(name || '').slice(0, 12) || cfg.profiles.names[id];
  return true;
}

// 删除档：default 不可删；级联清理 appRules；删 active 先回落 default。
// 返回切换后的 activeId（未删 active 则返回原值），失败返回 null。
function delProfile(cfg, id) {
  if (id === 'default' || !cfg.bindingsByProfile[id]) return null;
  delete cfg.bindingsByProfile[id];
  cfg.profiles.order = cfg.profiles.order.filter(x => x !== id);
  delete cfg.profiles.names[id];
  cfg.appRules = cfg.appRules.filter(r => r.profileId !== id);
  let activeId = cfg.profiles.activeId;
  if (activeId === id) {
    activeId = 'default';
    setActive(cfg, activeId);
  }
  return activeId;
}

function setActive(cfg, id) {
  if (!cfg.bindingsByProfile[id]) return false;
  cfg.profiles.activeId = id;
  projectActive(cfg);
  return true;
}

function defaultBinding(keyId) {
  return { type: 'none' };
}

module.exports = {
  load, save, defaultBinding, DEFAULTS, MAX_PROFILES, AI_LAYER_DEFAULT,
  migrateRaw, projectActive, addProfile, renameProfile, delProfile, setActive,
};
