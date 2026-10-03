"""Build the single-file PDF-Tools.html from browser/app.src.html and browser/tools/.

    python browser/build.py PATH/TO/pdfjs-dist-3.11.174/cmaps

CJK character maps (from the pdfjs-dist npm package), the Thai font
(browser/fonts, Sarabun, SIL Open Font License), fontkit (browser/vendor) and the icon are embedded so the page works when opened straight from disk.
"""

import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CDN = {
    "__PDFJS__": "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "__PDFJS_WORKER__": "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    "__PDFLIB__": "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
}


TOOL_FILES = ["core.js", "pages.js", "convert.js", "stamp.js", "editor.js", "compare.js"]


def tools_bundle() -> tuple[str, str]:
    """CSS and JS of all tools (browser/tools); files that do not exist yet are skipped."""
    d = ROOT / "browser" / "tools"
    css = "\n".join(f.read_text("utf-8") for f in sorted(d.glob("*.css")))
    js = "\n".join((d / n).read_text("utf-8") for n in TOOL_FILES if (d / n).exists())
    js = '(() => {\n"use strict";\n' + js + "\nboot();\n})();"
    assert "</script" not in js, "tools must not contain a closing script tag"
    return css, js


def main() -> None:
    cmaps = Path(sys.argv[1])
    src = (ROOT / "browser" / "app.src.html").read_text("utf-8")
    buf = io.BytesIO()
    Image.open(ROOT / "pdf_translator" / "static" / "icon.png").resize((96, 96), Image.LANCZOS).save(buf, "PNG", optimize=True)
    icon = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    maps = {f.stem: base64.b64encode(f.read_bytes()).decode() for f in sorted(cmaps.glob("*.bcmap"))}
    fonts = ROOT / "browser" / "fonts"
    thai = {k: base64.b64encode((fonts / f"Sarabun-{k.title()}.ttf").read_bytes()).decode() for k in ("regular", "bold")}
    fontkit = (ROOT / "browser" / "vendor" / "fontkit.umd.min.js").read_text("utf-8").replace("</script", "<\\/script")
    src = src.replace("__CMAPDATA__", json.dumps(maps)).replace("__ICON__", icon).replace("__THAIFONT__", json.dumps(thai))
    src = src.replace("__FONTKIT__", fontkit)
    css, js = tools_bundle()
    src = src.replace("__TOOLSCSS__", css).replace("__TOOLSJS__", js)
    for k, v in CDN.items():
        src = src.replace(k, v)
    head = ('<!doctype html>\n<html lang="th">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<link rel="icon" href="{icon}">\n</head>\n<body>\n')
    out = ROOT / "PDF-Tools.html"
    out.write_text(head + src + "\n</body>\n</html>\n", encoding="utf-8")
    print("written", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
