// Builds a realistic scene and saves screenshots to screenshots/v3: once in the default
// Liquid Glass light theme and once in the dark theme (also an end-to-end check).
import { test, expect, type Page } from '@playwright/test';
import { boot, open, clickUser, at, waitRendered, FIX } from './helpers';

import { mkdirSync } from 'node:fs';
const SHOTS = new URL('../screenshots/v3/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const pm = (page: Page, expr: string) => page.evaluate(`(() => { const pm = window.__pm; return ${expr}; })()`);
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

function bez(p0: number[], p1: number[], p2: number[], p3: number[], n: number) {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return out;
}

for (const theme of ['light', 'dark'] as const) test(`screenshots (${theme})`, async ({ page }) => {
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}${name}-${theme}.png` });
  await page.emulateMedia({ colorScheme: theme });
  // light is the default (nothing stored); dark is picked in the Appearance menu
  if (theme === 'dark') await page.addInitScript(() => localStorage.setItem('pm.theme', 'dark'));
  await boot(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  await shot('00-start-screen');
  await page.evaluate(() => localStorage.setItem('pm.author', 'Andrew Pocta'));
  await open(page, 'demo-plan.pdf');
  await page.click('#fit-page');
  await page.waitForTimeout(300);
  await waitRendered(page);
  await pm(page, 'pm.setSnap(false)');

  // calibrate on the graphic scale bar: 0 to 100 ft
  await page.keyboard.press('k');
  await clickUser(page, 0, 945, 433);
  await clickUser(page, 0, 1089, 433);
  await page.fill('#cal-value', '100');
  await page.selectOption('#cal-unit', 'ft');
  await shot('01-calibrate-on-scale-bar');
  await page.click('#cal-ok');
  await page.waitForTimeout(2800); // let the toast fade before later shots

  // layer for the delineation
  await page.click('[data-rt="layers"]');
  page.once('dialog', (d) => d.accept('Wetland Delineation'));
  await page.click('#ly-add');
  // wetland area traced along its boundary
  await page.keyboard.press('4');
  const ring = [
    ...bez([380, 300], [450, 395], [560, 430], [640, 400], 5),
    ...bez([640, 400], [700, 370], [690, 300], [620, 270], 4),
    ...bez([620, 270], [540, 230], [420, 240], [380, 300], 4),
  ];
  for (const [x, y] of ring) await clickUser(page, 0, x, y);
  await page.keyboard.press('Enter');
  // wetland flags count
  await page.keyboard.press('5');
  for (const [x, y] of [[395, 318], [470, 392], [600, 418], [668, 352], [610, 268], [470, 246]]) await clickUser(page, 0, x, y);
  await page.keyboard.press('Escape');
  // stream length (polylength)
  await page.keyboard.press('2');
  for (const [x, y] of [[60, 300], [140, 336], [220, 334], [300, 290], [380, 300]]) await clickUser(page, 0, x, y);
  const end = await at(page, 0, 380, 300);
  await page.mouse.dblclick(end.x, end.y);
  // buffer distance from wetland edge to road
  await page.keyboard.press('1');
  await clickUser(page, 0, 540, 418);
  await clickUser(page, 0, 540, 588);

  // review comments layer: cloud + callout + highlight
  await page.click('[data-rt="layers"]');
  page.once('dialog', (d) => d.accept('Review Comments'));
  await page.click('#ly-add');
  await page.keyboard.press('c');
  await clickUser(page, 0, 650, 330);
  await clickUser(page, 0, 700, 375);
  await page.keyboard.press('q');
  await clickUser(page, 0, 690, 365);
  await clickUser(page, 0, 735, 520);
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('Confirm WL-4 flag location in field; boundary may extend east.');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('i');
  await clickUser(page, 0, 940, 600);
  await clickUser(page, 0, 1000, 620);
  await page.keyboard.press('v');
  // select the wetland area to show its properties
  await clickUser(page, 0, 560, 380);
  await page.click('[data-rt="props"]');
  await expect(page.locator('#p-measure')).toContainText('acres');
  await page.hover('[data-tool="m-area"]');
  await expect(page.locator('#tip.show')).toBeVisible();
  await page.waitForTimeout(200);
  await shot('02-main-area-selected');
  await page.mouse.move(5, 500);
  await page.locator('.swatches[data-for="p-stroke"] .sw.more').click();
  await expect(page.locator('.pop.more-pop')).toBeVisible();
  await page.waitForTimeout(150);
  await shot('02b-more-colours-popover');
  await page.keyboard.press('Escape');

  await page.click('[data-rt="markups"]');
  await page.waitForTimeout(200);
  await shot('03-markups-list-and-totals');

  await page.click('[data-rt="layers"]');
  await expect(page.locator('#pdf-layers .layer')).toHaveCount(3);
  await page.locator('#pdf-layers .layer', { hasText: 'Topography' }).locator('input').uncheck();
  await page.waitForTimeout(600);
  await waitRendered(page);
  await shot('04-layers-topo-hidden');
  await page.locator('#pdf-layers .layer', { hasText: 'Topography' }).locator('input').check();

  // zoomed-in detail (crisp vector rendering at 400%)
  await page.evaluate(() => (window as any).__pm.setZoom(4));
  await page.evaluate(() => (window as any).__pm.centerOn(0, 600, 380));
  await page.waitForTimeout(900);
  await shot('05-zoomed-detail-400pct');
  await page.click('#fit-page');
  await page.waitForTimeout(400);

  // save dialog
  await page.click('#btn-export');
  await shot('06-export-editable-or-flattened');
  await page.keyboard.press('Escape');

  // combine dialog
  await page.click('#btn-combine');
  await page.setInputFiles('#cb-file', FIX + 'demo-sheet2.pdf');
  await expect(page.locator('#cb-list .it')).toHaveCount(2);
  await shot('07-combine');
  await page.keyboard.press('Escape');

  // reduce dialog on a bloated file
  await page.click('#btn-reduce');
  await page.setInputFiles('#rd-input', FIX + 'bloated.pdf');
  await expect(page.locator('.rd-after')).toBeVisible({ timeout: 30000 });
  await shot('08-reduce-size-lossless');
  await page.keyboard.press('Escape');

  // shortcuts sheet, then close everything: the start screen now lists recent files
  await page.locator('#viewer').focus();
  await page.keyboard.press('?');
  await shot('09-shortcuts');
  await page.keyboard.press('Escape');
  await open(page, 'demo-sheet2.pdf');
  for (let n = await page.locator('.tab').count(); n > 0; n--) {
    await page.locator('.tab .x').first().click();
    await expect(page.locator('.tab')).toHaveCount(n - 1);
  }
  await expect.poll(() => page.locator('.rc').count()).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  await shot('10-start-screen-recent');
});
