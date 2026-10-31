import { chromium } from '@playwright/test';
const [,, ...jobs] = process.argv; // e.g. A:main:dark
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const dir = new URL('./', import.meta.url).pathname;
for (const j of jobs) {
  const [c, view, theme, name] = j.split(':');
  await p.goto(`file://${dir}${c}.html?view=${view}&theme=${theme}`);
  if (c === 'icons') await p.setViewportSize({ width: 1280, height: 800 });
  await p.waitForLoadState('networkidle'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(150);
  const out = c === 'icons' ? `${dir}../screenshots/concepts/icons-and-app-icon.png` : `${dir}../screenshots/concepts/${c}-${name || `${view}-${theme}`}.png`;
  await p.screenshot({ path: out }); console.log(out);
}
await b.close();
