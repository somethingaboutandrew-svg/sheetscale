import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('public/icons/icon.svg', 'utf8');
const b = await chromium.launch();
for (const s of [192, 512]) {
  const p = await b.newPage({ viewport: { width: s, height: s } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  writeFileSync(`public/icons/icon-${s}.png`, await p.screenshot({ omitBackground: true }));
}
await b.close();
