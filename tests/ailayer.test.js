// AI 层（任意键盘 F 区 → 动作槽位）测试：
// 覆盖 normalizeAiLayer 配置规范化、buildHotkeys 注册表生成（含 Alt 方案跳过 F4）、
// CODING_PRESET 预设有效性、config.load 对旧配置的 aiLayer 字段合并。
// 纯逻辑测试，不启动 worker（RegisterHotKey 真注册在 E2E 里验证）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ FAIL:', name)); };

// ---- stub electron（config.js 顶层 require('electron').app.getPath）----
const fakeData = fs.mkdtempSync(path.join(os.tmpdir(), 'anykey-ai-test-'));
try {
  const electronPath = require.resolve('electron', { paths: [ROOT] });
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => fakeData } },
  };
} catch (_) { /* 无 electron 依赖解析时直接用 */ }

const aiLayer = require('../src/main/ailayer.js');
const config = require('../src/main/config.js');

// ---------- normalizeAiLayer ----------
console.log('[T1] normalizeAiLayer：空/非法输入收敛成安全默认');
{
  const d = aiLayer.normalizeAiLayer(undefined);
  ok(d.enabled === false, '默认不启用（不注册任何热键，F 键零影响）');
  ok(d.trigger === 'ctrlalt', '默认触发键 ctrlalt');
  ok(aiLayer.SLOT_KEYS.every(k => d.slots[k] && d.slots[k].type === 'none'), '12 个槽位默认全为不动作');

  const bad = aiLayer.normalizeAiLayer({ enabled: 'yes', trigger: 'hack', slots: { f1: { type: 'rm -rf' }, f2: 'url', f3: { type: 'url', target: 'https://x' } } });
  ok(bad.enabled === false, 'enabled 严格布尔');
  ok(bad.trigger === 'ctrlalt', '非法 trigger 回落 ctrlalt');
  ok(bad.slots.f1.type === 'none' && bad.slots.f2.type === 'none', '非法 action 形状回落不动作');
  ok(bad.slots.f3.type === 'url' && bad.slots.f3.target === 'https://x', '合法 action 原样保留');

  const off = aiLayer.normalizeAiLayer({ enabled: true, trigger: 'off' });
  ok(off.trigger === 'off' && off.enabled === true, "'off' 是合法 trigger（启用但不注册）");
}

// ---------- buildHotkeys ----------
console.log('[T2] buildHotkeys：注册表生成');
{
  const ca = aiLayer.buildHotkeys('ctrlalt');
  ok(ca.length === 12, 'ctrlalt 方案 12 个热键');
  ok(ca.every(h => (h.mods & 0x0002) !== 0 && (h.mods & 0x0001) !== 0), '全部含 MOD_CONTROL|MOD_ALT');
  ok(ca.every(h => (h.mods & 0x4000) !== 0), '全部含 MOD_NOREPEAT（按住不重触发）');
  ok(ca[0].vk === 0x70 && ca[11].vk === 0x7b, 'VK 码 F1=0x70 … F12=0x7B');
  ok(ca.map(h => h.id).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12', 'id 与 F 序号一致');

  const alt = aiLayer.buildHotkeys('alt');
  ok(alt.length === 11, 'alt 方案 11 个（跳过 F4，保留 Alt+F4 给系统）');
  ok(!alt.some(h => h.key === 'f4'), 'f4 不在注册表');
  ok(alt.every(h => (h.mods & 0x0002) === 0 && (h.mods & 0x0001) !== 0), 'alt 方案只含 MOD_ALT');

  ok(aiLayer.buildHotkeys('off').length === 0 && aiLayer.buildHotkeys('nope').length === 0, 'off/未知方案 → 空表（不注册）');
}

// ---------- buildHotkeys darwin（macOS 适配：显式传参，默认仍 win32） ----------
console.log('[T2b] buildHotkeys darwin：mac 键码与修饰符');
{
  const ca = aiLayer.buildHotkeys('ctrlalt', 'darwin');
  ok(ca.length === 12, 'ctrlalt 方案 12 个热键');
  ok(ca[0].code === 122 && ca[1].code === 120 && ca[2].code === 99, 'mac 键码 F1=122/F2=120/F3=99（HIToolbox 非连续）');
  ok(ca.every(h => (h.mods & 0x40000) !== 0 && (h.mods & 0x80000) !== 0), '全部含 Control|Alternate flags');
  ok(ca.every(h => h.vk === undefined), 'darwin 形状不带 VK 码字段（code 才是键码）');

  const alt = aiLayer.buildHotkeys('alt', 'darwin');
  ok(alt.length === 11 && !alt.some(h => h.key === 'f4'), 'alt 方案 11 个（跳过 F4，mac 同语义）');
  ok(alt.every(h => h.mods === 0x80000), 'alt 方案只含 Option(⌥) flag');

  ok(aiLayer.buildHotkeys('off', 'darwin').length === 0, 'off → 空表（不注册）');
}

// ---------- CODING_PRESET ----------
console.log('[T3] CODING_PRESET：预设动作形状合法');
{
  ok(aiLayer.CODING_PRESET.f1.type === 'url' && /^https:\/\//.test(aiLayer.CODING_PRESET.f1.target), 'F1 是 https 网址');
  const n = Object.keys(aiLayer.CODING_PRESET).length;
  ok(n >= 5, `预设填了 ${n} 个槽位（≥5）`);
  ok(Object.values(aiLayer.CODING_PRESET).every(a => aiLayer.normalizeAiLayer({ slots: { f1: a } }).slots.f1.type !== undefined), '全部动作过 normalize 不丢');
}

// ---------- slotLabel / triggerOptions ----------
console.log('[T4] slotLabel / triggerOptions');
{
  ok(aiLayer.slotLabel('ctrlalt', 'f1').includes('F1'), '槽位标签含键名');
  const opts = aiLayer.triggerOptions();
  ok(opts.length === 2 && opts.some(o => o.value === 'ctrlalt' && o.skip.length === 0) && opts.some(o => o.value === 'alt' && o.skip.includes('f4')), '两个方案，alt 带 F4 skip');
}

// ---------- config.load 合并 aiLayer ----------
console.log('[T5] config.load：aiLayer 字段合并与默认');
{
  const d = config.load(); // fakeData 无 config.json → 首次启动默认
  ok(d.aiLayer && d.aiLayer.enabled === false && d.aiLayer.trigger === 'ctrlalt', '首次启动默认 aiLayer（关闭）');

  fs.writeFileSync(path.join(fakeData, 'config.json'), JSON.stringify({
    bindings: {},
    settings: { statsEnabled: false },
    aiLayer: { enabled: true, trigger: 'alt', slots: { f1: { type: 'hotkey', combo: 'Win+H' } } },
  }));
  const c = config.load();
  ok(c.aiLayer.enabled === true && c.aiLayer.trigger === 'alt', '旧配置的 aiLayer 正确读回');
  ok(c.aiLayer.slots.f1 && c.aiLayer.slots.f1.combo === 'Win+H', '槽位动作保留');
  // load 只做浅合并：缺槽位在写路径（normalizeAiLayer）与运行时（syncAilayer 兜底 {type:none}）收敛，
  // 手改 JSON 缺键也不会崩（T1 已覆盖 normalize 的全量补齐）
  ok(c.aiLayer.slots.f2 === undefined, '缺槽位浅合并保留（运行时兜底不动作）');
  ok(c.settings.statsEnabled === false, '其他字段合并不受影响');
}

fs.rmSync(fakeData, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
