"""Translator interface and a persistent translation cache."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Item:
    id: str
    text: str
    max_chars: Optional[int] = None


@dataclass
class Context:
    source_lang: str
    target_lang: str
    glossary: dict[str, str] = field(default_factory=dict)
    document_hint: str = ""  # a short excerpt so the model knows the domain
    notes: str = ""  # extra user instructions


class Translator:
    name = "base"
    batch_chars = 3000  # source characters per request
    batch_items = 60

    def cache_tag(self) -> str:
        return self.name

    def translate(self, items: list[Item], ctx: Context) -> dict[str, str]:
        raise NotImplementedError


class TranslationCache:
    """SQLite cache so re-running never pays twice for the same text."""

    def __init__(self, path: Optional[Path]):
        self.path = path
        self._lock = threading.Lock()
        self._db = None
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(str(path), check_same_thread=False)
            self._db.execute("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)")
            self._db.commit()

    @staticmethod
    def key(tag: str, ctx: Context, text: str) -> str:
        h = hashlib.sha256()
        gl = json.dumps(ctx.glossary, sort_keys=True, ensure_ascii=False)
        for part in (tag, ctx.source_lang, ctx.target_lang, gl, ctx.notes, text):
            h.update(part.encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()

    def get(self, key: str) -> Optional[str]:
        if not self._db:
            return None
        with self._lock:
            row = self._db.execute("SELECT v FROM t WHERE k=?", (key,)).fetchone()
        return row[0] if row else None

    def put(self, key: str, value: str) -> None:
        if not self._db:
            return
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)", (key, value))
            self._db.commit()


def make_batches(items: list[Item], max_chars: int, max_items: int) -> list[list[Item]]:
    batches: list[list[Item]] = []
    cur: list[Item] = []
    size = 0
    for it in items:
        if cur and (size + len(it.text) > max_chars or len(cur) >= max_items):
            batches.append(cur)
            cur, size = [], 0
        cur.append(it)
        size += len(it.text)
    if cur:
        batches.append(cur)
    return batches


def load_glossary(path: Optional[str]) -> dict[str, str]:
    """Glossary file: CSV/TSV (source,target per line) or JSON object."""
    if not path:
        return {}
    p = Path(path)
    text = p.read_text("utf-8-sig")
    if p.suffix.lower() == ".json":
        data = json.loads(text)
        return {str(k): str(v) for k, v in data.items()}
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        sep = "\t" if "\t" in line else ","
        if sep not in line:
            continue
        src, tgt = line.split(sep, 1)
        out[src.strip()] = tgt.strip()
    return out
