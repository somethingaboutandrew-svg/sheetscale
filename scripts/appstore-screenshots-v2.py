#!/usr/bin/env python3
"""App Store screenshots v2 (CAD drawing set). Takes the real Playwright captures from
tests/shots/appstore-v2.spec.ts (screenshots/v4/, light Liquid Glass theme, 1440x900 @2x) and writes:
  <out>/NN-name.png            2880x1800 RGB, the raw app window (same style as the v1 set)
  <out>/captioned/NN-name.png  2880x1800 RGB, headline + subline over a frosted backdrop (optional set)
  <out>/contact.png, <out>/captioned/contact.png  overview sheets for review
Usage: python3 scripts/appstore-screenshots-v2.py [out_dir]   (default appstore/screenshots-v2)"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

root = Path(__file__).resolve().parent.parent
src = root / 'screenshots' / 'v4'
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'appstore' / 'screenshots-v2'
ORDER = [
    ('01-markup-cad-sheet', '01-markup', 'Review drawings in full color', 'Revision clouds, callouts, notes and stamps on any PDF sheet.'),
    ('02-measure-area-takeoff', '02-measure', 'Takeoffs at true scale', 'Set the scale once. Lengths, areas and counts total up live.'),
    ('03-layers-and-styles', '03-layers', 'Layers and styles, organized', 'Toggle CAD layers. Keep your go-to markup styles a click away.'),
    ('04-combine-300-pages', '04-combine', 'Combine hundreds of pages', 'Merge a 300-page report with your drawing set in one step.'),
    ('05-303-page-document', '04b-combined', 'Built for big documents', 'Smooth scrolling and instant thumbnails, even at 303 pages.'),
    ('06-reduce-size-lossless', '05-reduce', 'Smaller files, same quality', 'Lossless compression. Images are never downsampled.'),
    ('07-save-editable-or-flattened', '06-export', 'Editable or flattened', 'Keep markups live for your team, or burn them in to share.'),
    ('08-vector-detail-zoom', '07-zoom', 'Sharp at any zoom', 'Vector-crisp linework and markups, from full sheet to detail.'),
]
FONT = '/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'


def font(size, weight):
    try:
        f = ImageFont.truetype(FONT, size)
        f.set_variation_by_name(weight)
        return f
    except Exception:
        return ImageFont.truetype('DejaVuSans-Bold.ttf' if weight != 'Regular' else 'DejaVuSans.ttf', size)


def backdrop(w, h):
    top, bottom = (246, 247, 249), (231, 234, 240)
    bg = Image.new('RGB', (w, h))
    px = ImageDraw.Draw(bg)
    for y in range(h):
        t = y / (h - 1)
        px.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    glow = Image.new('L', (w, h), 0)
    ImageDraw.Draw(glow).ellipse([w * 0.18, -h * 0.35, w * 0.82, h * 0.45], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    return Image.composite(Image.new('RGB', (w, h), (222, 232, 252)), bg, glow)


def captioned(shot, title, sub):
    W, H = shot.size
    canvas = backdrop(W, H)
    d = ImageDraw.Draw(canvas)
    ft, fs = font(96, 'Bold'), font(46, 'Regular')
    d.text((W / 2, 150), title, font=ft, fill=(15, 23, 42), anchor='mm')
    d.text((W / 2, 250), sub, font=fs, fill=(71, 85, 105), anchor='mm')
    scale = 0.775
    sw, sh = round(W * scale), round(H * scale)
    x, y = (W - sw) // 2, 340
    small = shot.resize((sw, sh), Image.LANCZOS)
    r = 30
    mask = Image.new('L', (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], r, fill=255)
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + 24, x + sw, y + sh + 24], r, fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    canvas = Image.composite(Image.new('RGB', (W, H), (60, 70, 90)), canvas, shadow)
    canvas.paste(small, (x, y), mask)
    ImageDraw.Draw(canvas).rounded_rectangle([x, y, x + sw - 1, y + sh - 1], r, outline=(205, 210, 220), width=2)
    return canvas


def contact(paths, dest, title):
    tw, th, pad, cols = 1080, 675, 48, 2
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tw + (cols + 1) * pad, rows * (th + 70) + pad + 110), (238, 240, 244))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 40), title, font=font(40, 'Bold'), fill=(15, 23, 42))
    for i, p in enumerate(paths):
        im = Image.open(p).resize((tw, th), Image.LANCZOS)
        x, y = pad + (i % cols) * (tw + pad), 110 + (i // cols) * (th + 70)
        sheet.paste(im, (x, y))
        d.rectangle([x - 1, y - 1, x + tw, y + th], outline=(200, 205, 214), width=2)
        d.text((x, y + th + 14), p.name, font=font(28, 'Medium'), fill=(51, 65, 85))
    sheet.save(dest, optimize=True)


(out / 'captioned').mkdir(parents=True, exist_ok=True)
for old in list(out.glob('*.png')) + list((out / 'captioned').glob('*.png')):
    old.unlink()
raw, cap = [], []
for name, shot, title, sub in ORDER:
    im = Image.open(src / f'{shot}.png')
    assert im.size == (2880, 1800), (shot, im.size)
    rgb = Image.new('RGB', im.size, (242, 243, 245))
    rgb.paste(im, mask=im.split()[-1] if im.mode == 'RGBA' else None)
    rgb.save(out / f'{name}.png', optimize=True)
    captioned(rgb, title, sub).save(out / 'captioned' / f'{name}.png', optimize=True)
    raw.append(out / f'{name}.png')
    cap.append(out / 'captioned' / f'{name}.png')
    print(f'{name}.png  {rgb.size[0]}x{rgb.size[1]}  {rgb.mode}')
contact(raw, out / 'contact.png', 'SheetScale - App Store screenshots v2 (app window)')
contact(cap, out / 'captioned' / 'contact.png', 'SheetScale - App Store screenshots v2 (captioned option)')
