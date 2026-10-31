// Realistic large fixtures for performance tests (not committed; ~120 MB):
//  - report-{1,2,3}.pdf: 100-page consulting reports: text pages, photo pages (JPEG), raster map pages (11x17, big JPEG)
//    and vector plan sheets (24x36).
//  - big-plan.pdf: one 36x24 in sheet with ~40k vector segments and ~1.5k labels (draw/zoom stress).
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const OUT = new URL('../tests/fixtures/big/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const force = process.argv.includes('--force');
const want = ['report-1.pdf', 'report-2.pdf', 'report-3.pdf', 'big-plan.pdf'];
if (!force && want.every((f) => existsSync(OUT + f))) { console.log('big fixtures exist'); process.exit(0); }

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const WORDS = 'wetland delineation boundary hydric soils hydrology vegetation dominant facultative obligate upland transect plot sample data form culvert stream ordinary high water mark jurisdictional determination waters buffer mitigation compensatory credits permit section nationwide palustrine emergent forested scrub shrub redoximorphic features saturation inundation drainage pattern sediment deposits watermarks oxidized rhizospheres'.split(' ');
const sentence = () => { const n = 8 + Math.floor(rnd() * 14); const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(' ') + '.'; };

const browser = await chromium.launch();
const page = await browser.newPage();
async function jpeg(w, h, kind, s, q = 0.85) {
  const b64 = await page.evaluate(({ w, h, kind, s, q }) => {
    let sd = s; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    if (kind === 'photo') {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, `hsl(${200 + r() * 20},45%,${70 + r() * 10}%)`); gr.addColorStop(0.45, `hsl(${80 + r() * 40},35%,45%)`); gr.addColorStop(1, `hsl(${60 + r() * 30},30%,25%)`);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2500; i++) { g.fillStyle = `hsla(${70 + r() * 60},${30 + r() * 40}%,${20 + r() * 40}%,${0.2 + r() * 0.5})`; g.beginPath(); g.ellipse(r() * w, h * 0.35 + r() * h * 0.65, 4 + r() * 30, 2 + r() * 14, r() * 3, 0, 7); g.fill(); }
    } else {
      g.fillStyle = '#e9e4d4'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) { g.fillStyle = `hsla(${90 + r() * 50},${20 + r() * 30}%,${45 + r() * 30}%,.55)`; g.beginPath(); const x = r() * w, y = r() * h; g.moveTo(x, y); for (let k = 0; k < 6; k++) g.lineTo(x + (r() - 0.5) * 400, y + (r() - 0.5) * 400); g.fill(); }
      g.strokeStyle = 'rgba(120,90,60,.5)'; g.lineWidth = 2;
      for (let i = 0; i < 120; i++) { g.beginPath(); let y = r() * h; g.moveTo(0, y); for (let x = 0; x <= w; x += 40) { y += (r() - 0.5) * 30; g.lineTo(x, y); } g.stroke(); }
    }
    const img = g.getImageData(0, 0, w, h), d = img.data; // sensor-like noise so JPEG sizes are realistic
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 34; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', q).split(',')[1];
  }, { w, h, kind, s, q });
  return Buffer.from(b64, 'base64');
}

function vectorSheet(doc, font, W, H, density, title) {
  const p = doc.addPage([W, H]);
  const ops = [];
  const n = (v) => v.toFixed(1);
  ops.push('0.55 0.45 0.35 RG 0.6 w');
  for (let i = 0; i < density; i++) { // contours
    let y = 60 + rnd() * (H - 120); const parts = [`40 ${n(y)} m`];
    for (let x = 40; x < W - 300; x += 18) { y += (rnd() - 0.5) * 6; parts.push(`${n(x)} ${n(y)} l`); }
    ops.push(parts.join(' ') + ' S');
  }
  ops.push('0.2 0.4 0.85 RG 1.6 w'); // streams
  for (let i = 0; i < 6; i++) { let x = 40, y = rnd() * H; const parts = [`${n(x)} ${n(y)} m`]; while (x < W - 300) { x += 30; y += (rnd() - 0.5) * 40; parts.push(`${n(x)} ${n(y)} l`); } ops.push(parts.join(' ') + ' S'); }
  ops.push('0 0 0 RG 1 w');
  for (let i = 0; i < density / 4; i++) { const x = 60 + rnd() * (W - 400), y = 60 + rnd() * (H - 120), s = 6 + rnd() * 30; ops.push(`${n(x)} ${n(y)} ${n(s)} ${n(s * 0.7)} re S`); }
  ops.push(`2 w ${W - 280} 20 260 ${H - 40} re S 20 20 ${W - 40} ${H - 40} re S`);
  p.pushOperators(); // ensure content array exists
  const stream = doc.context.flateStream(ops.join('\n'));
  p.node.addContentStream(doc.context.register(stream));
  for (let i = 0; i < density / 25; i++) p.drawText(`EL ${(100 + rnd() * 80).toFixed(1)}`, { x: 60 + rnd() * (W - 400), y: 60 + rnd() * (H - 120), size: 5, font, color: rgb(0.4, 0.3, 0.2) });
  p.drawText(title, { x: W - 270, y: H - 80, size: 14, font });
  p.drawText('SCALE 1" = 50\'', { x: W - 270, y: H - 110, size: 10, font });
  return p;
}

async function report(i, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const title = `Report ${i}: Riverbend Commons Environmental Assessment, Vol. ${i}`;
  for (let k = 0; k < pages; k++) {
    const kind = k % 17 === 5 ? 'map' : k % 33 === 20 ? 'plan' : k % 8 === 3 ? 'photo' : 'text';
    if (kind === 'map') {
      const p = doc.addPage([1224, 792]);
      const img = await doc.embedJpg(await jpeg(4400, 2850, 'map', i * 1000 + k, 0.82));
      p.drawImage(img, { x: 36, y: 60, width: 1152, height: 700 });
      p.drawText(`Figure ${k}: Site map with delineated wetland boundaries`, { x: 36, y: 30, size: 11, font: bold });
    } else if (kind === 'plan') {
      vectorSheet(doc, font, 2592, 1728, 900, `Sheet C-${k}: Grading plan`);
    } else {
      const p = doc.addPage([612, 792]);
      p.drawText(title, { x: 54, y: 760, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
      p.drawText(String(k + 1), { x: 300, y: 30, size: 9, font });
      let y = 720;
      if (kind === 'photo') {
        for (let j = 0; j < 2; j++) {
          const img = await doc.embedJpg(await jpeg(1800, 1350, 'photo', i * 1000 + k * 10 + j));
          p.drawImage(img, { x: 106, y: y - 300, width: 400, height: 300 });
          p.drawText(`Photo ${k}-${j + 1}: Data point DP-${k}${j} looking north`, { x: 106, y: y - 316, size: 9, font });
          y -= 345;
        }
        continue;
      }
      p.drawText(`${k + 1}.0 ${sentence().slice(0, 48)}`, { x: 54, y, size: 13, font: bold }); y -= 24;
      while (y > 70) {
        const line = sentence() + ' ' + sentence();
        let cur = '';
        for (const w of line.split(' ')) {
          if (font.widthOfTextAtSize(cur + ' ' + w, 10) > 504) { p.drawText(cur, { x: 54, y, size: 10, font }); y -= 13; cur = w; if (y < 70) break; } else cur = cur ? cur + ' ' + w : w;
        }
        if (y > 70 && cur) { p.drawText(cur, { x: 54, y, size: 10, font }); y -= 19; }
      }
    }
  }
  const bytes = await doc.save({ useObjectStreams: true });
  writeFileSync(OUT + `report-${i}.pdf`, bytes);
  console.log(`report-${i}.pdf`, pages, 'pages', (bytes.length / 1e6).toFixed(1), 'MB');
}

for (let i = 1; i <= 3; i++) await report(i, i === 2 ? 98 : 101);
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  vectorSheet(doc, font, 2592, 1728, 2600, 'BIG PLAN: Riverbend Commons master grading plan');
  const b = await doc.save();
  writeFileSync(OUT + 'big-plan.pdf', b);
  console.log('big-plan.pdf', (b.length / 1e6).toFixed(1), 'MB');
}
await browser.close();
