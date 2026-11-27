#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EyePilot · 瞳行 — 局域网 HTTPS 服务器（手机当摄像头）

【为什么需要它】
浏览器只在「安全上下文」下授予摄像头权限：HTTPS 或 localhost。
手机用 http://192.168.x.x 访问属于不安全上下文，getUserMedia 会被直接拒绝，
所以必须走 HTTPS。本脚本用自签证书提供与 serve.py 完全相同的静态资源。

【首次在手机上打开】
会提示「证书不受信任 / 您的连接不是私密连接」——点「高级」→「继续前往」即可。
传输仍然是加密的，只是浏览器不认识这张自签证书。

用法：
    python serve-https.py                 # 默认 8443 端口
    python serve-https.py --port 9443
    python serve-https.py --no-open

证书放在 ./certs/，若不存在会提示生成命令。
"""

import argparse
import http.server
import os
import socket
import ssl
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from serve import Handler  # 复用 MIME / 缓存头设置

CERT_DIR = os.path.join(ROOT, "certs")
CERT_PEM = os.path.join(CERT_DIR, "cert.pem")
KEY_PEM = os.path.join(CERT_DIR, "key.pem")


def local_ips():
    """尽力枚举本机可用于局域网访问的 IPv4 地址。"""
    ips = set()

    # 主机名解析到的地址
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass

    # 「默认出口」地址（UDP connect 只选路，不会真发包）
    for probe in ("192.168.255.255", "10.255.255.255", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((probe, 1))
                ips.add(s.getsockname()[0])
            break
        except Exception:
            continue

    return sorted(i for i in ips if not i.startswith("127.") and not i.startswith("169.254."))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    if not (os.path.exists(CERT_PEM) and os.path.exists(KEY_PEM)):
        print()
        print("  缺少证书。先在项目根目录执行：")
        print()
        print("  mkdir -p certs && cd certs && \\")
        print('  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \\')
        print('    -days 3650 -subj "/CN=eyepilot.local" \\')
        print('    -addext "subjectAltName=IP:127.0.0.1,IP:<你的局域网IP>,DNS:localhost"')
        print()
        return 1

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_PEM, KEY_PEM)

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    httpd.daemon_threads = True
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    ips = local_ips()

    print()
    print("  EyePilot · 瞳行  —  局域网模式（手机可访问）")
    print("  ------------------------------------------------------")
    print(f"  本机访问：   https://127.0.0.1:{args.port}/")
    if ips:
        for ip in ips:
            print(f"  手机访问：   https://{ip}:{args.port}/")
    else:
        print("  未探测到局域网地址，请用 ipconfig 查看后手动拼接")
    print()
    print("  手机操作：")
    print("    1. 手机连到与电脑相同的 WiFi")
    print("    2. 浏览器打开上面的「手机访问」地址")
    print("    3. 证书警告 → 高级 → 继续前往")
    print("    4. 点击「启动相机」→ 允许摄像头 → 九点校准")
    print()
    print("  注意：手机视场角通常比笔记本更广，校准后如感觉过灵敏，")
    print("        在设置里调低灵敏度或改用头部模式。")
    print()
    print("  按 Ctrl+C 停止服务")
    print()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
