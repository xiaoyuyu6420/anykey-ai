// 开发调试工具：对运行中的应用（--remote-debugging-port=9222）执行页面表达式
// 用法：node tools/cdp-eval.js "表达式"（支持 await/Promise，返回 JSON）
(async () => {
  const expr = process.argv[2];
  if (!expr) { console.error('用法: node tools/cdp-eval.js "表达式"'); process.exit(1); }
  // CDP_PORT：同一台机器跑多个实例时指到目标实例的调试端口（默认 9222）
  const port = Number(process.env.CDP_PORT) || 9222;
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
  // CDP_EVAL_W/H：按指定视口宽度求值（量布局时用，避免拿真实窗口尺寸算错）
  const ew = Number(process.env.CDP_EVAL_W) || 0;
  const eh = Number(process.env.CDP_EVAL_H) || 0;
  if (ew || eh) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: ew || 1280, height: eh || 900, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise(r => setTimeout(r, 150));
  }
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (ew || eh) await send('Emulation.clearDeviceMetricsOverride');
  if (r.result && r.result.exceptionDetails) {
    console.error('页面异常:', JSON.stringify(r.result.exceptionDetails.exception, null, 1));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result && r.result.result && r.result.result.value, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
