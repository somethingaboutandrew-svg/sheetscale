// Copies pdf.js runtime assets (cmaps, standard fonts, wasm decoders) and qpdf-wasm into public/
import { cpSync, mkdirSync } from 'node:fs';
const nm = new URL('../node_modules/', import.meta.url).pathname;
const pub = new URL('../public/', import.meta.url).pathname;
for (const d of ['cmaps', 'standard_fonts', 'wasm']) {
  mkdirSync(`${pub}pdfjs/${d}`, { recursive: true });
  cpSync(`${nm}pdfjs-dist/${d}`, `${pub}pdfjs/${d}`, { recursive: true });
}
mkdirSync(`${pub}qpdf`, { recursive: true });
cpSync(`${nm}@neslinesli93/qpdf-wasm/dist/qpdf.js`, `${pub}qpdf/qpdf.js`);
cpSync(`${nm}@neslinesli93/qpdf-wasm/dist/qpdf.wasm`, `${pub}qpdf/qpdf.wasm`);
console.log('assets copied');
