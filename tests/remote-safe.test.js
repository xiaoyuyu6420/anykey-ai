// 远控防串键单测（纯逻辑，stub electron）：键名决策表 + 配置默认值兼容
const path = require('path');
const fs = require('fs');
const os = require('os');

// stub electron：config.js 只用 app.getPath('userData')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rk87-rs-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const { REMOTE_SAFE_KEY, REMOTE_SAFE_VK, passKeyNameOf, aliasKeyOf } = require('../src/main/pt-alias');
const config = require('../src/main/config.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

console.log('[T1] passKeyNameOf 决策表');
{
  const S = (over) => ({ remoteSafeMode: true, micPassMod: 'ctrl', micTriggerKeys: ['f10', 'ai_key'], ...over });

  ok(passKeyNameOf(S(), 'f10', true) === REMOTE_SAFE_KEY, 'win+开启+ctrl+语音键 → f13');
  ok(passKeyNameOf(S(), 'ai_key', true) === REMOTE_SAFE_KEY, 'AI 键同样替换');
  ok(passKeyNameOf(S(), 'f5', true) === 'f5', '非语音触发键不替换');
  ok(passKeyNameOf(S({ micPassMod: 'none' }), 'f10', true) === 'f10', '修饰键=无 不替换（微信配不进纯 F13）');
  ok(passKeyNameOf(S({ remoteSafeMode: false }), 'f10', true) === 'f10', '开关关闭不替换');
  ok(passKeyNameOf(undefined, 'f10', true) === 'f10', 'settings 缺失安全回落');
  ok(passKeyNameOf(S(), 'f10', false) === 'f10', 'mac 恒不替换（mac 无组合键强制）');

  // 决策只改主键名：修饰键由调用方照常附加（序列语义在 index.js 集成）
  ok(REMOTE_SAFE_KEY === 'f13' && REMOTE_SAFE_VK === 0x7c, '冷门键常量：VK_F13=0x7C');
}

console.log('[T2] aliasKeyOf 借用键（无系统键码的触发键）');
{
  // 用 actions 的真实 vkOf：AI 键/PrtSc/扩展键位在 Win 上没有系统键码
  const actions = require('../src/main/actions.js');
  const vk = name => actions.vkOf(name);
  const S = (over) => ({ micPassMod: 'ctrl', micTriggerKeys: ['f10', 'ai_key'], ...over });

  ok(vk('f10') !== null && vk('ai_key') === null && vk('ext_1') === null,
    '前提：F10 有键码，AI 键/扩展键位没有');
  ok(aliasKeyOf(S(), 'f10', vk) === 'f10', '有键码的键原样返回');
  ok(aliasKeyOf(S(), 'ai_key', vk) === 'f10', 'AI 键借第一个有键码的触发键（默认 F10）');
  ok(aliasKeyOf(S({ micTriggerKeys: ['ai_key', 'f7'] }), 'ai_key', vk) === 'f7',
    '触发键顺序决定借用对象（只勾 AI 键+F7 → 借 F7，与用户配的 Ctrl+F7 对齐）');
  ok(aliasKeyOf(S({ micTriggerKeys: ['ai_key'] }), 'ai_key', vk) === 'f10',
    '只勾了 AI 键：兜底借官方语音键 F10');
  ok(aliasKeyOf(undefined, 'ai_key', vk) === 'ai_key', 'settings 缺失：不合成，原样返回');
  const S2 = S({ micTriggerKeys: ['ai_key', 'ext_1', 'f10'] });
  ok(aliasKeyOf(S2, 'ai_key', vk) === 'f10' && aliasKeyOf(S2, 'ext_1', vk) === 'f10',
    '两个不同的无键码触发键借同一个（第一个有键码的键）——行为可预期');
  ok(aliasKeyOf(S(), 'ext_1', vk) === 'ext_1',
    '不在触发键列表里的无键码键：不发（保持「注入失败=什么都不发」，绝不凭空合成）');
}

console.log('[T3] 配置默认值与旧文件兼容');
{
  const cfg1 = config.load();
  ok(cfg1.settings.remoteSafeMode === false, '缺省 remoteSafeMode=false');

  // 旧格式配置文件（无该字段）迁移后补默认值，不报错
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    bindings: { f5: { type: 'hotkey', combo: 'Ctrl+S' } },
    settings: { micPassMod: 'ctrl', fatigueMinutes: 9 },
  }));
  const cfg2 = config.load();
  ok(cfg2.settings.remoteSafeMode === false && cfg2.settings.micPassMod === 'ctrl',
    '旧文件合并：新字段补默认、旧字段保留');
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
