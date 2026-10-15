// 3D 键盘首屏（Three.js）：87 键程序化建模 + 键缝 RGB 透光 + 拖拽旋转 + 点击拾取
// 性能守门：几何体按键宽共享（7 种）；常驻动画只有悬浮微动；窗口失焦/容器滚出
// 视野/页面隐藏/托盘暂停（setRenderPaused）时停渲染循环；悬停拾取只在 pointermove 时做。
import * as THREE from '../../vendor/three/three.module.min.js';
import { animate, stagger } from '../../vendor/animejs/anime.esm.min.js';

const U = 1; // 1 键帽单位

// ---------- 托盘暂停（全实例共享） ----------
// 窗口隐藏/最小化到托盘时主进程发 app-visibility=false（见 index.js syncRenderActive），
// app.js 调这里的 setRenderPaused 停掉所有实例的渲染循环。页面级 document.hidden
// 依赖主进程隐藏期打开 backgroundThrottling 才会变 true，且事件时序不保证——
// 显式开关是主保险，页面可见性只是自然兜底（2026-09-06 GPU 进程 31h CPU 的修复）
let renderPaused = false;
const liveLoops = new Set(); // 各实例的 tick 函数：恢复时逐个拉起
export function setRenderPaused(p) {
  if (renderPaused === p) return;
  renderPaused = p;
  if (!p && !document.hidden) for (const tick of liveLoops) tick();
}

// ---------- TKL 87 键布局（视觉近似）：[键id|null, 宽度u]，null=装饰键 ----------
// 可配置键 id 必须与 keymap.js 一致；标准键 id 供热力图用（阶段 3）
export const LAYOUT = [
  // F 行：Esc + F1-F12（官方 AI 功能键）+ PrtSc + AI 模式切换键（模式开关，非动作键）
  [['esc', 1], [null, .5], ['f1', 1], ['f2', 1], ['f3', 1], ['f4', 1], [null, .5],
   ['f5', 1], ['f6', 1], ['f7', 1], ['f8', 1], [null, .5],
   ['f9', 1], ['f10', 1], ['f11', 1], ['f12', 1], [null, .5], ['prtsc', 1], ['ai_toggle', 1]],
  // 数字行 + 导航列
  [['backtick', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1],
   ['8', 1], ['9', 1], ['0', 1], ['minus', 1], ['equal', 1], ['backspace', 2],
   [null, .5], ['insert', 1], ['home', 1], ['pgup', 1]],
  // Q 行
  [['tab', 1.5], ['q', 1], ['w', 1], ['e', 1], ['r', 1], ['t', 1], ['y', 1], ['u', 1],
   ['i', 1], ['o', 1], ['p', 1], ['lbracket', 1], ['rbracket', 1], ['backslash', 1.5],
   [null, .5], ['delete', 1], ['end', 1], ['pgdn', 1]],
  // A 行
  [['capslock', 1.75], ['a', 1], ['s', 1], ['d', 1], ['f', 1], ['g', 1], ['h', 1], ['j', 1],
   ['k', 1], ['l', 1], ['semicolon', 1], ['quote', 1], ['enter', 2.25]],
  // Z 行 + 方向上
  [['lshift', 2.25], ['z', 1], ['x', 1], ['c', 1], ['v', 1], ['b', 1], ['n', 1], ['m', 1],
   ['comma', 1], ['period', 1], ['slash', 1], ['rshift', 2.75],
   [null, 1.5], ['up', 1]],
  // 底行 + 方向列（Fn 右侧是 AI 问答键：实体上新增的独立按键，可配置动作）
  [['lctrl', 1.25], ['lwin', 1.25], ['lalt', 1.25], ['space', 6.25], ['ralt', 1.5],
   ['fn', 1.25], ['ai_key', 1], ['rctrl', 1.25],
   [null, .5], ['left', 1], ['down', 1], ['right', 1]],
];
// 可配置键（ext_1-4 是协议保留位、实体键盘上不存在，只留在列表模式里配置，3D 不画）
const CONFIGURABLE = new Set(['ai_key', 'prtsc', ...Array.from({ length: 12 }, (_, i) => 'f' + (i + 1))]);

// 标准键帽显示名（字母/数字直接大写，特殊键用短名）
const CAP_LABELS = {
  backtick: '`', minus: '-', equal: '=', lbracket: '[', rbracket: ']', backslash: '\\',
  semicolon: ';', quote: "'", comma: ',', period: '.', slash: '/',
  tab: 'Tab', capslock: 'Caps', enter: 'Enter', backspace: '⌫', esc: 'Esc',
  lshift: 'Shift', rshift: 'Shift', lctrl: 'Ctrl', rctrl: 'Ctrl',
  lalt: 'Alt', ralt: 'Alt', lwin: 'Win', fn: 'Fn',
  insert: 'Ins', home: 'Home', pgup: 'PgUp', delete: 'Del', end: 'End', pgdn: 'PgDn',
  up: '↑', down: '↓', left: '←', right: '→', ai_toggle: 'AI切换',
};

// ---------- 键帽几何（按宽度缓存，Extrude 圆角） ----------
const capGeoCache = new Map();
function capGeometry(wu) {
  if (capGeoCache.has(wu)) return capGeoCache.get(wu);
  const w = wu * U * .92, d = U * .92;
  const r = .09, s = new THREE.Shape();
  const hw = w / 2 - r, hd = d / 2 - r;
  // 圆角矩形轮廓（顶面比底面小做键帽梯形感：靠 bevel 外扩 + 顶盖缩放太复杂，
  // 这里直接用略缩的圆角矩形 + bevel，视觉上即键帽）
  s.moveTo(-hw, -hd);
  s.lineTo(hw, -hd); s.quadraticCurveTo(hw + r, -hd, hw + r, -hd + r);
  s.lineTo(hw + r, hd - r); s.quadraticCurveTo(hw + r, hd, hw, hd);
  s.lineTo(-hw, hd); s.quadraticCurveTo(-hw - r, hd, -hw - r, hd - r);
  s.lineTo(-hw - r, -hd + r); s.quadraticCurveTo(-hw - r, -hd, -hw, -hd);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: .34, bevelEnabled: true, bevelThickness: .07, bevelSize: .07,
    bevelSegments: 2, curveSegments: 3,
  });
  geo.rotateX(-Math.PI / 2); // shape 的 xy → 地面平铺，depth 朝上
  geo.translate(0, .07, 0); // 抬升 bevel 底厚，键帽底面贴板（顶面 ≈ y0.48）
  capGeoCache.set(wu, geo);
  return geo;
}

export function createKeyboard3D(container, { onKeyClick, intro = false } = {}) {
  const W = () => container.clientWidth, H = () => container.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W(), H());
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, W() / H(), .1, 100);
  camera.position.set(0, 13, 18.5); // 拉远到默认视野可完整容纳 87 键（四周留余量）
  camera.lookAt(0, 0, .1);

  // 灯光：环境冷光 + 左蓝右紫两盏点光（呼应键缝 RGB）
  scene.add(new THREE.AmbientLight(0x8fa3c8, .55));
  const key = new THREE.DirectionalLight(0xdfe8ff, .9);
  key.position.set(4, 10, 6);
  scene.add(key);
  const p1 = new THREE.PointLight(0x2b5cff, 40, 30); p1.position.set(-9, 4, 4);
  const p2 = new THREE.PointLight(0x7c5cff, 32, 30); p2.position.set(9, 4, 2);
  scene.add(p1, p2);

  const world = new THREE.Group(); // 悬浮微动作用
  scene.add(world);

  // 键盘底板：圆角板 + 侧沿发光条
  const totalCols = Math.max(...LAYOUT.map(row => row.reduce((a, [, w]) => a + w, 0)));
  const plateW = totalCols * U + 1, plateD = LAYOUT.length * U + 1;
  const plate = roundedPlate(plateW, plateD, .45, .5);
  world.add(plate);

  // 键帽材质：标准键共享；可配置键共享另一份（悬停提亮需要独立→悬停改用底部光，键帽可共享）
  const keyMeshes = [];      // { mesh, mat(独立键帽材质), id, glow(底部 RGB plane 材质), cfg }
  const byId = new Map();

  const rowGap = 0; // 行距（u 内已含 0.92 留缝）
  LAYOUT.forEach((row, ri) => {
    let cx = -totalCols * U / 2;
    for (const [id, w] of row) {
      const cw = w * U;
      if (id) addKey(id, cx, ri, cw);
      cx += cw;
    }
  });

  function addKey(id, cx, ri, cw) {
    const cfg = CONFIGURABLE.has(id);
    // 每键独立材质：热力模式要把计数打到键帽自发光上（缝光俯视被键帽遮挡，看不见）
    const mat = new THREE.MeshStandardMaterial(cfg
      ? { color: 0x39415c, roughness: .45, metalness: .22 }
      : { color: 0x252a36, roughness: .6, metalness: .18 });
    const mesh = new THREE.Mesh(capGeometry(cw / U), mat);
    // z 居中：行索引从板前缘起算会整体偏移半块板（键区须对中于底板）
    mesh.position.set(cx + cw / 2, 0, (ri - LAYOUT.length / 2 + .5) * U);
    world.add(mesh);
    // 底部 RGB 透光面（键缝光）
    const glowMat = cfg
      ? new THREE.MeshBasicMaterial({ color: 0x1f2f5c })
      : new THREE.MeshBasicMaterial({ color: 0x0d1730 }); // 独立材质：热力图逐键着色需要
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(cw * .8, U * .8), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(mesh.position.x, .02, mesh.position.z);
    world.add(glow);
    // 键帽刻字：所有键都显示键名（可配置键亮白，标准键暗灰）
    if (id !== 'space') labelKey(mesh, id, cw, cfg);
    const rec = { mesh, mat, id, glowMat, cfg };
    keyMeshes.push(rec);
    if (cfg) byId.set(id, rec);
  }

  // 键帽刻字：canvas 纹理平面贴在键帽顶面（每键一张小纹理）
  function labelKey(mesh, id, cw, cfg) {
    const short = cfg
      ? ({ ai_key: 'AI', prtsc: 'PrtSc' }[id] ||
         (/^f\d+$/.test(id) ? id.toUpperCase() : 'E' + id.slice(4)))
      : (CAP_LABELS[id] !== undefined ? CAP_LABELS[id]
         : (/^[a-z0-9]$/.test(id) ? id.toUpperCase() : id));
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = cfg ? '#eef3ff' : '#7e879c';
    g.font = `700 ${short.length <= 2 ? 46 : Math.floor(120 / short.length)}px "Segoe UI", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(short, 64, 66);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    const lbl = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(cw * .72, 1.1), Math.min(cw * .72, 1.1)),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 1 }));
    lbl.rotation.x = -Math.PI / 2;
    lbl.position.set(mesh.position.x, mesh.position.y + .52, mesh.position.z);
    world.add(lbl);
  }

  function roundedPlate(w, d, r, h) {
    const s = new THREE.Shape();
    const hw = w / 2, hd = d / 2;
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd); s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r); s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd); s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r); s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: .12, bevelSize: .12, bevelSegments: 2, curveSegments: 4 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0c0e15, roughness: .45, metalness: .5 });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -h;
    // 侧沿发光条（前缘）
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(w * .96, .06, .06),
      new THREE.MeshBasicMaterial({ color: 0x4f8cff }));
    strip.position.set(0, -h + .12, hd + .1);
    const g2 = new THREE.Group();
    g2.add(m, strip);
    return g2;
  }

  // ---------- 交互：拖拽旋转 + 点击拾取 + 悬停高亮 ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let dragging = false, moved = 0, px = 0, py = 0;
  let rotY = 0, rotX = 0;           // 用户拖拽的偏移
  let hoverRec = null;

  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(keyMeshes.filter(k => k.cfg).map(k => k.mesh), false);
    if (!hits.length) return null;
    return keyMeshes.find(k => k.mesh === hits[0].object) || null;
  }

  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    dragging = true; moved = 0; px = e.clientX; py = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (dragging) {
      const dx = e.clientX - px, dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      rotY += dx * .005;
      rotX = Math.max(-.35, Math.min(.6, rotX + dy * .004));
      px = e.clientX; py = e.clientY;
    } else {
      const rec = pick(e);
      if (rec !== hoverRec) {
        if (hoverRec) hoverRec.glowMat.color.set(configuredIds.has(hoverRec.id) ? 0x4f8cff : 0x1f2f5c);
        if (rec) rec.glowMat.color.set(0x9dc4ff);
        hoverRec = rec;
        el.style.cursor = rec ? 'pointer' : 'grab';
      }
    }
  });
  el.addEventListener('pointerup', e => {
    dragging = false;
    if (moved < 6) {
      const rec = pick(e);
      if (rec && onKeyClick) onKeyClick(rec.id);
    }
  });
  el.addEventListener('pointerleave', () => {
    if (hoverRec) { hoverRec.glowMat.color.set(configuredIds.has(hoverRec.id) ? 0x4f8cff : 0x1f2f5c); hoverRec = null; }
  });

  // ---------- 状态：已配置键发光（全量替换：模式/档位切换不残留） ----------
  const configuredIds = new Set();
  function setConfigured(ids) {
    configuredIds.clear();
    for (const id of ids) if (byId.has(id)) configuredIds.add(id);
    for (const [id, rec] of byId) {
      if (rec === hoverRec) continue;
      rec.glowMat.color.set(configuredIds.has(id) ? 0x4f8cff : 0x1f2f5c);
    }
  }

  // ---------- 热力模式：按键次数逐键着色（统计页用） ----------
  // 打在键帽自发光（emissive）上——缝光俯视被键帽遮挡，平面热力的经验是直接亮键帽
  // 统计的修饰键不分左右（ctrl/shift/alt/win）→ 左右两颗键同亮
  const HEAT_ALIAS = {
    lctrl: 'ctrl', rctrl: 'ctrl', lshift: 'shift', rshift: 'shift',
    lalt: 'alt', ralt: 'alt', lwin: 'win',
  };
  const heatDark = new THREE.Color(0x101521);
  const heatLo = new THREE.Color(0x1f3f8f);
  const heatHi = new THREE.Color(0x35e0a8);
  function setHeat(counts) {
    const max = Math.max(1, ...Object.values(counts || {}));
    for (const rec of keyMeshes) {
      const c = (counts && counts[HEAT_ALIAS[rec.id] || rec.id]) || 0;
      if (!c) {
        rec.glowMat.color.copy(heatDark);
        rec.mat.emissive.set(0x000000);
        continue;
      }
      const t = Math.sqrt(c / max);
      rec.glowMat.color.copy(heatLo).lerp(heatHi, t);
      rec.mat.emissive.copy(heatLo).lerp(heatHi, t);
      rec.mat.emissiveIntensity = .35 + .85 * t;
    }
  }

  // ---------- 渲染循环：失焦/视野外/页面隐藏/托盘暂停即停 ----------
  // 失焦 0 帧：设置页没焦点时 3D 键盘根本没人看，整循环停掉。失焦判定由主进程
  // OS 级 isFocused() 经 app-visibility → setRenderPaused 驱动（渲染端 DOM
  // blur/focus 在全屏游戏抢占前台时不可靠——实测 document.hasFocus() 恒 true）。
  // 只停渲染循环：同页的麦克风桥接 AudioWorklet 不受影响（语音输入时焦点本来
  // 就在别的窗口上）。
  let visible = true, raf = 0, t0 = performance.now();
  const io = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible && !raf && !document.hidden && !renderPaused) tick(); // 滚回视野：重启渲染循环
  }, { threshold: .05 });
  io.observe(container);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  liveLoops.add(tick); // setRenderPaused 恢复时逐实例拉起（页面存续期内不清理，实例至多 2 个）

  function tick() {
    // 取消优先：重复拉起一律幂等收敛成一条链。曾经 raf=0 直接排新帧，
    // 未取消旧链——setRenderPaused 恢复 / visibilitychange 等入口每触发一次
    // 就多叠一条 RAF 链，每条都在渲染（实测 N 条链 = N 倍 GPU/渲染进程占用，
    // 是「没在用也占 CPU」的隐性放大器）
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!visible || document.hidden || renderPaused) return;
    const t = (performance.now() - t0) / 1000;
    // 悬浮微动 + 未拖拽时缓慢摇摆
    world.rotation.y = rotY + Math.sin(t * .3) * .045;
    world.rotation.x = rotX + Math.sin(t * .22) * .015;
    world.position.y = Math.sin(t * .8) * .09;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  function resize() {
    if (!W() || !H()) return;
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
    renderer.setSize(W(), H());
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  tick();
  el.style.cursor = 'grab';

  // ---------- 开场动画：底板浮起 + 键帽逐键升起（anime.js stagger） ----------
  let introBase = null; // 非 null = 待播（构造时已置为起始姿态）
  if (intro) {
    introBase = keyMeshes.map(k => {
      const m = k.mesh;
      m.userData.by = m.position.y;
      m.position.y -= 1.1;
      m.scale.setScalar(.25);
      return m;
    });
    plate.position.y = -2.2;
  }
  function playIntro() {
    if (introBase === null) return Promise.resolve();
    const list = introBase;
    introBase = null;
    const starts = stagger(16, { start: 300 });
    animate(list.map(m => m.position), {
      y: (p, i) => list[i].userData.by,
      delay: starts, duration: 850, ease: 'out(4)',
    });
    animate(list.map(m => m.scale), {
      x: 1, y: 1, z: 1,
      delay: starts, duration: 850, ease: 'out(4)',
    });
    animate(plate.position, { y: [-2.2, 0], duration: 900, ease: 'out(3)' });
    const total = 300 + list.length * 16 + 900;
    return new Promise(res => setTimeout(res, total));
  }

  // ---------- 调试/验证钩子：键位投影坐标、配置状态、旋转角（自动化测试用） ----------
  function projectKey(id) {
    const rec = byId.get(id);
    if (!rec) return null;
    const v = rec.mesh.position.clone();
    v.y += .45;
    v.project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { cx: (v.x + 1) / 2 * r.width, cy: (1 - v.y) / 2 * r.height };
  }
  const getRotation = () => ({ x: world.rotation.x, y: world.rotation.y });

  return {
    setConfigured,
    setHeat,
    playIntro,
    projectKey,
    getConfigured: () => [...configuredIds],
    getRotation,
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect();
      renderer.dispose();
      container.removeChild(el);
    },
  };
}
