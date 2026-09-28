"""Free Google Translate web endpoint (no API key, lower quality).

Useful for a quick preview or when no Anthropic API key is available. The
endpoint is unofficial and may be rate limited; glossary entries are applied
only when a whole segment matches a glossary term.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ..langs import GOOGLE_CODES
from .base import Context, Item, Translator

URL = "https://translate.googleapis.com/translate_a/single"


class GoogleTranslator(Translator):
    name = "google"
    batch_chars = 4000
    batch_items = 100

    def __init__(self, workers: int = 6):
        self.workers = workers

    def _one(self, text: str, sl: str, tl: str) -> str:
        q = urllib.parse.urlencode({"client": "gtx", "sl": sl, "tl": tl, "dt": "t", "q": text})
        for attempt in range(5):
            try:
                req = urllib.request.Request(f"{URL}?{q}", headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode("utf-8"))
                return "".join(part[0] for part in data[0] if part and part[0])
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(1.5 * 2**attempt)
        return text

    def translate(self, items: list[Item], ctx: Context) -> dict[str, str]:
        sl = GOOGLE_CODES.get(ctx.source_lang.lower(), ctx.source_lang)
        tl = GOOGLE_CODES.get(ctx.target_lang.lower(), ctx.target_lang)
        out: dict[str, str] = {}
        todo = []
        for it in items:
            if it.text in ctx.glossary:
                out[it.id] = ctx.glossary[it.text]
            else:
                todo.append(it)
        with ThreadPoolExecutor(self.workers) as pool:
            for it, res in zip(todo, pool.map(lambda i: self._one(i.text, sl, tl), todo)):
                out[it.id] = res
        return out
