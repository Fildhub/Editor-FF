"""End-to-end: analyse pages -> translate -> typeset -> verify."""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import pymupdf

from .extract import OcrCache, PageLayout, analyse_page
from .layout import build_segments
from .models import Box, Segment, box_overlap_area
from .render import FontSet, Placement, cover_leftovers, draw, erase_page, fit, harmonise
from .translators import Context, Item, TranslationCache, get_translator, load_glossary, make_batches


def default_cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(base) / "pdf-translator"


@dataclass
class Options:
    source_lang: str = "zh"
    target_lang: str = "en"
    engine: str = "google"
    pages: Optional[str] = None  # "1-3,5"
    ocr: str = "auto"  # auto | always | never
    dpi: int = 300
    glossary: Optional[str] = None
    translations: Optional[str] = None  # JSON file for --engine file
    font: Optional[str] = None
    serif: bool = False
    bilingual: bool = False
    export_json: Optional[str] = None
    report: Optional[str] = None
    cache_dir: Optional[Path] = field(default_factory=default_cache_dir)
    workers: int = 4
    translate_all: bool = False


@dataclass
class Issue:
    page: int
    segment: str
    kind: str
    detail: str


@dataclass
class Report:
    pages: int = 0
    segments: int = 0
    translated: int = 0
    kept: int = 0
    shrunk: int = 0
    issues: list[Issue] = field(default_factory=list)
    seconds: float = 0.0

    def summary(self) -> str:
        kinds = Counter(i.kind for i in self.issues)
        lines = [
            f"pages: {self.pages}, text segments: {self.segments}, translated: {self.translated}, "
            f"left as is (numbers/codes/untranslated): {self.kept}",
            f"segments set in a smaller font to fit: {self.shrunk}",
            f"layout problems: {len(self.issues)}" + (f" ({dict(kinds)})" if kinds else " - none"),
            f"time: {self.seconds:.1f} s",
        ]
        return "\n".join(lines)


def parse_pages(spec: Optional[str], n: int) -> list[int]:
    if not spec:
        return list(range(n))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lo = int(a) if a else 1
            hi = int(b) if b else n
            out.extend(range(lo - 1, min(hi, n)))
        else:
            out.append(int(part) - 1)
    return sorted({p for p in out if 0 <= p < n})


# ------------------------------------------------------------------ steps

def analyse(doc: pymupdf.Document, pages: list[int], opts: Options, log) -> dict[int, tuple[PageLayout, list[Segment]]]:
    cache = OcrCache(opts.cache_dir / "ocr") if opts.cache_dir else None
    result = {}
    for pno in pages:
        page = doc[pno]
        layout = analyse_page(page, ocr=opts.ocr, dpi=opts.dpi, cache=cache, log=log)
        segs = build_segments(layout, opts.source_lang, opts.translate_all)
        n_tr = sum(s.translate for s in segs)
        log(f"  page {pno + 1}: {len(segs)} text blocks, {n_tr} to translate" + (" (OCR)" if layout.ocr_used else ""))
        result[pno] = (layout, segs)
    return result


def translate_segments(all_segs: list[Segment], opts: Options, log) -> None:
    todo = [s for s in all_segs if s.translate]
    if not todo:
        return
    translator = get_translator(opts.engine, path=opts.translations)
    glossary = load_glossary(opts.glossary)
    hint = " / ".join(s.text for s in all_segs[:40])[:1500]
    ctx = Context(opts.source_lang, opts.target_lang, glossary, hint)
    cache = TranslationCache(opts.cache_dir / "translations.sqlite") if (opts.cache_dir and opts.engine != "file") else TranslationCache(None)
    tag = translator.cache_tag()

    pending: list[Segment] = []
    for s in todo:
        hit = cache.get(TranslationCache.key(tag, ctx, s.text))
        if hit is not None:
            s.translation = hit
        else:
            pending.append(s)
    if len(todo) - len(pending):
        log(f"  {len(todo) - len(pending)} segments from cache")
    if not pending:
        return

    # batches never mix pages so each request is one coherent context
    batches: list[list[Item]] = []
    by_page: dict[int, list[Segment]] = {}
    for s in pending:
        by_page.setdefault(s.page, []).append(s)
    for segs in by_page.values():
        items = [Item(s.id, s.text, s.char_budget) for s in segs]
        batches.extend(make_batches(items, translator.batch_chars, translator.batch_items))
    seg_by_id = {s.id: s for s in pending}
    log(f"  translating {len(pending)} segments with {opts.engine} in {len(batches)} request(s)...")
    done = 0
    workers = max(1, min(opts.workers, len(batches)))
    with ThreadPoolExecutor(workers) as pool:
        futs = {pool.submit(translator.translate, b, ctx): b for b in batches}
        for fut in as_completed(futs):
            batch = futs[fut]
            try:
                res = fut.result()
            except Exception as exc:
                log(f"  ! a batch of {len(batch)} segments failed: {exc}")
                continue
            for it in batch:
                t = res.get(it.id)
                if t is None:
                    continue
                t = t.strip()
                if not t:
                    continue
                seg_by_id[it.id].translation = t
                cache.put(TranslationCache.key(tag, ctx, it.text), t)
            done += len(batch)
            log(f"  ... {done}/{len(pending)}")


def export_segments(path: str, analysed: dict[int, tuple[PageLayout, list[Segment]]], opts: Options) -> None:
    rows = []
    for pno in sorted(analysed):
        for s in analysed[pno][1]:
            if s.translate:
                rows.append(s.to_json())
    data = {
        "source_lang": opts.source_lang,
        "target_lang": opts.target_lang,
        "note": "Edit 'translation' and re-run with --engine file --translations THIS_FILE",
        "segments": rows,
    }
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")


def _spans(page: pymupdf.Page) -> list[tuple[Box, str]]:
    """Text spans as (ink box, text). The box spans cap height to descender
    around the baseline - the span bbox itself includes the font's full
    ascender/descender, which for symbol fallback fonts is huge."""
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            dx, dy = ln.get("dir", (1, 0))
            for sp in ln["spans"]:
                if not sp["text"].strip():
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                ox, oy = sp["origin"]
                sz = sp["size"]
                if abs(dx) > 0.99:  # horizontal
                    box = (x0 + 0.03 * sz, oy - 0.74 * sz, x1 - 0.03 * sz, oy + 0.2 * sz)
                elif abs(dy) > 0.99:  # vertical (rotated text)
                    box = (ox - 0.2 * sz, y0 + 0.03 * sz, ox + 0.74 * sz, y1 - 0.03 * sz) if dy > 0 else (
                        ox - 0.74 * sz, y0 + 0.03 * sz, ox + 0.2 * sz, y1 - 0.03 * sz)
                else:
                    box = (x0, y0, x1, y1)
                out.append((tuple(round(v, 2) for v in box), sp["text"]))
    return out


def render_page(page: pymupdf.Page, layout: PageLayout, segs: list[Segment], fonts: FontSet, report: Report) -> None:
    active = [s for s in segs if s.translate and s.translation and s.translation.strip() != s.text.strip()]
    placements: list[Placement] = [fit(fonts, s, s.translation) for s in active]
    harmonise(placements, fonts)
    erase_page(page, active)
    cover_leftovers(page, active)
    before = Counter(_spans(page))
    drawn: dict[str, Box] = {}
    for p in placements:
        rect = draw(page, p, fonts)
        drawn[p.seg.id] = rect
        if p.scale < 0.98:
            report.shrunk += 1
        if not p.fits:
            report.issues.append(Issue(page.number + 1, p.seg.id, "overflow",
                                       f"text had to be scaled to {p.size:.1f}pt: {p.seg.translation[:60]}"))
    # ----- verification: inserted text must not touch anything else
    after = Counter(_spans(page))
    new_spans = list((after - before).elements())
    owner: list[tuple[Box, str]] = []
    for bbox, text in new_spans:
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        sid = next((sid for sid, r in drawn.items() if r[0] - 1 <= cx <= r[2] + 1 and r[1] - 1 <= cy <= r[3] + 1), "?")
        owner.append((bbox, sid))
    by_id = {s.id: s for s in segs}
    obstacles: list[tuple[Box, str]] = [(b, "line") for b in layout.hlines + layout.vlines]
    obstacles += [(b, "picture") for b in layout.pictures]
    obstacles += [(s.bbox, "text:" + s.id) for s in segs if not (s in active)]
    seen = set()
    for i, (b, sid) in enumerate(owner):
        for j in range(i + 1, len(owner)):
            b2, sid2 = owner[j]
            if sid2 != sid and box_overlap_area(b, b2) > 0.3:
                key = tuple(sorted((sid, sid2)))
                if key not in seen:
                    seen.add(key)
                    report.issues.append(Issue(page.number + 1, sid, "overlap-text", f"touches {sid2}"))
        own = by_id.get(sid)
        for ob, kind in obstacles:
            # things that already overlapped the original text (frames,
            # shading, a picture's bounding box) are not collisions
            if own is not None and box_overlap_area(own.bbox, ob) > 0.2:
                continue
            if box_overlap_area(b, ob) > 0.4:
                key = (sid, kind)
                if key not in seen:
                    seen.add(key)
                    report.issues.append(Issue(page.number + 1, sid, "overlap-" + kind.split(":")[0], kind))


def make_bilingual(src_path: str, translated: pymupdf.Document, pages: list[int]) -> pymupdf.Document:
    src = pymupdf.open(src_path)
    out = pymupdf.open()
    for pno in pages:
        r = src[pno].rect
        page = out.new_page(width=r.width * 2 + 20, height=r.height)
        page.show_pdf_page(pymupdf.Rect(0, 0, r.width, r.height), src, pno)
        page.show_pdf_page(pymupdf.Rect(r.width + 20, 0, 2 * r.width + 20, r.height), translated, pno)
    return out


def save_compact(doc: pymupdf.Document, path: str) -> None:
    """Save without bloat.

    Every inserted text box embeds its own copy of the font; garbage=4
    merges the identical copies, then only the glyphs actually used are
    kept (subsetting). Without this a page with 300 text boxes grows by
    tens of megabytes.
    """
    merged = pymupdf.open("pdf", doc.tobytes(garbage=4, deflate=True))
    try:
        merged.subset_fonts()
    except Exception:  # subsetting is an optimisation only
        pass
    merged.save(path, garbage=4, deflate=True, use_objstms=1)


def translate_pdf(
    input_path: str,
    output_path: str,
    opts: Options,
    log: Callable[[str], None] = print,
) -> Report:
    t0 = time.time()
    report = Report()
    doc = pymupdf.open(input_path)
    if doc.needs_pass:
        raise RuntimeError("The PDF is password protected.")
    pages = parse_pages(opts.pages, doc.page_count)
    rotations = {p: doc[p].rotation for p in pages}
    for p in pages:
        if rotations[p]:
            doc[p].set_rotation(0)

    log(f"Analysing {len(pages)} page(s)...")
    analysed = analyse(doc, pages, opts, log)
    all_segs = [s for p in pages for s in analysed[p][1]]
    report.pages = len(pages)
    report.segments = len(all_segs)

    log("Translating...")
    translate_segments(all_segs, opts, log)
    if opts.export_json:
        export_segments(opts.export_json, analysed, opts)
        log(f"  segments written to {opts.export_json}")

    log("Typesetting...")
    fonts = FontSet.create(opts.font, opts.serif)
    for p in pages:
        layout, segs = analysed[p]
        render_page(doc[p], layout, segs, fonts, report)
    for p in pages:
        if rotations[p]:
            doc[p].set_rotation(rotations[p])
    report.translated = sum(1 for s in all_segs if s.translate and s.translation)
    report.kept = report.segments - report.translated

    if opts.bilingual:
        tmp = pymupdf.open()
        tmp.insert_pdf(doc)
        out = make_bilingual(input_path, tmp, pages)
        save_compact(out, output_path)
    else:
        save_compact(doc, output_path)
    report.seconds = time.time() - t0
    if opts.report:
        Path(opts.report).write_text(
            json.dumps(
                {"summary": report.summary(), "issues": [i.__dict__ for i in report.issues]},
                ensure_ascii=False,
                indent=1,
            ),
            "utf-8",
        )
    return report
