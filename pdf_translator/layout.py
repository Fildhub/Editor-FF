"""Turn raw text lines into translatable segments and find where each
translation may be placed without touching anything else on the page."""

from __future__ import annotations

import re
from typing import Optional

from .extract import PageLayout
from .langs import CJK_RE, join_lines, needs_translation
from .models import Box, Char, Line, Segment, box_h, box_union, box_w
from .raster import CellFinder

# Things that start a new paragraph / list item.
BULLET_RE = re.compile(
    r"^\s*("
    r"[·•・●○◆◇■□▪▶►※*＊]"
    r"|[①-⑳❶-❿]"  # ① .. ⑳, ❶ ..
    r"|\(?\d{1,2}[.)、．]\s*\D"
    r"|[（(][0-9一二三四五六七八九十]{1,3}[)）]"
    r"|[一二三四五六七八九十]{1,3}、"
    r"|第[一二三四五六七八九十0-9]+[章节条]"
    r"|<|＜|〈|《"
    r")"
)

LINE_PAD = 0.9  # keep this far from ruling lines / pictures (pt)
TEXT_PAD = 1.0  # and from other text


# ---------------------------------------------------------------- helpers

def _y_overlap(a: Box, b: Box) -> float:
    return min(a[3], b[3]) - max(a[1], b[1])


def _x_overlap(a: Box, b: Box) -> float:
    return min(a[2], b[2]) - max(a[0], b[0])


def _line_between_x(a: Box, b: Box, vlines: list[Box]) -> bool:
    """Is there a vertical rule between a (left) and b (right)?"""
    lo, hi = a[2] - 1.0, b[0] + 1.0
    y0, y1 = max(a[1], b[1]), min(a[3], b[3])
    mid = (y0 + y1) / 2
    for v in vlines:
        cx = (v[0] + v[2]) / 2
        if lo <= cx <= hi and v[1] <= mid <= v[3]:
            return True
    return False


def _line_between_y(a: Box, b: Box, hlines: list[Box]) -> bool:
    """Is there a horizontal rule between a (above) and b (below)?"""
    lo, hi = a[3] - 1.0, b[1] + 1.0
    x0, x1 = max(a[0], b[0]), min(a[2], b[2])
    if x1 <= x0:
        x0 = x1 = (a[0] + a[2] + b[0] + b[2]) / 4
    for h in hlines:
        cy = (h[1] + h[3]) / 2
        if lo <= cy <= hi and h[0] <= x1 and h[2] >= x0:
            return True
    return False


def _merge_lines(parts: list[Line], vertical: bool = False) -> Line:
    parts_sorted = sorted(parts, key=(lambda l: l.bbox[1]) if vertical else (lambda l: l.bbox[0]))
    text = ""
    for p in parts_sorted:
        if not text:
            text = p.text
        elif CJK_RE.search(text[-1]) or CJK_RE.search(p.text[0]) or vertical:
            text += p.text
        else:
            text += " " + p.text
    weights = [len(p.text) for p in parts_sorted]
    main = parts_sorted[weights.index(max(weights))]
    size = main.size
    bbox = box_union([p.bbox for p in parts_sorted])
    if vertical:
        size = box_w(bbox) / 0.86
    return Line(
        bbox=bbox,
        text=text,
        size=size,
        color=main.color,
        bold=sum(p.bold * len(p.text) for p in parts_sorted) * 2 > sum(weights),
        italic=main.italic,
        serif=main.serif,
        font=main.font,
        rotate=main.rotate,
        vertical=vertical or main.vertical,
        chars=[c for p in parts_sorted for c in p.chars],
        background=main.background,
        source=main.source,
    )


def merge_rows(lines: list[Line], vlines: list[Box]) -> list[Line]:
    """Join pieces that sit side by side on the same text line."""
    todo = sorted(lines, key=lambda l: l.bbox[0])
    rows: list[list[Line]] = []
    for ln in todo:
        if ln.vertical or ln.rotate != 0:
            rows.append([ln])
            continue
        placed = False
        for row in rows:
            last = row[-1]
            if last.vertical or last.rotate != 0 or last.source != ln.source:
                continue
            h = min(box_h(last.bbox), box_h(ln.bbox))
            if _y_overlap(last.bbox, ln.bbox) < 0.6 * h:
                continue
            size = max(last.size, ln.size)
            if max(last.size, ln.size) / max(0.1, min(last.size, ln.size)) > 1.4:
                continue
            gap = ln.bbox[0] - last.bbox[2]
            if not (-0.5 * size <= gap <= 1.2 * size):
                continue
            if _line_between_x(last.bbox, ln.bbox, vlines):
                continue
            row.append(ln)
            placed = True
            break
        if not placed:
            rows.append([ln])
    return [r[0] if len(r) == 1 else _merge_lines(r) for r in rows]


def merge_vertical_stacks(lines: list[Line], hlines: list[Box]) -> list[Line]:
    """CJK written top-to-bottom one glyph per row, e.g. 基/本/规/格 in a table."""
    singles = [l for l in lines if len(l.text) == 1 and CJK_RE.match(l.text)]
    others = [l for l in lines if not (len(l.text) == 1 and CJK_RE.match(l.text))]
    singles.sort(key=lambda l: (l.bbox[1] + l.bbox[3]) / 2)
    stacks: list[list[Line]] = []
    for ln in singles:
        cx = (ln.bbox[0] + ln.bbox[2]) / 2
        cy = (ln.bbox[1] + ln.bbox[3]) / 2
        w = box_w(ln.bbox)
        for st in stacks:
            last = st[-1]
            lcx = (last.bbox[0] + last.bbox[2]) / 2
            lcy = (last.bbox[1] + last.bbox[3]) / 2
            wm = max(w, box_w(last.bbox))
            if abs(lcx - cx) > 0.45 * wm:
                continue
            pitch = cy - lcy
            if 0.5 * wm <= pitch <= 2.6 * wm and not _line_between_y(last.bbox, ln.bbox, hlines):
                st.append(ln)
                break
        else:
            stacks.append([ln])
    out = list(others)
    for st in stacks:
        out.append(st[0] if len(st) == 1 else _merge_lines(st, vertical=True))
    return out


def split_labels(lines: list[Line]) -> list[Line]:
    """Split "标签：VALUE" so only the label is translated.

    The value (a code, date, version...) keeps its original glyphs and
    position; the translated label must fit in front of it, like in a form.
    """
    out: list[Line] = []
    for ln in lines:
        if ln.vertical or ln.rotate or len(ln.chars) < 3:
            out.append(ln)
            continue
        idx = next((i for i, c in enumerate(ln.chars) if c.text in "：:"), None)
        if idx is None or idx == 0 or idx >= len(ln.chars) - 1:
            out.append(ln)
            continue
        left = "".join(c.text for c in ln.chars[: idx + 1])
        right = "".join(c.text for c in ln.chars[idx + 1 :]).strip()
        if not CJK_RE.search(left) or CJK_RE.search(right) or len(right) < 2:
            out.append(ln)
            continue
        lx1 = ln.chars[idx].bbox[2]
        rx0 = ln.chars[idx + 1].bbox[0]
        if rx0 <= ln.bbox[0] or lx1 >= ln.bbox[2]:
            out.append(ln)
            continue
        b = ln.bbox
        for text, chars, box in (
            (left, ln.chars[: idx + 1], (b[0], b[1], min(lx1, b[2]), b[3])),
            (right, ln.chars[idx + 1 :], (max(rx0, b[0]), b[1], b[2], b[3])),
        ):
            out.append(
                Line(
                    bbox=box,
                    text=text,
                    size=ln.size,
                    color=ln.color,
                    bold=ln.bold,
                    italic=ln.italic,
                    serif=ln.serif,
                    font=ln.font,
                    chars=list(chars),
                    background=ln.background,
                    source=ln.source,
                )
            )
    return out


def snap_sizes(lines: list[Line], tolerance: float = 0.07) -> None:
    """Snap noisy (OCR) size estimates to the few sizes the page really uses.

    Designers use a handful of font sizes; estimates from pixels scatter
    around them. Sizes within ~7% of each other are clustered and replaced
    by the cluster's length-weighted median, so a table column comes out in
    one consistent size.
    """
    est = [l for l in lines if l.source == "ocr" and not l.vertical]
    if len(est) < 4:
        return
    est.sort(key=lambda l: l.size)
    clusters: list[list[Line]] = [[est[0]]]
    for ln in est[1:]:
        cur = clusters[-1]
        base = _weighted_median(cur)
        if ln.size <= base * (1 + tolerance):
            cur.append(ln)
        else:
            clusters.append([ln])
    for cl in clusters:
        m = _weighted_median(cl)
        for ln in cl:
            ln.size = m


def _weighted_median(lines: list[Line]) -> float:
    items = sorted((l.size, max(1, len(l.text))) for l in lines)
    total = sum(w for _, w in items)
    acc = 0
    for size, w in items:
        acc += w
        if acc * 2 >= total:
            return size
    return items[-1][0]


# ------------------------------------------------------------- free space

class Obstacles:
    def __init__(self, layout: PageLayout, segments: list[Segment], extra: Optional[list[Box]] = None):
        self.hlines = list(layout.hlines)
        self.vlines = list(layout.vlines)
        self.fixed: list[Box] = self.hlines + self.vlines + list(layout.pictures) + list(extra or [])
        self.segments = segments
        allboxes = self.fixed + [s.bbox for s in segments]
        x0, y0, x1, y1 = layout.rect
        if allboxes:
            cb = box_union(allboxes)
            # Stay inside the printed area (keeps the page margins intact).
            self.bounds = (max(x0 + 2, cb[0]), max(y0 + 2, cb[1]), min(x1 - 2, cb[2]), min(y1 - 2, cb[3]))
        else:
            self.bounds = (x0 + 2, y0 + 2, x1 - 2, y1 - 2)

    def items(self, seg: Segment):
        for b in self.fixed:
            yield b, LINE_PAD, False, False
        for s in self.segments:
            if s is seg:
                continue
            yield s.bbox, TEXT_PAD, s.translate, True


def _inside_pt(p: tuple[float, float], b: Box) -> bool:
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def free_container(seg: Segment, obs: Obstacles) -> tuple[Box, dict]:
    """Largest rectangle around the segment that touches nothing else.

    Horizontal room is found first (to the nearest rule / text on the same
    rows), then vertical room across that whole width. When the neighbour is
    another translated text the gap is shared half-and-half so the two
    translations can never collide.
    """
    x0, y0, x1, y1 = seg.bbox
    h = y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bx0, by0, bx1, by1 = obs.bounds
    left, right = min(bx0, x0), max(bx1, x1)
    hit = {"left": "page", "right": "page", "top": "page", "bottom": "page"}

    def overlaps_self(b: Box) -> bool:
        return _x_overlap(b, seg.bbox) > 0.5 and _y_overlap(b, seg.bbox) > 0.5

    for b, pad, shared, is_text in obs.items(seg):
        if overlaps_self(b) and not is_text:
            continue  # a frame or shading that contains the text
        if not (b[1] < y1 - 0.15 * h and b[3] > y0 + 0.15 * h):
            continue
        bcx = (b[0] + b[2]) / 2
        if is_text and overlaps_self(b) and abs(bcx - cx) < 0.5 * (x1 - x0):
            continue  # overlapping text on the same row: handled vertically
        if is_text and seg.cell is not None and not _inside_pt(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), seg.cell):
            continue  # beyond our cell's edge: the edge is the boundary
        if is_text and not overlaps_self(b):
            # a table border between us is the real boundary
            a_, b_ = (seg.bbox, b) if bcx > cx else (b, seg.bbox)
            if _line_between_x(a_, b_, obs.vlines):
                continue
        if b[0] >= x1 - 0.5 or (is_text and bcx > cx and b[0] > x0):
            lim = (x1 + b[0]) / 2 if shared else b[0] - pad
            if lim < right:
                right, hit["right"] = lim, ("text" if is_text else "line")
        elif b[2] <= x0 + 0.5 or (is_text and bcx < cx and b[2] < x1):
            lim = (x0 + b[2]) / 2 if shared else b[2] + pad
            if lim > left:
                left, hit["left"] = lim, ("text" if is_text else "line")
    top, bottom = min(by0, y0), max(by1, y1)
    for b, pad, shared, is_text in obs.items(seg):
        if overlaps_self(b) and not is_text:
            continue
        if not (b[0] < right - 0.3 and b[2] > left + 0.3):
            continue
        bcy = (b[1] + b[3]) / 2
        if is_text and seg.cell is not None and not _inside_pt(((b[0] + b[2]) / 2, bcy), seg.cell):
            continue
        if is_text and not overlaps_self(b):
            a_, b_ = (seg.bbox, b) if bcy > cy else (b, seg.bbox)
            if _line_between_y(a_, b_, obs.hlines):
                continue
        if b[1] >= y1 - 0.3 * h or (is_text and bcy > cy and b[1] > y0):
            lim = (y1 + b[1]) / 2 if (shared or is_text and b[1] < y1) else b[1] - pad
            if lim < bottom:
                bottom, hit["bottom"] = lim, ("text" if is_text else "line")
        elif b[3] <= y0 + 0.3 * h or (is_text and bcy < cy and b[3] < y1):
            lim = (y0 + b[3]) / 2 if (shared or is_text and b[3] > y0) else b[3] + pad
            if lim > top:
                top, hit["top"] = lim, ("text" if is_text else "line")
    if seg.cell is not None:
        c = seg.cell
        # stay inside a shaded cell / bar (its edges are not ruling lines)
        if c[0] > left and c[0] <= x0 + 0.5:
            left, hit["left"] = c[0] + 0.6, "line"
        if c[2] < right and c[2] >= x1 - 0.5:
            right, hit["right"] = c[2] - 0.6, "line"
        if c[1] > top and c[1] <= y0 + 0.5:
            top, hit["top"] = c[1] + 0.4, "line"
        if c[3] < bottom and c[3] >= y1 - 0.5:
            bottom, hit["bottom"] = c[3] - 0.4, "line"
    return (left, top, right, bottom), hit


# ------------------------------------------------------------- paragraphs

def _right_room(ln: Line, lines: list[Line], layout: PageLayout) -> float:
    """Free space to the right of a line (used to detect wrapped lines)."""
    x1 = ln.bbox[2]
    limit = layout.rect[2] - 2
    for b in layout.vlines + layout.pictures + [o.bbox for o in lines if o is not ln]:
        if b[0] >= x1 - 0.5 and _y_overlap(b, ln.bbox) > 0.3 * box_h(ln.bbox):
            limit = min(limit, b[0])
    return limit - x1


def group_paragraphs(lines: list[Line], layout: PageLayout) -> list[list[Line]]:
    order = sorted(lines, key=lambda l: (round(l.bbox[1], 1), l.bbox[0]))
    groups: list[list[Line]] = []
    tail_of: dict[int, int] = {}  # id(line) -> group index, only for group tails
    room = {id(l): _right_room(l, lines, layout) for l in order}
    content_right = max((l.bbox[2] for l in order), default=0)
    for ln in order:
        best = None
        if not ln.vertical and ln.rotate == 0 and not BULLET_RE.match(ln.text):
            for prev in order:
                gi = tail_of.get(id(prev))
                if gi is None or prev is ln or prev.vertical or prev.rotate != 0:
                    continue
                if prev.text.rstrip()[-1:] in ("：", ":"):
                    continue  # a form label ("版本号：") never runs on
                size = max(prev.size, ln.size)
                gap = ln.bbox[1] - prev.bbox[3]
                if not (-0.2 * size <= gap <= 0.7 * size):
                    continue
                if max(prev.size, ln.size) / max(0.1, min(prev.size, ln.size)) > 1.25:
                    continue
                if prev.bold != ln.bold:
                    continue
                if _x_overlap(prev.bbox, ln.bbox) <= 0:
                    continue
                first = groups[gi][0]
                dx = ln.bbox[0] - first.bbox[0] if len(groups[gi]) == 1 else ln.bbox[0] - groups[gi][1].bbox[0]
                hanging = len(groups[gi]) == 1 and BULLET_RE.match(first.text) and 0 < dx <= 3 * size
                indent = len(groups[gi]) == 1 and -3 * size <= dx < 0  # first-line indent
                if not (abs(dx) <= 1.2 * size or hanging or indent):
                    continue
                # the previous line must be "full" (it wrapped)
                if room[id(prev)] > 2.6 * size and content_right - prev.bbox[2] > 2.6 * size:
                    continue
                if _line_between_y(prev.bbox, ln.bbox, layout.hlines):
                    continue
                if best is None or gap < best[1]:
                    best = (gi, gap, prev)
        if best is not None:
            gi, _, prev = best
            del tail_of[id(prev)]
            groups[gi].append(ln)
            tail_of[id(ln)] = gi
        else:
            groups.append([ln])
            tail_of[id(ln)] = len(groups) - 1
    return groups


def _align(lines: list[Line], container: Box, cell: Optional[Box] = None) -> str:
    if len(lines) > 1:
        x0s = [l.bbox[0] for l in lines]
        x1s = [l.bbox[2] for l in lines]
        size = max(l.size for l in lines)
        if max(x0s) - min(x0s) <= 1.2 * size:
            full = [x for x in x1s[:-1]]
            if full and max(full) - min(full) <= 1.0 * size:
                return "justify"
            return "left"
        cs = [(a + b) / 2 for a, b in zip(x0s, x1s)]
        if max(cs) - min(cs) <= 1.2 * size:
            return "center"
        return "left"
    b = lines[0].bbox
    size = lines[0].size
    ref = container
    if cell is not None and cell[0] <= b[0] + 0.5 and cell[2] >= b[2] - 0.5 and box_w(cell) < box_w(container) * 1.5:
        ref = cell
    lg, rg = b[0] - ref[0], ref[2] - b[2]
    cw = box_w(ref)
    if lg > 1.2 * size and abs(lg - rg) <= max(0.12 * cw, 1.5 * size):
        return "center"
    if rg < 0.8 * size and lg > 3 * size:
        return "right"
    return "left"


def build_segments(layout: PageLayout, source_lang: str, translate_all: bool = False) -> list[Segment]:
    lines = merge_rows(layout.lines, layout.vlines)
    lines = merge_vertical_stacks(lines, layout.hlines)
    lines = split_labels(lines)
    snap_sizes(lines)
    groups = group_paragraphs(lines, layout)
    segments: list[Segment] = []
    for n, grp in enumerate(groups):
        grp.sort(key=lambda l: l.bbox[1] if not l.vertical else l.bbox[0])
        text = grp[0].text if len(grp) == 1 else join_lines([l.text for l in grp])
        bbox = box_union([l.bbox for l in grp])
        weights = [max(1, len(l.text)) for l in grp]
        main = grp[weights.index(max(weights))]
        sizes = sorted(l.size for l in grp)
        size = sizes[len(sizes) // 2]
        seg = Segment(
            id=f"p{layout.page_no + 1}-{n + 1}",
            page=layout.page_no,
            lines=grp,
            text=text,
            bbox=bbox,
            size=size,
            color=main.color,
            bold=main.bold,
            italic=main.italic,
            serif=main.serif,
            align="left",
            rotate=90 if main.vertical else main.rotate,
            vertical=main.vertical,
            translate=translate_all or needs_translation(text, source_lang),
            source=main.source,
        )
        segments.append(seg)
    segments.sort(key=lambda s: (s.bbox[1], s.bbox[0]))
    for i, s in enumerate(segments):
        s.id = f"p{layout.page_no + 1}-{i + 1}"
    obs = Obstacles(layout, segments)
    finder = CellFinder(layout.image, [(l.bbox, l.background) for s in segments for l in s.lines])
    page_area = box_w(layout.rect) * box_h(layout.rect)
    for seg in segments:
        if not seg.translate:
            continue
        cell = finder.cell(seg.bbox)
        # a "cell" covering most of the page is just open paper
        seg.cell = cell if cell and box_w(cell) * box_h(cell) < 0.25 * page_area else None
        container, hit = free_container(seg, obs)
        seg.container = container
        seg.align = "center" if seg.vertical else _align(seg.lines, container, seg.cell)
        seg.char_budget = char_budget(seg)
        seg.valign = _valign(seg, container, hit)
    return segments


def _valign(seg: Segment, c: Box, hit: dict) -> str:
    b = seg.bbox
    if seg.vertical or seg.rotate in (90, 270):
        return "middle"
    top_gap, bot_gap = b[1] - c[1], c[3] - b[3]
    ch = box_h(c)
    if hit["top"] == "line" and hit["bottom"] == "line" and abs(top_gap - bot_gap) <= max(0.35 * ch, 0.8 * seg.size):
        return "middle"
    return "top"


def char_budget(seg: Segment) -> int:
    """Rough number of Latin characters that fit at the original size."""
    c = seg.container or seg.bbox
    w, h = box_w(c), box_h(c)
    if seg.vertical or seg.rotate in (90, 270):
        w, h = h, w
    size = max(seg.size, 1.0)
    lines = max(1, int(h / (size * 1.18)))
    per_line = max(4, int(w / (size * 0.5)))
    return lines * per_line
