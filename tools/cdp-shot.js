// 开发调试工具：对运行中的应用（--remote-debugging-port=9222）整页截图
// 用法：node tools/cdp-shot.js [输出文件] [宽度px]
// 宽度只影响截图视口（会用 Emulation 覆盖，不改真实窗口）
const fs = require('fs');

(async () => {
  const out = process.argv[2] || 'shot.png';
  const width = Number(process.argv[3]) || 0;
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find(p => p.type === 'page');
  if (!page) { console.error('未找到应用页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });

  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const height = Number(process.env.SHOT_H) || 0;
  // SHOT_VIEWPORT=1：按真实窗口视口截图（不设任何 Emulation 覆盖，最安全）
  const viewportOnly = process.env.SHOT_VIEWPORT === '1';
  if (!viewportOnly && (width || height)) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: width || 1280, height: height || 1200, deviceScaleFactor: 1, mobile: false,
    });
  }
  // SHOT_RELOAD=1：先重载页面（改完渲染层代码后必须重载才生效）
  if (process.env.SHOT_RELOAD === '1') {
    await send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, Number(process.env.SHOT_WAIT) || 2500));
  }
  // 展开所有 <details>，截图才看得到折叠内容
  if (process.env.SHOT_OPEN === '1') {
    await send('Runtime.evaluate', { expression: "document.querySelectorAll('details').forEach(d => d.open = true)" });
  }
  // SHOT_SCROLL=<px>：先滚动到指定位置（视口截图，文字才够大）
  const scroll = Number(process.env.SHOT_SCROLL) || 0;
  if (!viewportOnly) await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scroll})` });
  const r = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: !viewportOnly && !height && !scroll,
  });
  // 视口覆盖是持久的（不清掉，真实窗口会一直按截图用的尺寸渲染 —— 表现是页面下部留白）
  await send('Emulation.clearDeviceMetricsOverride');
  if (!r.result || !r.result.data) { console.error('截图失败', JSON.stringify(r).slice(0, 300)); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('已保存', out);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
