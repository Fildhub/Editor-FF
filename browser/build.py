"""Build the single-file PDF-Tools.html (and site/index.html + site/_headers) from browser/app.src.html and browser/tools/.

    python browser/build.py

Everything is embedded - pdf.js, pdf-lib, fontkit, CJK character maps, the Thai
font and the icon (see browser/vendor/README.txt) - so the page works offline,
straight from disk, and loads no third-party script.
"""

import base64
import io
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "browser" / "vendor"
TOOL_FILES = ["core.js", "pages.js", "convert.js", "stamp.js", "editor.js", "compare.js"]

# Content Security Policy: no remote scripts, no frames, no plugins; the only
# network call is Google Translate. ('unsafe-inline' is needed because the app
# is one file with inline script/style.)
CSP_BASE = (
    "default-src 'none'; "
    "script-src 'unsafe-inline'; "
    "style-src 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob:; "
    "media-src blob:; "
    "connect-src https://translate.googleapis.com; "
    "worker-src blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'"
)
HEADERS = f"""/*
  Content-Security-Policy: {CSP_BASE}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
"""


def tools_bundle() -> tuple[str, str]:
    """CSS and JS of all tools (browser/tools)."""
    d = ROOT / "browser" / "tools"
    css = "\n".join(f.read_text("utf-8") for f in sorted(d.glob("*.css")))
    js = "\n".join((d / n).read_text("utf-8") for n in TOOL_FILES)
    js = '(() => {\n"use strict";\n' + js + "\nboot();\n})();"
    return css, js


def _inline_js(name: str) -> str:
    text = (VENDOR / name).read_text("utf-8")
    return text.replace("</script", "<\\/script")


def render() -> str:
    src = (ROOT / "browser" / "app.src.html").read_text("utf-8")
    buf = io.BytesIO()
    Image.open(ROOT / "pdf_translator" / "static" / "icon.png").resize((96, 96), Image.LANCZOS).save(buf, "PNG", optimize=True)
    icon = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    fonts = ROOT / "browser" / "fonts"
    thai = {k: base64.b64encode((fonts / f"Sarabun-{k.title()}.ttf").read_bytes()).decode() for k in ("regular", "bold")}
    css, js = tools_bundle()
    assert "</script" not in js, "tools must not contain a closing script tag"
    repl = {
        "__CMAPDATA__": (VENDOR / "pdfjs-cmaps.json").read_text("utf-8"),
        "__ICON__": icon,
        "__THAIFONT__": json.dumps(thai),
        "__FONTKIT__": _inline_js("fontkit.umd.min.js"),
        "__PDFJS__": _inline_js("pdf.min.js"),
        "__PDFJS_WORKER__": _inline_js("pdf.worker.min.js"),
        "__PDFLIB__": _inline_js("pdf-lib.min.js"),
        "__TOOLSCSS__": css,
        "__TOOLSJS__": js,
    }
    # one pass, so text inside an inserted library can never be mistaken for a placeholder
    import re
    src = re.sub("|".join(map(re.escape, repl)), lambda m: repl[m.group(0)], src)
    head = ('<!doctype html>\n<html lang="th">\n<head>\n<meta charset="utf-8">\n'
            f'<meta http-equiv="Content-Security-Policy" content="{CSP_BASE}">\n'
            '<meta name="referrer" content="no-referrer">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<link rel="icon" href="{icon}">\n</head>\n<body>\n')
    return head + src + "\n</body>\n</html>\n"


def main() -> None:
    html = render()
    out = ROOT / "PDF-Tools.html"
    out.write_text(html, encoding="utf-8")
    print("written", out, out.stat().st_size, "bytes")
    # ready-to-upload folder for static hosting (Cloudflare Pages, GitHub Pages ...)
    site = ROOT / "site"
    site.mkdir(exist_ok=True)
    (site / "index.html").write_text(html, encoding="utf-8")
    (site / "_headers").write_text(HEADERS, encoding="utf-8")
    print("written", site / "index.html", "and", site / "_headers")


if __name__ == "__main__":
    main()
