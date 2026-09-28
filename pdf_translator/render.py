"""Erase the original text and typeset the translation in its place."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pymupdf

from .models import Box, Segment, box_h, box_overlap_area, box_pad, box_w

LINE_HEIGHT = 1.2
MIN_SCALE = 0.45  # never shrink below 45% of the original size ...
MIN_SIZE = 3.2  # ... or below 3.2 pt, unless nothing else fits


@dataclass
class FontSet:
    """CSS + font files used for the translated text."""

    css: str
    archive: pymupdf.Archive
    family: str
    regular: Optional[pymupdf.Font] = None
    bold: Optional[pymupdf.Font] = None

    def text_width(self, text: str, size: float, bold: bool = False) -> float:
        font = (self.bold if bold else self.regular) or self.regular
        if font is None:
            return len(text) * 0.55 * size
        w = 0.0
        for ch in text:
            if font.has_glyph(ord(ch)):
                w += font.text_length(ch, fontsize=size)
            else:  # glyph comes from a fallback font (CJK, Thai...)
                w += size * (1.0 if ord(ch) > 0x2E80 else 0.6)
        return w

    @classmethod
    def create(cls, font_file: Optional[str] = None, serif: bool = False) -> "FontSet":
        arch = pymupdf.Archive()
        if font_file:
            p = Path(font_file)
            arch.add(str(p.parent))
            css = f'@font-face {{font-family: userfont; src: url("{p.name}");}}\n'
            f = pymupdf.Font(fontfile=str(p))
            return cls(css=css, archive=arch, family="userfont", regular=f, bold=f)
        try:
            code = "notoserif" if serif else "notos"
            css = pymupdf.css_for_pymupdf_font(code, archive=arch, name="bodyfont")
            reg = pymupdf.Font(code)
            try:
                bold = pymupdf.Font(code + "bo")
            except Exception:
                bold = reg
            return cls(css=css, archive=arch, family="bodyfont", regular=reg, bold=bold)
        except Exception:  # pymupdf-fonts not installed: built-in Base14
            base = "tiro" if serif else "helv"
            bold = "tibo" if serif else "hebo"
            return cls(css="", archive=arch, family="serif" if serif else "sans-serif",
                       regular=pymupdf.Font(base), bold=pymupdf.Font(bold))


def _hex(rgb: tuple[float, float, float]) -> str:
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c * 255)))) for c in rgb)


def _html(text: str) -> str:
    parts = [html.escape(p) for p in text.split("\n")]
    return "<br/>".join(parts)


def _css(fonts: FontSet, seg: Segment, size: float) -> str:
    align = {"left": "left", "center": "center", "right": "right", "justify": "justify"}[seg.align]
    color = _hex(_readable_color(seg.color))
    weight = "bold" if seg.bold else "normal"
    style = "italic" if seg.italic else "normal"
    return (
        fonts.css
        + f"* {{font-family: {fonts.family}; font-size: {size:.3f}px; line-height: {LINE_HEIGHT};"
        f" color: {color}; font-weight: {weight}; font-style: {style}; margin: 0; padding: 0;}}"
        f" body {{text-align: {align}; margin: 0 !important; padding: 0 !important;}}"
    )


def _readable_color(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    # OCR colour sampling picks anti-aliased pixels; near-black -> black.
    if max(rgb) < 0.35:
        return (min(rgb[0], 0.14), min(rgb[1], 0.12), min(rgb[2], 0.13)) if max(rgb) > 0.1 else rgb
    return rgb


def measure(fonts: FontSet, seg: Segment, text: str, size: float, width: float) -> tuple[float, float]:
    """(height, width) the text needs at *size* when wrapped at *width*."""
    story = pymupdf.Story(_html(text), user_css=_css(fonts, seg, size), archive=fonts.archive)
    more, filled = story.place(pymupdf.Rect(0, 0, width, 100000))
    return filled[3] - filled[1], filled[2] - filled[0]


@dataclass
class Placement:
    seg: Segment
    rect: Box  # where the text box is drawn (unrotated page coordinates)
    size: float
    scale: float  # size / original size
    fits: bool
    content_h: float


def _draw_area(seg: Segment) -> Box:
    """The area the translation may use, respecting the original alignment."""
    c = seg.container or seg.bbox
    b = seg.bbox
    if seg.rotate in (90, 270):
        cy = (b[1] + b[3]) / 2
        half = min(cy - c[1], c[3] - cy)
        return (c[0], cy - half, c[2], cy + half)
    if seg.align in ("left", "justify"):
        x0, x1 = min(b[0], max(c[0], b[0] - 0.3)), c[2]
    elif seg.align == "right":
        x0, x1 = c[0], b[2]
    else:  # center
        cx = (b[0] + b[2]) / 2
        half = min(cx - c[0], c[2] - cx)
        x0, x1 = cx - half, cx + half
    if seg.valign == "middle":
        y0, y1 = c[1], c[3]
    else:
        y0, y1 = max(c[1], b[1] - 0.12 * seg.size), c[3]
    return (x0, y0, x1, y1)


def fit(fonts: FontSet, seg: Segment, text: str) -> Placement:
    """Choose the largest font size (<= original) at which the text fits."""
    area = _draw_area(seg)
    rotated = seg.rotate in (90, 270)
    W, H = (box_h(area), box_w(area)) if rotated else (box_w(area), box_h(area))
    s0 = max(seg.size, 1.0)

    def ok(size: float) -> tuple[bool, float]:
        h, w = measure(fonts, seg, text, size, W)
        return (h <= H + 0.01 and w <= W + 0.01), h

    # 1) The original was one line (a label, a cell, a heading): keep the
    #    translation on one line if that costs at most ~22% of the size.
    if "\n" not in text and (len(seg.lines) == 1 or rotated):
        natural = fonts.text_width(text, s0, seg.bold) * 1.01 + 0.5
        one = s0 if natural <= W else s0 * W / natural
        if one >= 0.78 * s0:
            good, h = ok(one)
            while not good and one > 0.78 * s0:
                one *= 0.97
                good, h = ok(one)
            if good and h <= one * LINE_HEIGHT * 1.6:
                return Placement(seg=seg, rect=area, size=one, scale=one / s0, fits=True, content_h=h)

    # 2) Wrap into as many lines as the free space allows, shrink if needed.
    good, h = ok(s0)
    size = s0
    if not good:
        lo, hi = 0.25, s0
        floor = max(MIN_SIZE, s0 * MIN_SCALE)
        if floor < s0 and ok(floor)[0]:
            lo = floor
        best = None
        for _ in range(14):
            mid = (lo + hi) / 2
            g, hh = ok(mid)
            if g:
                lo, best = mid, (mid, hh)
            else:
                hi = mid
            if hi - lo < 0.02:
                break
        if best is None:
            g, hh = ok(lo)
            best = (lo, hh)
            good = g
        else:
            good = True
        size, h = best
    return Placement(seg=seg, rect=area, size=size, scale=size / s0, fits=good, content_h=h)


def harmonise(placements: list[Placement], fonts: FontSet) -> None:
    """Keep sizes consistent between sibling cells (same column / style).

    Without this, every table cell gets its own shrink factor and the table
    looks ragged. Siblings share page, original size, weight and horizontal
    extent. Most of them are brought down to a common size (the 25th
    percentile of what they need); cells that need less keep their own
    smaller size, and nobody is reduced below 75% of the original.
    """
    groups: dict[tuple, list[Placement]] = {}
    for p in placements:
        s = p.seg
        if s.rotate:
            continue
        key = (s.page, round(s.size, 1), s.bold, round(p.rect[0] / 4), round(p.rect[2] / 4))
        groups.setdefault(key, []).append(p)
    for grp in groups.values():
        if len(grp) < 2:
            continue
        sizes = sorted(p.size for p in grp)
        target = sizes[int(0.25 * (len(sizes) - 1))]
        for p in grp:
            floor = 0.75 * max(p.seg.size, 1.0)
            new = max(target, floor)
            if p.size > new:
                p.size = new
                p.scale = new / max(p.seg.size, 1.0)


def erase_rects(seg: Segment) -> list[Box]:
    """Areas covering the original glyphs of a segment."""
    rects = []
    for ln in seg.lines:
        if ln.source == "text" and ln.chars:
            for c in ln.chars:
                b = c.bbox
                h = b[3] - b[1]
                # shrink vertically so neighbouring lines are not touched
                rects.append((b[0], b[1] + 0.12 * h, b[2], b[3] - 0.12 * h))
        else:
            # rendered ink misses the faint anti-aliased edge of outlines
            rects.append(box_pad(ln.bbox, 0.8, 0.55))
    return rects


def erase_page(page: pymupdf.Page, segments: list[Segment]) -> None:
    """Remove the original text of translated segments.

    Real text is deleted; vector outlines that lie completely inside the
    text area are deleted as well (this is how outlined text disappears).
    Table borders, shading and pictures are longer/larger than the text
    boxes and therefore stay untouched. Raster remains are painted over
    afterwards by :func:`cover_leftovers`.
    """
    rects: list[Box] = []
    ocr_boxes: list[Box] = []
    for seg in segments:
        if not seg.translate or seg.translation is None:
            continue
        rects.extend(erase_rects(seg))
        ocr_boxes.extend(box_pad(ln.bbox, 0.6) for ln in seg.lines if ln.source == "ocr")
    if ocr_boxes:
        # Glyph outlines whose centre lies in a text box: redact their own
        # bounding box too (curve control points can stick out of the ink).
        for d in page.get_drawings():
            r = d.get("rect")
            if r is None or d.get("fill") is None:
                continue
            if r.width > 40 or r.height > 40:
                continue
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            for b in ocr_boxes:
                if b[0] <= cx <= b[2] and b[1] <= cy <= b[3]:
                    inside = box_overlap_area(tuple(r), box_pad(b, 1.0)) >= 0.9 * max(r.width * r.height, 1e-6)
                    if inside:
                        rects.append((r.x0 - 0.15, r.y0 - 0.15, r.x1 + 0.15, r.y1 + 0.15))
                    break
    for r in rects:
        page.add_redact_annot(pymupdf.Rect(r), fill=False)
    if rects:
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )


def cover_leftovers(page: pymupdf.Page, segments: list[Segment], dpi: int = 200) -> int:
    """Paint over original glyph remains that could not be removed (scans,
    or outline fragments sticking out of the text box). Only the leftover
    specks themselves are covered, with the local background colour.
    Returns the number of patches painted."""
    import cv2

    todo = [s for s in segments if s.translate and s.translation is not None and s.source == "ocr"]
    if not todo:
        return 0
    pix = page.get_pixmap(dpi=dpi, alpha=False, colorspace=pymupdf.csRGB)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3].astype(np.int16)
    sc = dpi / 72.0
    painted = 0
    for seg in todo:
        for ln in seg.lines:
            b = box_pad(ln.bbox, 0.8, 0.5)
            x0, y0 = max(0, int(b[0] * sc)), max(0, int(b[1] * sc))
            x1, y1 = min(pix.w, int(b[2] * sc) + 1), min(pix.h, int(b[3] * sc) + 1)
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            reg = arr[y0:y1, x0:x1]
            bgc = ln.background if ln.background else (1.0, 1.0, 1.0)
            bg = np.array(bgc) * 255
            ink = (np.abs(reg - bg).max(axis=2) > 60).astype(np.uint8)
            # ruling lines crossing the box are not leftovers
            if ink.shape[1] > 8:
                ink[ink.mean(axis=1) > 0.8, :] = 0
            if ink.shape[0] > 8:
                ink[:, ink.mean(axis=0) > 0.8] = 0
            if ink.sum() < 3:
                continue
            n, _, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
            for i in range(1, n):
                cx, cy, cw, ch, area = stats[i]
                if area < 2:
                    continue
                comp = ((x0 + cx) / sc, (y0 + cy) / sc, (x0 + cx + cw) / sc, (y0 + cy + ch) / sc)
                # only remains of this line's glyphs: mostly inside its box
                # (an icon or a neighbour's glyph just outside is left alone)
                if box_overlap_area(comp, ln.bbox) < 0.5 * max(box_w(comp) * box_h(comp), 1e-6):
                    continue
                r = (
                    (x0 + cx) / sc - 0.4,
                    (y0 + cy) / sc - 0.4,
                    (x0 + cx + cw) / sc + 0.4,
                    (y0 + cy + ch) / sc + 0.4,
                )
                page.draw_rect(pymupdf.Rect(r), color=None, fill=tuple(float(v) for v in bgc), overlay=True)
                painted += 1
    return painted


def draw(page: pymupdf.Page, p: Placement, fonts: FontSet) -> Box:
    """Draw one placement; returns the rectangle actually covered by text."""
    seg = p.seg
    text = seg.translation or ""
    rotated = seg.rotate in (90, 270)
    area = p.rect
    W = box_h(area) if rotated else box_w(area)
    H = box_w(area) if rotated else box_h(area)
    ch = min(p.content_h if p.fits else H, H)
    # measure again at the final size (harmonise may have changed it)
    ch, cw = measure(fonts, seg, text, p.size, W)
    ch = min(ch, H)
    if rotated:
        # text runs bottom-to-top, "height" is the horizontal extent
        off = (H - ch) / 2
        rect = (area[0] + off, area[1], area[0] + off + ch, area[3])
    elif seg.valign == "middle":
        off = (H - ch) / 2
        rect = (area[0], area[1] + off, area[2], area[1] + off + ch)
    else:
        rect = (area[0], area[1], area[2], area[1] + ch)
    r = pymupdf.Rect(rect)
    # tiny tolerance so rounding never drops the last line
    r.y1 += 0.02 * p.size if not rotated else 0
    if rotated:
        r.x1 += 0.02 * p.size
    spare, scale = page.insert_htmlbox(
        r,
        _html(text),
        css=_css(fonts, seg, p.size),
        archive=fonts.archive,
        rotate=90 if seg.rotate == 90 else (270 if seg.rotate == 270 else 0),
        scale_low=0,
    )
    if scale < 0.999:
        p.size *= scale
        p.fits = False
    return tuple(r)


def text_extent(rect: Box, seg: Segment) -> Box:
    return rect
