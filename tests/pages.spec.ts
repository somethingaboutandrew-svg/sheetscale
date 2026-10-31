import { test, expect, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { boot, open, saveDownload, loadPdf, pdfinfoPages, waitRendered, renderPage, FIX, qpdfCheck, sh, offNames, ocgNames, setZoom, clickUser, annots, name } from './helpers';

const pm = (page: Page, expr: string) => page.evaluate(`(() => { const pm = window.__pm; return ${expr}; })()`);

test('combine PDFs, reorder by drag, rotate, delete, extract', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1400 }); // keep all 5 thumbnails on screen for drag & drop
  await boot(page);
  await open(page, 'sample.pdf');
  await open(page, 'second.pdf');
  expect(await pm(page, 'pm.docs.length')).toBe(2);
  await page.click('#btn-combine');
  await expect(page.locator('#cb-list .it')).toHaveCount(2);
  // put second.pdf first
  await page.locator('#cb-list .it').nth(1).locator('button[title="Move up"]').click();
  await expect(page.locator('#cb-list .it').first()).toContainText('second.pdf');
  await page.fill('#cb-name', 'Merged set');
  await page.click('#cb-ok');
  await expect.poll(() => pm(page, 'pm.doc.name')).toBe('Merged set.pdf');
  await expect(page.locator('.page')).toHaveCount(5);
  await expect(page.locator('.thumb')).toHaveCount(5);
  const srcName = (i: number) => pm(page, `(() => { const p = pm.doc.pages[${i}]; return pm.docs.flatMap(d => d.pages).length && p.index; })()`);
  void srcName;

  // export merged -> 5 pages
  const merged = await saveDownload(page, () => page.click('#btn-save'), 'merged.pdf');
  expect(pdfinfoPages(merged)).toBe(5);
  expect(sh('pdftotext', ['-f', '1', '-l', '1', merged, '-'])).toContain('SECOND FILE PAGE 1');
  expect(sh('pdftotext', ['-f', '3', '-l', '3', merged, '-'])).toContain('SAMPLE SITE PLAN');

  // drag thumbnail 5 (sample p3) to the top
  const before = (await pm(page, 'pm.doc.pages.map(p => p.uid)')) as string[];
  await page.locator('.thumb').nth(4).dragTo(page.locator('.thumb').nth(3), { targetPosition: { x: 20, y: 5 } });
  await expect.poll(() => pm(page, 'pm.doc.pages[3].uid')).toBe(before[4]);
  await expect(page.locator('.thumb').nth(3)).toHaveAttribute('data-uid', before[4]);
  for (const i of [3, 2, 1]) {
    await page.locator('.thumb').nth(i).scrollIntoViewIfNeeded();
    await page.locator('.thumb').nth(i).dragTo(page.locator('.thumb').nth(i - 1), { targetPosition: { x: 20, y: 5 } });
    await expect.poll(() => pm(page, `pm.doc.pages[${i - 1}].uid`)).toBe(before[4]);
    await expect(page.locator('.thumb').nth(i - 1)).toHaveAttribute('data-uid', before[4]);
  }
  await expect.poll(() => pm(page, 'pm.doc.pages[0].uid')).toBe(before[4]);
  // rotate the new first page right, delete page 2
  await page.locator('.thumb').nth(0).click();
  await page.click('#pg-rotr');
  expect(await pm(page, 'pm.doc.pages[0].rot')).toBe(90);
  await page.locator('.thumb').nth(1).click();
  page.once('dialog', (d) => d.accept());
  await page.click('#pg-del');
  await expect(page.locator('.page')).toHaveCount(4);
  const out = await saveDownload(page, () => page.click('#btn-save'), 'reordered.pdf');
  expect(pdfinfoPages(out)).toBe(4);
  const d = await loadPdf(out);
  // sample p3 already had /Rotate 90, +90 => 180
  expect(d.getPage(0).getRotation().angle).toBe(180);
  expect(sh('pdftotext', ['-f', '1', '-l', '1', out, '-'])).toContain('SHEET 3');
  expect(sh('pdftotext', ['-f', '2', '-l', '2', out, '-'])).toContain('SECOND FILE PAGE 2');
  expect((await qpdfCheck(out)).code).toBe(0);

  // extract pages 3-4 (shift-click range)
  await page.locator('.thumb').nth(2).click();
  await page.locator('.thumb').nth(3).click({ modifiers: ['Shift'] });
  const ex = await saveDownload(page, () => page.click('#pg-extract'), 'extract.pdf');
  expect(pdfinfoPages(ex)).toBe(2);

  // undo the delete brings the page back
  await page.keyboard.press('Control+z');
  await expect(page.locator('.page')).toHaveCount(5);
});

test('lossless reduce: smaller file, pixel-identical pages', async ({ page }) => {
  await boot(page);
  await page.click('#btn-reduce');
  await page.setInputFiles('#rd-input', FIX + 'bloated.pdf');
  await expect(page.locator('.rd-after')).toBeVisible({ timeout: 30000 });
  const beforeB = +(await page.locator('.rd-before').getAttribute('data-bytes'))!;
  const afterB = +(await page.locator('.rd-after').getAttribute('data-bytes'))!;
  const out = await saveDownload(page, () => page.click('.rd-dl'), 'reduced.pdf');
  const orig = FIX + 'bloated.pdf';
  expect(beforeB).toBe(statSync(orig).size);
  expect(statSync(out).size).toBe(afterB);
  expect(afterB).toBeLessThan(beforeB * 0.6);
  console.log(`reduce: ${beforeB} -> ${afterB} bytes (${((1 - afterB / beforeB) * 100).toFixed(1)}% smaller)`);
  expect(pdfinfoPages(out)).toBe(4);
  expect((await qpdfCheck(out)).code).toBe(0);
  for (let p = 1; p <= 4; p++) {
    const a = renderPage(orig, p, 100), b = renderPage(out, p, 100);
    expect(b.w).toBe(a.w);
    expect(Buffer.compare(a.raw, b.raw)).toBe(0); // identical pixels
  }
  // image kept at full resolution
  const li = (f: string) => sh('pdfimages', ['-list', f]).split('\n').slice(2).filter(Boolean).map((l) => l.trim().split(/\s+/).slice(3, 5).join('x'));
  expect(li(out)).toEqual(li(orig));
});

test('PDF layers (OCG): list, toggle visibility on canvas, carried to export', async ({ page }) => {
  await boot(page);
  await open(page, 'layers.pdf');
  await page.click('[data-rt="layers"]');
  const wet = page.locator('#pdf-layers .layer', { hasText: 'Wetlands' }).locator('input');
  const roads = page.locator('#pdf-layers .layer', { hasText: 'Roads' }).locator('input');
  await expect(wet).toBeChecked();
  await expect(roads).toBeChecked();
  const pixel = (x: number, y: number) => page.evaluate(([x, y]) => {
    const el = document.querySelector('.page') as HTMLElement;
    const c = el.querySelector('canvas.base') as HTMLCanvasElement;
    const k = c.width / 612;
    const d = c.getContext('2d')!.getImageData(Math.round(x * k), Math.round((792 - y) * k), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  await waitRendered(page);
  await expect.poll(() => pixel(200, 500)).toEqual([0, 153, 0]);
  await wet.uncheck();
  await expect.poll(() => pixel(200, 500)).toEqual([255, 255, 255]);
  // Roads still visible
  expect((await pixel(350, 300))[0]).toBeLessThan(60);
  // export keeps both OCGs, Wetlands OFF by default
  const out = await saveDownload(page, () => page.click('#btn-save'), 'layers-out.pdf');
  const d = await loadPdf(out);
  expect(ocgNames(d)).toEqual(expect.arrayContaining(['Wetlands', 'Roads']));
  expect(offNames(d)).toEqual(['Wetlands']);
  const r = renderPage(out, 1);
  expect(r.px(200, 500)).toEqual([255, 255, 255]);
  await wet.check();
  await expect.poll(() => pixel(200, 500)).toEqual([0, 153, 0]);
});

test('images to PDF (PNG + TIFF + JPG)', async ({ page }) => {
  await boot(page);
  await page.setInputFiles('#file-open', [FIX + 'image.png', FIX + 'image.tif']);
  await expect.poll(() => pm(page, 'pm.doc?.pages.length')).toBe(2);
  await waitRendered(page);
  const out = await saveDownload(page, () => page.click('#btn-save'), 'images.pdf');
  expect(pdfinfoPages(out)).toBe(2);
  const r = renderPage(out, 2, 96);
  expect(r.w).toBe(480); // 480 px image at 96 dpi
  const [R, G, B] = r.px(240 * 0.75, 180 * 0.75); // centre of the green ellipse
  expect(G).toBeGreaterThan(100);
  expect(R).toBeLessThan(40);
  void B;
  await page.setInputFiles('#file-open', [FIX + 'image.jpg']);
  await expect.poll(() => pm(page, 'pm.docs.length')).toBe(2);
  expect(await pm(page, 'pm.doc.pages.length')).toBe(1);
});

test('autosave: markups survive a page reload', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await setZoom(page, 0.75);
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 500));
  await page.keyboard.press('r');
  await clickUser(page, 0, 100, 450);
  await clickUser(page, 0, 250, 550);
  expect(await pm(page, 'pm.doc.markups.length')).toBe(1);
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  await expect.poll(() => pm(page, 'pm.doc?.markups.length')).toBe(1);
  expect(await pm(page, 'pm.doc.markups[0].type')).toBe('rect');
  await expect(page.locator('.mk')).toHaveCount(1);
});

test('every markup tool creates a real PDF annotation', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await setZoom(page, 0.75);
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 500));
  await page.evaluate(() => (window as any).__pm.setSnap(false));
  const drag = async (key: string, a: [number, number], b: [number, number]) => {
    await page.keyboard.press(key);
    await clickUser(page, 0, ...a);
    await clickUser(page, 0, ...b);
  };
  // pen (press-drag-release)
  await page.keyboard.press('p');
  const { at } = await import('./helpers');
  let p0 = await at(page, 0, 60, 700);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { const q = await at(page, 0, 60 + i * 8, 700 + (i % 2) * 10); await page.mouse.move(q.x, q.y); }
  await page.mouse.up();
  await drag('l', [60, 660], [200, 660]);
  await drag('a', [60, 630], [200, 630]);
  await page.keyboard.press('y');
  for (const pt of [[250, 700], [300, 660], [350, 700]] as [number, number][]) await clickUser(page, 0, ...pt);
  await page.keyboard.press('Enter');
  await page.keyboard.press('g');
  for (const pt of [[400, 700], [480, 700], [440, 640]] as [number, number][]) await clickUser(page, 0, ...pt);
  await page.keyboard.press('Enter');
  await drag('r', [60, 520], [160, 580]);
  await drag('e', [180, 520], [280, 580]);
  await drag('c', [300, 520], [420, 590]);
  await drag('i', [440, 520], [540, 560]);
  // text box: click, type, commit
  await page.keyboard.press('t');
  await clickUser(page, 0, 60, 480);
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('Wetland boundary flagged 10/31');
  await page.keyboard.press('Control+Enter');
  // callout: tip, then box location
  await page.keyboard.press('q');
  await clickUser(page, 0, 300, 450);
  await clickUser(page, 0, 360, 480);
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('Verify culvert');
  await page.keyboard.press('Control+Enter');
  const types = (await pm(page, 'pm.doc.markups.map(m => m.type)')) as string[];
  expect(types.sort()).toEqual(['arrow', 'callout', 'cloud', 'ellipse', 'highlight', 'line', 'pen', 'polygon', 'polyline', 'rect', 'text'].sort());
  expect(await pm(page, `pm.doc.markups.find(m => m.type === 'text').text`)).toBe('Wetland boundary flagged 10/31');
  const out = await saveDownload(page, () => page.click('#btn-save'), 'all-tools.pdf');
  const d = await loadPdf(out);
  const subs = annots(d, 0).map((a) => name(a, 'Subtype')).sort();
  expect(subs).toEqual(['/Circle', '/FreeText', '/FreeText', '/Highlight', '/Ink', '/Line', '/Line', '/Polygon', '/Polygon', '/PolyLine', '/Square'].sort());
  expect(sh('pdftotext', ['-f', '1', '-l', '1', out, '-'])).toContain('Verify culvert');
  expect((await qpdfCheck(out)).code).toBe(0);
  void readFileSync;
});
