"""Translation with Claude (Anthropic API) - the highest quality engine.

Claude sees each page's segments together, in reading order, so it can use
the surrounding context, keep terminology consistent and write natural,
fluent text instead of word-for-word output. Each segment carries the number
of characters that fit in its space on the page, which keeps translations
short enough for tight table cells.
"""

from __future__ import annotations

import json
import time
from typing import Optional

from ..langs import language_name
from .base import Context, Item, Translator

DEFAULT_MODEL = "claude-opus-5"

SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["translations"],
    "additionalProperties": False,
}


def _system_prompt(ctx: Context) -> str:
    src = language_name(ctx.source_lang)
    tgt = language_name(ctx.target_lang)
    lines = [
        f"You are a senior technical translator. You translate {src} documents into {tgt} "
        f"so that they read as if a native {tgt} technical writer wrote them.",
        "",
        "You receive text segments extracted from a PDF page, in reading order. Each segment is "
        "a heading, a paragraph, a list item or a table cell, and its translation is typeset back "
        "into exactly the same place on the page.",
        "",
        "How to translate:",
        "- Translate the meaning, not the words. Use the natural, idiomatic phrasing and the "
        "standard terminology of the field (for manuals: the wording used in well-written "
        f"{tgt} manuals and datasheets).",
        "- Use the neighbouring segments as context: a table cell is often a fragment of a "
        "sentence that its row or column completes. Keep terminology identical everywhere.",
        "- Text may come from OCR. Silently correct obvious recognition errors (wrong similar-"
        "looking characters, 'Mo' for 'MΩ', a missing character) when the intended text is clear.",
        "- Keep unchanged: numbers, units, model numbers and codes, part numbers, URLs, and "
        "symbols such as ①②③, ·, •, ■, □, ±, Φ, ℃ and °C. Keep a leading bullet or number.",
        "- Each segment has max_chars: roughly how many characters fit in its space at the "
        "original font size. Stay within it whenever the meaning allows. Headings and table "
        "cells should be short and conventional; abbreviate only in the standard way for the "
        "field. Never drop information to save space.",
        "- Do not add explanations, notes, quotation marks or text that is not in the source.",
        "- If a segment needs no translation (only a code, number or a proper name that is "
        "already in the target language), return it unchanged.",
        "- Return every id exactly once.",
    ]
    if ctx.glossary:
        lines += ["", "Mandatory glossary (source => target):"]
        for k, v in ctx.glossary.items():
            lines.append(f"- {k} => {v}")
    if ctx.notes:
        lines += ["", "Additional instructions from the user:", ctx.notes]
    if ctx.document_hint:
        lines += ["", "For context, the document begins with:", ctx.document_hint[:1500]]
    return "\n".join(lines)


class ClaudeTranslator(Translator):
    name = "claude"
    batch_chars = 3500
    batch_items = 80

    def __init__(self, model: Optional[str] = None, effort: str = "medium", api_key: Optional[str] = None):
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("Install the Anthropic SDK:  pip install anthropic") from exc
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, max_retries=4) if api_key else anthropic.Anthropic(max_retries=4)
        self.model = model or DEFAULT_MODEL
        self.effort = effort

    def cache_tag(self) -> str:
        return f"claude:{self.model}"

    def translate(self, items: list[Item], ctx: Context) -> dict[str, str]:
        payload = [
            {"id": it.id, "text": it.text, **({"max_chars": it.max_chars} if it.max_chars else {})}
            for it in items
        ]
        user = (
            f"Translate these segments from {language_name(ctx.source_lang)} to "
            f"{language_name(ctx.target_lang)}.\n\n" + json.dumps(payload, ensure_ascii=False, indent=0)
        )
        message = self._call(_system_prompt(ctx), user)
        if message.stop_reason == "refusal":
            raise RuntimeError("Claude declined to translate this batch (stop_reason=refusal).")
        if message.stop_reason == "max_tokens":
            if len(items) == 1:
                raise RuntimeError("Translation of a single segment exceeded max_tokens.")
            half = len(items) // 2
            out = self.translate(items[:half], ctx)
            out.update(self.translate(items[half:], ctx))
            return out
        text = next((b.text for b in message.content if b.type == "text"), "")
        data = json.loads(text)
        result = {t["id"]: t["text"] for t in data.get("translations", [])}
        missing = [it for it in items if it.id not in result]
        if missing and len(missing) < len(items):
            result.update(self.translate(missing, ctx))
        return result

    def _call(self, system: str, user: str):
        anthropic = self.anthropic
        for attempt in range(5):
            try:
                with self.client.beta.messages.stream(
                    model=self.model,
                    max_tokens=32000,
                    system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                    messages=[{"role": "user", "content": user}],
                    thinking={"type": "adaptive"},
                    output_config={
                        "effort": self.effort,
                        "format": {"type": "json_schema", "schema": SCHEMA},
                    },
                    # A declined request is re-run on the recommended fallback model.
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                ) as stream:
                    return stream.get_final_message()
            except anthropic.AuthenticationError as exc:
                raise RuntimeError(
                    "Anthropic API authentication failed. Set ANTHROPIC_API_KEY "
                    "(https://console.anthropic.com) or run `ant auth login`."
                ) from exc
            except anthropic.BadRequestError:
                raise
            except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError):
                if attempt == 4:
                    raise
                time.sleep(min(60, 5 * 2**attempt))
        raise RuntimeError("unreachable")
