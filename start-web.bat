@echo off
chcp 65001 >nul
title PDF Translator
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY (
  echo ไม่พบ Python - ดาวน์โหลดที่ https://www.python.org/downloads/
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)
echo PDF Translator กำลังเปิดในเบราว์เซอร์ ... (ปิดหน้าต่างนี้ = ปิดโปรแกรม)
%PY% -m pdf_translator.web
if errorlevel 1 pause
