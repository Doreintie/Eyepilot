#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EyePilot · 瞳行 — 本地静态服务器 + 手机摄像头中继
------------------------------------------------
- 修正 .mjs / .wasm / .task 的 MIME，保证 MediaPipe 正常加载
- 零依赖，只用 Python 标准库
- 默认只监听 127.0.0.1（摄像头权限需要 localhost 安全上下文）

手机互联（--lan）：
  手机浏览器调用 getUserMedia 必须是「安全上下文」，http://192.168.x.x 不算，
  所以 --lan 会自动生成自签证书并用 HTTPS 提供服务，同时把访问地址和令牌打印出来。
  首次在手机上打开会提示证书不受信任，选择「继续访问」即可。

用法：
    python serve.py                 # 本机使用，自动打开浏览器
    python serve.py --lan           # 同时允许手机连接（HTTPS，打印地址与令牌）
    python serve.py --lan --token 123456
    python serve.py --no-open
    python serve.py --port 9000
"""

import argparse
import base64
import http.server
import json
import os
import queue
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, "certs")

# ---------------------------------------------------------------- 中继状态
LINK = {
    "phone": "",
    "width": 0,
    "height": 0,
    "packets": 0,
    "lastAt": 0.0,
    "bytes": 0,
}
LINK_LOCK = threading.Lock()
SUBSCRIBERS = set()
SUB_LOCK = threading.Lock()

TOKEN = ""
LAN_ENABLED = False
IS_HTTPS = False
LAN_URL = ""
LOOPBACK = ("127.0.0.1", "::1")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert():
    """用 openssl 生成自签证书（只在 --lan 时需要）。失败返回 None。"""
    crt = os.path.join(CERT_DIR, "lan-dev.crt")
    key = os.path.join(CERT_DIR, "lan-dev.key")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    os.makedirs(CERT_DIR, exist_ok=True)
    san = f"IP:{lan_ip()},IP:127.0.0.1,DNS:localhost"
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/CN=EyePilot LAN",
        "-addext", f"subjectAltName={san}",
    ]
    candidates = [
        "openssl",
        r"C://Program Files//Git//usr//bin//openssl.exe",
        r"C://Program Files//Git//mingw64//bin//openssl.exe",
        r"C://Program Files (x86)//Git//usr//bin//openssl.exe",
    ]
    last = None
    for bin_path in candidates:
        try:
            subprocess.run([bin_path] + cmd[1:], check=True, capture_output=True)
            return crt, key
        except (OSError, subprocess.CalledProcessError) as err:
            last = err
    sys.stdout.write(f"  [warn] 生成证书失败（{last}），改为 HTTP 模式；手机可能拒绝摄像头\n")
    return None


def broadcast(item):
    with SUB_LOCK:
        subs = list(SUBSCRIBERS)
    for q in subs:
        try:
            q.put_nowait(item)
        except queue.Full:
            try:
                q.get_nowait()
                q.put_nowait(item)
            except queue.Empty:
                pass


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
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

    # ------------------------------------------------ 基础设施
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args if args else fmt
        if any(k in msg for k in (".wasm", ".task", ".mjs", "favicon", "/api/link/")):
            return
        sys.stdout.write(f"  {msg}\n")
        sys.stdout.flush()

    def is_local(self):
        return self.client_address[0] in LOOPBACK

    def authorized(self):
        if not TOKEN or self.is_local():
            return True
        return self.headers.get("X-EyePilot-Token", "") == TOKEN

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/link/state":
            if not self.authorized():
                self.send_json(401, {"error": "token"})
                return
            with LINK_LOCK:
                st = dict(LINK)
            st.update({
                "lan": LAN_ENABLED,
                "https": IS_HTTPS,
                "lanUrl": LAN_URL if self.is_local() else "",
                "token": TOKEN if self.is_local() else "",
            })
            self.send_json(200, st)
            return
        if path == "/api/link/stream":
            if not self.authorized():
                self.send_json(401, {"error": "token"})
                return
            self.stream_events()
            return
        super().do_GET()

    def stream_events(self):
        q = queue.Queue(maxsize=4)
        with SUB_LOCK:
            SUBSCRIBERS.add(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b"retry: 1500\n: ready\n\n")
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                payload = json.dumps(item, separators=(",", ":"))
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with SUB_LOCK:
                SUBSCRIBERS.discard(q)

    # ------------------------------------------------ POST
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/link/"):
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.read_body()
            self.send_json(401, {"error": "token"})
            return

        if path == "/api/link/frame":
            body = self.read_body()
            if not body or len(body) < 32 or body[:4] != b"EPL1":
                self.send_json(400, {"error": "bad packet"})
                return
            now = time.time() * 1000
            with LINK_LOCK:
                LINK["packets"] += 1
                LINK["lastAt"] = now
                LINK["bytes"] = len(body)
            broadcast({"t": round(now, 1), "p": base64.b64encode(body).decode("ascii")})
            self.send_response(204)
            self.end_headers()
            return

        if path == "/api/link/hello":
            raw = self.read_body()
            try:
                info = json.loads(raw.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                info = {}
            with LINK_LOCK:
                LINK["phone"] = str(info.get("name") or "手机摄像头")[:48]
                LINK["width"] = int(info.get("width") or 0)
                LINK["height"] = int(info.get("height") or 0)
                LINK["lastAt"] = time.time() * 1000
            sys.stdout.write(f"  [手机] 已连接：{LINK['phone']} ({LINK['width']}×{LINK['height']})\n")
            sys.stdout.flush()
            self.send_json(200, {"ok": True})
            return

        if path == "/api/link/bye":
            self.read_body()
            with LINK_LOCK:
                name = LINK["phone"]
                LINK["phone"] = ""
            if name:
                sys.stdout.write(f"  [手机] 已断开：{name}\n")
                sys.stdout.flush()
            self.send_json(200, {"ok": True})
            return

        self.send_json(404, {"error": "not found"})

    def read_body(self, limit=128 * 1024):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return b""
        if n <= 0 or n > limit:
            return b""
        return self.rfile.read(n)


def free_port(host, start=8848, tries=30):
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    return start


def main():
    global TOKEN, LAN_ENABLED, IS_HTTPS, LAN_URL

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--lan", action="store_true", help="允许手机通过局域网连接（HTTPS）")
    ap.add_argument("--token", default="", help="固定连接令牌，默认随机六位")
    args = ap.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    port = free_port(host, args.port)
    scheme = "http"
    local_url = f"http://127.0.0.1:{port}/"

    LAN_ENABLED = args.lan
    TOKEN = (args.token or "").strip() or (f"{secrets.randbelow(900000) + 100000}" if args.lan else "")

    httpd = http.server.ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    if args.lan:
        cert = ensure_cert()
        if cert:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert[0], cert[1])
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            IS_HTTPS = True
            scheme = "https"
        ip = lan_ip()
        LAN_URL = f"{scheme}://{ip}:{port}/phone.html?t={TOKEN}"

    print()
    print("  EyePilot · 瞳行  —  AI 眼控与用眼健康助手")
    print("  ------------------------------------------------")
    print(f"  本机访问：{local_url.replace('http', scheme, 1) if IS_HTTPS and not args.lan else local_url}")
    print("  首次使用：点击「启动相机」→ 允许摄像头 → 完成九点校准")
    print("  没有摄像头？点击右上角「演示」用鼠标模拟视线")
    if args.lan:
        print()
        print("  手机互联已开启（手机和电脑要连同一个 Wi-Fi）")
        print(f"  在手机浏览器打开：{LAN_URL}")
        print(f"  令牌：{TOKEN}" + ("" if IS_HTTPS else "   [注意] 未生成证书，手机可能拒绝摄像头"))
        if IS_HTTPS:
            print("  首次打开会提示「连接不安全」，选择「继续访问 / 高级 → 继续」即可")
    else:
        print("  想用手机当第二个摄像头？加 --lan 启动，例如：python serve.py --lan")
    print("  按 Ctrl+C 停止服务")
    print()

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
