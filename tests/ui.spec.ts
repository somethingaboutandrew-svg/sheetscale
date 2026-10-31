import { test, expect } from '@playwright/test';
import { boot, open } from './helpers';

test('theme: light glass by default (even on a dark system); Appearance menu offers dark and match-system, and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await boot(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  expect(await theme()).toBe('light'); // default is light glass, whatever the system says
  // frosted side panels: translucent fill + backdrop blur; nothing over the pages is blurred
  await open(page, 'sample.pdf');
  // opening fits the zoom, and the blur pauses during zoom by design; wait for it to settle
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('aside.right')!).backdropFilter)).toContain('blur');
  const css = await page.evaluate(() => {
    const f = (sel: string) => { const s = getComputedStyle(document.querySelector(sel)!); return { bf: s.backdropFilter, bg: s.backgroundColor }; };
    return { right: f('aside.right'), rail: f('#toolbar'), status: f('#statusbar'), viewer: f('#viewer'), tip: f('#tip') };
  });
  expect(css.right.bf).toContain('blur');
  expect(css.right.bg).toMatch(/rgba\(.*0\.\d+\)/);
  for (const k of ['rail', 'status', 'viewer', 'tip'] as const) expect(css[k].bf, k).toBe('none');
  // while the pages scroll, the panels skip the blur (no re-blur per frame); it returns when still
  const bfNow = () => page.evaluate(() => getComputedStyle(document.querySelector('aside.right')!).backdropFilter);
  await page.evaluate(() => { const v = document.getElementById('viewer')!; v.dispatchEvent(new Event('scroll')); });
  expect(await bfNow()).toBe('none');
  await expect.poll(bfNow).toContain('blur');
  const pick = async (mode: string) => { await page.click('#btn-theme'); await page.click(`.theme-menu [data-mode="${mode}"]`); await expect(page.locator('.theme-menu')).toHaveCount(0); };
  const bgLight = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')!).backgroundColor);
  await pick('dark');
  expect(await theme()).toBe('dark');
  const bgDark = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')!).backgroundColor);
  expect(bgLight).not.toBe(bgDark);
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  expect(await theme()).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('pm.theme'))).toBe('dark');
  await pick('auto'); // match system: follows live changes
  expect(await theme()).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(theme).toBe('dark');
  await page.click('#btn-theme');
  await expect(page.locator('.theme-menu [data-mode="auto"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.theme-menu')).toHaveCount(0);
  await pick('light');
  expect(await theme()).toBe('light');
});

test('reduced transparency: panels go solid, no blur', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page);
  await open(page, 'sample.pdf');
  await page.evaluate(() => (window as any).__pm.setGlass(false)); // same rules as prefers-reduced-transparency
  const s = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('aside.right')!); return { bf: c.backdropFilter, bg: c.backgroundColor }; });
  expect(s.bf).toBe('none');
  expect(s.bg).toBe('rgb(250, 250, 251)');
});

test('compact palette: 8 core colours at ~17px, more colours in a popover, custom hex works', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await page.click('[data-tool="rect"]'); // rectangle tool → style panel for new rectangles
  const row = page.locator('.swatches[data-for="p-stroke"]');
  await expect(row.locator('.sw[data-c]')).toHaveCount(8);
  const box = await row.locator('.sw[data-c]').first().boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(15);
  expect(box!.width).toBeLessThanOrEqual(18);
  const rowBox = await row.boundingBox();
  expect(rowBox!.height).toBeLessThanOrEqual(24); // one quiet line, no blocks
  await row.locator('.sw.more').click();
  const pop = page.locator('.pop.more-pop');
  await expect(pop.locator('.sw[data-c]')).toHaveCount(16);
  // the popover stays over the inspector panel, not over the pages
  const pb = (await pop.boundingBox())!, rb = (await page.locator('aside.right').boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(rb.x);
  expect(pb.x + pb.width).toBeLessThanOrEqual(rb.x + rb.width + 1);
  await pop.locator('[data-c="#1e3a8a"]').click();
  await expect(page.locator('.swatches[data-for="p-stroke"] .sw.more.on')).toHaveCount(1);
  expect(await page.evaluate(() => (document.querySelector('#p-stroke') as HTMLInputElement).value)).toBe('#1e3a8a');
  await row.locator('.sw.more').click();
  await pop.locator('.hex').fill('#12ab34');
  await pop.locator('.hex').press('Enter');
  expect(await page.evaluate(() => (document.querySelector('#p-stroke') as HTMLInputElement).value)).toBe('#12ab34');
  await page.locator('.swatches[data-for="p-stroke"] .sw[data-c]').first().click();
  await expect(page.locator('.swatches[data-for="p-stroke"] .sw[data-c]').first()).toHaveClass(/on/);
});

test('reduced motion: no transitions or animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await open(page, 'sample.pdf');
  const durations = await page.evaluate(() => [...document.querySelectorAll('.tool, .btn, .ib, .tip, .toast, .spin')].map((e) => {
    const s = getComputedStyle(e);
    return [s.transitionDuration, s.animationName];
  }));
  for (const [t, a] of durations) { expect(t.split(',').every((x) => parseFloat(x) === 0)).toBe(true); expect(a).toBe('none'); }
});

test('motion budget: every transition is transform/opacity and ≤150 ms', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const e of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(e, pseudo);
        const props = s.transitionProperty.split(',').map((x) => x.trim());
        const durs = s.transitionDuration.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 1 : 1000));
        props.forEach((p, i) => {
          const d = durs[i % durs.length];
          if (!d) return;
          if (!['transform', 'opacity'].includes(p) || d > 150) out.push(`${(e as HTMLElement).className}${pseudo ?? ''}: ${p} ${d}ms`);
        });
      }
    }
    return [...new Set(out)];
  });
  expect(bad).toEqual([]);
});

test('tooltips show the name and shortcut chip; ? opens the shortcut list', async ({ page }) => {
  await boot(page);
  await open(page, 'sample.pdf');
  await page.hover('[data-tool="m-area"]');
  const tip = page.locator('#tip.show');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Area');
  await expect(tip.locator('kbd')).toHaveText('4');
  await expect(tip).toContainText('double-click to close');
  await page.mouse.move(700, 450);
  await expect(page.locator('#tip.show')).toHaveCount(0);
  await page.locator('#viewer').focus();
  await page.keyboard.press('?');
  await expect(page.locator('dialog[open]')).toContainText('Keyboard shortcuts');
  await expect(page.locator('dialog[open]')).toContainText('Calibrate scale');
  await page.keyboard.press('Escape');
});

test('start screen: recent files reopen with their markups; panels can be hidden', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#start')).toBeVisible();
  await open(page, 'sample.pdf');
  await expect(page.locator('#start')).toHaveCount(0);
  // a markup, then close the tab
  await page.locator('#viewer').focus();
  await page.keyboard.press('r');
  const box = (await page.locator('.page').first().boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 160, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__pm.doc.markups.length)).toBe(1);
  await page.locator('.tab .x').first().click();
  await expect(page.locator('#start')).toBeVisible();
  const recent = page.locator('.rc', { hasText: 'sample.pdf' });
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('page');
  await recent.click();
  await expect.poll(() => page.evaluate(() => (window as any).__pm.doc?.markups.length)).toBe(1);
  // the scale chip is visible and opens the Scale tab
  await page.click('#scalechip');
  await expect(page.locator('[data-rt="scale"]')).toHaveClass(/active/);
  // panels toggle and the choice sticks
  await page.click('#btn-left');
  await expect(page.locator('aside.left')).toBeHidden();
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  await expect(page.locator('aside.left')).toBeHidden();
  await page.click('#btn-left');
  await expect(page.locator('aside.left')).toBeVisible();
});
