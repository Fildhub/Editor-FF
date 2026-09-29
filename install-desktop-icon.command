#!/bin/sh
# Double-click in Finder (macOS), or run:  sh install-desktop-icon.command
cd "$(dirname "$0")" || exit 1
echo "PDF Translator : ติดตั้งไอคอนบนหน้าจอ"
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys; assert sys.version_info >= (3, 10)" 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "[X] ไม่พบ Python 3.10+  ดาวน์โหลดที่ https://www.python.org/downloads/"
  (open https://www.python.org/downloads/ || xdg-open https://www.python.org/downloads/) >/dev/null 2>&1
  printf "กด Enter เพื่อปิด"; read _; exit 1
fi
echo "[1/2] ติดตั้งส่วนประกอบ (ครั้งแรก 1-3 นาที) ..."
"$PY" -m pip install --disable-pip-version-check -e ".[ocr]" || { echo "[X] ติดตั้งไม่สำเร็จ"; printf "กด Enter เพื่อปิด"; read _; exit 1; }
echo "[2/2] สร้างไอคอน ..."
"$PY" -m pdf_translator.shortcut || { echo "[X] สร้างไอคอนไม่สำเร็จ"; printf "กด Enter เพื่อปิด"; read _; exit 1; }
echo "[OK] เสร็จแล้ว! ดับเบิลคลิกไอคอน PDF Translator บนหน้าจอ"
printf "กด Enter เพื่อปิด"; read _
