// SheetScale icon set from one glyph: an "S" drawn as a measured path, with a dimension tick.
// Writes public/icons/{icon.svg,icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png and
// desktop/build/icon.png (1024 px macOS-style: rounded square with margin and soft shadow).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
export const GLYPH = `<path d="M44 19H27a7 7 0 000 14h10a7 7 0 010 14H19" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44" cy="19" r="4.6" fill="#fff"/><circle cx="19" cy="47" r="4.6" fill="#fff"/>`;
const GRAD = `<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#8B7CFF'/><stop offset='1' stop-color='#2DD4BF'/></linearGradient>`;
const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs>${GRAD}</defs><rect x='2' y='2' width='60' height='60' rx='15' fill='url(#g)'/>${GLYPH}</svg>`;
const full = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs>${GRAD}</defs><rect width='64' height='64' fill='url(#g)'/><g transform='translate(6.4 6.4) scale(.8)'>${GLYPH}</g></svg>`;
const mac = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'><defs>${GRAD}<filter id='s' x='-20%' y='-20%' width='140%' height='140%'><feDropShadow dx='0' dy='10' stdDeviation='14' flood-opacity='.28'/></filter></defs><rect x='100' y='100' width='824' height='824' rx='185' fill='url(#g)' filter='url(#s)'/><g transform='translate(100 100) scale(12.875)'>${GLYPH}</g></svg>`;
writeFileSync('public/icons/icon.svg', svg);
const b = await chromium.launch();
const shot = async (src, s, file, bg = false) => {
  const p = await b.newPage({ viewport: { width: s, height: s } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  writeFileSync(file, await p.screenshot({ omitBackground: !bg }));
  await p.close();
};
await shot(svg, 192, 'public/icons/icon-192.png');
await shot(svg, 512, 'public/icons/icon-512.png');
await shot(full, 512, 'public/icons/icon-maskable-512.png', true);
await shot(full, 180, 'public/icons/apple-touch-icon.png', true);
await shot(mac, 1024, 'desktop/build/icon.png');
await b.close();
console.log('icons written');
