# PDF Translator — แปล PDF โดยคงรูปแบบเดิม

แปลภาษาในไฟล์ PDF (เริ่มต้น: จีน → อังกฤษ) โดยตำแหน่ง ขนาดตัวอักษร สี ตัวหนา ตาราง รูปภาพ และเส้นต่าง ๆ ยังเหมือนต้นฉบับ
ข้อความที่แปลแล้วจะถูกจัดให้อยู่ในช่องเดิม **ไม่ทับกัน ไม่ล้นออกนอกช่อง และไม่ถูกตัดหาย** — โปรแกรมตรวจสอบให้อัตโนมัติทุกหน้า

Translate PDFs (default Chinese → English) while keeping the layout: positions, font sizes, colours,
bold text, tables, images and ruling lines. Translations are fitted into the original space and every
page is checked automatically for overlaps.

## ความสามารถ

- **PDF ทุกแบบ**: ข้อความจริง, PDF สแกน, และ PDF ที่ตัวอักษรถูกแปลงเป็นเส้น (outline) — ใช้ OCR (PP-OCRv4, ทำงานออฟไลน์) อัตโนมัติ
- **เข้าใจโครงสร้าง**: แยกย่อหน้า หัวข้อ ช่องตาราง ข้อความแนวตั้ง (หมุนคำแปล 90° ให้), ป้ายแบบ `ชื่อ：ค่า` (แปลเฉพาะชื่อ ค่าคงเดิม)
- **จัดวางอัจฉริยะ**: หาพื้นที่ว่างรอบข้อความ (ถึงเส้นตาราง/ข้อความข้างเคียง), ขยายกล่องก่อน ย่อตัวอักษรเมื่อจำเป็น, ขนาดตัวอักษรในคอลัมน์เดียวกันสม่ำเสมอ
- **คำแปลลื่นไหล**: เครื่องมือแปลหลักคือ Claude — เห็นบริบททั้งหน้า ใช้ศัพท์เทคนิคสม่ำเสมอ แก้คำที่ OCR อ่านผิด และรู้ว่าแต่ละช่องมีที่ว่างกี่ตัวอักษร
- **ภาษาอื่น ๆ**: ต้นทาง/ปลายทางเปลี่ยนได้ เช่น `-t th` (ไทย), `ja`, `ko`, `vi` — ฟอนต์สำรองรองรับอักษรไทย/จีน/ญี่ปุ่นอัตโนมัติ
- **ตัวเลข/รหัสรุ่นไม่ถูกแตะ**: ข้อความที่ไม่มีภาษาต้นทาง (เช่น `MH040A`, `220V`) คงเดิมทุกพิกเซล
- **แก้คำแปลเองได้**: ส่งออก JSON → แก้ → สร้าง PDF ใหม่
- **แคช**: ผล OCR และคำแปลถูกเก็บไว้ รันซ้ำไม่เสียเวลา/ค่า API ซ้ำ

## ติดตั้ง

ต้องมี Python 3.10 ขึ้นไป

```bash
git clone https://github.com/fildhub/editor-ff.git
cd editor-ff
pip install -e ".[ocr]"
```

## ใช้งาน

```bash
# แปลด้วย Claude (คุณภาพดีที่สุด) — ต้องมี API key จาก https://console.anthropic.com
export ANTHROPIC_API_KEY=sk-ant-...        # Windows: set ANTHROPIC_API_KEY=sk-ant-...
pdf-translate manual.pdf -o manual.en.pdf

# แปลฟรีด้วย Google (ดูตัวอย่างเร็ว ๆ คุณภาพต่ำกว่า)
pdf-translate manual.pdf -e google

# จีน → ไทย, เฉพาะหน้า 1-3
pdf-translate manual.pdf -t th -p 1-3

# ต้นฉบับ + คำแปลเทียบกันซ้าย-ขวา
pdf-translate manual.pdf --bilingual
```

### ตรวจแก้คำแปลเอง

```bash
pdf-translate manual.pdf --export-json segments.json        # แปลและส่งออกทุกข้อความ
# แก้ช่อง "translation" ใน segments.json (ใช้ \n เพื่อขึ้นบรรทัดใหม่)
pdf-translate manual.pdf -e file --translations segments.json -o manual.en.pdf
```

### Glossary (บังคับศัพท์)

ไฟล์ CSV `source,target` ต่อบรรทัด เช่น

```
伺服电机,servo motor
驱动器,drive
```

```bash
pdf-translate manual.pdf --glossary glossary.csv --notes "Audience: field technicians"
```

### ตัวเลือกทั้งหมด

| ตัวเลือก | ความหมาย |
|---|---|
| `-s / -t` | ภาษาต้นทาง / ปลายทาง (ค่าเริ่มต้น `zh` / `en`) |
| `-e` | `claude` (ค่าเริ่มต้น), `google`, `file` |
| `--model`, `--effort` | รุ่น Claude (ค่าเริ่มต้น `claude-opus-5`) และระดับความละเอียด `low`…`max` |
| `-p` | หน้าที่จะแปล เช่น `1-3,5` |
| `--ocr` | `auto` (ค่าเริ่มต้น: OCR เฉพาะหน้าที่ไม่มีข้อความจริง), `always`, `never` |
| `--font`, `--serif` | ใช้ฟอนต์ของคุณเอง (.ttf/.otf) หรือ Noto Serif |
| `--bilingual` | สร้าง PDF ต้นฉบับ/คำแปลคู่กัน |
| `--export-json`, `--translations` | ส่งออก / นำเข้าคำแปล |
| `--glossary`, `--notes` | ศัพท์บังคับ และคำแนะนำเพิ่มเติมถึงผู้แปล |
| `--report` | บันทึกรายงานตรวจคุณภาพการจัดวาง (JSON) |
| `--no-cache` | ไม่ใช้แคช |

เมื่อรันเสร็จ โปรแกรมจะสรุปผล เช่น

```
pages: 2, text segments: 1262, translated: 329, left as is (numbers/codes/untranslated): 933
segments set in a smaller font to fit: 270
layout problems: 0 - none
```

`layout problems: 0` หมายถึงตรวจแล้วไม่มีคำแปลใดทับข้อความอื่น เส้นตาราง หรือรูปภาพ

## หลักการทำงาน

1. **วิเคราะห์หน้า** (`extract.py`, `ocr.py`, `raster.py`) — อ่านข้อความจริงพร้อมตำแหน่ง หรือ OCR ภาพที่ 300 dpi;
   หาเส้นตาราง รูปภาพ สีพื้นหลัง ขนาดและความหนาของตัวอักษร
2. **จัดกลุ่ม** (`layout.py`) — รวมบรรทัดเป็นย่อหน้า/ช่องตาราง แล้วคำนวณ "พื้นที่ว่าง" ที่คำแปลใช้ได้โดยไม่ชนสิ่งอื่น
   (ช่องว่างระหว่างข้อความสองชิ้นที่ต้องแปลทั้งคู่จะแบ่งครึ่ง จึงชนกันไม่ได้)
3. **แปล** (`translators/`) — ส่งทีละหน้าตามลำดับการอ่าน พร้อมจำนวนตัวอักษรที่แต่ละช่องรองรับ
4. **วางข้อความ** (`render.py`) — ลบข้อความเดิม (รวมตัวอักษรแบบเส้น) โดยไม่แตะเส้นตาราง/พื้นหลัง/รูป,
   เลือกขนาดตัวอักษรใหญ่ที่สุดที่ใส่ได้, ทำให้ขนาดในคอลัมน์เดียวกันสม่ำเสมอ
5. **ตรวจสอบ** (`pipeline.py`) — อ่านข้อความที่วางแล้วกลับมาตรวจว่าไม่ทับกัน/ไม่ชนเส้นหรือรูป

## ทดสอบ

```bash
pip install -e ".[dev,ocr]"
pytest
```

## หมายเหตุ

- PyMuPDF ใช้สัญญาอนุญาต AGPL — ใช้ภายในองค์กรได้ ถ้าจะนำไปจำหน่าย/ให้บริการต้องซื้อ license เชิงพาณิชย์ของ PyMuPDF
- `--engine google` ใช้ endpoint สาธารณะของ Google Translate ที่ไม่เป็นทางการ อาจถูกจำกัดการใช้งาน
