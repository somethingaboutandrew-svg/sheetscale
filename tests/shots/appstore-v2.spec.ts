// App Store screenshots v2: the real SheetScale web build (light Liquid Glass theme, 1440x900 @2x)
// driven through a review of an original, fictional CAD drawing set (scripts/make-cad-set.mjs).
// Raw captures go to screenshots/v4/; scripts/appstore-screenshots-v2.py turns them into the set.
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, copyFileSync } from 'node:fs';
import { boot, open, clickUser, at, waitRendered, FIX } from '../helpers';

const SHOTS = new URL('../../screenshots/v4/', import.meta.url).pathname;
const TMP = new URL('../../test-results/shots-v2/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(TMP, { recursive: true });
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

// plan coordinates: feet from the building's SW outside corner -> PDF points (1/4" = 1'-0")
const X = (ft: number) => 240 + ft * 18, Y = (ft: number) => 330 + ft * 18;
const base = { stroke: '#e11d48', fill: null, opacity: 1, fillOpacity: 0.3, width: 1.5, dash: 'solid', startHead: 'none', endHead: 'none', fontSize: 12, textColor: '#c81e1e' };
const RED = '#dc2626', BLUE = '#2563eb', GREEN = '#16a34a';
const STYLES = {
  pen: { ...base }, line: { ...base }, arrow: { ...base, endHead: 'closed' }, polyline: { ...base }, rect: { ...base }, ellipse: { ...base },
  polygon: { ...base, stroke: GREEN, fill: '#22c55e', fillOpacity: 0.22, width: 1.6 },
  cloud: { ...base, stroke: RED, width: 2, dash: 'cloud' },
  text: { ...base, stroke: BLUE, fill: '#eff6ff', fillOpacity: 0.95, width: 1, fontSize: 15, textColor: '#1e3a8a' },
  callout: { ...base, stroke: RED, width: 1.4, fill: '#ffffff', fillOpacity: 1, endHead: 'closed', fontSize: 16, textColor: '#b91c1c' },
  highlight: { ...base, stroke: '#facc15', fill: '#fde047', fillOpacity: 0.45, width: 0 },
  'm-length': { ...base, stroke: BLUE, startHead: 'closed', endHead: 'closed', fontSize: 18, width: 1.8 },
  'm-polylength': { ...base, stroke: BLUE, fontSize: 18, width: 2 },
  'm-perimeter': { ...base, stroke: '#7c3aed', fontSize: 15, width: 2 },
  'm-area': { ...base, stroke: BLUE, fill: '#3b82f6', fillOpacity: 0.16, fontSize: 18, width: 1.8 },
  'm-count': { ...base, stroke: '#ea580c', fill: '#ea580c', fontSize: 13, width: 2 },
};
const PRESETS = [
  ['Revision cloud', 'cloud', STYLES.cloud], ['Review callout', 'callout', STYLES.callout], ['Coordination note', 'text', STYLES.text],
  ['Floor area takeoff', 'm-area', STYLES['m-area']], ['Wall length', 'm-length', STYLES['m-length']], ['Door count', 'm-count', STYLES['m-count']],
  ['Phase 2 zone', 'polygon', STYLES.polygon], ['Approval stamp', 'text', { ...STYLES.text, stroke: RED, fill: '#ffffff', width: 3, fontSize: 24, textColor: RED }],
].map(([name, tool, style], i) => ({ id: `p${i}`, name, tool, style }));

async function click(page: Page, ft: [number, number], pt = false) {
  await clickUser(page, 0, pt ? ft[0] : X(ft[0]), pt ? ft[1] : Y(ft[1]));
}
async function poly(page: Page, key: string, pts: [number, number][]) {
  await page.keyboard.press(key);
  for (const p of pts) await click(page, p);
  await page.keyboard.press('Enter');
}
async function textBox(page: Page, key: string, a: [number, number], b: [number, number], text: string, pt = false) {
  await page.keyboard.press(key);
  await click(page, a, pt); await click(page, b, pt);
  await page.waitForSelector('.text-editor');
  await page.keyboard.type(text);
  await page.keyboard.press('Control+Enter');
}
async function layer(page: Page, name: string) {
  await page.click('[data-rt="layers"]');
  page.once('dialog', (d) => d.accept(name));
  await page.click('#ly-add');
}
/** edit the newest markup of a type in place (exact geometry/style), then redraw via a no-op layer lock toggle */
async function patch(page: Page, type: string, edit: Record<string, unknown>) {
  await page.evaluate(([type, edit]) => {
    const ms = (window as any).__pm.doc.markups.filter((m: any) => m.type === type);
    const m = ms[ms.length - 1];
    const { style, ...rest } = edit as any;
    Object.assign(m, rest);
    if (style) Object.assign(m.style, style);
  }, [type, edit] as const);
  await page.click('[data-rt="layers"]');
  await page.click('#app-layers .layer.active .ly-lock');
  await page.click('#app-layers .layer.active .ly-lock');
}
async function view(page: Page, zoom: number, cx: number, cy: number) {
  await page.evaluate((z) => (window as any).__pm.setZoom(z), zoom);
  await page.waitForTimeout(500);
  await page.evaluate(([x, y]) => (window as any).__pm.centerOn(0, x, y), [cx, cy]);
  await page.waitForTimeout(700);
  await waitRendered(page);
  await page.waitForTimeout(600);
}

test('App Store screenshots v2', async ({ page }) => {
  const shot = (name: string) => { console.log('shot', name); return page.screenshot({ path: `${SHOTS}${name}.png` }); };
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(([s, p]) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('pm.toolStyles', s); localStorage.setItem('pm.presets', p); localStorage.setItem('pm.author', 'Andrew Pocta');
      sessionStorage.setItem('seeded', '1');
    }
  }, [JSON.stringify(STYLES), JSON.stringify(PRESETS)]);
  await boot(page);
  await open(page, 'harbor-point-CD-set.pdf');
  await page.click('#fit-page');
  await waitRendered(page);
  await page.evaluate(() => (window as any).__pm.setSnap(false));

  // scale: architectural preset on every sheet
  await page.click('[data-rt="scale"]');
  await page.click('#sc-set');
  await page.selectOption('#sc-preset', { label: '1/4" = 1\'-0"' });
  await page.selectOption('#sc-target', 'all');
  await page.click('#sc-ok');
  await page.waitForTimeout(2800);

  // draw at a zoom where the whole sheet is on screen
  await page.evaluate(() => (window as any).__pm.setPanels(false, true));
  await page.click('#fit-page');
  await page.waitForTimeout(600);

  // ── Architect review (red) ──
  await layer(page, 'Architect Review');
  await page.locator('#app-layers .layer', { hasText: 'Markups' }).locator('.ly-del').click(); // start with named layers only
  await page.keyboard.press('c');
  await click(page, [65.2, 13.3]); await click(page, [76.8, 26.9]);
  await page.keyboard.press('c');
  await click(page, [74.6, 55.2]); await click(page, [80.4, 59.4]);
  await textBox(page, 'q', [70.5, 24.5], [52, 38], 'Toilets 113 + 114 lack 60" turning space. Combine into one accessible room. See 3/A-501.');
  await patch(page, 'callout', { pts: [[1150, 1040], [1396, 950], [X(70.2), Y(24.2)]] });
  await textBox(page, 'q', [77.5, 57], [72, 45], 'Lower counter to 34" max with knee space at sink.');
  await patch(page, 'callout', { pts: [[1520, 1150], [1762, 1092], [X(77.2), Y(56.4)]] });
  // approval stamp in the open band beside the notes
  await textBox(page, 't', [1940, 960], [1940, 960], 'APPROVED AS NOTED\nA. POCTA  11.10.2026', true);
  await patch(page, 'text', { pts: [[1912, 985], [2172, 912]], style: { stroke: RED, width: 3, fontSize: 20, textColor: RED, fill: '#ffffff', fillOpacity: 0.9 } });
  await page.keyboard.press('Escape');

  // ── Quantity takeoff (blue) ──
  await layer(page, 'Quantity Takeoff');
  await poly(page, '4', [[48.25, 32.25], [69.75, 32.25], [69.75, 59], [48.25, 59]]); // conference 105
  await poly(page, '4', [[1, 32.25], [11.75, 32.25], [11.75, 59], [1, 59]]); // office 101
  for (const x0 of [12, 24, 36]) await poly(page, '4', [[x0 + 0.25, 32.25], [x0 + 11.75, 32.25], [x0 + 11.75, 59], [x0 + 0.25, 59]]); // offices 102-104
  await page.keyboard.press('1');
  await click(page, [1, 27.2]); await click(page, [87, 27.2]); // corridor length
  await page.keyboard.press('2');
  for (const p of [[0, 61.8], [88, 61.8]] as [number, number][]) await click(page, p);
  const e = await at(page, 0, X(88), Y(61.8));
  await page.mouse.dblclick(e.x, e.y); // north wall run
  await page.keyboard.press('5');
  for (const p of [[9.5, 33.9], [21.5, 33.9], [33.5, 33.9], [45.5, 33.9], [65.5, 33.9], [74.5, 33.9], [31.5, 24.1], [69, 24.1], [74, 24.1], [81.5, 24.1]] as [number, number][]) await click(page, p);
  await page.keyboard.press('Escape');

  // ── Owner notes (green) ──
  await layer(page, 'Owner Notes');
  await poly(page, 'g', [[34.25, 1], [65.75, 1], [65.75, 25.75], [34.25, 25.75]]);
  await textBox(page, 't', [53, 24], [53, 24], 'PHASE 2: owner-furnished workstations (NIC)');
  await patch(page, 'text', { pts: [[X(52.3), Y(25.2)], [X(64.6), Y(21.6)]] });
  await page.keyboard.press('i');
  await click(page, [1922, 1499], true); await click(page, [2206, 1476], true);
  await page.keyboard.press('v');

  // 01 markup on a CAD sheet: select the first cloud so the Style panel shows it
  await page.evaluate(() => (window as any).__pm.setPanels(false, true));
  await page.click('[data-rt="markups"]');
  await page.locator('#right-body .mrow', { hasText: 'Cloud' }).first().click();
  await page.click('[data-rt="props"]');
  await view(page, 0.52, 1600, 1000);
  await page.mouse.move(5, 450);
  await page.waitForTimeout(300);
  await shot('01-markup');

  // 02 measurement + takeoff totals
  await page.keyboard.press('Escape');
  await view(page, 0.5, X(31), Y(43.5));
  await click(page, [59, 36]);
  await page.click('[data-rt="markups"]');
  await page.selectOption('#ml-filter', 'measure'); // takeoff rows + live totals
  await page.mouse.move(5, 450);
  await page.waitForTimeout(300);
  await shot('02-measure');

  await page.selectOption('#ml-filter', 'all');

  // 03 layers + styles: whole sheet, furniture layer hidden, Tool Chest open
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__pm.setPanels(true, true));
  await page.click('[data-lt="chest"]');
  await page.click('[data-rt="layers"]');
  await expect(page.locator('#pdf-layers .layer')).toHaveCount(8);
  await page.locator('#pdf-layers .layer', { hasText: 'A-FURN' }).locator('input').uncheck();
  await page.click('#fit-page');
  await page.waitForTimeout(900);
  await waitRendered(page);
  await page.mouse.move(5, 450);
  await page.waitForTimeout(400);
  await shot('03-layers');
  await page.locator('#pdf-layers .layer', { hasText: 'A-FURN' }).locator('input').check();
  await page.click('[data-lt="pages"]');

  // 07 crisp vector detail at 400%
  await page.evaluate(() => (window as any).__pm.setPanels(false, true));
  await page.click('[data-rt="layers"]');
  await page.locator('#app-layers .layer', { hasText: 'Owner Notes' }).locator('.ly-vis').uncheck();
  await view(page, 1.9, X(72.5), Y(21.3));
  await page.click('[data-rt="scale"]');
  await page.mouse.move(5, 450);
  await shot('07-zoom');
  await page.click('[data-rt="layers"]');
  await page.locator('#app-layers .layer', { hasText: 'Owner Notes' }).locator('.ly-vis').check();
  await page.evaluate(() => (window as any).__pm.setPanels(true, true));

  // 06 save: editable or flattened
  await view(page, 0.42, X(50), Y(30));
  await page.click('[data-rt="markups"]');
  await page.click('#btn-export');
  await page.check('input[value="flatten"]');
  await page.check('#ex-reduce');
  await page.waitForTimeout(300);
  await shot('06-export');
  await page.keyboard.press('Escape');

  // 04 combine a 300-page report with the drawing set
  const vols = ['Project Manual - Vol 1 (Div 00-09).pdf', 'Project Manual - Vol 2 (Div 10-28).pdf', 'Geotechnical + Survey Report.pdf'];
  vols.forEach((v, i) => copyFileSync(FIX + `big/report-${i + 1}.pdf`, TMP + v));
  await page.click('#btn-combine');
  await page.setInputFiles('#cb-file', vols.map((v) => TMP + v));
  await expect(page.locator('#cb-list .it')).toHaveCount(4, { timeout: 180_000 });
  await page.fill('#cb-name', 'Harbor Point - Permit Submission');
  await page.waitForTimeout(500);
  await shot('04-combine');
  await page.click('#cb-ok');
  await expect.poll(() => page.evaluate(() => (window as any).__pm.doc.pages.length), { timeout: 300_000 }).toBe(303);
  await page.waitForTimeout(1500);
  await waitRendered(page);
  await shot('04b-combined');

  // 05 lossless size reduction
  await page.click('#btn-reduce');
  const bloated = [['cad-export-uncompressed.pdf', 'Harbor Point CD Set - CAD export.pdf'], ['project-manual-uncompressed.pdf', 'Project Manual - Specifications (300 pg).pdf'], ['bloated.pdf', 'Site Photos - Scanner Output.pdf']];
  bloated.forEach(([a, b]) => copyFileSync(FIX + a, TMP + b));
  await page.setInputFiles('#rd-input', bloated.map(([, b]) => TMP + b));
  await expect(page.locator('.rd-after')).toHaveCount(3, { timeout: 600_000 });
  await page.waitForTimeout(500);
  await shot('05-reduce');
});
