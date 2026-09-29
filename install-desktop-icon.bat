@echo off
chcp 65001 >nul
title PDF Translator - install desktop icon
cd /d "%~dp0"
echo.
echo  ==============================================
echo    PDF Translator : ติดตั้งไอคอนบนหน้าจอ
echo  ==============================================
echo.

if not exist "pdf_translator\__init__.py" (
  echo  [X] ไม่พบโฟลเดอร์โปรแกรม
  echo      ต้องแตกไฟล์ ZIP ก่อน แล้วดับเบิลคลิกไฟล์นี้จากในโฟลเดอร์ที่แตกแล้ว
  echo      ^(ห้ามเปิดจากในไฟล์ ZIP โดยตรง^)
  goto :fail
)

echo  [1/3] ตรวจหา Python ...
set "PY="
py -3 -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>nul && set "PY=python"
if not defined PY (
  echo  [X] ไม่พบ Python 3.10 ขึ้นไปในเครื่อง
  echo      1. ดาวน์โหลดที่ https://www.python.org/downloads/
  echo      2. ตอนติดตั้ง ติ๊กช่อง "Add python.exe to PATH"
  echo      3. แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง
  start "" https://www.python.org/downloads/
  goto :fail
)
for /f "delims=" %%v in ('%PY% --version') do echo      พบ %%v

echo.
echo  [2/3] ติดตั้งส่วนประกอบของโปรแกรม (ครั้งแรกใช้เวลา 1-3 นาที) ...
%PY% -m pip install --disable-pip-version-check -e ".[ocr]"
if errorlevel 1 (
  echo  [X] ติดตั้งส่วนประกอบไม่สำเร็จ - ดูข้อความ error ด้านบน
  echo      ^(ตรวจอินเทอร์เน็ต แล้วลองใหม่อีกครั้ง^)
  goto :fail
)

echo.
echo  [3/3] สร้างไอคอนบนหน้าจอ ...
%PY% -m pdf_translator.shortcut
if errorlevel 1 (
  echo  [X] สร้างไอคอนไม่สำเร็จ - ดูข้อความ error ด้านบน
  echo      ยังเปิดโปรแกรมได้ โดยดับเบิลคลิก start-web.bat ในโฟลเดอร์นี้
  goto :fail
)

echo.
echo  [OK] เสร็จแล้ว! ดับเบิลคลิกไอคอน "PDF Translator" บนหน้าจอเพื่อเปิดโปรแกรม
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
