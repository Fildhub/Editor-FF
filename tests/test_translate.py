import json
import re
from pathlib import Path

import pymupdf
import pytest

from pdf_translator.langs import join_lines, needs_translation
from pdf_translator.pipeline import Options, parse_pages, translate_pdf

CJK = re.compile(r"[一-鿿]")

TRANSLATIONS = {
    "安全注意事项": "Safety Precautions",
    "请勿在电机、驱动器的周围放置可燃物。": "Keep flammable materials away from the motor and drive.",
    "否则，会引发火灾事故。": "May cause fire.",
    "务必由专业电工进行接线作业。": "Wiring must be done by a qualified electrician.",
    "否则，会引发触电。": "May cause electric shock.",
    "项目": "Item",
    "额定电流": "Rated current",
    "感谢您使用本产品。本手册介绍伺服电机的安装、接线以及日常维护方法，请在使用前仔细阅读。":
        "Thank you for using this product. This manual describes the installation, wiring and routine "
        "maintenance of the servo motor. Please read it carefully before use.",
}


def make_sample(path: Path, scanned: bool = False) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=300)
    font = "china-s"
    page.insert_text((30, 40), "安全注意事项", fontname=font, fontsize=14)
    para = "感谢您使用本产品。本手册介绍伺服电机的安装、接线以及日常维护方法，请在使用前仔细阅读。"
    page.insert_textbox(pymupdf.Rect(30, 50, 390, 90), para, fontname=font, fontsize=9)
    # a 3x2 table with ruling lines
    x0, x1, xm = 30, 390, 250
    rows = [100, 118, 136, 154]
    for y in rows:
        page.draw_line((x0, y), (x1, y), width=0.6)
    for x in (x0, xm, x1):
        page.draw_line((x, rows[0]), (x, rows[-1]), width=0.6)
    cells = [
        ("请勿在电机、驱动器的周围放置可燃物。", "否则，会引发火灾事故。"),
        ("务必由专业电工进行接线作业。", "否则，会引发触电。"),
        ("额定电流", "MH010A 1.1 A"),
    ]
    for (a, b), y in zip(cells, rows):
        page.insert_text((x0 + 3, y + 12), a, fontname=font, fontsize=7.5)
        page.insert_text((xm + 3, y + 12), b, fontname=font, fontsize=7.5)
    page.draw_rect(pymupdf.Rect(300, 200, 380, 260), color=(0, 0, 0), fill=(0.8, 0.8, 0.8))
    if scanned:
        pix = page.get_pixmap(dpi=300)
        out = pymupdf.open()
        p2 = out.new_page(width=420, height=300)
        p2.insert_image(p2.rect, pixmap=pix)
        out.save(path)
    else:
        doc.save(path)


def write_translations(path: Path) -> None:
    rows = [{"id": f"t{i}", "source": s, "translation": t} for i, (s, t) in enumerate(TRANSLATIONS.items())]
    path.write_text(json.dumps({"segments": rows}, ensure_ascii=False), "utf-8")


def run(tmp_path: Path, scanned: bool = False, **kw):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    tr = tmp_path / "tr.json"
    make_sample(src, scanned)
    write_translations(tr)
    opts = Options(engine="file", translations=str(tr), cache_dir=None, **kw)
    report = translate_pdf(str(src), str(out), opts, log=lambda *_: None)
    return report, pymupdf.open(out)


def test_native_pdf_is_translated_in_place(tmp_path):
    report, doc = run(tmp_path)
    text = doc[0].get_text()
    assert not CJK.search(text), text
    assert "Safety Precautions" in text
    assert "May cause fire." in text
    assert "MH010A 1.1 A" in text  # untranslated content is untouched
    assert report.issues == []


def test_layout_is_preserved(tmp_path):
    src = tmp_path / "in.pdf"
    make_sample(src)
    before = pymupdf.open(src)[0].get_drawings()
    _, doc = run(tmp_path)
    after = doc[0].get_drawings()
    assert len(after) == len(before)  # table rules and the grey box survive
    # the translated heading stays where the original heading was
    heading = [b for b in doc[0].get_text("blocks") if "Safety" in b[4]][0]
    assert abs(heading[0] - 30) < 3 and heading[1] < 45


def test_table_cells_stay_inside_their_cells(tmp_path):
    _, doc = run(tmp_path)
    for b in doc[0].get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for sp in ln["spans"]:
                if "May cause" in sp["text"]:
                    x0, y0, x1, y1 = sp["bbox"]
                    assert x0 >= 250 and x1 <= 390


def test_bilingual_output(tmp_path):
    _, doc = run(tmp_path, bilingual=True)
    assert doc[0].rect.width > 800


try:
    import rapidocr_onnxruntime  # noqa: F401

    HAS_OCR = True
except ImportError:
    HAS_OCR = False


@pytest.mark.skipif(not HAS_OCR, reason="OCR extra not installed")
def test_scanned_pdf_uses_ocr(tmp_path):
    report, doc = run(tmp_path, scanned=True)
    text = doc[0].get_text()
    assert "Safety Precautions" in text
    assert report.translated >= 5
    assert report.issues == []


def test_helpers():
    assert needs_translation("否则，会引发火灾。", "zh")
    assert not needs_translation("MH010A 220V", "zh")
    assert join_lines(["请勿在电机", "周围放置。"]) == "请勿在电机周围放置。"
    assert join_lines(["Do not place", "objects here."]) == "Do not place objects here."
    assert join_lines(["connec-", "tor"]) == "connector"
    assert parse_pages("1-3,5", 10) == [0, 1, 2, 4]
    assert parse_pages(None, 2) == [0, 1]
