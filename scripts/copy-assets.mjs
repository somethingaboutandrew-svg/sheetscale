// Copies pdf.js runtime assets (cmaps, standard fonts, wasm decoders) and qpdf-wasm into public/,
// then writes the Acknowledgements page (public/licenses.html) from the shipped license texts.
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const nm = new URL('../node_modules/', import.meta.url).pathname;
const pub = new URL('../public/', import.meta.url).pathname;
const vendor = new URL('../vendor/', import.meta.url).pathname;
for (const d of ['cmaps', 'standard_fonts', 'wasm']) {
  rmSync(`${pub}pdfjs/${d}`, { recursive: true, force: true });
  mkdirSync(`${pub}pdfjs/${d}`, { recursive: true });
  cpSync(`${nm}pdfjs-dist/${d}`, `${pub}pdfjs/${d}`, { recursive: true });
}
// pdf.js ships Liberation Sans 1.07 (GPLv2 + font exception). Swap in the metric-identical
// Liberation Sans 2.1.5 (SIL Open Font License 1.1) so nothing GPL-licensed is distributed.
for (const f of readdirSync(`${vendor}liberation-fonts-2.1.5`)) cpSync(`${vendor}liberation-fonts-2.1.5/${f}`, `${pub}pdfjs/standard_fonts/${f}`);
// The QuickJS form-scripting sandbox is never enabled by SheetScale; don't ship it.
for (const f of readdirSync(`${pub}pdfjs/wasm`)) if (f.startsWith('quickjs')) rmSync(`${pub}pdfjs/wasm/${f}`);
mkdirSync(`${pub}qpdf`, { recursive: true });
cpSync(`${nm}@neslinesli93/qpdf-wasm/dist/qpdf.js`, `${pub}qpdf/qpdf.js`);
cpSync(`${nm}@neslinesli93/qpdf-wasm/dist/qpdf.wasm`, `${pub}qpdf/qpdf.wasm`);
execFileSync(process.execPath, [new URL('./make-licenses.mjs', import.meta.url).pathname], { stdio: 'inherit' });
console.log('assets copied');
