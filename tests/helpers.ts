import { expect, type Page, type Download } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } from 'pdf-lib';

export const FIX = new URL('./fixtures/', import.meta.url).pathname;
export const OUT = new URL('../test-results/files/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

export async function boot(page: Page) {
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto('./?nosw');
  await page.waitForSelector('body[data-ready="1"]');
}

export async function open(page: Page, ...files: string[]) {
  const before = await page.evaluate(() => (window as any).__pm.docs.length);
  await page.setInputFiles('#file-open', files.map((f) => FIX + f));
  await expect.poll(() => page.evaluate(() => (window as any).__pm.docs.length)).toBeGreaterThan(before);
  await page.waitForSelector('.page');
  await waitRendered(page);
}

export async function waitRendered(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__pm.rendered()), { timeout: 20000 }).toBe(true);
}

export async function setZoom(page: Page, z: number) {
  await page.evaluate((z) => (window as any).__pm.setZoom(z), z);
  await page.waitForTimeout(250);
}

/** Screen point for a PDF user-space point on page i. */
export async function at(page: Page, i: number, x: number, y: number) {
  return page.evaluate(([i, x, y]) => (window as any).__pm.userToClient(i, x, y), [i, x, y] as const);
}
export async function clickUser(page: Page, i: number, x: number, y: number) {
  const p = await at(page, i, x, y);
  await page.mouse.click(p.x, p.y);
}

export async function saveDownload(page: Page, trigger: () => Promise<unknown>, name: string) {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = OUT + name;
  await (dl as Download).saveAs(path);
  return path;
}

export async function loadPdf(path: string) {
  return PDFDocument.load(readFileSync(path), { updateMetadata: false });
}

export function annots(doc: PDFDocument, pageIdx: number): PDFDict[] {
  const a = doc.getPage(pageIdx).node.Annots();
  if (!a) return [];
  return Array.from({ length: a.size() }, (_, i) => a.lookup(i, PDFDict));
}

export function name(d: PDFDict, key: string) {
  return d.get(PDFName.of(key))?.toString();
}
export function nums(d: PDFDict, key: string): number[] {
  const a = d.lookupMaybe(PDFName.of(key), PDFArray);
  return a ? a.asArray().map((x) => Number(x.toString())) : [];
}
export function text(o: unknown) {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : String(o);
}
export function ocgNames(doc: PDFDocument) {
  const ocp = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  const ocgs = ocp?.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  if (!ocgs) return [];
  return ocgs.asArray().map((r) => text((doc.context.lookup(r as PDFRef) as PDFDict).get(PDFName.of('Name'))));
}
export function offNames(doc: PDFDocument) {
  const ocp = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  const off = ocp?.lookupMaybe(PDFName.of('D'), PDFDict)?.lookupMaybe(PDFName.of('OFF'), PDFArray);
  if (!off) return [];
  return off.asArray().map((r) => text((doc.context.lookup(r as PDFRef) as PDFDict).get(PDFName.of('Name'))));
}

export const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });
export const pdfinfoPages = (path: string) => +(/Pages:\s+(\d+)/.exec(sh('pdfinfo', [path]))![1]);
export const pdftext = (path: string, page?: number) => sh('pdftotext', [...(page ? ['-f', String(page), '-l', String(page)] : []), '-layout', path, '-']);

/** Render a page to raw RGB with poppler and return pixel accessor in PDF points (72 dpi, unrotated pages). */
export function renderPage(path: string, page: number, dpi = 72) {
  const ppm = execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), path], { maxBuffer: 1 << 28 });
  // parse P6 header
  let off = 0;
  const tok: string[] = [];
  while (tok.length < 4) {
    while (ppm[off] === 0x20 || ppm[off] === 0x0a) off++;
    let t = '';
    while (ppm[off] !== 0x20 && ppm[off] !== 0x0a) t += String.fromCharCode(ppm[off++]);
    tok.push(t);
  }
  off++;
  const w = +tok[1], h = +tok[2];
  const data = ppm.subarray(off);
  return {
    w, h, data, raw: ppm,
    px(x: number, y: number) {
      const sx = Math.round((x * dpi) / 72), sy = Math.round(h - (y * dpi) / 72);
      const i = (sy * w + sx) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

/** qpdf --check via the same WebAssembly build the app uses. */
export async function qpdfCheck(path: string) {
  const require = createRequire(import.meta.url);
  const createModule = require('@neslinesli93/qpdf-wasm');
  let out = '';
  const q = await createModule({ print: (t: string) => (out += t + '\n'), printErr: (t: string) => (out += t + '\n') });
  q.FS.writeFile('/c.pdf', readFileSync(path));
  let code = 0;
  try { code = q.callMain(['--check', '/c.pdf']); } catch (e: any) { code = e?.status ?? -1; }
  return { code, out };
}
