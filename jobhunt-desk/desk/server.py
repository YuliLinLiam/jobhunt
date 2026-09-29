"""把 api.handle 包成一个 http.server，顺便伺候静态文件。

只绑 127.0.0.1，外面访问不到。
"""

import json
import os
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import api, db

WEB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web"
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}

MAX_BODY = 8 * 1024 * 1024  # 8MB，CSV 再大也够了


class Handler(BaseHTTPRequestHandler):
    server_version = "JobHuntDesk"
    protocol_version = "HTTP/1.1"
    conn = None  # 由 serve() 注入

    # 默认的日志太吵，只在出错时打
    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("[desk] %s\n" % (fmt % args))

    # ---------------------------------------------------------- 基础设施

    def _send(self, code, ctype, body, extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 扩展是从任意网页的上下文发过来的，得允许跨源
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PATCH, DELETE, OPTIONS")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return ""
        if length <= 0:
            return ""
        if length > MAX_BODY:
            return ""
        raw = self.rfile.read(length)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("utf-8", "replace")

    # ---------------------------------------------------------- 路由

    def do_OPTIONS(self):
        self._send(204, "text/plain", b"")

    def do_GET(self):
        path, query = api.parse_target(self.path)
        if path.startswith("/api/"):
            code, ctype, body = api.handle(self.conn, "GET", path, query, "")
            headers = None
            if path == "/api/export.csv":
                headers = {
                    "Content-Disposition":
                        'attachment; filename="jobhunt-export.csv"'
                }
            return self._send(code, ctype, body, headers)
        return self._serve_static(path)

    def do_HEAD(self):
        self.do_GET()

    def _with_body(self, method):
        path, query = api.parse_target(self.path)
        if not path.startswith("/api/"):
            return self._send(404, "text/plain; charset=utf-8", "只有 /api/ 接受写入")
        body = self._read_body()
        code, ctype, out = api.handle(self.conn, method, path, query, body)
        self._send(code, ctype, out)

    def do_POST(self):
        self._with_body("POST")

    def do_PATCH(self):
        self._with_body("PATCH")

    def do_DELETE(self):
        self._with_body("DELETE")

    # ---------------------------------------------------------- 静态文件

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        # 防目录穿越：只允许 web/ 下面的文件
        rel = os.path.normpath(path.lstrip("/")).replace("\\", "/")
        if rel.startswith("..") or os.path.isabs(rel):
            return self._send(403, "text/plain; charset=utf-8", "不允许")
        full = os.path.join(WEB_DIR, rel)
        if not os.path.isfile(full):
            return self._send(404, "text/plain; charset=utf-8", "没有这个文件")
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            data = fh.read()
        self._send(200, MIME.get(ext, "application/octet-stream"), data,
                   {"Cache-Control": "no-store"})


def pick_port(preferred=8765, tries=20):
    """首选端口被占就顺延，别让用户自己去查谁占了 8765。"""
    for offset in range(tries):
        port = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("从 %d 开始连续 %d 个端口都被占用了" % (preferred, tries))


def make_server(conn, port):
    handler = type("BoundHandler", (Handler,), {"conn": conn})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    return httpd


def serve(db_path=None, port=8765, open_browser=True):
    conn = db.init(db.connect(db_path))
    port = pick_port(port)
    httpd = make_server(conn, port)
    url = "http://127.0.0.1:%d/" % port

    print("求职工作台已启动：%s" % url)
    print("数据库：%s" % (db_path or db.default_db_path()))
    print("按 Ctrl+C 停止。")

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
        conn.close()
