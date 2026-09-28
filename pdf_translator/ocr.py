"""OCR for pages whose text is not extractable.

This covers scanned documents and - very common for printed manuals exported
from InDesign/Illustrator - PDFs where every glyph was converted to vector
outlines. RapidOCR (PP-OCRv4 models, runs offline on CPU) is used because it
is excellent at Chinese and also reads Latin text and digits.
"""

from __future__ import annotations

import re
from typing import Callable, Optional

import cv2

import numpy as np

from .langs import CJK_RE, LETTER_RE
from .models import Box, Char, Line
from .raster import PageImage, analyse_ink

_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as exc:  # pragma: no cover - depends on install
            raise RuntimeError(
                "This PDF needs OCR (its text is an image or vector outlines). "
                "Install the OCR extra:  pip install rapidocr_onnxruntime"
            ) from exc
        # Strips are processed at native resolution - never downscale them.
        _engine = RapidOCR(max_side_len=20000, print_verbose=False)
    return _engine


def _quad_to_box(quad) -> tuple[float, float, float, float]:
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def _raw_ocr(img: PageImage, strip_px: int = 1400, overlap_px: int = 260) -> list[dict]:
    """Run detection+recognition on overlapping full-width strips."""
    engine = _get_engine()
    H = img.height
    results: list[dict] = []
    start = 0
    while True:
        end = min(H, start + strip_px)
        strip = img.rgb[start:end]
        core_top = start + (overlap_px // 2 if start > 0 else 0)
        core_bot = end - (overlap_px // 2 if end < H else 0)
        out, _ = engine(strip, return_word_box=True)
        for item in out or []:
            quad, text, score = item[0], item[1], float(item[2])
            x0, y0, x1, y1 = _quad_to_box(quad)
            cy = (y0 + y1) / 2 + start
            if not (core_top <= cy < core_bot):
                continue
            chars = []
            if len(item) >= 5 and item[3] and item[4] and len(item[3]) == len(item[4]):
                for cq, ct in zip(item[3], item[4]):
                    cx0, cy0, cx1, cy1 = _quad_to_box(cq)
                    chars.append((ct, (cx0, cy0 + start, cx1, cy1 + start)))
            results.append(
                {
                    "box": (x0, y0 + start, x1, y1 + start),
                    "text": text,
                    "score": score,
                    "chars": chars,
                }
            )
        if end >= H:
            break
        start = end - overlap_px
    return results


SEPARATOR_CHARS = set("|丨｜")


def _split_pieces(item: dict, vlines: list[Box]) -> list[dict]:
    """Split one OCR line (in points) where a table border crosses it, at a
    '|' that is really a border, or at a very wide gap between characters."""
    chars: list[Char] = item["chars"]
    if len(chars) < 2:
        return [item]
    x0, y0, x1, y1 = item["box"]
    h = y1 - y0
    cuts: set[int] = set()  # cut after char i
    drop: set[int] = set()

    def crossing(lo: float, hi: float) -> bool:
        for v in vlines:
            lx = (v[0] + v[2]) / 2
            if lo <= lx <= hi and v[1] <= y0 + h * 0.7 and v[3] >= y1 - h * 0.7:
                return True
        return False

    for i, ch in enumerate(chars):
        b = ch.bbox
        if ch.text in SEPARATOR_CHARS or (ch.text in "Il1" and crossing(b[0], b[2])):
            if ch.text in SEPARATOR_CHARS or crossing(b[0] - 0.3, b[2] + 0.3):
                drop.add(i)
                if i > 0:
                    cuts.add(i - 1)
                cuts.add(i)
                continue
        if i < len(chars) - 1:
            a, nb = b, chars[i + 1].bbox
            if crossing(a[2] - 0.5, nb[0] + 0.5):
                cuts.add(i)
            elif nb[0] - a[2] > 2.2 * h:
                cuts.add(i)
    if not cuts:
        return [item]
    pieces: list[list[Char]] = []
    cur: list[Char] = []
    for i, ch in enumerate(chars):
        if i not in drop:
            cur.append(ch)
        if i in cuts:
            if cur:
                pieces.append(cur)
            cur = []
    if cur:
        pieces.append(cur)
    out = []
    for pc in pieces:
        text = "".join(c.text for c in pc).strip()
        if not text:
            continue
        bx0 = min(c.bbox[0] for c in pc)
        bx1 = max(c.bbox[2] for c in pc)
        out.append({"box": (bx0, y0, bx1, y1), "text": text, "score": item["score"], "chars": pc})
    return out


FULLWIDTH_PUNCT = set("，。、；：？！（）【】「」『』《》〈〉“”‘’…—～·")
_TRAIL_HALF = set("，。、；：？！）】」』》〉”’")
_LEAD_HALF = set("（【「『《〈“‘")


def _ems(text: str) -> float:
    """Advance width of *text* in em for a typical CJK font."""
    ems = 0.0
    for ch in text:
        if (
            CJK_RE.match(ch)
            or ch in FULLWIDTH_PUNCT
            or "\uff01" <= ch <= "\uff5e"
            or "\u2460" <= ch <= "\u24ff"  # ① ② ...
            or "\u25a0" <= ch <= "\u25ff"  # ■ □ ...
        ):
            ems += 1.0
        elif ch == " ":
            ems += 0.28
        elif ch in "il.,:;'|!":
            ems += 0.28
        elif ch.isupper() or ch in "mwMW%":
            ems += 0.66
        else:
            ems += 0.54
    # a trailing full-width punctuation mark has no ink in its right half
    if text and text[-1] in _TRAIL_HALF:
        ems -= 0.55
    if text and text[0] in _LEAD_HALF:
        ems -= 0.45
    return max(ems, 0.5)


def _estimate_size(text: str, ink_w: float, ink_h: float) -> float:
    """Font size (pt) of a horizontal line from its inked area.

    CJK glyphs are all one em wide, so for lines with several CJK characters
    the width gives a far more stable size than the height (which depends on
    the particular glyphs and on OCR box noise).
    """
    n_cjk = len(CJK_RE.findall(text))
    if n_cjk:
        by_h = ink_h / 0.86
        if n_cjk >= 3:
            by_w = ink_w / _ems(text)
            # trust the width unless it is wildly off (e.g. letter-spacing)
            if 0.5 * by_h <= by_w <= 1.3 * by_h:
                return by_w
        return by_h
    if re.search(r"[gjpqy(),;\[\]{}|/]", text):
        return ink_h / 0.93
    if re.search(r"[a-z]", text) and re.search(r"[bdfhklt0-9A-Z]", text):
        return ink_h / 0.74
    if re.search(r"[bdfhklt0-9A-Z]", text):
        return ink_h / 0.72
    return ink_h / 0.52  # x-height only (e.g. "ms", "are")


def _drop_decorations(piece: dict) -> dict:
    """Remove dashes OCR read as 一 at either end of a line ("— 禾川科技 —")."""
    chars = list(piece["chars"])
    text = piece["text"]
    changed = False
    while len(chars) >= 3 and chars[-1].text == "一":
        gap = chars[-1].bbox[0] - chars[-2].bbox[2]
        if gap < 0.35 * (chars[-2].bbox[3] - chars[-2].bbox[1]):
            break
        chars.pop()
        changed = True
    while len(chars) >= 3 and chars[0].text == "一":
        gap = chars[1].bbox[0] - chars[0].bbox[2]
        if gap < 0.35 * (chars[1].bbox[3] - chars[1].bbox[1]):
            break
        chars.pop(0)
        changed = True
    if not changed:
        return piece
    text = "".join(c.text for c in chars).strip()
    b = piece["box"]
    return {"box": (chars[0].bbox[0], b[1], chars[-1].bbox[2], b[3]), "text": text, "chars": chars}


def raw_ocr(img: PageImage) -> list[dict]:
    """Run OCR on a page image. Result in PDF points (cacheable)."""
    sc = img.scale
    out = []
    for item in _raw_ocr(img):
        b = item["box"]
        out.append(
            {
                "box": (b[0] / sc, b[1] / sc, b[2] / sc, b[3] / sc),
                "text": item["text"],
                "score": item["score"],
                "chars": [Char(t, (c[0] / sc, c[1] / sc, c[2] / sc, c[3] / sc)) for t, c in item["chars"]],
            }
        )
    return out


def ocr_pieces(raw: list[dict], vlines: Optional[list[Box]] = None, min_score: float = 0.5) -> list[dict]:
    """Split raw OCR lines into pieces (cells) and drop non-text detections."""
    out = []
    for item in raw:
        if item["score"] < min_score:
            continue
        for piece in _split_pieces(item, vlines or []):
            text = piece["text"].strip()
            # Symbol-only detections (warning icons read as "!" etc.) are
            # graphics - leave them alone.
            if not (LETTER_RE.search(text) or re.search(r"\d", text)):
                continue
            piece["text"] = text
            out.append(piece)
    return out


def _strip_dashes(img: PageImage, text: str, bx: Box) -> tuple[str, Box]:
    """A long dash set apart from the text ("— 禾川科技 —") is decoration,
    not the character 一. Detect it from the ink: a thin stroke separated
    from the neighbouring glyph by a clear gap."""
    x0, y0, x1, y1 = img.to_px(bx)
    ink = img.ink[y0:y1, x0:x1]
    if ink.size == 0:
        return text, bx
    cols = ink.any(axis=0)
    h = y1 - y0
    runs = []  # (start, end) of inked column runs, merging tiny gaps
    start = None
    gap = 0
    for i, c in enumerate(cols):
        if c:
            if start is None:
                start = i
            gap = 0
            end = i + 1
        elif start is not None:
            gap += 1
            if gap > 0.12 * h:
                runs.append((start, end))
                start = None
    if start is not None:
        runs.append((start, end))
    if len(runs) < 2:
        return text, bx

    def thin(run):
        rows = ink[:, run[0] : run[1]].any(axis=1)
        return rows.sum() < 0.22 * h

    s = img.scale
    if text[-1] == "一" and thin(runs[-1]) and runs[-1][0] - runs[-2][1] > 0.2 * h:
        text = text[:-1].rstrip()
        bx = (bx[0], bx[1], (x0 + runs[-2][1]) / s, bx[3])
    if text and text[0] == "一" and thin(runs[0]) and runs[1][0] - runs[0][1] > 0.2 * h:
        text = text[1:].lstrip()
        bx = ((x0 + runs[1][0]) / s, bx[1], bx[2], bx[3])
    return text, bx


def pieces_to_lines(
    img: PageImage,
    pieces: list[dict],
    hires: Optional[Callable[[Box], Optional[np.ndarray]]] = None,
) -> list[Line]:
    """Measure each OCR piece on the page image (tight box, colour, weight).

    *hires* returns a high-resolution grayscale crop of a box; stroke weight
    (bold detection) is much more reliable at 600 dpi than at OCR resolution.
    """
    lines: list[Line] = []
    weights: list[Optional[tuple[float, float]]] = []
    for piece in pieces:
        piece = _drop_decorations(piece)
        text = piece["text"]
        det = piece["box"]
        det_h = det[3] - det[1]
        xlim = None
        if piece["chars"]:
            # recognised characters only - not an icon in front of the word
            cx0 = min(c.bbox[0] for c in piece["chars"])
            cx1 = max(c.bbox[2] for c in piece["chars"])
            # the right end is not trimmed: the last glyph often sticks out
            # of its (approximate) character box
            xlim = (cx0 - 0.25 * det_h, max(cx1, det[2]) + 0.5)
        ink = analyse_ink(img, det, pad_pt=0.3, xlim=xlim)
        if ink is None:
            continue
        bx = ink.bbox
        if len(text) >= 3 and (text[-1] == "一" or text[0] == "一"):
            text, bx = _strip_dashes(img, text, bx)
        bw, bh = bx[2] - bx[0], bx[3] - bx[1]
        is_cjk = bool(CJK_RE.search(text))
        if len(text) == 1 and is_cjk and bh < 0.3 * bw:
            continue  # a dash that OCR read as 一 / 二
        if bh < 0.55 * det_h and len(text) > 1 and not (bw < bh):
            # The ink analysis latched onto a fragment; trust the detector.
            cy = (det[1] + det[3]) / 2
            half = det_h * 0.85 / 2
            bx = (bx[0], cy - half, bx[2], cy + half)
            bw, bh = bx[2] - bx[0], bx[3] - bx[1]
        if bh < 1.2:
            continue  # speck of ink, not text
        vertical = is_cjk and len(text) >= 2 and bh > 1.6 * bw
        size = bw / 0.92 if vertical else _estimate_size(text, bw, bh)
        lines.append(
            Line(
                bbox=bx,
                text=text,
                size=size,
                color=ink.color,
                vertical=vertical,
                chars=piece["chars"],
                background=ink.background,
                source="ocr",
            )
        )
        weights.append(_weight(hires(bx) if hires else None) if is_cjk else None)
    _mark_bold(lines, weights)
    return lines


def _weight(gray: Optional[np.ndarray]) -> Optional[tuple[float, float]]:
    """(mean stroke half-width / height, ink density) of a text crop."""
    if gray is None or gray.size == 0 or gray.shape[0] < 8:
        return None
    mask = (gray < 128).astype(np.uint8)
    if mask.sum() < 20:
        return None
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    return float(dist[mask > 0].mean()) / gray.shape[0], float(mask.mean())


def _mark_bold(lines: list[Line], weights: list[Optional[tuple[float, float]]]) -> None:
    """Flag bold lines from their stroke thickness.

    Documents often mix light, regular and bold weights, so a threshold
    relative to the page median misfires; absolute stroke/height ratios
    (measured at 600 dpi on the tight ink box) separate CJK weights well.
    """
    for w, ln in zip(weights, lines):
        if w is None or len(ln.text) < 2:
            continue
        dt, den = w
        ln.bold = dt >= 0.0315 or (dt >= 0.0295 and den >= 0.29)
