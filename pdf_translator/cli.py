"""Command line interface:  pdf-translate input.pdf -o output.pdf"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .pipeline import Options, translate_pdf


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pdf-translate",
        description="Translate a PDF while keeping its layout (positions, tables, images, fonts sizes).",
    )
    p.add_argument("input", help="PDF file to translate")
    p.add_argument("-o", "--output", help="output PDF (default: <input>.<target>.pdf)")
    p.add_argument("-s", "--source", default="zh", help="source language code (default: zh)")
    p.add_argument("-t", "--target", default="en", help="target language code (default: en; e.g. th, ja, ko, vi)")
    p.add_argument(
        "-e",
        "--engine",
        default="google",
        choices=["google", "file"],
        help="google = Google Translate, free, no key needed (default); "
        "file = use translations from --translations JSON",
    )
    p.add_argument("--translations", help="JSON with translations (for --engine file)")
    p.add_argument("--export-json", help="also write all segments + translations to this JSON (edit & re-use)")
    p.add_argument("--glossary", help="CSV/TSV/JSON glossary: source term,target term")
    p.add_argument("-p", "--pages", help="pages to translate, e.g. 1-3,5 (default: all)")
    p.add_argument("--ocr", default="auto", choices=["auto", "always", "never"],
                   help="OCR pages without real text (scans / outlined text). default: auto")
    p.add_argument("--dpi", type=int, default=300, help="OCR resolution (default: 300)")
    p.add_argument("--font", help="TTF/OTF font file for the translated text")
    p.add_argument("--serif", action="store_true", help="use a serif font (Noto Serif) instead of Noto Sans")
    p.add_argument("--bilingual", action="store_true", help="output original and translation side by side")
    p.add_argument("--report", help="write a JSON quality report (layout checks) to this file")
    p.add_argument("--workers", type=int, default=4, help="parallel translation requests (default: 4)")
    p.add_argument("--no-cache", action="store_true", help="do not read/write the OCR and translation cache")
    p.add_argument("--translate-all", action="store_true",
                   help="translate every text block, not only those containing source-language characters")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    src = Path(args.input)
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 2
    out = args.output or str(src.with_name(f"{src.stem}.{args.target}.pdf"))
    opts = Options(
        source_lang=args.source,
        target_lang=args.target,
        engine=args.engine,
        pages=args.pages,
        ocr=args.ocr,
        dpi=args.dpi,
        glossary=args.glossary,
        translations=args.translations,
        font=args.font,
        serif=args.serif,
        bilingual=args.bilingual,
        export_json=args.export_json,
        report=args.report,
        workers=args.workers,
        translate_all=args.translate_all,
    )
    if args.no_cache:
        opts.cache_dir = None
    try:
        report = translate_pdf(str(src), out, opts)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print()
    print(report.summary())
    for issue in report.issues[:30]:
        print(f"  page {issue.page} {issue.segment}: {issue.kind} - {issue.detail}")
    print(f"\nSaved: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
