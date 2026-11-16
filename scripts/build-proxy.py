#!/usr/bin/env python3
"""Build proxy/worker.js = proxy/worker.src.js + the installer page (e2e-live.html).

Run after editing e2e-live.html or proxy/worker.src.js:   python3 scripts/build-proxy.py
The UI is served by the proxy itself, so it talks to the proxy on the same origin.
"""
import base64, json, re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
html = (root / "e2e-live.html").read_text(encoding="utf8")

qr = (root / "assets/qrcode.min.js").read_text(encoding="utf8").replace("</script", "<\\/script")
logo = "data:image/svg+xml;base64," + base64.b64encode((root / "assets/logo-mark.svg").read_bytes()).decode()

html = html.replace('<script src="assets/qrcode.min.js"></script>', "<script>" + qr + "</script>")
html = html.replace('src="assets/logo-mark.svg"', f'src="{logo}"')
html = html.replace('href="assets/logo-mark.svg"', f'href="{logo}"')
html = re.sub(r'<link rel="preload"[^>]*vazirmatn[^>]*/>\s*', "", html)
html = re.sub(r"@font-face\{[^}]*vazirmatn[^}]*\}\s*", "", html)
html = re.sub(r'<meta name="nova-proxy"[^>]*/>\s*', "", html)
html = re.sub(r'var PROXY_URL = "[^"]*";', 'var PROXY_URL = "";  /* same origin */', html)
assert 'assets/' not in html, "unresolved asset reference"

src = (root / "proxy/worker.src.js").read_text(encoding="utf8")
out = src.replace("__UI_HTML__", json.dumps(html, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
(root / "proxy/worker.js").write_text(out, encoding="utf8")
print(f"proxy/worker.js: {len(out):,} bytes")
