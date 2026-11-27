/* ============================================================
   tools/build-single.mjs — 把整个 EyePilot 打成一个可微信发送的 HTML
   用法：node tools/build-single.mjs
   产出：../EyePilot-Standalone.html（自包含，file:// 直接打开）
   ============================================================ */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(ROOT, '..', 'EyePilot-Standalone.html');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const b64 = (rel) => read(rel).toString('base64');

console.log('[1/4] 打包 JS 模块…');
const bundled = await build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'edge100', 'firefox110', 'safari16'],
  minify: true,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const js = bundled.outputFiles[0].text;

console.log('[2/4] 内嵌 CSS 与背景图…');
const bgData = `data:image/png;base64,${b64('assets/bg-iceland.png')}`;
const css = ['styles/main.css', 'styles/glass.css', 'styles/focus-v141.css']
  .map((f) => read(f).toString('utf8'))
  .join('\n')
  .replace(/url\(["']?\.\/bg-iceland\.png["']?\)/g, `url("${bgData}")`);

console.log('[3/4] 生成运行时资源桥接…');
// 只内嵌 SIMD 版 wasm（现代浏览器都支持）；nosimd 请求重定向到 SIMD 版
const assets = {
  wasmJs: b64('vendor/mediapipe/wasm/vision_wasm_internal.js'),
  wasmBin: b64('vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
  task: b64('vendor/mediapipe/face_landmarker.task'),
};

const bootstrap = `<script>
(function(){
  var B64 = ${JSON.stringify(assets)};
  var rawCache = {}, urlCache = {};
  // 解码为真正的二进制。wasm/task 必须用原始字节，绝不能传 blob URL 字符串，
  // 否则 WebAssembly.instantiateStreaming 拿到的是 "blob:http://..." 文本而报编译失败。
  function raw(key){
    if (rawCache[key]) return rawCache[key];
    var bin = atob(B64[key]), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    rawCache[key] = u8;
    return u8;
  }
  // 只有 <script src> 重定向才需要 blob URL。
  function assetUrl(key, type){
    if (urlCache[key]) return urlCache[key];
    urlCache[key] = URL.createObjectURL(new Blob([raw(key)], {type: type}));
    return urlCache[key];
  }

  // MediaPipe 通过 <script src=".../vision_wasm_internal.js"> 注入 loader，
  // 把它重定向到内嵌的 blob URL。
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  Object.defineProperty(HTMLScriptElement.prototype, 'src', {
    configurable: true, enumerable: srcDesc.enumerable,
    get: function(){ return srcDesc.get.call(this); },
    set: function(v){
      var s = String(v);
      if (/vision_wasm_(no)?simd_internal\\.js$|vision_wasm_internal\\.js$/.test(s)) {
        v = assetUrl('wasmJs', 'text/javascript');
      }
      srcDesc.set.call(this, v);
    }
  });

  // wasm 二进制 / task 模型 / 本机服务端 API 全部走内存响应，
  // 其余请求（例如 AI 教练的在线模型）保持原样透传。
  var origFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/vision_wasm_internal\\.wasm($|\\?)|vision_wasm_nosimd_internal\\.wasm/.test(url)) {
      return Promise.resolve(new Response(raw('wasmBin'), {
        status: 200, headers: {'Content-Type': 'application/wasm'}
      }));
    }
    if (/face_landmarker\\.task($|\\?)/.test(url)) {
      return Promise.resolve(new Response(raw('task'), {status: 200}));
    }
    if (url.indexOf('/api/link/state') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({
        phone: '', width: 0, height: 0, lastAt: 0,
        lanUrl: '', token: '', lan: false, https: false,
      }), {status: 200, headers: {'Content-Type': 'application/json'}}));
    }
    if (url.indexOf('/api/island/metrics') >= 0) {
      return Promise.resolve(new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}}));
    }
    return origFetch(input, init);
  };

  // 手机中继依赖服务端 SSE，单文件版给一个静默存根，避免控制台报错。
  var NativeES = window.EventSource;
  window.EventSource = function(url, cfg){
    if (String(url).indexOf('/api/link/stream') >= 0) {
      return {
        readyState: 0, onopen: null, onmessage: null, onerror: null,
        addEventListener: function(){}, removeEventListener: function(){},
        close: function(){ this.readyState = 2; },
      };
    }
    return new NativeES(url, cfg);
  };

  window.__EYEPILOT_STANDALONE__ = true;
})();
</script>`;

console.log('[4/4] 组装单文件 HTML…');
let html = read('index.html').toString('utf8');
html = html.replace(/<link rel="stylesheet"[^>]*\/>/g, '');
// 必须用函数形式的 replacement：压缩后的 JS 里含 "$&"，
// 直接传字符串会被 String.replace 当成“插入匹配原文”，把旧 script 标签重新塞回去。
html = html.replace('</head>', () => `<style>${css}</style></head>`);
html = html.replace(
  '<script type="module" src="./src/main.js"></script>',
  () => `${bootstrap}\n<script>${js}</script>`,
);

if (html.includes('src="./src/main.js"') || html.includes('styles/main.css')) {
  throw new Error('资源替换不完整，拒绝产出半成品');
}

fs.writeFileSync(OUT, html, 'utf8');
const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`完成：${OUT}（${size} MB）`);
