"""Language names and script detection helpers."""

from __future__ import annotations

import re

LANGUAGE_NAMES = {
    "zh": "Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "en": "English",
    "th": "Thai",
    "ja": "Japanese",
    "ko": "Korean",
    "vi": "Vietnamese",
    "id": "Indonesian",
    "ms": "Malay",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "pt": "Portuguese",
    "it": "Italian",
    "ru": "Russian",
    "ar": "Arabic",
    "hi": "Hindi",
    "lo": "Lao",
    "my": "Burmese",
    "km": "Khmer",
}

# Google Translate uses slightly different codes for a few languages.
GOOGLE_CODES = {"zh": "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW"}

_CJK = "㐀-䶿一-鿿豈-﫿\U00020000-\U0002a6df"
_KANA = "぀-ヿㇰ-ㇿ"
_HANGUL = "가-힯ᄀ-ᇿ㄰-㆏"

SCRIPT_PATTERNS = {
    "zh": re.compile(f"[{_CJK}]"),
    "zh-cn": re.compile(f"[{_CJK}]"),
    "zh-tw": re.compile(f"[{_CJK}]"),
    "ja": re.compile(f"[{_CJK}{_KANA}]"),
    "ko": re.compile(f"[{_HANGUL}]"),
    "th": re.compile("[฀-๿]"),
    "ru": re.compile("[Ѐ-ӿ]"),
    "ar": re.compile("[؀-ۿ]"),
    "hi": re.compile("[ऀ-ॿ]"),
}

CJK_RE = re.compile(f"[{_CJK}{_KANA}{_HANGUL}]")
LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)
# Full-width / CJK punctuation that should be glued to the previous character.
CJK_PUNCT = set("，。、；：？！）】」』》〉”’%％·…—")


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code.lower(), code)


def needs_translation(text: str, source_lang: str) -> bool:
    """True when *text* contains characters of the source language.

    Numbers, model codes and units ("MH010A", "220V", "N.m") are left
    untouched, which keeps them pixel-identical to the original.
    """
    pat = SCRIPT_PATTERNS.get(source_lang.lower())
    if pat is not None:
        return bool(pat.search(text))
    # Latin-script source: translate anything that has at least two letters
    # in a row (skips pure numbers / codes of a single letter).
    return bool(re.search(r"[^\W\d_]{2,}", text, re.UNICODE))


def is_cjk_char(ch: str) -> bool:
    return bool(CJK_RE.match(ch))


def join_lines(parts: list[str]) -> str:
    """Join visual lines into a paragraph.

    CJK text never uses spaces between lines; Latin text needs one, and a
    trailing hyphen at a line end is a soft hyphenation to be removed.
    """
    out = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not out:
            out = part
            continue
        prev, nxt = out[-1], part[0]
        if is_cjk_char(prev) or is_cjk_char(nxt) or prev in CJK_PUNCT or nxt in CJK_PUNCT:
            out += part
        elif prev == "-" and len(out) > 1 and out[-2].isalpha() and nxt.islower():
            out = out[:-1] + part
        else:
            out += " " + part
    return out
