/* 用 Edge 无头 + CDP 验证单文件 HTML 在 file:// 下能加载 wasm 与模型。
   纯 Node 内置模块，无需 puppeteer。 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HTML = 'C:/Users/syc/WorkBuddy/2026-11-27-12-14-21/EyePilot-Standalone.html';
const PORT = 9333;
const USERDIR = 'C:/Users/syc/AppData/Local/Temp/eyepilot-cdp-verify';

const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDIR}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws = null;
try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON(`http://127.0.0.1:${PORT}/json`); break; } catch { await sleep(250); }
  }
  if (!targets) throw new Error('CDP not reachable');
  const page = targets.find(t => t.type === 'page');

  // 用原生 WebSocket 连 CDP
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 收集运行时异常与控制台报错
  const runtimeErrors = [];
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(m.params.exceptionDetails?.text || 'exception');
      const d = m.params.exceptionDetails?.exception?.description;
      if (d) runtimeErrors.push(d.slice(0, 300));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 300));
    }
  };

  const fileUrl = 'file:///' + HTML.replace(/\\/g, '/');
  await send('Page.navigate', { url: fileUrl });
  await sleep(9000); // 给 wasm + 模型加载留时间

  // 主动触发一次模型加载：真实校验 wasm 二进制是否被正确还原
  const loadExpr = `(async function(){
    try {
      if (!window.__EYEPILOT_STANDALONE__) return {standalone:false};
      // 直接走应用暴露的 VisionEngine（若打包进 IIFE 则不可见），改为检查全局错误标记
      return {
        standalone: true,
        title: document.title,
        hasCanvas: !!document.querySelector('canvas'),
        bodyLen: document.body ? document.body.innerText.length : 0,
        wasmErrSeen: /blob:http/.test(document.body ? document.body.innerText : '')
      };
    } catch(e) { return {error: String(e)}; }
  })()`;
  const r = await send('Runtime.evaluate', { expression: loadExpr, returnByValue: true, awaitPromise: true });
  console.log('RESULT', JSON.stringify(r.result?.result?.value, null, 2));
  if (r.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails).slice(0, 500));

  console.log('RUNTIME_ERRORS', JSON.stringify(runtimeErrors.slice(0, 10), null, 2));
  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors.slice(0, 10), null, 2));

  // 端到端：点击「启动相机」(使用假摄像头)，看模型能否加载成功。
  const prevRt = runtimeErrors.length, prevCe = consoleErrors.length;
  await send('Runtime.evaluate', { expression: `(function(){var b=document.getElementById('btnStart'); if(b) b.click(); return !!b;})()`, returnByValue: true });
  await sleep(10000);
  const statusExpr = `(function(){
    var out = {};
    var body = document.body ? document.body.innerText : '';
    out.calibrationVisible = /校准|九点|注视/.test(body);
    out.blobError = /blob:http.*wasm|Failed to compile|WebAssembly|模型加载失败/.test(body);
    out.statusTexts = body.split('\\n').filter(function(l){return /模型|相机|加载|校准|就绪|失败/.test(l);}).slice(0,12);
    return out;
  })()`;
  const sr = await send('Runtime.evaluate', { expression: statusExpr, returnByValue: true });
  console.log('AFTER_START', JSON.stringify(sr.result?.result?.value, null, 2));
  console.log('NEW_RUNTIME_ERRORS', JSON.stringify(runtimeErrors.slice(prevRt), null, 2));
  console.log('NEW_CONSOLE_ERRORS', JSON.stringify(consoleErrors.slice(prevCe), null, 2));
} catch (e) {
  console.error('VERIFY FAILED:', e.message);
} finally {
  if (ws) ws.close();
  edge.kill('SIGTERM');
}
