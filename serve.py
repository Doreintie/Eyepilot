#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EyePilot · 瞳行 — 本地静态服务器
- 修正 .mjs / .wasm / .task 的 MIME，保证 MediaPipe 正常加载
- 零依赖，只用 Python 标准库
- 默认只监听 127.0.0.1（摄像头权限需要 localhost 安全上下文）

用法：
    python serve.py            # 自动打开浏览器
    python serve.py --no-open  # 不自动打开
    python serve.py --port 9000
"""

import argparse
import http.server
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".md": "text/markdown; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args if args else fmt
        # 模型与 wasm 的请求比较吵，只记录非静态资源
        if any(k in msg for k in (".wasm", ".task", ".mjs", "favicon")):
            return
        sys.stdout.write(f"  {msg}\n")
        sys.stdout.flush()


def free_port(start=8848, tries=30):
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True

    print()
    print("  EyePilot · 瞳行  —  AI 眼控与用眼健康助手")
    print("  ------------------------------------------------")
    print(f"  服务已启动：{url}")
    print("  首次使用：点击「启动相机」→ 允许摄像头 → 完成九点校准")
    print("  没有摄像头？点击右上角「演示」用鼠标模拟视线")
    print("  按 Ctrl+C 停止服务")
    print()

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
