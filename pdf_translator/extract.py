"""Page analysis: find every piece of text and the page's graphic structure."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pymupdf

from .langs import LETTER_RE
from .models import Box, Char, Line, box_area, box_overlap_area, box_union
from .raster import (
    PageImage,
    detect_lines,
    detect_pictures,
    render_page,
    set_line_mask,
)


@dataclass
class PageLayout:
    page_no: int
    rect: Box
    lines: list[Line]
    hlines: list[Box]
    vlines: list[Box]
    pictures: list[Box]
    image: PageImage
    ocr_used: bool


def _dir_to_rotate(d: tuple[float, float]) -> Optional[int]:
    cos, sin = d
    if cos > 0.99:
        return 0
    if sin < -0.99:
        return 90
    if cos < -0.99:
        return 180
    if sin > 0.99:
        return 270
    return None  # skewed text is left as it is


def native_lines(page: pymupdf.Page) -> list[Line]:
    """Lines of real (extractable) text, split at large gaps between spans."""
    flags = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_MEDIABOX_CLIP
    raw = page.get_text("rawdict", flags=flags)
    out: list[Line] = []
    for block in raw["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            rot = _dir_to_rotate(tuple(line["dir"]))
            if rot is None:
                continue
            pieces: list[list[dict]] = []
            prev = None
            for span in line["spans"]:
                chars = [c for c in span["chars"]]
                if not chars:
                    continue
                text = "".join(c["c"] for c in chars)
                if not text.strip():
                    prev = None if prev is None else prev
                    continue
                if prev is not None and rot == 0:
                    gap = span["bbox"][0] - prev["bbox"][2]
                    if gap > 1.5 * max(span["size"], prev["size"]):
                        pieces.append([])
                if not pieces:
                    pieces.append([])
                pieces[-1].append(span)
                prev = span
            for spans in pieces:
                if not spans:
                    continue
                text = "".join("".join(c["c"] for c in s["chars"]) for s in spans).strip()
                if not text:
                    continue
                weights = [len(s["chars"]) for s in spans]
                main = spans[weights.index(max(weights))]
                color = main["color"]
                rgb = (((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255)
                fname = main["font"]
                low = fname.lower()
                bold = bool(main["flags"] & 16) or any(k in low for k in ("bold", "heavy", "black", "semibold", "demi"))
                italic = bool(main["flags"] & 2) or "italic" in low or "oblique" in low
                serif = bool(main["flags"] & 4) or any(k in low for k in ("song", "ming", "serif", "times", "simsun", "mincho"))
                chars = [
                    Char(c["c"], tuple(c["bbox"]))
                    for s in spans
                    for c in s["chars"]
                    if c["c"].strip()
                ]
                bbox = box_union([tuple(s["bbox"]) for s in spans])
                out.append(
                    Line(
                        bbox=bbox,
                        text=text,
                        size=float(main["size"]),
                        color=rgb,
                        bold=bold,
                        italic=italic,
                        serif=serif,
                        font=fname,
                        rotate=rot,
                        chars=chars,
                        source="text",
                    )
                )
    return out


class OcrCache:
    """Raw OCR results are expensive (~30 s per large page); keep them."""

    def __init__(self, directory: Optional[Path]):
        self.dir = directory
        if self.dir:
            self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Optional[Path]:
        return self.dir / f"ocr-{key}.json" if self.dir else None

    def get(self, key: str):
        p = self._path(key)
        if p and p.exists():
            data = json.loads(p.read_text("utf-8"))
            for item in data:
                item["box"] = tuple(item["box"])
                item.setdefault("score", 1.0)
                item["chars"] = [Char(c[0], tuple(c[1])) for c in item["chars"]]
            return data
        return None

    def put(self, key: str, pieces: list[dict]) -> None:
        p = self._path(key)
        if not p:
            return
        data = [
            {
                "box": list(it["box"]),
                "text": it["text"],
                "score": it.get("score", 1.0),
                "chars": [[c.text, list(c.bbox)] for c in it["chars"]],
            }
            for it in pieces
        ]
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        os.replace(tmp, p)


def page_fingerprint(page: pymupdf.Page) -> str:
    h = hashlib.sha256()
    h.update(page.read_contents())
    h.update(repr(tuple(page.rect)).encode())
    return h.hexdigest()[:24]


def _inside(inner: Box, outer: Box, tol: float = 0.5) -> bool:
    return (
        inner[0] >= outer[0] - tol
        and inner[1] >= outer[1] - tol
        and inner[2] <= outer[2] + tol
        and inner[3] <= outer[3] + tol
    )


def _is_glyph_stroke(line: Box, text: Box, horizontal: bool) -> bool:
    """A 'ruling line' that is really a stroke of a large glyph (一, 丨, l)."""
    th = text[3] - text[1]
    if horizontal:
        length = line[2] - line[0]
        return (
            line[1] >= text[1] - 1.0
            and line[3] <= text[3] + 1.0
            and line[0] >= text[0] - 2.0
            and line[2] <= text[2] + 2.0
            and length <= 2.0 * th
        )
    length = line[3] - line[1]
    return (
        length <= 1.35 * th
        and line[1] >= text[1] - 0.25 * th
        and line[3] <= text[3] + 0.25 * th
        and line[0] >= text[0] - 2.0
        and line[2] <= text[2] + 2.0
    )


def _hires_cropper(page: pymupdf.Page, dpi: int = 600, max_pixels: int = 110_000_000):
    """Return f(box) -> grayscale crop rendered once at high resolution."""
    import numpy as np

    area_in = (page.rect.width / 72.0) * (page.rect.height / 72.0)
    dpi = min(dpi, int((max_pixels / area_in) ** 0.5))
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w)
    sc = dpi / 72.0

    def crop(b: Box):
        x0, y0 = max(0, int(b[0] * sc)), max(0, int(b[1] * sc))
        x1, y1 = min(pix.w, int(b[2] * sc + 1)), min(pix.h, int(b[3] * sc + 1))
        if x1 <= x0 or y1 <= y0:
            return None
        return arr[y0:y1, x0:x1]

    return crop


def analyse_page(
    page: pymupdf.Page,
    ocr: str = "auto",
    dpi: int = 300,
    cache: Optional[OcrCache] = None,
    log=print,
) -> PageLayout:
    """Collect text lines (native and/or OCR) plus lines and pictures."""
    natives = native_lines(page)
    native_chars = sum(len(LETTER_RE.findall(ln.text)) for ln in natives)
    use_ocr = ocr == "always" or (ocr == "auto" and native_chars < 20)
    img = render_page(page, dpi if use_ocr else min(dpi, 200))
    if use_ocr and native_chars < 20 and not img.ink.any():
        use_ocr = False  # blank page
    hlines, vlines = detect_lines(img)
    lines = list(natives)

    if use_ocr:
        from .ocr import ocr_pieces, pieces_to_lines, raw_ocr

        key = f"raw2-{page_fingerprint(page)}-{int(img.scale * 72)}"
        raw = cache.get(key) if cache else None
        if raw is None:
            log(f"  page {page.number + 1}: running OCR (text is an image or vector outlines)...")
            raw = raw_ocr(img)
            if cache:
                cache.put(key, raw)
        # Long glyph strokes of big headings look like ruling lines: drop
        # "lines" that belong to a piece of text.
        text_boxes = [p["box"] for p in raw if p["score"] >= 0.5]
        hlines = [b for b in hlines if not any(_is_glyph_stroke(b, t, True) for t in text_boxes)]
        vlines = [b for b in vlines if not any(_is_glyph_stroke(b, t, False) for t in text_boxes)]
        set_line_mask(img, hlines + vlines)
        pieces = ocr_pieces(raw, vlines)
        hires = _hires_cropper(page)
        ocr_lines = pieces_to_lines(img, pieces, hires)
        # Do not duplicate text that is also available natively.
        for ln in ocr_lines:
            if any(box_overlap_area(ln.bbox, n.bbox) > 0.3 * box_area(ln.bbox) for n in natives):
                continue
            lines.append(ln)
    else:
        set_line_mask(img, hlines + vlines)

    pictures = detect_pictures(img, [ln.bbox for ln in lines])
    # Drawings that contain text (frames, shaded panels) are not obstacles
    # for that text; keep them anyway - layout ignores obstacles that overlap
    # the text box itself.
    return PageLayout(
        page_no=page.number,
        rect=tuple(page.rect),
        lines=lines,
        hlines=hlines,
        vlines=vlines,
        pictures=pictures,
        image=img,
        ocr_used=use_ocr,
    )
