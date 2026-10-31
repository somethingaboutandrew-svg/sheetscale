// Builds the Acknowledgements page (public/licenses.html) and THIRD_PARTY_LICENSES.txt from the
// license texts of every third-party component that ships inside PlanMark (web app and desktop app).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url).pathname;
const nm = `${root}node_modules/`;
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
const ver = (pkg) => JSON.parse(readFileSync(`${nm}${pkg}/package.json`, 'utf8')).version;
const desktopPkg = JSON.parse(readFileSync(`${root}desktop/package.json`, 'utf8'));
const electronVer = existsSync(`${root}desktop/node_modules/electron/package.json`)
  ? JSON.parse(readFileSync(`${root}desktop/node_modules/electron/package.json`, 'utf8')).version
  : desktopPkg.devDependencies.electron.replace(/^[^\d]*/, '');

const ZLIB = `(C) 1995-2024 Jean-loup Gailly and Mark Adler

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;
const APACHE = read(`${nm}pdfjs-dist/LICENSE`);

// [name, version, license, homepage, what PlanMark uses it for, license text]
const C = [
  ['PDF.js (pdfjs-dist)', ver('pdfjs-dist'), 'Apache-2.0', 'https://github.com/mozilla/pdf.js', 'Renders PDF pages and thumbnails.', APACHE],
  ['PDF.js JBIG2 decoder (from PDFium)', ver('pdfjs-dist'), 'BSD-3-Clause / Apache-2.0', 'https://pdfium.googlesource.com/pdfium/', 'Decodes JBIG2 images inside PDFs.', read(`${nm}pdfjs-dist/wasm/LICENSE_JBIG2`) + '\n\n' + read(`${nm}pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2`)],
  ['OpenJPEG (PDF.js build)', ver('pdfjs-dist'), 'BSD-2-Clause', 'https://github.com/uclouvain/openjpeg', 'Decodes JPEG 2000 images inside PDFs.', read(`${nm}pdfjs-dist/wasm/LICENSE_OPENJPEG`) + '\n\n' + read(`${nm}pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG`)],
  ['qcms (PDF.js build)', ver('pdfjs-dist'), 'MIT', 'https://github.com/mozilla/pdf.js', 'Colour management for ICC-based images.', read(`${nm}pdfjs-dist/wasm/LICENSE_QCMS`) + '\n\n' + read(`${nm}pdfjs-dist/wasm/LICENSE_PDFJS_QCMS`)],
  ['Foxit standard fonts (from PDFium)', ver('pdfjs-dist'), 'BSD-3-Clause', 'https://pdfium.googlesource.com/pdfium/', 'Substitute Courier, Times, Symbol and Dingbats fonts.', read(`${nm}pdfjs-dist/standard_fonts/LICENSE_FOXIT`)],
  ['Liberation Sans fonts', '2.1.5', 'OFL-1.1', 'https://github.com/liberationfonts/liberation-fonts', 'Substitute Helvetica font for PDFs that do not embed it.', read(`${root}vendor/liberation-fonts-2.1.5/LICENSE_LIBERATION`)],
  ['Adobe CMap resources', ver('pdfjs-dist'), 'BSD-3-Clause', 'https://github.com/adobe-type-tools/cmap-resources', 'Character maps for CJK text in PDFs.', read(`${nm}pdfjs-dist/cmaps/LICENSE`).replace(/^%%Copyright: ?/gm, '')],
  ['pdf-lib', ver('pdf-lib'), 'MIT', 'https://github.com/Hopding/pdf-lib', 'Writes markups, layers and combined PDFs.', read(`${nm}pdf-lib/LICENSE.md`)],
  ['@pdf-lib/standard-fonts', ver('@pdf-lib/standard-fonts'), 'MIT', 'https://github.com/Hopding/standard-fonts', 'Standard 14 font metrics.', read(`${nm}@pdf-lib/standard-fonts/LICENSE.md`)],
  ['@pdf-lib/upng', ver('@pdf-lib/upng'), 'MIT', 'https://github.com/Hopding/upng', 'PNG decoding for images-to-PDF.', read(`${nm}@pdf-lib/upng/LICENSE`)],
  ['pako', ver('pako'), 'MIT AND Zlib', 'https://github.com/nodeca/pako', 'Deflate compression.', read(`${nm}pako/LICENSE`) + '\n\nPortions derived from zlib:\n\n' + ZLIB],
  ['tslib', ver('tslib'), '0BSD', 'https://github.com/microsoft/tslib', 'TypeScript runtime helpers used by pdf-lib.', read(`${nm}tslib/LICENSE.txt`)],
  ['UTIF.js', ver('utif'), 'MIT', 'https://github.com/photopea/UTIF.js', 'Decodes TIFF images for images-to-PDF.', read(`${nm}utif/LICENSE`)],
  ['qpdf-wasm (@neslinesli93/qpdf-wasm)', ver('@neslinesli93/qpdf-wasm'), 'ISC', 'https://github.com/neslinesli93/qpdf-wasm', 'qpdf compiled to WebAssembly.', read(`${root}vendor/licenses/qpdf-wasm-LICENSE`)],
  ['qpdf', '12.2.0', 'Apache-2.0', 'https://github.com/qpdf/qpdf', 'Lossless size reduction, decryption and structure repair.', read(`${root}vendor/licenses/qpdf-NOTICE.md`) + '\n\n' + APACHE],
  ['libjpeg-turbo (inside qpdf-wasm)', '2.1.1', 'IJG AND BSD-3-Clause AND Zlib', 'https://libjpeg-turbo.org/', 'JPEG handling inside qpdf.', read(`${root}vendor/licenses/libjpeg-turbo-LICENSE.md`) + '\n\n' + read(`${root}vendor/licenses/libjpeg-turbo-README.ijg`)],
  ['zlib (inside qpdf-wasm)', '1.x', 'Zlib', 'https://zlib.net/', 'Compression inside qpdf.', ZLIB],
];
const DESKTOP = [
  ['Electron', electronVer, 'MIT', 'https://www.electronjs.org/', 'Desktop app shell (Mac and Windows apps only).', read(`${root}vendor/licenses/electron-LICENSE`)],
  ['Chromium and its components', `bundled with Electron ${electronVer}`, 'BSD-3-Clause and others', 'https://www.chromium.org/', 'Web engine inside the desktop app. Its full list of component licenses (about 500 entries) ships inside the app as LICENSES.chromium.html (PlanMark.app/Contents/Resources/LICENSES.chromium.html) and opens from Help > Acknowledgements > Chromium licenses.', 'See LICENSES.chromium.html inside the application bundle.'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const all = [...C, ...DESKTOP];
const txt = [
  'PlanMark third-party licenses',
  '=============================',
  '',
  'PlanMark is (c) 2026 Andrew Pocta. It includes the open-source components below, each under its own license.',
  '',
  ...all.flatMap(([n, v, l, h, u, t]) => ['-'.repeat(78), `${n} ${v}`, `License: ${l}`, `Source: ${h}`, `Used for: ${u}`, '', t, '']),
].join('\n');
writeFileSync(`${root}THIRD_PARTY_LICENSES.txt`, txt + '\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PlanMark: Acknowledgements</title>
<style>
:root{color-scheme:light dark;--bg:#F2F3F5;--card:#fff;--ink:#1c1d21;--mut:#5d6068;--line:#e2e4e8;--acc:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--card:#1f2024;--ink:#ececef;--mut:#a0a3ab;--line:#2e3036;--acc:#8ea2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 24px 80px}h1{font-size:26px;margin:0 0 6px}p.lead{color:var(--mut);margin:0 0 24px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:28px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--mut);font-weight:600}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0;padding:0 14px}summary{cursor:pointer;padding:12px 0;font-weight:600}
summary span{color:var(--mut);font-weight:400}pre{white-space:pre-wrap;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut);margin:0 0 14px}
a{color:var(--acc)}
</style></head><body><main>
<h1>Acknowledgements</h1>
<p class="lead">PlanMark is &copy; 2026 Andrew Pocta. It is built on the open-source software below. Thank you to everyone who made it. Each component keeps its own license; the full texts follow the table.</p>
<table><thead><tr><th>Component</th><th>Version</th><th>License</th><th>Used for</th></tr></thead><tbody>
${all.map(([n, v, l, h, u]) => `<tr><td><a href="${h}" target="_blank" rel="noopener">${esc(n)}</a></td><td>${esc(v)}</td><td>${esc(l)}</td><td>${esc(u)}</td></tr>`).join('\n')}
</tbody></table>
${all.map(([n, v, l, , , t]) => `<details><summary>${esc(n)} <span>${esc(v)} &middot; ${esc(l)}</span></summary><pre>${esc(t)}</pre></details>`).join('\n')}
</main></body></html>
`;
writeFileSync(`${root}public/licenses.html`, html);
console.log(`licenses: ${all.length} components -> public/licenses.html, THIRD_PARTY_LICENSES.txt`);
