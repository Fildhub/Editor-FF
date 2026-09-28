"""Use translations from a JSON file (human translator, reviewer edits, or
a previous run exported with --export-json)."""

from __future__ import annotations

import json
from pathlib import Path

from .base import Context, Item, Translator


def load_translations(path: str) -> dict[str, str]:
    data = json.loads(Path(path).read_text("utf-8"))
    if isinstance(data, dict) and "segments" in data:
        data = data["segments"]
    if isinstance(data, dict):
        return {str(k): str(v) for k, v in data.items() if v is not None}
    out = {}
    for row in data:
        if row.get("translation") is not None:
            out[str(row["id"])] = str(row["translation"])
    return out


class FileTranslator(Translator):
    """Looks translations up by segment id, falling back to the source text."""

    name = "file"
    batch_chars = 10**9
    batch_items = 10**9

    def __init__(self, path: str):
        self.path = path
        self.by_id = load_translations(path)
        # Also allow lookups by source text (handy when ids shift).
        self.by_text: dict[str, str] = {}
        raw = json.loads(Path(path).read_text("utf-8"))
        rows = raw["segments"] if isinstance(raw, dict) and "segments" in raw else raw
        if isinstance(rows, list):
            for row in rows:
                if row.get("translation") is not None and row.get("source"):
                    self.by_text.setdefault(row["source"], row["translation"])

    def cache_tag(self) -> str:
        return f"file:{self.path}"

    def translate(self, items: list[Item], ctx: Context) -> dict[str, str]:
        out = {}
        for it in items:
            if it.id in self.by_id:
                out[it.id] = self.by_id[it.id]
            elif it.text in self.by_text:
                out[it.id] = self.by_text[it.text]
        return out
