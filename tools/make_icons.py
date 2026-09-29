"""Generate the application icon (PNG, Windows .ico, macOS .icns).

    python tools/make_icons.py

Design: a blue-violet rounded square with a white document; the
document shows a Chinese character and, after an arrow, a Latin "A" -
"translate this PDF". Drawn at 1024 px and downsampled for crisp edges.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "pdf_translator" / "static"
S = 1024

CJK_FONTS = ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "C:/Windows/Fonts/msyh.ttc", "/System/Library/Fonts/PingFang.ttc"]
LATIN_FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/Helvetica.ttc"]


def font(paths, size):
    for p in paths:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)


def gradient(size, c1, c2):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))
    return g


def make() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # background tile
    tile = Image.new("L", (S, S), 0)
    ImageDraw.Draw(tile).rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=255)
    bg = gradient(S, (59, 91, 253), (124, 76, 255)).convert("RGBA")
    img.paste(bg, (0, 0), tile)

    # page: rounded rectangle with the top-right corner cut off
    x0, y0, x1, y1 = 262, 170, 762, 860
    fold = 150
    page = Image.new("L", (S, S), 0)
    pd = ImageDraw.Draw(page)
    pd.rounded_rectangle((x0, y0, x1, y1), radius=52, fill=255)
    pd.polygon([(x1 - fold, y0 - 5), (x1 + 5, y0 - 5), (x1 + 5, y0 + fold)], fill=0)
    shadow = Image.new("RGBA", (S, S), (25, 12, 90, 0))
    shadow.putalpha(page.point(lambda v: v * 115 // 255).filter(ImageFilter.GaussianBlur(26)))
    img.alpha_composite(shadow, (8, 26))
    img.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0), page)
    d = ImageDraw.Draw(img)
    # the folded corner
    d.polygon([(x1 - fold, y0), (x1, y0 + fold), (x1 - fold + 26, y0 + fold - 26)], fill=(206, 214, 255, 255))
    d.polygon([(x1 - fold, y0), (x1 - fold + 26, y0 + fold - 26), (x1, y0 + fold)], outline=(206, 214, 255, 255))

    # 文  ->  A
    cjk = font(CJK_FONTS, 250)
    lat = font(LATIN_FONTS, 270)
    d.text((x0 + 62, y0 + 70), "文", font=cjk, fill=(140, 150, 170, 255))
    d.text((x1 - 62, y1 - 60), "A", font=lat, fill=(59, 91, 253, 255), anchor="rs")
    # curved arrow from 文 (top-left) to A (bottom-right)
    blue = (59, 91, 253, 255)
    box = (x0 + 70, y0 + 150, x0 + 300, y0 + 540)  # left half of an ellipse
    d.arc(box, start=100, end=178, fill=blue, width=34)
    # the arc ends at the bottom; continue to the right with an arrow head
    bx = (box[0] + box[2]) / 2 - 12
    by = box[3] - 4
    d.line([(bx - 16, by), (bx + 18, by)], fill=blue, width=34)
    d.polygon([(bx + 82, by), (bx + 14, by - 52), (bx + 14, by + 52)], fill=blue)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big = make()
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    big.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(OUT / "icon.icns")
    print("written:", *(p.name for p in sorted(OUT.glob("icon.*"))))


if __name__ == "__main__":
    main()
