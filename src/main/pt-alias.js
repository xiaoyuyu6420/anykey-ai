// 透传键名决策（纯函数，无依赖，便于单测）：
// 远控防串键开启时，语音触发键的主键改发冷门键码 F13（普通键盘没有此键），
// 合成修饰键由调用方照常附加 → 实际序列如 Ctrl+F13。转发到被控端后修饰键
// 退化也只可能是 F13，打不中远端任何常见配置；UU远程「仅控制端响应的快捷键」
// 白名单只收单键，加一条 F13 即可彻底不转发。
// 生效条件：仅 win32 + 已开启 remoteSafeMode + 已选透传修饰键（微信输入法
// 「按住说话」强制组合键，纯 F13 配不进去）+ 该键在语音触发键列表内。
const REMOTE_SAFE_KEY = 'f13';
const REMOTE_SAFE_VK = 0x7c; // VK_F13

function passKeyNameOf(settings, keyId, isWin) {
  if (!settings || !isWin || !settings.remoteSafeMode) return keyId;
  if (!['ctrl', 'alt', 'shift'].includes(settings.micPassMod)) return keyId;
  if (!(settings.micTriggerKeys || []).includes(keyId)) return keyId;
  return REMOTE_SAFE_KEY;
}

// 无系统键码的触发键（AI 键 / PrtSc / 扩展键位）改发「借用键」——
// 这些键在 Windows 上根本没有对应的虚拟键码（vkOf 返回 null，注入必然静默失败），
// 所以按住它们时输入法永远收不到任何按键：麦开了、声音在流，但不出字。
// 借用规则：改发「触发键里第一个有键码的键」，修饰键照常叠加 —— 借 F10 且
// 透传修饰键=Ctrl 时，按 AI 键发出的就是 Ctrl+F10，正是微信里配好的那个组合，
// 于是 AI 键与 F10 等效。都不借（只勾了 AI 键）时兜底 F10：官方语音键，
// 也是文档里让用户在输入法里配的那个。mac 不走这条路（无组合键强制、注入模型不同）。
// 只对「语音触发键」成立：别的无键码键（扩展键位等）没有可等价的原功能，
// 保持既有语义「注入失败 = 什么都不发」，绝不凭空合成一个键。
function aliasKeyOf(settings, keyId, vkOf) {
  if (vkOf(keyId) !== null) return keyId;
  const triggers = (settings && settings.micTriggerKeys) || [];
  if (!triggers.includes(keyId)) return keyId;
  const donor = triggers.find(k => k !== keyId && vkOf(k) !== null);
  return donor || 'f10';
}

module.exports = { REMOTE_SAFE_KEY, REMOTE_SAFE_VK, passKeyNameOf, aliasKeyOf };
