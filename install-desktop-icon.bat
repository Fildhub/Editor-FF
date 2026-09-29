@echo off
REM Double-click once: puts a "PDF Translator" icon on your desktop
cd /d "%~dp0"
python -m pip install -e ".[ocr]"
python -m pdf_translator.shortcut
pause
