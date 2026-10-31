#!/usr/bin/env python3
"""Copies the real Playwright captures (light Liquid Glass theme, 1440x900 @2x) made by
tests/zz-screenshots.spec.ts into appstore/screenshots/ in App Store order, as 2880x1800 RGB PNGs
(no alpha channel). Run `npm test` first so screenshots/v3/ is fresh."""
from pathlib import Path
from PIL import Image
root = Path(__file__).resolve().parent.parent
src, out = root / 'screenshots' / 'v3', root / 'appstore' / 'screenshots'
ORDER = [
    ('01-measure-area-acres', '02-main-area-selected'),
    ('02-markups-list-totals', '03-markups-list-and-totals'),
    ('03-calibrate-scale', '01-calibrate-on-scale-bar'),
    ('04-pdf-layers', '04-layers-topo-hidden'),
    ('05-zoom-400-percent', '05-zoomed-detail-400pct'),
    ('06-combine-pdfs', '07-combine'),
    ('07-reduce-size-lossless', '08-reduce-size-lossless'),
    ('08-save-editable-or-flattened', '06-export-editable-or-flattened'),
    ('09-start-screen-recent', '10-start-screen-recent'),
]
out.mkdir(parents=True, exist_ok=True)
for old in out.glob('*.png'):
    old.unlink()
for name, shot in ORDER:
    im = Image.open(src / f'{shot}-light.png')
    assert im.size == (2880, 1800), (shot, im.size)
    rgb = Image.new('RGB', im.size, (242, 243, 245))
    rgb.paste(im, mask=im.split()[-1] if im.mode == 'RGBA' else None)
    rgb.save(out / f'{name}.png', optimize=True)
    print(f'{name}.png  {rgb.size[0]}x{rgb.size[1]}  {rgb.mode}')
