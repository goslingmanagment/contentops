#!/usr/bin/env python3
"""Локальный сервер для слепого просмотра: статика + приём результатов по PUT r/<session>.json.
    python3 blind_serve.py <каталог с index.html, manifest.json, c/> [порт]
Для сайта на nginx эквивалент — dav_methods PUT в location r/ (см. compression.md §10.6)."""
import http.server, os, re, sys

ROOT = os.path.abspath(sys.argv[1]); PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
os.makedirs(os.path.join(ROOT, "r"), exist_ok=True)

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=ROOT, **kw)
    def do_PUT(self):
        m = re.fullmatch(r"/r/(s[a-z0-9]{6,32})\.json", self.path)
        if not m: self.send_error(404); return
        n = int(self.headers.get("Content-Length", 0))
        if n > 2_000_000: self.send_error(413); return
        with open(os.path.join(ROOT, "r", m.group(1) + ".json"), "wb") as f: f.write(self.rfile.read(n))
        self.send_response(204); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/r/"): self.send_error(403); return
        super().do_GET()
    def log_message(self, fmt, *a):
        if "/c/" not in (a[0] if a else ""): super().log_message(fmt, *a)

print(f"http://localhost:{PORT}/  ({ROOT})")
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
