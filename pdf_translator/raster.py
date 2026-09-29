"""Page rasterisation and pixel-level analysis.

Everything here works on what the page *looks like*, so it behaves the same
for real text, text converted to vector outlines, and scanned images.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
import pymupdf

from .models import Box

INK_DELTA = 60  # min difference from the local background to count as ink


@dataclass
class PageImage:
    rgb: np.ndarray  # H x W x 3, uint8
    scale: float  # pixels per point
    ink: np.ndarray  # H x W bool, pixels that differ from white paper
    line_mask: np.ndarray | None = None  # ruling lines found by detect_lines()

    @property
    def height(self) -> int:
        return self.rgb.shape[0]

    @property
    def width(self) -> int:
        return self.rgb.shape[1]

    def to_px(self, b: Box) -> tuple[int, int, int, int]:
        s = self.scale
        x0 = max(0, int(np.floor(b[0] * s)))
        y0 = max(0, int(np.floor(b[1] * s)))
        x1 = min(self.width, int(np.ceil(b[2] * s)))
        y1 = min(self.height, int(np.ceil(b[3] * s)))
        return x0, y0, x1, y1

    def to_pt(self, x0: float, y0: float, x1: float, y1: float) -> Box:
        s = self.scale
        return (x0 / s, y0 / s, x1 / s, y1 / s)


def render_page(page: pymupdf.Page, dpi: int, max_pixels: int = 60_000_000) -> PageImage:
    area_in = (page.rect.width / 72.0) * (page.rect.height / 72.0)
    if area_in * dpi * dpi > max_pixels:
        dpi = int((max_pixels / area_in) ** 0.5)
    pix = page.get_pixmap(dpi=dpi, alpha=False, colorspace=pymupdf.csRGB)
    rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3].copy()
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink = gray < (255 - INK_DELTA)
    return PageImage(rgb=rgb, scale=dpi / 72.0, ink=ink)


@dataclass
class InkInfo:
    bbox: Box  # tight bounding box of the glyph ink, in points
    color: tuple[float, float, float]
    background: tuple[float, float, float]
    stroke: float  # estimated stroke width / ink height


def _background(region: np.ndarray, exclude: np.ndarray | None) -> np.ndarray:
    """Dominant colour of a region (the paper / cell shading behind text)."""
    px = region.reshape(-1, 3)
    if exclude is not None:
        keep = ~exclude.reshape(-1)
        if keep.sum() > 10:
            px = px[keep]
    q = (px // 16).astype(np.int32)
    codes = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    vals, counts = np.unique(codes, return_counts=True)
    mode = vals[counts.argmax()]
    return np.median(px[codes == mode], axis=0)


def analyse_ink(img: PageImage, box: Box, pad_pt: float = 0.6, xlim: tuple[float, float] | None = None) -> InkInfo | None:
    """Tight ink box, text colour, background colour and stroke weight.

    *xlim* restricts the horizontal search range (e.g. to the recognised
    characters, so an icon in front of a word is not taken as text).
    """
    x0, y0, x1, y1 = img.to_px((box[0] - pad_pt, box[1] - pad_pt, box[2] + pad_pt, box[3] + pad_pt))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    region = img.rgb[y0:y1, x0:x1].astype(np.int16)
    lines = img.line_mask[y0:y1, x0:x1] if img.line_mask is not None else None
    bg = _background(region, lines)
    diff = np.abs(region - bg).max(axis=2)
    mask = diff > INK_DELTA
    if lines is not None:
        mask &= ~lines
    if xlim is not None:
        lx0 = int(xlim[0] * img.scale) - x0
        lx1 = int(np.ceil(xlim[1] * img.scale)) - x0
        if lx0 > 0:
            mask[:, : min(lx0, mask.shape[1])] = False
        if lx1 < mask.shape[1]:
            mask[:, max(lx1, 0) :] = False
    h, w = mask.shape
    # Rows / columns that are almost completely inked are ruling lines.
    if w > 8:
        mask[mask.mean(axis=1) > 0.85, :] = False
    if h > 8:
        mask[:, mask.mean(axis=0) > 0.85] = False
    mask = _main_band(mask)
    ys, xs = np.nonzero(mask)
    if len(xs) < 3:
        return None
    bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    d = diff[mask]
    thr = np.percentile(d, 85)
    ink_px = region[mask][d >= thr]
    color = np.median(ink_px, axis=0) if len(ink_px) else np.array([0, 0, 0])
    sub = mask[by0:by1, bx0:bx1].astype(np.uint8)
    dist = cv2.distanceTransform(sub, cv2.DIST_L2, 3)
    vals = dist[dist > 0]
    stroke_px = 2.0 * float(np.percentile(vals, 90)) if len(vals) else 1.0
    ink_h = max(1, by1 - by0)
    return InkInfo(
        bbox=img.to_pt(x0 + bx0, y0 + by0, x0 + bx1, y0 + by1),
        color=tuple(float(c) / 255.0 for c in color),
        background=tuple(float(c) / 255.0 for c in bg),
        stroke=stroke_px / ink_h,
    )


def _main_band(mask: np.ndarray) -> np.ndarray:
    """Keep the dominant horizontal band of ink rows.

    OCR boxes are padded, so they may catch the top of the line below or the
    bottom of the line above; those slivers must not inflate the text box.
    """
    rows = mask.sum(axis=1)
    h = len(rows)
    if h < 6 or rows.sum() == 0:
        return mask
    max_gap = max(1, int(h * 0.2))
    runs = []  # (start, end, ink)
    start, last, gap = None, None, 0
    for i, v in enumerate(rows):
        if v > 0:
            if start is None:
                start = i
            last, gap = i, 0
        elif start is not None:
            gap += 1
            if gap > max_gap:
                runs.append((start, last + 1, int(rows[start : last + 1].sum())))
                start, gap = None, 0
    if start is not None:
        runs.append((start, last + 1, int(rows[start : last + 1].sum())))
    if len(runs) <= 1:
        return mask
    best = max(runs, key=lambda r: r[2])
    out = np.zeros_like(mask)
    out[best[0] : best[1]] = mask[best[0] : best[1]]
    return out


@dataclass
class Graphics:
    """Non-text page structure used as obstacles when laying out text."""

    hlines: list[Box]
    vlines: list[Box]
    pictures: list[Box]

    def all(self) -> list[Box]:
        return self.hlines + self.vlines + self.pictures


def detect_lines(img: PageImage, min_line_pt: float = 9.0) -> tuple[list[Box], list[Box]]:
    """Find ruling lines (table borders, separators). Stores img.line_mask."""
    ink = img.ink.astype(np.uint8) * 255
    s = img.scale
    k = max(15, int(min_line_pt * s))
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k)))
    max_thick = max(2, int(2.0 * s))  # thicker than 2pt: a filled area, not a line

    def components(mask: np.ndarray, horizontal: bool) -> list[Box]:
        out = []
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for i in range(1, n):
            x, y, w, h, _ = stats[i]
            thick = h if horizontal else w
            if thick <= max_thick:
                out.append(img.to_pt(x, y, x + w, y + h))
            else:
                mask[labels == i] = 0
        return out

    hlines = components(horiz, True)
    vlines = components(vert, False)
    img.line_mask = (horiz > 0) | (vert > 0)
    return hlines, vlines


def detect_pictures(img: PageImage, text_boxes: list[Box]) -> list[Box]:
    """Ink that is neither text nor a ruling line: photos, drawings, icons."""
    rest = img.ink.astype(np.uint8) * 255
    if img.line_mask is not None:
        rest[img.line_mask] = 0
    for b in text_boxes:
        x0, y0, x1, y1 = img.to_px((b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1))
        rest[y0:y1, x0:x1] = 0
    rest = cv2.dilate(rest, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    pictures = []
    n, _, stats, _ = cv2.connectedComponentsWithStats(rest, connectivity=8)
    min_side = 3.0 * img.scale
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        # icons, photos - and short rules / dashes (thin but long)
        if max(w, h) >= min_side and min(w, h) >= 4 and area > 30:
            pictures.append(img.to_pt(x + 2, y + 2, x + w - 2, y + h - 2))
    return pictures


def set_line_mask(img: PageImage, lines: list[Box]) -> None:
    """Rebuild img.line_mask from a (filtered) list of ruling-line boxes."""
    mask = np.zeros(img.ink.shape, dtype=bool)
    for b in lines:
        x0, y0, x1, y1 = img.to_px((b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3))
        mask[y0:y1, x0:x1] = True
    img.line_mask = mask & img.ink


class CellFinder:
    """Find the shaded or ruled cell around a piece of text by flood-filling
    its background colour (text glyphs are painted out first)."""

    def __init__(self, img: PageImage, texts: list[tuple[Box, tuple | None]], dpi: int = 100):
        """*texts*: (box, background colour 0..1 or None) of every text."""
        s = dpi / 72.0
        self.s = s
        h = max(1, int(round(img.height * s / img.scale)))
        w = max(1, int(round(img.width * s / img.scale)))
        small = cv2.resize(img.rgb, (w, h), interpolation=cv2.INTER_AREA)
        # paint text out with the colour behind it (measured at full
        # resolution), so the fill can flow through the glyphs
        for b, bg in texts:
            x0, y0 = max(0, int(b[0] * s) - 1), max(0, int(b[1] * s) - 1)
            x1, y1 = min(w, int(np.ceil(b[2] * s)) + 1), min(h, int(np.ceil(b[3] * s)) + 1)
            if x1 - x0 < 1 or y1 - y0 < 1:
                continue
            if bg is not None:
                small[y0:y1, x0:x1] = np.array(bg) * 255
            else:
                ring = np.concatenate(
                    [
                        small[max(0, y0 - 1), x0:x1],
                        small[min(h - 1, y1), x0:x1],
                        small[y0:y1, max(0, x0 - 1)],
                        small[y0:y1, min(w - 1, x1)],
                    ]
                )
                small[y0:y1, x0:x1] = np.median(ring, axis=0) if len(ring) else 255
        self.small = small
        self.w, self.h = w, h

    def cell(self, box: Box, tol: int = 14) -> Box | None:
        s = self.s
        cx = int((box[0] + box[2]) / 2 * s)
        cy = int((box[1] + box[3]) / 2 * s)
        if not (0 <= cx < self.w and 0 <= cy < self.h):
            return None
        img = self.small.copy()
        mask = np.zeros((self.h + 2, self.w + 2), np.uint8)
        flags = 4 | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
        _, _, _, rect = cv2.floodFill(img, mask, (cx, cy), (0, 0, 0), (tol,) * 3, (tol,) * 3, flags)
        x, y, w, h = rect
        return (x / s, y / s, (x + w) / s, (y + h) / s)
