#!/bin/sh
# Run once: puts a "PDF Translator" icon on your desktop (macOS / Linux)
cd "$(dirname "$0")" && python3 -m pip install -e ".[ocr]" && python3 -m pdf_translator.shortcut
