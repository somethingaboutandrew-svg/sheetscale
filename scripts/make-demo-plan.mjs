// Original demo drawing for screenshots: a fictional wetland delineation sheet (tabloid, 1" = 50').
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
const fb = await d.embedFont(StandardFonts.HelveticaBold);
const p = d.addPage([1224, 792]);
const ctx = d.context;
const topo = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Topography') }));
const hydro = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hydrology') }));
const parcel = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Parcel & Survey') }));
let ops = '';
// border + title block
ops += '0 0 0 RG 1.5 w 24 24 1176 744 re S 0.8 w 930 24 m 930 768 l S\n';
// topography (contours)
ops += '/OC /t BDC 0.62 0.55 0.45 RG 0.6 w\n';
for (let i = 0; i < 9; i++) {
  const y = 120 + i * 62;
  ops += `60 ${y} m 250 ${y + 40} 420 ${y - 30} 600 ${y + 20} c 760 ${y + 60} 840 ${y - 10} 900 ${y + 10} c S\n`;
}
ops += 'EMC\n';
// hydrology: stream + wetland hatch
ops += '/OC /h BDC 0.15 0.45 0.85 RG 2.2 w 60 300 m 220 360 330 250 470 330 c 590 400 700 360 900 470 c S\n';
ops += '0.55 0.8 0.55 rg 0.2 0.5 0.2 RG 0.8 w [4 3] 0 d 380 300 m 450 395 560 430 640 400 c 700 370 690 300 620 270 c 540 230 420 240 380 300 c h B [] 0 d\n';
ops += 'EMC\n';
// parcel + road
ops += '/OC /p BDC 0.1 0.1 0.1 RG 2 w [12 4 2 4] 0 d 80 80 m 880 110 l 860 700 l 100 680 l h S [] 0 d\n';
ops += '0.4 0.4 0.4 RG 1 w 60 600 m 900 640 l S 60 570 m 900 610 l S EMC\n';
const cs = ctx.register(ctx.flateStream(ops));
p.node.set(PDFName.of('Contents'), cs);
p.node.set(PDFName.of('Resources'), ctx.obj({ Properties: { t: topo, h: hydro, p: parcel } }));
d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [topo, hydro, parcel], D: { Order: [topo, hydro, parcel], ON: [topo, hydro, parcel] } }));
const T = (s, x, y, size = 9, font = f, color = rgb(0.1, 0.1, 0.1)) => p.drawText(s, { x, y, size, font, color });
T('WETLAND A', 470, 330, 11, fb, rgb(0.1, 0.35, 0.1));
T('(PFO1E)', 485, 317, 8);
T('UNNAMED TRIBUTARY', 150, 352, 8, f, rgb(0.15, 0.4, 0.75));
T('ROUTE 17 (VARIABLE WIDTH R/W)', 380, 625, 8);
T('PARCEL 12-B  +/- 13.6 AC', 140, 150, 9, fb);
// title block text
T('PROJECT', 945, 740, 7, f, rgb(0.4, 0.4, 0.4)); T('Riverbend Commons', 945, 724, 12, fb);
T('SHEET TITLE', 945, 690, 7, f, rgb(0.4, 0.4, 0.4)); T('Wetland Delineation Plan', 945, 674, 11, fb);
T('Waters of the U.S. - Field Verification', 945, 660, 8);
T('SCALE', 945, 620, 7, f, rgb(0.4, 0.4, 0.4)); T('1" = 50\'', 945, 604, 12, fb);
T('DATE', 945, 570, 7, f, rgb(0.4, 0.4, 0.4)); T('October 2026', 945, 556, 10);
T('SHEET', 945, 520, 7, f, rgb(0.4, 0.4, 0.4)); T('W-1 of 3', 945, 500, 16, fb);
T('DEMO DRAWING - FICTIONAL SITE', 945, 60, 7, f, rgb(0.5, 0.5, 0.5));
// graphic scale: 0-50-100 ft = 0, 72, 144 pt
p.drawRectangle({ x: 945, y: 430, width: 72, height: 6, color: rgb(0, 0, 0) });
p.drawRectangle({ x: 1017, y: 430, width: 72, height: 6, borderColor: rgb(0, 0, 0), borderWidth: 1 });
T('0', 943, 440, 7); T('50', 1012, 440, 7); T('100 FT', 1080, 440, 7);
// north arrow
p.drawLine({ start: { x: 1150, y: 380 }, end: { x: 1150, y: 440 }, thickness: 1.5 });
p.drawSvgPath('M 1150 -450 L 1142 -430 L 1158 -430 Z', { x: 0, y: 0, color: rgb(0, 0, 0) });
T('N', 1146, 452, 10, fb);
// wetland flags
for (const [x, y, n] of [[395, 318, 1], [470, 392, 2], [600, 418, 3], [668, 352, 4], [610, 268, 5], [470, 246, 6]]) {
  p.drawCircle({ x, y, size: 2.2, color: rgb(0.85, 0.1, 0.1) });
  T(`WL-${n}`, x + 4, y + 3, 6, f, rgb(0.85, 0.1, 0.1));
}
writeFileSync(new URL('../tests/fixtures/demo-plan.pdf', import.meta.url), await d.save());
// a second sheet for the combine screenshot
const d2 = await PDFDocument.create();
const g = d2.addPage([1224, 792]);
g.drawText('Sheet W-2: Data Point Locations', { x: 60, y: 720, size: 18, font: await d2.embedFont(StandardFonts.HelveticaBold) });
writeFileSync(new URL('../tests/fixtures/demo-sheet2.pdf', import.meta.url), await d2.save());
console.log('demo plan written');
