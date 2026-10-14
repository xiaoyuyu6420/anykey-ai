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
    denoiseEnabled: true,    // RNNoise 神经降噪 + DSP 增强链（高通/VAD 门控 AGC/软限幅）
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
    // 默认关闭：先用降噪探针量出基线（DFN3 单独工作时的底噪前后对比），
    // 确认「软件还能不能救」再决定是否叠加这一层——避免多层处理互相掩盖问题。
    noiseSubtractEnabled: false,
    overSub: 2.0,
    floorDb: -18,
    statsEnabled: true,      // 打字统计（只记每键计数与每日总数，纯本地 stats.json）
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
