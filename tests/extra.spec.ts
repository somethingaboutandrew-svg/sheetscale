import { test, expect, type Page } from '@playwright/test';
import { boot, open, setZoom, clickUser, saveDownload, renderPage, pdfinfoPages, waitRendered, FIX } from './helpers';

const pm = (page: Page, expr: string) => page.evaluate(`(() => { const pm = window.__pm; return ${expr}; })()`);

test('markups on a rotated page land in the same place in the exported PDF', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await setZoom(page, 0.75);
  await page.evaluate(() => (window as any).__pm.centerOn(2, 306, 396));
  await waitRendered(page);
  expect((await pm(page, 'pm.pageBox(2)') as any).rot).toBe(90);
  await page.keyboard.press('r');
  await clickUser(page, 2, 200, 300);
  await clickUser(page, 2, 300, 450);
  const id = await pm(page, 'pm.doc.markups[0].id');
  // make it a solid blue fill
  await page.keyboard.press('v');
  await clickUser(page, 2, 200, 375);
  expect(await pm(page, 'pm.selection()')).toEqual([id]);
  await page.evaluate(() => {
    const on = document.querySelector('#p-fill-on') as HTMLInputElement; on.checked = true; on.dispatchEvent(new Event('change'));
    const f = document.querySelector('#p-fill') as HTMLInputElement; f.value = '#0000ff'; f.dispatchEvent(new Event('change'));
    const o = document.querySelector('#p-fill-opacity') as HTMLInputElement; o.value = '100'; o.dispatchEvent(new Event('change'));
  });
  const box = (await pm(page, 'pm.pageBox(2)')) as any;
  const c = (await pm(page, 'pm.userToClient(2, 250, 375)')) as any;
  const fx = (c.x - box.left) / box.width, fy = (c.y - box.top) / box.height;
  await page.click('#btn-export');
  await page.check('input[name=ex-mode][value=flatten]');
  const flat = await saveDownload(page, () => page.click('#ex-ok'), 'rotated-flat.pdf');
  const r = renderPage(flat, 3, 72);
  expect(r.w).toBe(792); // displayed landscape
  const i = (Math.round(fy * r.h) * r.w + Math.round(fx * r.w)) * 3;
  expect([r.data[i], r.data[i + 1], r.data[i + 2]]).toEqual([0, 0, 255]);
  const ed = await saveDownload(page, () => page.click('#btn-save'), 'rotated-ed.pdf');
  const r2 = renderPage(ed, 3, 72);
  expect([r2.data[i], r2.data[i + 1], r2.data[i + 2]]).toEqual([0, 0, 255]);
});

test('owner-password-protected PDF opens (decrypted locally with qpdf)', async ({ page }) => {
  await boot(page);
  await open(page, 'encrypted.pdf');
  await expect(page.locator('.page')).toHaveCount(3);
  await setZoom(page, 0.75);
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 500));
  await page.keyboard.press('r');
  await clickUser(page, 0, 100, 450);
  await clickUser(page, 0, 200, 550);
  const out = await saveDownload(page, () => page.click('#btn-save'), 'decrypted-annotated.pdf');
  expect(pdfinfoPages(out)).toBe(3);
});

test('PWA: manifest + service worker, app reloads offline', async ({ page, context }) => {
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto('./');
  await page.waitForSelector('body[data-ready="1"]');
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the SW
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  await page.setInputFiles('#file-open', FIX + 'sample.pdf');
  await expect(page.locator('.page')).toHaveCount(3);
  await waitRendered(page);
  // qpdf WebAssembly (worker + wasm) must also come from the SW cache while offline
  await page.click('#btn-reduce');
  await page.setInputFiles('#rd-input', FIX + 'bloated.pdf');
  await expect(page.locator('.rd-after')).toBeVisible({ timeout: 30000 });
  await context.setOffline(false);
});
