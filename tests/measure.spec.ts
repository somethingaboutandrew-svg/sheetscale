import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, open, setZoom, clickUser, at, saveDownload, loadPdf, annots, name, nums, ocgNames, pdftext, renderPage, qpdfCheck, pdfinfoPages, waitRendered, text } from './helpers';
import { PDFName, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';

const pm = (page: Page, expr: string) => page.evaluate(`(() => { const pm = window.__pm; return ${expr}; })()`);
async function setVal(page: Page, sel: string, v: string) {
  await page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, v]);
}
const markups = (page: Page) => pm(page, 'pm.doc.markups') as Promise<any[]>;

test('calibrate, measure, style, layers, export editable + flattened, round-trip, CSV', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await expect(page.locator('.page')).toHaveCount(3);
  await expect(page.locator('.thumb')).toHaveCount(3);
  await setZoom(page, 0.75); // 1 CSS px == 1 PDF pt
  expect(await pm(page, 'pm.zoom')).toBe(0.75);
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 580));
  await waitRendered(page);

  // ---- calibrate: 100 px on screen == 10 ft ----
  await page.keyboard.press('k');
  const a = await at(page, 0, 100, 650), b = await at(page, 0, 200, 650);
  expect(Math.round(b.x - a.x)).toBe(100); // 100 screen px apart
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.fill('#cal-value', '10');
  await page.selectOption('#cal-unit', 'ft');
  await page.click('#cal-ok');
  const sc = (await pm(page, 'pm.doc.pages[0].scale')) as any;
  expect(sc.unit).toBe('ft');
  expect(sc.factor).toBeCloseTo(0.1, 6);

  // ---- length: 200 px -> 20 ft (tool switched to Length automatically) ----
  await clickUser(page, 0, 100, 600);
  await clickUser(page, 0, 300, 600);
  let ms = await markups(page);
  expect(ms).toHaveLength(1);
  const lenId = ms[0].id;
  expect(ms[0].type).toBe('m-length');
  let mv = (await pm(page, `pm.measure('${lenId}')`)) as any;
  expect(mv.value).toBeCloseTo(20, 2);
  await expect(page.locator(`.mk[data-id="${lenId}"] text`)).toContainText('20.00 ft');

  // ---- area: 100x100 px square -> 100 sq ft = 0.0023 ac ----
  await page.keyboard.press('4');
  for (const [x, y] of [[350, 450], [450, 450], [450, 550], [350, 550]]) await clickUser(page, 0, x, y);
  await page.keyboard.press('Enter');
  ms = await markups(page);
  const area = ms.find((m) => m.type === 'm-area');
  expect(area.pts).toHaveLength(4);
  mv = await pm(page, `pm.measure('${area.id}')`);
  expect(mv.value).toBeCloseTo(100, 2);
  expect(mv.unit).toBe('sq ft');
  expect(mv.area2).toBeCloseTo(100 / 43560, 6);
  expect(mv.area2Unit).toBe('ac');
  expect(mv.perimeter).toBeCloseTo(40, 2);

  // ---- polylength: 100 + 60 px = 16 ft, finished with double-click ----
  await page.keyboard.press('2');
  await clickUser(page, 0, 100, 520);
  await clickUser(page, 0, 200, 520);
  const last = await at(page, 0, 200, 460);
  await page.mouse.dblclick(last.x, last.y);
  ms = await markups(page);
  const pl = ms.find((m) => m.type === 'm-polylength');
  expect(pl.pts).toHaveLength(3);
  expect(((await pm(page, `pm.measure('${pl.id}')`)) as any).value).toBeCloseTo(16, 2);

  // ---- count ----
  await page.keyboard.press('5');
  for (const x of [500, 530, 560]) await clickUser(page, 0, x, 700);
  await page.keyboard.press('Escape');
  ms = await markups(page);
  const cnt = ms.find((m) => m.type === 'm-count');
  expect(cnt.pts).toHaveLength(3);

  // ---- preset scale on page 2: 1" = 20', 72 pt -> 20 ft ----
  await page.evaluate(() => (window as any).__pm.centerOn(1, 300, 400));
  await page.waitForTimeout(300);
  await page.click('[data-rt="scale"]');
  await page.click('#sc-set');
  await page.selectOption('#sc-preset', { label: `1" = 20'` });
  await page.click('#sc-ok');
  const sc2 = (await pm(page, 'pm.doc.pages[1].scale')) as any;
  expect(sc2.factor * 72).toBeCloseTo(20, 6);
  await page.keyboard.press('1');
  await clickUser(page, 1, 200, 400);
  await clickUser(page, 1, 272, 400);
  ms = await markups(page);
  const len2 = ms.find((m) => m.type === 'm-length' && m.id !== lenId);
  expect(((await pm(page, `pm.measure('${len2.id}')`)) as any).value).toBeCloseTo(20, 2);

  // ---- select the first length and restyle it ----
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 580));
  await page.waitForTimeout(200);
  await page.keyboard.press('v');
  await clickUser(page, 0, 150, 600);
  expect(await pm(page, 'pm.selection()')).toEqual([lenId]);
  await page.click('[data-rt="props"]');
  await expect(page.locator('#p-measure')).toContainText('20.00 ft');
  await setVal(page, '#p-stroke', '#00aa00');
  await setVal(page, '#p-opacity', '60');
  await setVal(page, '#p-width', '3');
  await page.selectOption('#p-dash', 'dashed');
  let st = ((await markups(page)).find((m) => m.id === lenId)).style;
  expect(st).toMatchObject({ stroke: '#00aa00', opacity: 0.6, width: 3, dash: 'dashed' });
  const line = page.locator(`.mk[data-id="${lenId}"] path[stroke="#00aa00"]`).first();
  await expect(line).toHaveAttribute('stroke-width', '3');
  await expect(line).toHaveAttribute('stroke-opacity', '0.6');
  await expect(line).toHaveAttribute('stroke-dasharray', /\d/);
  // undo / redo
  await page.keyboard.press('Control+z');
  expect(((await markups(page)).find((m) => m.id === lenId)).style.dash).toBe('solid');
  await page.keyboard.press('Control+y');
  expect(((await markups(page)).find((m) => m.id === lenId)).style.dash).toBe('dashed');

  // ---- layers: new layer, assign area, hide / show ----
  await page.click('[data-rt="layers"]');
  page.once('dialog', (d) => d.accept('Wetland Delineation'));
  await page.click('#ly-add');
  await expect(page.locator('.layer .name', { hasText: 'Wetland Delineation' })).toBeVisible();
  await page.keyboard.press('v');
  await clickUser(page, 0, 370, 470);
  expect(await pm(page, 'pm.selection()')).toEqual([area.id]);
  await page.click('[data-rt="props"]');
  await page.selectOption('#p-layer', { label: 'Wetland Delineation' });
  const newLayerId = ((await markups(page)).find((m) => m.id === area.id)).layer;
  expect(newLayerId).not.toBe('markups');
  await page.click('[data-rt="layers"]');
  const row = page.locator(`.layer[data-layer="${newLayerId}"] .ly-vis`);
  await row.uncheck();
  await expect(page.locator(`.mk[data-id="${area.id}"]`)).toHaveCount(0);
  await row.check();
  await expect(page.locator(`.mk[data-id="${area.id}"]`)).toHaveCount(1);

  // ---- CSV ----
  await page.click('[data-rt="markups"]');
  await expect(page.locator('#ml-totals')).toContainText('100.00 sq ft');
  const csvPath = await saveDownload(page, () => page.click('#ml-csv'), 'markups.csv');
  const csv = readFileSync(csvPath, 'utf8');
  expect(csv).toContain('Length');
  expect(csv).toMatch(/Area,Wetland Delineation,100\.00 sq ft \(0\.002 ac\),100,sq ft,0\.002296/);
  expect(csv).toMatch(/TOTAL,Count,.*3/);

  // ---- export with editable annotations ----
  await page.click('#btn-export');
  const editable = await saveDownload(page, () => page.click('#ex-ok'), 'editable.pdf');
  expect(pdfinfoPages(editable)).toBe(3);
  expect((await qpdfCheck(editable)).code).toBe(0);
  const ed = await loadPdf(editable);
  const an = annots(ed, 0);
  const lineA = an.find((d) => name(d, 'Subtype') === '/Line')!;
  expect(lineA).toBeTruthy();
  expect(name(lineA, 'IT')).toBe('/LineDimension');
  expect(nums(lineA, 'C').map((v) => +v.toFixed(2))).toEqual([0, 0.67, 0]);
  expect(Number(lineA.get(PDFName.of('CA'))!.toString())).toBeCloseTo(0.6, 3);
  const bs = lineA.lookup(PDFName.of('BS'), PDFDict);
  expect(Number(bs.get(PDFName.of('W'))!.toString())).toBe(3);
  expect(bs.get(PDFName.of('S'))!.toString()).toBe('/D');
  expect(lineA.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))).toBeTruthy();
  const meas = lineA.lookup(PDFName.of('Measure'), PDFDict);
  const x0 = meas.lookup(PDFName.of('X'), PDFArray).lookup(0, PDFDict);
  expect(x0.lookup(PDFName.of('C'), PDFNumber).asNumber()).toBeCloseTo(0.1, 6);
  expect(text(x0.get(PDFName.of('U')))).toBe('ft');
  const poly = an.find((d) => name(d, 'Subtype') === '/Polygon' && name(d, 'IT') === '/PolygonDimension')!;
  expect(poly).toBeTruthy();
  expect(text(poly.get(PDFName.of('Contents')))).toContain('100.00 sq ft');
  expect(an.some((d) => name(d, 'Subtype') === '/PolyLine' && name(d, 'IT') === '/PolyLineDimension')).toBe(true);
  expect(an.filter((d) => name(d, 'Subtype') === '/Circle')).toHaveLength(3); // count markers
  // markup layer -> OCG, and the area annotation is tied to it
  expect(ocgNames(ed)).toContain('Wetland Delineation');
  const oc = poly.lookup(PDFName.of('OC'), PDFDict);
  expect(text(oc.get(PDFName.of('Name')))).toBe('Wetland Delineation');
  // scale viewport (/VP /Measure) written on calibrated pages
  const vp = ed.getPage(0).node.lookup(PDFName.of('VP'), PDFArray).lookup(0, PDFDict);
  const vpx = vp.lookup(PDFName.of('Measure'), PDFDict).lookup(PDFName.of('X'), PDFArray).lookup(0, PDFDict);
  expect(vpx.lookup(PDFName.of('C'), PDFNumber).asNumber()).toBeCloseTo(0.1, 6);
  expect(annots(ed, 1).some((d) => name(d, 'IT') === '/LineDimension')).toBe(true);
  // poppler renders the annotation appearance: green, semi-transparent line at y=600
  const r1 = renderPage(editable, 1);
  const [R, G] = r1.px(150, 600);
  expect(G - R).toBeGreaterThan(50);

  // ---- export flattened ----
  await page.click('#btn-export');
  await page.check('input[name=ex-mode][value=flatten]');
  const flat = await saveDownload(page, () => page.click('#ex-ok'), 'flattened.pdf');
  expect(pdfinfoPages(flat)).toBe(3);
  expect((await qpdfCheck(flat)).code).toBe(0);
  const fl = await loadPdf(flat);
  for (let i = 0; i < 3; i++) expect(annots(fl, i).filter((d) => d.has(PDFName.of('PMID')))).toHaveLength(0);
  const t1 = pdftext(flat, 1);
  expect(t1).toContain('20.00 ft');
  expect(t1).toContain('100.00 sq ft');
  expect(t1).toContain('16.00 ft');
  expect(pdftext(flat, 2)).toContain('20.00 ft');
  const r2 = renderPage(flat, 1);
  const [R2, G2] = r2.px(150, 600);
  expect(G2 - R2).toBeGreaterThan(50);
  // flattened markups still sit inside their PDF layer
  expect(ocgNames(fl)).toContain('Wetland Delineation');
  // and the editable original is untouched in the app
  expect((await markups(page)).length).toBe(5);

  // ---- round trip: reopen the editable PDF, markups come back as editable objects ----
  await page.setInputFiles('#file-open', editable);
  await expect.poll(() => pm(page, 'pm.docs.length')).toBe(2);
  await waitRendered(page);
  const back = await markups(page);
  expect(back).toHaveLength(5);
  const backLen = back.find((m) => m.type === 'm-length' && m.style.stroke === '#00aa00');
  expect(((await pm(page, `pm.measure('${backLen.id}')`)) as any).value).toBeCloseTo(20, 2);
  expect(((await pm(page, 'pm.doc.layers')) as any[]).map((l) => l.name)).toContain('Wetland Delineation');
  // no duplicate annotations rendered underneath (our own annots were stripped on load)
  const src = (await pm(page, 'pm.doc.pages[0].src')) as string;
  expect(src).toBeTruthy();
});
