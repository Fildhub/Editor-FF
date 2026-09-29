"""Local web interface:  pdf-translate-web  (then open http://127.0.0.1:8765)

Pure standard library HTTP server - no extra dependencies. The browser
uploads the PDF as the raw request body; translation runs in a background
thread and the page polls for progress.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pymupdf

from .pipeline import Options, translate_pdf

STATIC = Path(__file__).parent / "static"
WORK = Path(tempfile.gettempdir()) / "pdf-translator-web"
MAX_UPLOAD = 200 * 1024 * 1024

# progress steps, matched against the pipeline's log lines
STEPS = [
    ("analyse", "Analysing"),
    ("translate", "Translating"),
    ("typeset", "Typesetting"),
    ("done", ""),
]


class Job:
    def __init__(self, name: str, src: Path, opts: Options):
        self.id = uuid.uuid4().hex[:12]
        self.name = name
        self.src = src
        self.out = src.with_name("translated.pdf")
        self.opts = opts
        self.step = "queued"
        self.logs: list[str] = []
        self.error: str | None = None
        self.report: dict | None = None
        self.pages = 0
        self.started = time.time()
        self.lock = threading.Lock()

    def log(self, msg: str) -> None:
        msg = str(msg)
        with self.lock:
            self.logs.append(msg.strip())
            for key, prefix in STEPS:
                if prefix and msg.startswith(prefix):
                    self.step = key

    def run(self) -> None:
        try:
            self.log("Analysing...")
            report = translate_pdf(str(self.src), str(self.out), self.opts, log=self.log)
            self.pages = pymupdf.open(self.out).page_count
            self.report = {
                "pages": report.pages,
                "segments": report.segments,
                "translated": report.translated,
                "kept": report.kept,
                "shrunk": report.shrunk,
                "issues": [i.__dict__ for i in report.issues],
                "seconds": round(report.seconds, 1),
            }
            self.step = "done"
        except Exception as exc:  # shown in the UI
            self.error = str(exc) or exc.__class__.__name__
            self.logs.append(traceback.format_exc(limit=3))
            self.step = "error"

    def state(self) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "name": self.name,
                "step": self.step,
                "logs": self.logs[-60:],
                "error": self.error,
                "report": self.report,
                "pages": self.pages,
                "elapsed": round(time.time() - self.started, 1),
            }


JOBS: dict[str, Job] = {}


def _render(path: Path, page: int, dpi: int = 110) -> bytes:
    doc = pymupdf.open(path)
    page = max(0, min(page, doc.page_count - 1))
    return doc[page].get_pixmap(dpi=dpi, alpha=False).tobytes("png")


class Handler(BaseHTTPRequestHandler):
    server_version = "pdf-translator"

    def log_message(self, fmt, *args):  # quiet
        pass

    # ---------------------------------------------------------- helpers
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _job(self, jid: str) -> Job | None:
        job = JOBS.get(jid)
        if job is None:
            self._json({"error": "unknown job"}, 404)
        return job

    # ---------------------------------------------------------- routes
    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        q = parse_qs(url.query)
        if not parts:
            return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
        if parts == ["api", "status"]:
            return self._json({"app": "pdf-translator", "claude_key": bool(os.environ.get("ANTHROPIC_API_KEY"))})
        if parts == ["icon.png"]:
            return self._send(200, (STATIC / "icon.png").read_bytes(), "image/png", {"Cache-Control": "max-age=86400"})
        if len(parts) >= 3 and parts[:2] == ["api", "jobs"]:
            job = self._job(parts[2])
            if job is None:
                return
            if len(parts) == 3:
                return self._json(job.state())
            if parts[3] == "download" and job.step == "done":
                stem = re.sub(r"[^\w.-]+", "_", Path(job.name).stem) or "document"
                fname = f"{stem}.{job.opts.target_lang}.pdf"
                return self._send(
                    200,
                    job.out.read_bytes(),
                    "application/pdf",
                    {"Content-Disposition": f'attachment; filename="{fname}"'},
                )
            if parts[3] == "page" and len(parts) == 5:
                which = q.get("v", ["out"])[0]
                path = job.out if which == "out" and job.step == "done" else job.src
                try:
                    return self._send(200, _render(path, int(parts[4])), "image/png")
                except Exception as exc:
                    return self._json({"error": str(exc)}, 400)
        self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if url.path != "/api/translate":
            return self._json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            return self._json({"error": "file missing or larger than 200 MB"}, 400)
        data = self.rfile.read(length)
        if not data.startswith(b"%PDF"):
            return self._json({"error": "this is not a PDF file"}, 400)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if q.get("api_key"):
            os.environ["ANTHROPIC_API_KEY"] = q["api_key"]
        opts = Options(
            source_lang=q.get("source", "zh"),
            target_lang=q.get("target", "en"),
            engine=q.get("engine", "google"),
            pages=q.get("pages") or None,
            bilingual=q.get("bilingual") == "1",
            ocr=q.get("ocr", "auto"),
            notes=q.get("notes", ""),
        )
        folder = WORK / uuid.uuid4().hex[:12]
        folder.mkdir(parents=True, exist_ok=True)
        src = folder / "source.pdf"
        src.write_bytes(data)
        job = Job(q.get("name", "document.pdf"), src, opts)
        try:
            job.pages = pymupdf.open(src).page_count
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            return self._json({"error": "the PDF could not be opened"}, 400)
        JOBS[job.id] = job
        threading.Thread(target=job.run, daemon=True).start()
        self._json({"id": job.id, "pages": job.pages})


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pdf-translate-web", description="Web interface for pdf-translate")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = p.parse_args(argv)
    WORK.mkdir(parents=True, exist_ok=True)
    url = f"http://{args.host}:{args.port}"
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError:
        # Already running (e.g. the desktop icon was clicked twice)? Then
        # just bring up the browser.
        if _already_running(url):
            if not args.no_browser:
                webbrowser.open(url)
            return 0
        raise SystemExit(f"Port {args.port} is in use. Try:  pdf-translate-web --port 8766")
    if sys.stdout:  # None under pythonw (desktop icon)
        print(f"PDF Translator is running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
    return 0


def _already_running(url: str) -> bool:
    from urllib.request import urlopen

    try:
        with urlopen(url + "/api/status", timeout=2) as r:
            return json.loads(r.read().decode()).get("app") == "pdf-translator"
    except Exception:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
