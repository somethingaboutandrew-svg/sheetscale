// Drives the packaged desktop app (Linux build of the same Electron shell) with Playwright.
import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const OUT = '/tmp/planmark-desktop-test/';
test.setTimeout(180_000);

test('desktop shell: open-file event, measure, native Save, File>Open, qpdf reduce', async () => {
  rmSync(OUT, { recursive: true, force: true });
  execFileSync('mkdir', ['-p', OUT]);
  const app = await electron.launch({
    executablePath: new URL('../desktop/release/linux-unpacked/planmark-desktop', import.meta.url).pathname,
    args: ['--no-sandbox', `--user-data-dir=${OUT}profile`],
  });
  const page = await app.firstWindow();
  const external: string[] = [];
  page.on('request', (r) => { if (!/^(app|blob|data):/.test(r.url())) external.push(r.url()); });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
  await page.waitForSelector('body[data-ready="1"]');
  expect(page.url()).toBe('app://planmark/index.html');
  expect(await page.evaluate(() => typeof (window as any).planmarkNative)).toBe('object');
  expect(await page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(false);

  // macOS "Open With" / dock drop path
  await app.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), FIX + 'sample.pdf');
  await expect(page.locator('.page')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => (window as any).__pm.rendered())).toBe(true);

  // calibrate 100 pt = 10 ft, then a 200 pt length
  await page.evaluate(() => { (window as any).__pm.setZoom(0.75); });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__pm.centerOn(0, 306, 600));
  const at = (x: number, y: number) => page.evaluate(([x, y]) => (window as any).__pm.userToClient(0, x, y), [x, y]);
  await page.keyboard.press('k');
  for (const [x, y] of [[100, 650], [200, 650]]) { const p = await at(x, y); await page.mouse.click(p.x, p.y); }
  await page.fill('#cal-value', '10');
  await page.selectOption('#cal-unit', 'ft');
  await page.click('#cal-ok');
  for (const [x, y] of [[100, 600], [300, 600]]) { const p = await at(x, y); await page.mouse.click(p.x, p.y); }
  const id = await page.evaluate(() => (window as any).__pm.doc.markups[0].id);
  expect((await page.evaluate((id) => (window as any).__pm.measure(id), id)).value).toBeCloseTo(20, 2);

  // native Save dialog (stubbed to a path) via the File > Save menu item
  const target = OUT + 'saved-from-desktop.pdf';
  await app.evaluate(({ dialog }, t) => { (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: t }); }, target);
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
    file.submenu!.items.find((i) => i.label === 'Save')!.click();
  });
  await expect.poll(() => existsSync(target), { timeout: 20000 }).toBe(true);
  await expect.poll(() => statSync(target).size).toBeGreaterThan(1000);
  expect(execFileSync('pdfinfo', [target], { encoding: 'utf8' })).toMatch(/Pages:\s+3/);
  expect(execFileSync('pdftotext', ['-f', '1', '-l', '1', target, '-'], { encoding: 'utf8' })).toContain('20.00 ft');

  // File > Open… (stubbed dialog)
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, FIX + 'second.pdf');
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
    file.submenu!.items.find((i) => i.label === 'Open…')!.click();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__pm.docs.length)).toBe(2);

  // qpdf WebAssembly worker works under app://
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!.submenu!.items.find((i) => i.label === 'Reduce File Size…')!.click();
  });
  await page.setInputFiles('#rd-input', FIX + 'bloated.pdf');
  await expect(page.locator('.rd-after')).toBeVisible({ timeout: 30000 });
  const after = +(await page.locator('.rd-after').getAttribute('data-bytes'))!;
  expect(after).toBeLessThan(statSync(FIX + 'bloated.pdf').size * 0.6);
  await page.screenshot({ path: OUT + 'desktop.png' });
  expect(external, 'no network requests: works offline').toEqual([]);
  await app.close();
});

test('desktop shell: PDF passed at launch (before renderer is ready) is queued and opened', async () => {
  const app = await electron.launch({
    executablePath: new URL('../desktop/release/linux-unpacked/planmark-desktop', import.meta.url).pathname,
    args: ['--no-sandbox', `--user-data-dir=${OUT}profile2`, FIX + 'layers.pdf'],
  });
  const page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => (window as any).__pm?.docs?.length ?? 0), { timeout: 20000 }).toBe(1);
  await app.close();
});
