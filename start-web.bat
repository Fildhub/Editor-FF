@echo off
REM Double-click to open PDF Translator in your browser
cd /d "%~dp0"
python -m pdf_translator.web
pause
