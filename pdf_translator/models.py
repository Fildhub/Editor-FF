"""Data structures shared by extraction, layout, translation and rendering."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

Box = tuple[float, float, float, float]  # x0, y0, x1, y1 in PDF points


def box_union(boxes: list[Box]) -> Box:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def box_w(b: Box) -> float:
    return b[2] - b[0]


def box_h(b: Box) -> float:
    return b[3] - b[1]


def box_area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def box_intersect(a: Box, b: Box) -> Box:
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def box_overlap_area(a: Box, b: Box) -> float:
    i = box_intersect(a, b)
    if i[2] <= i[0] or i[3] <= i[1]:
        return 0.0
    return (i[2] - i[0]) * (i[3] - i[1])


def box_pad(b: Box, dx: float, dy: Optional[float] = None) -> Box:
    dy = dx if dy is None else dy
    return (b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy)


@dataclass
class Char:
    text: str
    bbox: Box


@dataclass
class Line:
    """One visual line of text as found on the page."""

    bbox: Box
    text: str
    size: float  # font size in points
    color: tuple[float, float, float] = (0.0, 0.0, 0.0)
    bold: bool = False
    italic: bool = False
    serif: bool = False
    font: str = ""
    rotate: int = 0  # 0, 90, 180, 270 - direction of the text baseline
    vertical: bool = False  # CJK stacked vertical writing (one glyph per row)
    chars: list[Char] = field(default_factory=list)
    background: Optional[tuple[float, float, float]] = None
    source: str = "text"  # "text" (real PDF text) or "ocr"


@dataclass
class Segment:
    """A translatable unit: a paragraph, a heading or a table cell."""

    id: str
    page: int
    lines: list[Line]
    text: str
    bbox: Box
    size: float
    color: tuple[float, float, float]
    bold: bool
    italic: bool
    serif: bool
    align: str  # left | center | right | justify
    rotate: int = 0
    vertical: bool = False
    translate: bool = True
    source: str = "text"
    # Layout results
    cell: Optional[Box] = None  # shaded/ruled cell around the text, if any
    container: Optional[Box] = None  # free area the translation may occupy
    valign: str = "top"  # top | middle - vertical placement inside container
    char_budget: Optional[int] = None  # rough capacity hint for translators
    translation: Optional[str] = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "page": self.page + 1,
            "source": self.text,
            "translation": self.translation,
            "translate": self.translate,
            "char_budget": self.char_budget,
            "bbox": [round(v, 2) for v in self.bbox],
        }
