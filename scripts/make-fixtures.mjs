// Generates deterministic test fixtures in tests/fixtures/
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
const dir = new URL('../tests/fixtures/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });

// 1) sample.pdf — 3 pages: letter, tabloid landscape, letter rotated 90
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]);
  for (let x = 36; x <= 576; x += 36) p1.drawLine({ start: { x, y: 36 }, end: { x, y: 756 }, thickness: 0.3, color: rgb(0.75, 0.8, 0.85) });
  for (let y = 36; y <= 756; y += 36) p1.drawLine({ start: { x: 36, y }, end: { x: 576, y }, thickness: 0.3, color: rgb(0.75, 0.8, 0.85) });
  p1.drawText('SAMPLE SITE PLAN - SHEET 1', { x: 50, y: 760, size: 14, font: f });
  p1.drawRectangle({ x: 100, y: 200, width: 300, height: 200, borderColor: rgb(0.1, 0.3, 0.6), borderWidth: 2 });
  const p2 = d.addPage([1224, 792]);
  p2.drawText('SHEET 2 (TABLOID)', { x: 50, y: 750, size: 18, font: f });
  p2.drawCircle({ x: 600, y: 400, size: 150, borderColor: rgb(0, 0.5, 0.2), borderWidth: 3 });
  const p3 = d.addPage([612, 792]);
  p3.drawText('SHEET 3 (ROTATED)', { x: 50, y: 740, size: 18, font: f });
  p3.setRotation(degrees(90));
  writeFileSync(dir + 'sample.pdf', await d.save());
}

// 2) second.pdf — 2 pages for combining
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) d.addPage([612, 792]).drawText(`SECOND FILE PAGE ${n}`, { x: 60, y: 700, size: 20, font: f });
  writeFileSync(dir + 'second.pdf', await d.save());
}

// 3) layers.pdf — two optional content groups
{
  const d = await PDFDocument.create();
  const page = d.addPage([612, 792]);
  const ctx = d.context;
  const w = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Wetlands') }));
  const r = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Roads') }));
  const ops = '/OC /oc1 BDC 0 0.6 0 rg 100 400 200 200 re f EMC\n/OC /oc2 BDC 0 0 0 RG 8 w 350 100 m 350 700 l S EMC\n';
  const cs = ctx.register(ctx.flateStream(ops));
  page.node.set(PDFName.of('Contents'), cs);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Properties: { oc1: w, oc2: r } }));
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [w, r], D: { Order: [w, r], ON: [w, r] } }));
  writeFileSync(dir + 'layers.pdf', await d.save());
}

// 4) bloated.pdf — uncompressed content + raw image, no object streams, junk objects
{
  const d = await PDFDocument.create();
  const ctx = d.context;
  const W = 400, H = 300;
  const raw = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    raw[i] = (x * 255) / W; raw[i + 1] = (y * 255) / H; raw[i + 2] = ((x + y) % 64) * 4;
  }
  const img = ctx.register(ctx.stream(raw, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  for (let p = 0; p < 4; p++) {
    const page = d.addPage([612, 792]);
    let ops = `q 400 0 0 300 100 400 cm /Im0 Do Q\n`;
    for (let i = 0; i < 1500; i++) ops += `0.2 0.3 0.4 RG 0.5 w ${50 + (i % 50) * 10} ${60 + Math.floor(i / 50) * 10} m ${55 + (i % 50) * 10} ${65 + Math.floor(i / 50) * 10} l S\n`;
    const cs = ctx.register(ctx.stream(ops));
    page.node.set(PDFName.of('Contents'), cs);
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im0: img }, ExtGState: { Unused: { CA: 0.5 } } }));
  }
  for (let i = 0; i < 50; i++) ctx.register(ctx.stream('x'.repeat(2000))); // unreferenced junk
  writeFileSync(dir + 'bloated.pdf', await d.save({ useObjectStreams: false }));
}

// 5) images
execSync(`python3 - <<'PY'
from PIL import Image, ImageDraw
im = Image.new('RGB', (480, 360), 'white'); dr = ImageDraw.Draw(im)
dr.rectangle([40, 40, 440, 320], outline='navy', width=6); dr.ellipse([140, 100, 340, 260], fill='green')
im.save('${dir}image.png'); im.save('${dir}image.jpg', quality=90); im.save('${dir}image.tif', compression='tiff_lzw')
PY`);
console.log('fixtures written to', dir);

// 6) encrypted.pdf — owner-password protected (opens without a password), via qpdf-wasm
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const createModule = require('@neslinesli93/qpdf-wasm');
  const { readFileSync } = await import('node:fs');
  const q = await createModule({ print: () => {}, printErr: () => {} });
  q.FS.writeFile('/in.pdf', readFileSync(dir + 'sample.pdf'));
  try { q.callMain(['--encrypt', '', 'owner-secret', '256', '--modify=none', '--', '/in.pdf', '/out.pdf']); } catch {}
  writeFileSync(dir + 'encrypted.pdf', q.FS.readFile('/out.pdf'));
}
