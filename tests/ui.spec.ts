import { test, expect } from '@playwright/test';
import { boot, open } from './helpers';

test('theme: follows the system by default, toggle cycles auto → dark → light and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  expect(await theme()).toBe('light'); // auto + light system
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(theme).toBe('dark'); // auto follows a live system change
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toBe('light');
  await page.click('#btn-theme'); // → dark
  expect(await theme()).toBe('dark');
  await page.click('#btn-theme'); // → light
  expect(await theme()).toBe('light');
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  expect(await theme()).toBe('light');
  expect(await page.evaluate(() => localStorage.getItem('pm.theme'))).toBe('light');
  // the canvas behind the pages actually changes colour
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')!).backgroundColor);
  await page.click('#btn-theme'); // → auto (system light)
  await page.click('#btn-theme'); // → dark
  const bg2 = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')!).backgroundColor);
  expect(bg).not.toBe(bg2);
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
