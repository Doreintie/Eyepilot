#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EyePilot 外接程序桥 — 一个最小可用的「眼控信号接收器」

用途：证明眼动信号可以被浏览器之外的程序消费。
运行：
    python tools/gaze-bridge.py
然后在 EyePilot 页面按 F12 打开控制台，粘贴：

    setInterval(() => {
      const g = window.EyePilot.state.gaze;
      fetch('http://127.0.0.1:8765/gaze', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ x: g.x, y: g.y, valid: g.valid })
      });
    }, 100);

再打开 http://127.0.0.1:8765/ ，就能看到一个跟着你视线移动的光点。
这就是「外接程序」的最小形态：任何本地进程都可以订阅这路信号。
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"x": 0, "y": 0, "valid": False, "ts": 0, "count": 0}
PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>EyePilot Bridge · 外接程序</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; background:radial-gradient(900px 600px at 50% 0%,#0d1a26,#05080d);
         color:#e8effb; font-family:system-ui,"Microsoft YaHei",sans-serif; overflow:hidden; }
  .hud { position:fixed; left:22px; top:20px; z-index:3; }
  .hud h1 { font-size:15px; margin:0 0 4px; letter-spacing:-.01em; }
  .hud p { margin:0; font-size:11.5px; color:#8b9bb6; line-height:1.7; }
  .hud b { color:#2ee6d6; font-family:ui-monospace,monospace; }
  .dot { position:fixed; width:26px; height:26px; margin:-13px 0 0 -13px; border-radius:50%;
         background:#2ee6d6; box-shadow:0 0 26px #2ee6d6, 0 0 70px rgba(46,230,214,.45);
         transition:opacity .2s; pointer-events:none; }
  .trail { position:fixed; width:6px; height:6px; margin:-3px 0 0 -3px; border-radius:50%;
           background:rgba(124,156,255,.35); pointer-events:none; }
  .grid { position:fixed; inset:0; background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
          linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px); background-size:48px 48px; }
</style></head>
<body>
<div class="grid"></div>
<div class="dot" id="dot"></div>
<div class="hud">
  <h1>EyePilot · 外接程序桥</h1>
  <p>这是浏览器之外的进程。它正在通过 HTTP 接收眼控信号。<br/>
  坐标 <b id="xy">-- , --</b> · 有效 <b id="v">--</b> · 已接收 <b id="n">0</b> 帧</p>
</div>
<script>
  const trail = [];
  for (let i = 0; i < 14; i++) {
    const d = document.createElement('div');
    d.className = 'trail';
    document.body.appendChild(d);
    trail.push(d);
  }
  async function tick() {
    try {
      const r = await fetch('/gaze', { cache: 'no-store' });
      const s = await r.json();
      const dot = document.getElementById('dot');
      if (s.valid) {
        dot.style.opacity = 1;
        dot.style.left = s.x + 'px';
        dot.style.top = s.y + 'px';
        for (let i = trail.length - 1; i > 0; i--) {
          trail[i].style.left = trail[i - 1].style.left;
          trail[i].style.top = trail[i - 1].style.top;
        }
        trail[0].style.left = s.x + 'px';
        trail[0].style.top = s.y + 'px';
      } else {
        dot.style.opacity = .15;
      }
      document.getElementById('xy').textContent = Math.round(s.x) + ' , ' + Math.round(s.y);
      document.getElementById('v').textContent = s.valid ? '是' : '否';
      document.getElementById('n').textContent = s.count;
    } catch (e) { /* ignore */ }
    setTimeout(tick, 60);
  }
  tick();
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.startswith("/gaze"):
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            data = json.loads(raw or "{}")
        except json.JSONDecodeError:
            self.send_error(400)
            return
        STATE.update({
            "x": float(data.get("x") or 0),
            "y": float(data.get("y") or 0),
            "valid": bool(data.get("valid")),
            "ts": time.time(),
            "count": STATE["count"] + 1,
        })
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/gaze"):
            self._json(STATE)
            return
        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print()
    print("  EyePilot 外接程序桥已启动")
    print(f"  接收端：http://127.0.0.1:{port}/gaze")
    print(f"  可视化：http://127.0.0.1:{port}/")
    print("  在 EyePilot 页面控制台粘贴 docs/插件开发指南.md 里的转发片段即可。")
    print()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("  已停止。")
