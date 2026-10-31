import './styles.css';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Doc, Layer, Markup, MarkupType, PageRef, Pt, ScaleCal, SourceFile, Style, ToolId, Unit } from './types';
import { markupPrims, snapPoints, rectPts, bounds, primsBounds, type Prim } from './geom';
import { AREA_LABEL, IMPERIAL, METRIC, PAPER_SCALE, SCALE_PRESETS, UNIT_LABEL, convertLen, dist, fmtNum, isMeasure, measureOf, scaleFromCalibration, scaleFromRatio, withUnit } from './measure';
import { exportPdf, imagesToPdf, loadSource, TYPE_LABEL } from './pdfio';
import { reduceLosslessConsume } from './qpdf';
import { initRenderer, openInRenderer, closeInRenderer, renderPage, workerRenderingAvailable, renderQueueStats } from './render';
import * as store from './store';
import { ICONS, LOGO } from './icons';
import { textWidth } from './font';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const BASE = document.baseURI;
const PDFJS_OPTS = {
  cMapUrl: new URL('pdfjs/cmaps/', BASE).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('pdfjs/standard_fonts/', BASE).href,
  wasmUrl: new URL('pdfjs/wasm/', BASE).href,
  isEvalSupported: false,
  // pdf.js's WebCodecs JPEG path keeps decoded frames in native memory that is not released
  // promptly: on a 300-page report set it pushed the tab past 3.5 GB. The JS decoder is as smooth.
  isImageDecoderSupported: false,
};

// ───────────────────────── helpers ─────────────────────────
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
function toast(msg: string, ms = 2600) {
  $$('.toast').forEach((t) => t.remove());
  const el = h(`<div class="toast" role="status">${esc(msg)}</div>`);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 160); }, ms);
}
async function busy<T>(msg: string, fn: () => Promise<T>): Promise<T> {
  const el = h(`<div class="busy" role="alert" aria-busy="true"><div class="busy-pill"><i class="spin"></i>${esc(msg)}</div></div>`);
  document.body.appendChild(el);
  try {
    return await fn();
  } finally {
    el.remove();
  }
}
// Desktop (Electron) bridge, present only in the Mac app.
interface NativeBridge {
  saveFile(name: string, bytes: Uint8Array): Promise<string | null>;
  onOpenFiles(cb: (files: { name: string; bytes: Uint8Array }[]) => void): void;
  onCommand(cb: (cmd: string) => void): void;
  ready(): void;
  platform?: string;
}
const native = (window as any).planmarkNative as NativeBridge | undefined;
if (native?.platform === 'darwin') document.documentElement.classList.add('native-mac');
async function nativeSave(bytes: Uint8Array, name: string) {
  const path = await native!.saveFile(name, bytes);
  if (path) toast(`Saved ${fmtBytes(bytes.length)} to ${path}`, 4000);
  return path;
}
function download(bytes: Uint8Array | Blob, name: string) {
  if (native) { void (bytes instanceof Blob ? bytes.arrayBuffer().then((b) => nativeSave(new Uint8Array(b), name)) : nativeSave(bytes, name)); return; }
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: name.endsWith('.csv') ? 'text/csv' : 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function saveBytes(bytes: Uint8Array, name: string, pick: boolean) {
  if (native) { await nativeSave(bytes, name); return; }
  const w = window as any;
  if (pick && w.showSaveFilePicker) {
    try {
      const fh = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const ws = await fh.createWritable();
      await ws.write(bytes);
      await ws.close();
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  download(bytes, name);
}

// ───────────────────────── state ─────────────────────────
interface Src extends SourceFile { pdf: PDFDocumentProxy }
const sources = new Map<string, Src>();
let docs: Doc[] = [];
let doc: Doc | null = null;
const ocgCfg = new Map<string, any>();
const history = new Map<string, { undo: string[]; redo: string[] }>();

let tool: ToolId = 'select';
let zoom = 1; // 1 = 100% (actual paper size at 96 dpi)
let snapOn = true;
let selection = new Set<string>();
let currentPage = 0;
let clipboard: Markup[] = [];
let countTarget: string | null = null;

const ptPx = () => (zoom * 96) / 72; // CSS px per PDF point

const DEFAULT_LAYER: Layer = { id: 'markups', name: 'Markups', visible: true };

const baseStyle: Style = { stroke: '#e11d48', fill: null, opacity: 1, fillOpacity: 0.3, width: 1.5, dash: 'solid', startHead: 'none', endHead: 'none', fontSize: 12, textColor: '#c81e1e' };
const DEFAULT_STYLES: Record<MarkupType, Style> = {
  pen: { ...baseStyle, width: 2 },
  line: { ...baseStyle },
  arrow: { ...baseStyle, endHead: 'closed' },
  polyline: { ...baseStyle },
  polygon: { ...baseStyle },
  rect: { ...baseStyle },
  ellipse: { ...baseStyle },
  cloud: { ...baseStyle, dash: 'cloud' },
  text: { ...baseStyle, width: 0, stroke: '#c81e1e' },
  callout: { ...baseStyle, width: 1, fill: '#ffffff', fillOpacity: 1, endHead: 'closed' },
  highlight: { ...baseStyle, stroke: '#facc15', fill: '#fde047', fillOpacity: 0.45, width: 0 },
  'm-length': { ...baseStyle, stroke: '#1d4ed8', startHead: 'closed', endHead: 'closed', fontSize: 10, width: 1.2 },
  'm-polylength': { ...baseStyle, stroke: '#1d4ed8', fontSize: 10, width: 1.5 },
  'm-perimeter': { ...baseStyle, stroke: '#7c3aed', fontSize: 10, width: 1.5 },
  'm-area': { ...baseStyle, stroke: '#15803d', fill: '#22c55e', fillOpacity: 0.25, fontSize: 10, width: 1.5 },
  'm-count': { ...baseStyle, stroke: '#ea580c', fill: '#ea580c', fontSize: 10, width: 1.5 },
};
let toolStyles: Record<MarkupType, Style> = { ...clone(DEFAULT_STYLES), ...JSON.parse(localStorage.getItem('pm.toolStyles') || '{}') };
interface Preset { id: string; name: string; tool: MarkupType; style: Style }
let presets: Preset[] = JSON.parse(localStorage.getItem('pm.presets') || '[]');
const saveToolStyles = () => localStorage.setItem('pm.toolStyles', JSON.stringify(toolStyles));
const savePresets = () => localStorage.setItem('pm.presets', JSON.stringify(presets));
let author = localStorage.getItem('pm.author') || '';

const TOOL_NAMES: Record<ToolId, string> = {
  select: 'Select (V)', pan: 'Pan (H / hold Space)', pen: 'Pen (P)', line: 'Line (L)', arrow: 'Arrow (A)', polyline: 'Polyline (Y)', polygon: 'Polygon (G)',
  rect: 'Rectangle (R)', ellipse: 'Ellipse (E)', cloud: 'Cloud (C)', text: 'Text box (T)', callout: 'Callout (Q)', highlight: 'Highlight (I)',
  'm-length': 'Length (1)', 'm-polylength': 'Polylength (2)', 'm-perimeter': 'Perimeter (3)', 'm-area': 'Area (4)', 'm-count': 'Count (5)', calibrate: 'Calibrate scale (K)',
};
const TWO_POINT: ToolId[] = ['line', 'arrow', 'rect', 'ellipse', 'cloud', 'highlight', 'text', 'callout', 'm-length', 'calibrate'];
const MULTI_POINT: ToolId[] = ['polyline', 'polygon', 'm-polylength', 'm-perimeter', 'm-area'];
const RECT_TYPES: MarkupType[] = ['rect', 'ellipse', 'cloud', 'highlight', 'text'];

// ───────────────────────── layout ─────────────────────────
const TOOL_HINTS: Partial<Record<ToolId, string>> = {
  select: 'Click, drag a box, or Shift-click to add', pan: 'Drag to move around the sheet',
  pen: 'Freehand', line: 'Drag from start to end', arrow: 'Drag from tail to tip', polyline: 'Click points, double-click to finish',
  polygon: 'Click points, double-click to close', rect: 'Drag a box', ellipse: 'Drag a box', cloud: 'Drag a box',
  text: 'Drag a box, then type', callout: 'Drag from the point to the text box', highlight: 'Drag over the area',
  'm-length': 'Drag from start to end', 'm-polylength': 'Click points, double-click to finish', 'm-perimeter': 'Click points, double-click to close',
  'm-area': 'Click points, double-click to close', 'm-count': 'Click each item', calibrate: 'Drag along a known distance',
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const ib = (id: string, icon: string, tip: string, extra = '') => `<button class="ib" id="${id}" aria-label="${esc(tip.replace(/\s*\(.*\)$/, ''))}" data-tip="${esc(tip)}" ${extra}>${ICONS[icon]}</button>`;

const app = document.getElementById('app')!;
app.innerHTML = `
<header class="titlebar" id="titlebar">
  <div class="brand">${LOGO(22)}<span>SheetScale</span></div>
  <div class="tabs" id="tabs" role="tablist" aria-label="Open documents"></div>
  <button class="ib sm" id="btn-open" aria-label="Open files" data-tip="Open PDFs or images (${MOD}O)">${ICONS.plus}</button>
  <span class="sp"></span>
  <span class="savestate" id="st-save" aria-live="polite"></span>
  <button class="scalechip" id="scalechip" data-tip="Scale for this page. Click to calibrate or change it."><span class="sc-ic">${ICONS.scale}</span><span id="st-scale">No document</span></button>
  <span class="tsep"></span>
  ${ib('btn-undo', 'undo', `Undo (${MOD}Z)`)}${ib('btn-redo', 'redo', `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`)}
  <span class="tsep"></span>
  ${ib('btn-combine', 'combine', 'Combine PDFs')}${ib('btn-reduce', 'reduce', 'Reduce file size (lossless)')}
  ${ib('btn-theme', 'moon', 'Theme')}
  ${ib('btn-left', 'sidebar', 'Pages panel')}${ib('btn-right', 'sidebarr', 'Properties panel')}
  <button class="btn" id="btn-export" data-tip="Save a copy: editable or flattened, optionally smaller">${ICONS.export}<span>Export</span></button>
  <button class="btn primary" id="btn-save" data-tip="Save with editable markups (${MOD}S)">${ICONS.save}<span>Save</span></button>
  <input type="file" id="file-open" multiple accept=".pdf,application/pdf,image/*,.tif,.tiff" hidden />
  <input type="file" id="file-insert" multiple accept=".pdf,application/pdf,image/*,.tif,.tiff" hidden />
  <input type="file" id="file-images" multiple accept="image/*,.tif,.tiff" hidden />
</header>
<div class="stage" id="stage">
  <aside class="left glass" aria-label="Pages">
    <div class="ptabs" role="tablist"><button data-lt="pages" class="active" role="tab">${ICONS.pages}Pages</button><button data-lt="chest" role="tab">${ICONS.chest}Tool Chest</button></div>
    <div class="page-tools" id="page-tools">
      ${ib('pg-rotl', 'rotl', 'Rotate left')}${ib('pg-rotr', 'rotr', 'Rotate right')}${ib('pg-del', 'trash', 'Delete selected pages')}${ib('pg-extract', 'extract', 'Extract selected pages to a new PDF')}${ib('pg-insert', 'insert', 'Insert pages from a file after this page')}
    </div>
    <div class="pbody" id="left-body"></div>
  </aside>
  <section class="viewer" id="viewer" tabindex="0" aria-label="Document">
    <div class="pages" id="pages"></div>
  </section>
  <nav class="rail glass" id="toolbar" aria-label="Tools"></nav>
  <div class="status glass" id="statusbar">
    ${ib('zoom-out', 'minus', 'Zoom out (−)')}
    <input id="zoom-input" value="100%" aria-label="Zoom" />
    ${ib('zoom-in', 'plus', 'Zoom in (+)')}
    ${ib('fit-width', 'fitw', 'Fit width')}${ib('fit-page', 'fitp', 'Fit page')}
    <span class="div"></span>
    ${ib('pg-prev', 'chevl', 'Previous page')}<span class="pagenav"><input id="page-input" value="0" aria-label="Page number" /><span>/</span><span id="page-count">0</span></span>${ib('pg-next', 'chevr', 'Next page')}
    <span class="div"></span>
    <span class="coord" id="st-pos"></span>
    <span class="live" id="st-live"></span>
    <button class="snap on" id="btn-snap" aria-pressed="true" data-tip="Snap to markup points">${ICONS.magnet}<span>Snap</span></button>
  </div>
  <aside class="right glass" aria-label="Inspector">
    <div class="ptabs" role="tablist"><button data-rt="props" class="active" role="tab">${ICONS.sliders}<span>Style</span></button><button data-rt="markups" role="tab">${ICONS.list}<span>Markups</span></button><button data-rt="layers" role="tab">${ICONS.layers}<span>Layers</span></button><button data-rt="scale" role="tab">${ICONS.scale}<span>Scale</span></button></div>
    <div class="pbody" id="right-body"></div>
  </aside>
</div>
<div class="tip" id="tip" role="tooltip"></div>
`;

const viewer = $('#viewer');
const pagesEl = $('#pages');
const stage = $('#stage');
let leftTab: 'pages' | 'chest' = 'pages';
let rightTab: 'props' | 'markups' | 'layers' | 'scale' = 'props';

// tool rail
{
  const groups: [string, ToolId[]][] = [
    ['', ['select', 'pan']],
    ['Markup', ['pen', 'line', 'arrow', 'polyline', 'polygon', 'rect', 'ellipse', 'cloud', 'text', 'callout', 'highlight']],
    ['Measure', ['calibrate', 'm-length', 'm-polylength', 'm-perimeter', 'm-area', 'm-count']],
  ];
  const tb = $('#toolbar');
  groups.forEach(([label, ids]) => {
    if (label) tb.appendChild(h(`<div class="grp ${label === 'Measure' ? 'ms' : ''}">${label}</div>`));
    for (const id of ids) {
      const name = TOOL_NAMES[id];
      const b = h(`<button class="tool ${label === 'Measure' ? 'mtool' : ''}" data-tool="${id}" aria-label="${esc(name.replace(/\s*\(.*\)$/, ''))}" data-tip="${esc(name)}" data-hint="${esc(TOOL_HINTS[id] ?? '')}" data-side="right">${ICONS[id]}</button>`);
      b.onclick = () => setTool(id);
      tb.appendChild(b);
    }
  });
}

// ── small popovers (theme menu, more colours): opaque, never blurred, close on outside click or Esc ──
let popEl: HTMLElement | null = null, popOff: (() => void) | null = null;
function closePop() { popOff?.(); popOff = null; popEl?.remove(); popEl = null; }
function openPop(anchor: HTMLElement, html: string, cls = '', within?: HTMLElement) {
  closePop();
  const el = document.createElement('div');
  el.className = `pop ${cls}`;
  el.innerHTML = html;
  document.body.appendChild(el);
  const a = anchor.getBoundingClientRect(), w = el.offsetWidth, hgt = el.offsetHeight;
  const box = within?.getBoundingClientRect();
  const maxR = (box ? box.right - 8 : innerWidth - 8) - w, minL = box ? box.left + 8 : 8;
  let top = a.bottom + 6;
  if (top + hgt > innerHeight - 8) top = Math.max(8, a.top - hgt - 6);
  el.style.left = `${Math.max(minL, Math.min(a.left, maxR))}px`;
  el.style.top = `${top}px`;
  requestAnimationFrame(() => el.classList.add('in'));
  const down = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closePop(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); anchor.focus(); } };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('keydown', key, true);
  popOff = () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  popEl = el;
  return el;
}

// ── theme: light "Liquid Glass" is the default; dark, or follow the system, are options ──
type ThemeMode = 'auto' | 'dark' | 'light';
let themeMode: ThemeMode = (localStorage.getItem('pm.theme') as ThemeMode) || 'light';
const mqLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = themeMode === 'auto' ? (mqLight.matches ? 'light' : 'dark') : themeMode;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#0B0C0F' : '#F2F3F5');
  const b = $('#btn-theme');
  const label = themeMode === 'auto' ? `Appearance: match system (now ${t})` : `Appearance: ${t === 'light' ? 'Light glass' : 'Dark'}`;
  b.innerHTML = themeMode === 'auto' ? ICONS.grid.replace('<svg', '<svg class="auto"') : t === 'dark' ? ICONS.moon : ICONS.sun;
  b.dataset.tip = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'menu');
}
function setThemeMode(m: ThemeMode) { themeMode = m; localStorage.setItem('pm.theme', m); applyTheme(); }
mqLight.addEventListener('change', () => themeMode === 'auto' && applyTheme());
$('#btn-theme').onclick = () => {
  if (popEl?.classList.contains('theme-menu')) return closePop();
  hideTip();
  const item = (m: ThemeMode, icon: string, t: string, sub: string) => `<button role="menuitemradio" aria-checked="${themeMode === m}" data-mode="${m}">${ICONS[icon]}<span>${t}<small>${sub}</small></span><span class="ck">${ICONS.check}</span></button>`;
  const el = openPop($('#btn-theme'), `<div class="hd">Appearance</div><div role="menu" aria-label="Appearance">${item('light', 'sun', 'Light', 'Liquid Glass, the default')}${item('dark', 'moon', 'Graphite', 'The dark theme')}${item('auto', 'grid', 'Match system', 'Follows your computer’s setting')}</div>`, 'menu theme-menu');
  el.querySelectorAll<HTMLElement>('[data-mode]').forEach((x) => (x.onclick = () => { setThemeMode(x.dataset.mode as ThemeMode); closePop(); }));
  el.querySelector<HTMLElement>('[aria-checked=true]')?.focus();
};
applyTheme();

// ── panels can be hidden to give the sheet more room ──
function setPanels(left: boolean, right: boolean) {
  app.classList.toggle('no-left', !left);
  app.classList.toggle('no-right', !right);
  $('#btn-left').classList.toggle('on', left);
  $('#btn-right').classList.toggle('on', right);
  localStorage.setItem('pm.panels', JSON.stringify({ left, right }));
}
{
  const p = JSON.parse(localStorage.getItem('pm.panels') || 'null') ?? { left: true, right: innerWidth > 1000 };
  setPanels(p.left, p.right);
  $('#btn-left').onclick = () => setPanels(app.classList.contains('no-left'), !app.classList.contains('no-right'));
  $('#btn-right').onclick = () => setPanels(!app.classList.contains('no-left'), app.classList.contains('no-right'));
}

// ── tooltips: label + shortcut chip + optional hint, transform/opacity only ──
const tipEl = $('#tip');
let tipFor: HTMLElement | null = null, tipTimer = 0, tipWarm = 0;
function showTip(el: HTMLElement) {
  const raw = el.dataset.tip;
  if (!raw) return;
  const m = raw.match(/^(.*?)\s*\(([^()]{1,14})\)$/);
  const label = m ? m[1] : raw, key = m ? m[2] : '';
  const hint = el.dataset.hint;
  tipEl.innerHTML = `<span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span>${key ? `<kbd>${esc(key)}</kbd>` : ''}`;
  const r = el.getBoundingClientRect();
  const side = el.dataset.side ?? (r.top < 80 ? 'below' : 'above');
  tipEl.dataset.side = side;
  tipEl.classList.add('show');
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let x = side === 'right' ? r.right + 10 : r.left + r.width / 2 - tw / 2;
  let y = side === 'right' ? r.top + r.height / 2 - th / 2 : side === 'below' ? r.bottom + 8 : r.top - th - 8;
  x = Math.max(8, Math.min(innerWidth - tw - 8, x));
  y = Math.max(8, Math.min(innerHeight - th - 8, y));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  tipFor = el;
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipFor) tipWarm = performance.now();
  tipFor = null;
  tipEl.classList.remove('show');
}
document.addEventListener('pointerover', (e) => {
  const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
  if (el === tipFor) return;
  hideTip();
  if (!el || e.pointerType === 'touch') return;
  const warm = performance.now() - tipWarm < 400;
  tipTimer = window.setTimeout(() => showTip(el), warm ? 0 : 450);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('focusin', (e) => { const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null; if (el?.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);

// ───────────────────────── documents ─────────────────────────
async function addSource(name: string, bytes: Uint8Array, persist = true): Promise<Src> {
  const pdf = await pdfjs.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
  const s: Src = { id: uid(), name, bytes, pdf };
  sources.set(s.id, s);
  if (persist) await store.putSource({ id: s.id, name, bytes });
  return s;
}

function newDoc(name: string): Doc {
  return { id: uid(), name, pages: [], markups: [], layers: [clone(DEFAULT_LAYER)], activeLayer: DEFAULT_LAYER.id, ocgHidden: {}, ocgShown: {} };
}

async function openPdfBytes(name: string, raw: Uint8Array): Promise<Doc> {
  const loaded = await loadSource(raw);
  const src = await addSource(name, loaded.bytes);
  const d = newDoc(name);
  d.pages = Array.from({ length: loaded.pageCount }, (_, i) => ({ uid: uid(), src: src.id, index: i, rot: 0, scale: loaded.app?.pages[i]?.scale ?? loaded.vpScales[i] }));
  if (loaded.app) {
    d.layers = loaded.app.layers?.length ? loaded.app.layers : d.layers;
    d.activeLayer = loaded.app.activeLayer || d.layers[0].id;
    d.markups = loaded.app.markups.filter((m) => d.pages[m.page]).map((m) => ({ ...m, page: d.pages[m.page].uid }));
  }
  return d;
}

const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

async function openFiles(files: File[]) {
  if (!files.length) return;
  await busy('Opening…', async () => {
    const pdfs = files.filter(isPdf);
    const imgs = files.filter((f) => !isPdf(f));
    let last: Doc | null = null;
    for (const f of pdfs) {
      try {
        last = await openPdfBytes(f.name, new Uint8Array(await f.arrayBuffer()));
        docs.push(last);
        await persistDoc(last);
      } catch (e) {
        console.error(e);
        toast(`Could not open ${f.name}: ${(e as Error).message}`, 5000);
      }
    }
    if (imgs.length) {
      try {
        const bytes = await imagesToPdf(imgs);
        const name = imgs.length === 1 ? imgs[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'Images.pdf';
        last = await openPdfBytes(name, bytes);
        docs.push(last);
        await persistDoc(last);
      } catch (e) {
        console.error(e);
        toast(`Could not convert images: ${(e as Error).message}`, 5000);
      }
    }
    if (last) await activate(last);
  });
}

async function persistDoc(d: Doc) {
  await store.putDoc(d);
  await store.putMeta('open', { ids: docs.map((x) => x.id), active: doc?.id ?? d.id });
}

let saveTimer: number | undefined;
function scheduleSave() {
  if (!doc) return;
  const d = doc;
  $('#st-save').textContent = 'Saving…';
  $('#st-save').classList.remove('done');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await store.putDoc(d);
    await store.putMeta('open', { ids: docs.map((x) => x.id), active: doc?.id });
    $('#st-save').innerHTML = `${ICONS.check}Saved here`;
    $('#st-save').classList.add('done');
    $('#st-save').dataset.tip = 'Changes are kept in this browser automatically. Use Save to write a PDF.';
  }, 300);
}

async function restoreSession() {
  const meta = await store.getMeta<{ ids: string[]; active?: string }>('open');
  if (!meta?.ids?.length) return false;
  for (const id of meta.ids) {
    const d = await loadStoredDoc(id);
    if (d) docs.push(d);
  }
  const act = docs.find((d) => d.id === meta.active) ?? docs[0];
  if (act) await activate(act);
  return docs.length > 0;
}

// ── recent files: closed documents stay in this browser's storage (not in memory) so they can be
// reopened from the start screen. Bounded by count and size; the oldest are dropped first.
interface Recent { id: string; name: string; pages: number; bytes: number; when: number; thumb?: string }
const RECENT_MAX = 8, RECENT_BYTES = 400 * 1048576;
const getRecents = async () => (await store.getMeta<Recent[]>('recent')) ?? [];
async function noteRecent(d: Doc, thumb?: string) {
  const srcIds = [...new Set(d.pages.map((p) => p.src))];
  const bytes = srcIds.reduce((n, id) => n + (sources.get(id)?.bytes.length ?? 0), 0);
  const list = (await getRecents()).filter((r) => r.id !== d.id);
  const prev = (await getRecents()).find((r) => r.id === d.id);
  list.unshift({ id: d.id, name: d.name, pages: d.pages.length, bytes, when: Date.now(), thumb: thumb ?? prev?.thumb });
  await store.putMeta('recent', list);
}
/** Delete stored docs/sources that are neither open nor within the recent budget. */
async function pruneStore() {
  let list = await getRecents();
  const open = new Set(docs.map((d) => d.id));
  let total = 0;
  const keep: Recent[] = [];
  for (const r of list) {
    if (open.has(r.id)) { keep.push(r); continue; }
    if (keep.length < RECENT_MAX && total + r.bytes <= RECENT_BYTES) { keep.push(r); total += r.bytes; }
  }
  list = keep;
  await store.putMeta('recent', list);
  const keepDocs = new Set([...open, ...list.map((r) => r.id)]);
  const usedSrc = new Set(docs.flatMap((x) => x.pages.map((p) => p.src)));
  for (const r of list) {
    if (open.has(r.id)) continue;
    const d = await store.getDoc(r.id);
    d?.pages.forEach((p) => usedSrc.add(p.src));
  }
  for (const id of (await store.allDocIds()) as string[]) if (!keepDocs.has(id)) await store.delDoc(id);
  for (const id of (await store.allSourceIds()) as string[]) if (!usedSrc.has(id)) await store.delSource(id);
}
async function loadStoredDoc(id: string): Promise<Doc | null> {
  const d = await store.getDoc(id);
  if (!d) return null;
  d.ocgHidden ??= {};
  d.ocgShown ??= {};
  for (const sid of new Set(d.pages.map((p) => p.src))) {
    if (sources.has(sid)) continue;
    const s = await store.getSource(sid);
    if (!s) return null;
    const pdf = await pdfjs.getDocument({ ...PDFJS_OPTS, data: s.bytes.slice() }).promise;
    sources.set(sid, { ...s, pdf });
  }
  return d;
}
async function openRecent(id: string) {
  const open = docs.find((d) => d.id === id);
  if (open) return activate(open);
  const d = await busy('Opening…', () => loadStoredDoc(id));
  if (!d) {
    toast('That file is no longer stored here. Open it again from your disk.', 4000);
    await store.putMeta('recent', (await getRecents()).filter((r) => r.id !== id));
    if (!doc) await buildViewer();
    return;
  }
  docs.push(d);
  await persistDoc(d);
  await activate(d);
}
/** Small JPEG of page 1 for the start screen. */
async function recentThumb(d: Doc): Promise<string | undefined> {
  try {
    const ref = d.pages[0];
    if (!ref) return;
    const proxy = await getProxy(ref);
    const vp = proxy.getViewport({ scale: 1, rotation: pageRot(proxy, ref) });
    const s = Math.min(184 / vp.width, 120 / vp.height);
    const w = Math.max(1, Math.round(vp.width * s)), hh = Math.max(1, Math.round(vp.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    if (useWorker) {
      ensureInRenderer(ref.src);
      const bm = await renderPage({ doc: ref.src, index: ref.index, scale: s, rotation: vp.rotation, width: w, height: hh, annotations: true, priority: 3 }).promise;
      if (!bm) return;
      c.getContext('2d')!.drawImage(bm, 0, 0);
      bm.close();
    } else await proxy.render({ canvas: c, viewport: proxy.getViewport({ scale: s, rotation: vp.rotation }) }).promise;
    return c.toDataURL('image/jpeg', 0.8);
  } catch { return undefined; }
}

async function closeDoc(d: Doc) {
  if (editing) commitEditor();
  docs = docs.filter((x) => x !== d);
  history.delete(d.id);
  await store.putDoc(d);
  const had = (await getRecents()).find((r) => r.id === d.id)?.thumb;
  await noteRecent(d, had ?? (await recentThumb(d)));
  const used = new Set(docs.flatMap((x) => x.pages.map((p) => p.src)));
  for (const sid of new Set(d.pages.map((p) => p.src))) {
    if (!used.has(sid)) {
      (sources.get(sid)?.pdf as any)?.loadingTask?.destroy?.();
      closeInRenderer(sid);
      for (const k of [...proxyCache.keys()]) if (k.startsWith(sid + '|')) proxyCache.delete(k);
      for (const k of [...ocgCfg.keys()]) if (k.includes(sid)) ocgCfg.delete(k);
      sources.delete(sid);
    }
  }
  await store.putMeta('open', { ids: docs.map((x) => x.id), active: docs[0]?.id });
  if (doc === d) {
    doc = null;
    await activate(docs[docs.length - 1] ?? null);
  } else renderTabs();
  pruneStore().catch(() => {});
}

async function activate(d: Doc | null) {
  doc = d;
  selection.clear();
  countTarget = null;
  cancelDraft();
  currentPage = 0;
  renderTabs();
  await buildViewer();
  if (d) fitWidth();
  renderLeft();
  renderRight();
  updateStatus();
  if (d) {
    store.putMeta('open', { ids: docs.map((x) => x.id), active: d.id });
    getRecents().then((list) => {
      const r = list.find((x) => x.id === d.id);
      if (r?.thumb) return noteRecent(d);
      return recentThumb(d).then((t) => noteRecent(d, t));
    }).catch(() => {});
  }
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const d of docs) {
    const t = h(`<div class="tab ${d === doc ? 'active' : ''}" role="tab" aria-selected="${d === doc}" tabindex="0" data-tip="${esc(d.name)} · ${d.pages.length} page${d.pages.length === 1 ? '' : 's'}">${ICONS.file}<span class="nm">${esc(d.name)}</span><button class="x" aria-label="Close ${esc(d.name)}">${ICONS.close}</button></div>`);
    t.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (d !== doc) activate(d);
    };
    t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (d !== doc) activate(d); } };
    t.querySelector('button')!.onclick = () => closeDoc(d);
    tabs.appendChild(t);
  }
}

// ───────────────────────── history ─────────────────────────
const snap = (d: Doc) => JSON.stringify({ pages: d.pages, markups: d.markups, layers: d.layers, activeLayer: d.activeLayer, ocgHidden: d.ocgHidden, ocgShown: d.ocgShown });
function hist() {
  let x = history.get(doc!.id);
  if (!x) history.set(doc!.id, (x = { undo: [], redo: [] }));
  return x;
}
function pushUndo(before: string) {
  const x = hist();
  x.undo.push(before);
  if (x.undo.length > 200) x.undo.shift();
  x.redo = [];
}
function mutate(fn: () => void, opts: { pages?: boolean } = {}) {
  if (!doc) return;
  const before = snap(doc);
  fn();
  if (snap(doc) === before) return;
  pushUndo(before);
  changed(opts);
}
async function changed(opts: { pages?: boolean } = {}) {
  scheduleSave();
  if (opts.pages) {
    await buildViewer(true);
    renderLeft();
  } else redrawMarkups();
  renderRight();
  updateStatus();
}
function restore(state: string) {
  const prevPages = JSON.stringify(doc!.pages);
  const prevOcg = JSON.stringify([doc!.ocgHidden, doc!.ocgShown]);
  Object.assign(doc!, JSON.parse(state));
  if (JSON.stringify([doc!.ocgHidden, doc!.ocgShown]) !== prevOcg) {
    for (const [k, c] of ocgCfg) if (k.startsWith(doc!.id + '|')) for (const [id] of c) c.setVisibility(id, !(doc!.ocgHidden[k.split('|')[1]] ?? []).includes(id));
    invalidateRender();
  }
  for (const id of [...selection]) if (!doc!.markups.some((m) => m.id === id)) selection.delete(id);
  changed({ pages: JSON.stringify(doc!.pages) !== prevPages });
}
function undo() {
  if (!doc) return;
  const x = hist();
  const s = x.undo.pop();
  if (!s) return;
  x.redo.push(snap(doc));
  restore(s);
}
function redo() {
  if (!doc) return;
  const x = hist();
  const s = x.redo.pop();
  if (!s) return;
  x.undo.push(snap(doc));
  restore(s);
}

// ───────────────────────── viewer ─────────────────────────
// Rendering model (kept cheap at 300+ pages):
//  * every page has a placeholder <div>; only pages near the viewport hold a rendered bitmap (LRU-capped),
//  * rasterising happens in a worker (src/render-worker.ts) and comes back as an ImageBitmap,
//  * above the base resolution cap, 1024px tiles are rendered for the visible area and cached while panning,
//  * pages far away are released (bitmaps dropped, pdf.js page caches cleaned).
type Job = { cancel: () => void };
interface Tile { el: HTMLCanvasElement; job?: Job; task?: RenderTask }
interface PV {
  ref: PageRef;
  el: HTMLDivElement;
  base: HTMLCanvasElement;
  tiles: HTMLDivElement;
  hl: SVGSVGElement;
  svg: SVGSVGElement;
  proxy: PDFPageProxy;
  vp1: PageViewport;
  rot: number;
  baseScale: number;
  baseHash?: string;
  baseJob?: Job;
  baseTask?: RenderTask;
  tileKey?: string;
  tileMap: Map<string, Tile>;
  lastUsed: number;
}
let views: PV[] = [];
const SVGNS = 'http://www.w3.org/2000/svg';
const useWorker = workerRenderingAvailable() && !/[?&]mainrender\b/.test(location.search);
initRenderer(PDFJS_OPTS);
const MAX_BASES = 10; // rendered page bitmaps kept at once
const TILE = 1024; // device px

function pageRot(proxy: PDFPageProxy, ref: PageRef) {
  return (((proxy.rotate + ref.rot) % 360) + 360) % 360;
}

async function ocgFor(d: Doc, srcId: string) {
  const key = `${d.id}|${srcId}`;
  let c = ocgCfg.get(key);
  if (!c) {
    c = await sources.get(srcId)!.pdf.getOptionalContentConfig();
    ocgCfg.set(key, c);
  }
  for (const id of d.ocgHidden[srcId] ?? []) c.setVisibility(id, false);
  for (const id of d.ocgShown[srcId] ?? []) c.setVisibility(id, true);
  return c;
}
const ocgState = (d: Doc, srcId: string) => {
  const hidden = d.ocgHidden[srcId] ?? [], shown = d.ocgShown[srcId] ?? [];
  return { hidden, shown, hash: `${hidden.join(',')}|${shown.join(',')}` };
};
function ensureInRenderer(srcId: string) {
  const s = sources.get(srcId);
  if (s) openInRenderer(srcId, s.bytes);
}
/** Paint an ImageBitmap into a fresh canvas without copying (bitmaprenderer). */
function bitmapCanvas(bm: ImageBitmap, cls: string) {
  const c = document.createElement('canvas');
  c.width = bm.width;
  c.height = bm.height;
  c.className = cls;
  const ctx = c.getContext('bitmaprenderer');
  if (ctx) { ctx.transferFromImageBitmap(bm); (c as any).__brc = ctx; }
  else { c.getContext('2d')!.drawImage(bm, 0, 0); bm.close(); }
  return c;
}

/** Drop a canvas's backing store. A 'bitmaprenderer' canvas keeps its ImageBitmap until it is
 *  explicitly replaced with null; resizing alone does not release it. */
function freeCanvas(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  const ctx = (c as any).__brc as ImageBitmapRenderingContext | undefined;
  if (ctx) { try { ctx.transferFromImageBitmap(null); } catch {} }
  c.width = c.height = 0;
}

const proxyCache = new Map<string, Promise<PDFPageProxy>>();
const getProxy = (ref: PageRef) => {
  const k = `${ref.src}|${ref.index}`;
  let p = proxyCache.get(k);
  if (!p) proxyCache.set(k, (p = sources.get(ref.src)!.pdf.getPage(ref.index + 1)));
  return p;
};

async function buildViewer(keepScroll = false) {
  const st = { l: viewer.scrollLeft, t: viewer.scrollTop };
  $('#start')?.remove();
  app.classList.toggle('no-doc', !doc);
  if (!doc) {
    for (const v of views) releaseView(v);
    views = [];
    pagesEl.innerHTML = '';
    stage.appendChild(startScreen());
    $('#page-count').textContent = '0';
    return;
  }
  const d = doc;
  const proxies = await Promise.all(d.pages.map(getProxy));
  if (doc !== d) return;
  // Reuse page views whose page and rotation are unchanged, so reorders don't re-render anything.
  const old = new Map(views.map((v) => [v.ref.uid, v]));
  const next: PV[] = [];
  d.pages.forEach((ref, i) => {
    const proxy = proxies[i];
    const rot = pageRot(proxy, ref);
    const prev = old.get(ref.uid);
    if (prev && prev.rot === rot && prev.proxy === proxy) {
      old.delete(ref.uid);
      prev.ref = ref;
      ($('.pnum', prev.el) as HTMLElement).textContent = String(i + 1);
      next.push(prev);
      return;
    }
    const vp1 = proxy.getViewport({ scale: 1, rotation: rot });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.uid = ref.uid;
    el.innerHTML = `<span class="pnum">${i + 1}</span>`;
    const base = document.createElement('canvas');
    base.className = 'base';
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    const mk = (cls: string) => {
      const s = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      s.setAttribute('class', cls);
      s.setAttribute('viewBox', `0 0 ${vp1.width} ${vp1.height}`);
      s.setAttribute('preserveAspectRatio', 'none');
      const t = vp1.transform;
      s.innerHTML = `<g class="xf" transform="matrix(${t.join(',')})"><g class="mks"></g><g class="sel"></g><g class="draft"></g></g>`;
      return s;
    };
    const hl = mk('ov hlayer');
    hl.style.pointerEvents = 'none';
    hl.style.mixBlendMode = 'multiply';
    const svg = mk('ov');
    el.append(base, tiles, hl, svg);
    next.push({ ref, el, base, tiles, hl, svg, proxy, vp1, rot, baseScale: 0, tileMap: new Map(), lastUsed: 0 });
  });
  for (const v of old.values()) releaseView(v);
  views = next;
  pagesEl.replaceChildren(...views.map((v) => v.el));
  $('#page-count').textContent = String(d.pages.length);
  layout();
  redrawMarkups();
  if (keepScroll) { viewer.scrollLeft = st.l; viewer.scrollTop = st.t; }
  scheduleRender(0);
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return days < 7 ? `${days} d ago` : new Date(t).toLocaleDateString();
};
// Privacy, support and open-source acknowledgements. The web build links its own pages; the desktop
// app opens privacy/support on the website in the browser and shows the bundled licenses in a window.
const SITE = 'https://somethingaboutandrew-svg.github.io/sheetscale/';
const INFO_LINKS = [
  ['Privacy', native ? SITE + 'privacy.html' : 'privacy.html'],
  ['Support', native ? SITE + 'support.html' : 'support.html'],
  ['Acknowledgements', 'licenses.html'],
].map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('');
function startScreen() {
  const el = h(`<div class="start" id="start">
    <div class="hero">${LOGO(52)}
      <h1>Mark up and measure<br>plan sheets.</h1>
      <p>Calibrate any sheet, trace boundaries, buffers and streams, and read lengths, square feet and acres right on the page.</p>
      <div class="drop" id="start-drop">
        <div class="dic">${ICONS.drop}</div>
        <b>Drop PDFs or images here</b>
        <span>PDF, PNG, JPG and TIFF. Nothing is uploaded.</span>
        <div class="qa">
          <button class="btn primary" id="empty-open">${ICONS.open}Open files… <kbd>${MOD}O</kbd></button>
          <button class="btn" id="start-combine">${ICONS.combine}Combine</button>
          <button class="btn" id="start-images">${ICONS.image}Images to PDF</button>
        </div>
      </div>
    </div>
    <div class="recent"><h3>Recent <button class="link" id="recent-clear" hidden>Clear</button></h3><div id="recent-list"><p class="muted">Files you open show up here, so you can pick up where you left off.</p></div></div>
    <div class="foot"><span class="local">${ICONS.shield}Everything runs on this device. No account, no upload.</span><span class="kb"><span><kbd>?</kbd> Shortcuts</span><span class="links">${INFO_LINKS}</span></span></div>
  </div>`);
  $('#empty-open', el).onclick = () => $<HTMLInputElement>('#file-open').click();
  $('#start-combine', el).onclick = () => openCombineDialog();
  $('#start-images', el).onclick = () => $<HTMLInputElement>('#file-images').click();
  getRecents().then((list) => {
    const box = $('#recent-list', el);
    if (!list.length) return;
    box.innerHTML = '';
    $('#recent-clear', el).hidden = false;
    for (const r of list) {
      const row = h(`<button class="rc" data-recent="${r.id}">${r.thumb ? `<img src="${r.thumb}" alt="">` : `<span class="rc-ph">${ICONS.file}</span>`}<span class="rc-t"><b>${esc(r.name)}</b><span>${r.pages} page${r.pages === 1 ? '' : 's'} · ${fmtBytes(r.bytes)} · ${ago(r.when)}</span></span></button>`);
      row.onclick = () => openRecent(r.id);
      box.appendChild(row);
    }
  });
  $('#recent-clear', el).onclick = async () => {
    await store.putMeta('recent', (await getRecents()).filter((r) => docs.some((d) => d.id === r.id)));
    await pruneStore();
    $('#recent-list', el).innerHTML = '<p class="muted">Cleared. Stored copies of closed files were removed from this browser.</p>';
    $('#recent-clear', el).hidden = true;
  };
  return el;
}

function layout() {
  const k = ptPx();
  for (const v of views) {
    v.el.style.width = `${v.vp1.width * k}px`;
    v.el.style.height = `${v.vp1.height * k}px`;
  }
  $<HTMLInputElement>('#zoom-input').value = `${Math.round(zoom * 100)}%`;
  redrawSelection();
}

// Throttled (not debounced) so pages keep appearing while you scroll.
let renderTimer: number | undefined;
let renderDue = 0;
function scheduleRender(ms = 60) {
  const due = performance.now() + ms;
  if (renderTimer !== undefined && due >= renderDue) return;
  clearTimeout(renderTimer);
  renderDue = due;
  renderTimer = window.setTimeout(() => { renderTimer = undefined; renderVisible(); }, ms);
}
let zoomTimer: number | undefined;
function scheduleRenderAfterZoom() {
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => scheduleRender(0), 140);
}

/** Views intersecting the viewport (+ margin in viewport heights), via binary search on layout order. */
function visibleViews(margin = 0.5) {
  if (!views.length) return [];
  const vr = viewer.getBoundingClientRect();
  const mh = vr.height * margin;
  const top = vr.top - mh, bottom = vr.bottom + mh;
  let lo = 0, hi = views.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (views[mid].el.getBoundingClientRect().bottom < top) lo = mid + 1;
    else hi = mid;
  }
  const out: PV[] = [];
  for (let i = lo; i < views.length; i++) {
    const r = views[i].el.getBoundingClientRect();
    if (r.top > bottom) break;
    if (r.bottom > top && r.right > vr.left && r.left < vr.right) out.push(views[i]);
  }
  return out;
}

function renderVisible() {
  if (!doc) return;
  const now = performance.now();
  const inView = visibleViews(0);
  const near = visibleViews(1);
  const keep = new Set(near);
  for (const v of near) v.lastUsed = now + (inView.includes(v) ? 1 : 0);
  for (const v of near) renderBase(v, inView.includes(v) ? 0 : 3);
  for (const v of inView) renderTiles(v);
  // drop work and bitmaps for pages that scrolled away
  for (const v of views) {
    if (keep.has(v)) continue;
    if (v.baseJob) { v.baseJob.cancel(); v.baseJob = undefined; }
    v.baseTask?.cancel();
    if (v.tileMap.size) clearTiles(v);
  }
  const rendered = views.filter((v) => v.baseScale > 0 && !keep.has(v)).sort((a, b) => a.lastUsed - b.lastUsed);
  let live = views.filter((v) => v.baseScale > 0).length;
  for (const v of rendered) { if (live <= MAX_BASES) break; releaseView(v); live--; }
  updateCurrentPage();
}

function releaseView(v: PV) {
  v.baseJob?.cancel();
  v.baseJob = undefined;
  v.baseTask?.cancel();
  clearTiles(v);
  if (v.baseScale) {
    freeCanvas(v.base);
    v.baseScale = 0;
    if (!useWorker) v.proxy.cleanup();
  }
}
function clearTiles(v: PV) {
  for (const t of v.tileMap.values()) { t.job?.cancel(); t.task?.cancel(); freeCanvas(t.el); }
  v.tileMap.clear();
  v.tiles.replaceChildren();
  v.tileKey = undefined;
}

const MAX_PIXELS = 12e6;
function baseScaleFor(v: PV) {
  const dpr = window.devicePixelRatio || 1;
  const want = ptPx() * dpr;
  const cap = Math.min(Math.sqrt(MAX_PIXELS / (v.vp1.width * v.vp1.height)), 8192 / Math.max(v.vp1.width, v.vp1.height));
  return Math.min(want, cap);
}
async function renderBase(v: PV, priority: number) {
  const d = doc!;
  const s = baseScaleFor(v);
  const { hidden, shown, hash } = ocgState(d, v.ref.src);
  if (v.baseScale && Math.abs(v.baseScale - s) / s < 0.05 && v.baseHash === hash) return;
  if (v.baseJob && (v as any).baseWant === `${s}|${hash}`) return; // already queued
  v.baseJob?.cancel();
  v.baseTask?.cancel();
  const vp = v.proxy.getViewport({ scale: s, rotation: v.rot });
  const w = Math.max(1, Math.floor(vp.width)), h = Math.max(1, Math.floor(vp.height));
  const done = (c: HTMLCanvasElement) => {
    v.base.replaceWith(c);
    freeCanvas(v.base);
    v.base = c;
    v.baseScale = s;
    v.baseHash = hash;
    v.el.dataset.rendered = String(+v.el.dataset.rendered! + 1 || 1);
    if (v.tileKey) renderTiles(v);
  };
  if (useWorker) {
    ensureInRenderer(v.ref.src);
    const job = renderPage({ doc: v.ref.src, index: v.ref.index, scale: s, rotation: v.rot, width: w, height: h, hidden, shown, annotations: true, priority });
    v.baseJob = job;
    (v as any).baseWant = `${s}|${hash}`;
    const bm = await job.promise;
    if (v.baseJob !== job) { bm?.close(); return; }
    v.baseJob = undefined;
    if (!bm || !views.includes(v)) { bm?.close(); return; }
    done(bitmapCanvas(bm, 'base'));
    return;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.className = 'base';
  const ocg = await ocgFor(d, v.ref.src);
  const task = v.proxy.render({ canvas: c, viewport: vp, optionalContentConfigPromise: Promise.resolve(ocg), annotationMode: pdfjs.AnnotationMode.ENABLE });
  v.baseTask = task;
  try {
    await task.promise;
    done(c);
  } catch (e) {
    if ((e as Error)?.name !== 'RenderingCancelledException') console.warn(e);
  }
}

/** High-zoom detail: 1024px tiles over the visible part of the page, cached while panning. */
function renderTiles(v: PV) {
  const dpr = window.devicePixelRatio || 1;
  const want = ptPx() * dpr;
  if (!v.baseScale || v.baseScale >= want * 0.97) { if (v.tileMap.size) clearTiles(v); return; }
  const d = doc!;
  const { hidden, shown, hash } = ocgState(d, v.ref.src);
  const key = `${want.toFixed(5)}|${hash}`;
  if (v.tileKey !== key) { clearTiles(v); v.tileKey = key; }
  const vr = viewer.getBoundingClientRect();
  const r = v.el.getBoundingClientRect();
  const W = Math.floor(v.vp1.width * want), H = Math.floor(v.vp1.height * want);
  const pad = 200;
  const x0 = Math.max(0, vr.left - r.left - pad) * dpr, y0 = Math.max(0, vr.top - r.top - pad) * dpr;
  const x1 = Math.min(r.width, vr.right - r.left + pad) * dpr, y1 = Math.min(r.height, vr.bottom - r.top + pad) * dpr;
  if (x1 <= x0 || y1 <= y0) return;
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 1) / TILE), ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 1) / TILE);
  const wanted = new Set<string>();
  // centre tiles first
  const order: [number, number][] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) order.push([tx, ty]);
  const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
  order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  for (const [tx, ty] of order) {
    const k = `${tx},${ty}`;
    wanted.add(k);
    if (v.tileMap.has(k)) continue;
    const tw = Math.min(TILE, W - tx * TILE), th = Math.min(TILE, H - ty * TILE);
    if (tw <= 0 || th <= 0) continue;
    const ph = document.createElement('canvas');
    const tile: Tile = { el: ph };
    v.tileMap.set(k, tile);
    const place = (c: HTMLCanvasElement) => {
      c.className = 'tile';
      c.style.left = `${(tx * TILE) / dpr}px`;
      c.style.top = `${(ty * TILE) / dpr}px`;
      c.style.width = `${tw / dpr}px`;
      c.style.height = `${th / dpr}px`;
      v.tiles.appendChild(c);
      tile.el = c;
    };
    const transform = [1, 0, 0, 1, -tx * TILE, -ty * TILE];
    if (useWorker) {
      ensureInRenderer(v.ref.src);
      const job = renderPage({ doc: v.ref.src, index: v.ref.index, scale: want, rotation: v.rot, width: tw, height: th, transform, hidden, shown, annotations: true, priority: 1 });
      tile.job = job;
      job.promise.then((bm) => {
        if (v.tileMap.get(k) !== tile || v.tileKey !== key || !bm) { bm?.close(); return; }
        tile.job = undefined;
        place(bitmapCanvas(bm, 'tile'));
      });
    } else {
      ph.width = tw;
      ph.height = th;
      const vp = v.proxy.getViewport({ scale: want, rotation: v.rot });
      ocgFor(d, v.ref.src).then((ocg) => {
        if (v.tileMap.get(k) !== tile) return;
        tile.task = v.proxy.render({ canvas: ph, viewport: vp, transform, optionalContentConfigPromise: Promise.resolve(ocg) });
        tile.task.promise.then(() => { tile.task = undefined; if (v.tileMap.get(k) === tile) place(ph); }, () => {});
      });
    }
  }
  // keep a ring of recently seen tiles for panning back; drop the rest
  const keepR = 2;
  for (const [k, t] of v.tileMap) {
    if (wanted.has(k)) continue;
    const [tx, ty] = k.split(',').map(Number);
    if (tx < tx0 - keepR || tx > tx1 + keepR || ty < ty0 - keepR || ty > ty1 + keepR || v.tileMap.size > 60) {
      t.job?.cancel(); t.task?.cancel(); t.el.remove(); freeCanvas(t.el);
      v.tileMap.delete(k);
    }
  }
}

function invalidateRender(srcId?: string) {
  for (const v of views) if (!srcId || v.ref.src === srcId) { v.baseScale = 0; v.baseHash = undefined; clearTiles(v); }
  scheduleRender(0);
  renderThumbs(true, srcId);
}

function setZoom(z: number, anchor?: { x: number; y: number }) {
  z = Math.max(0.05, Math.min(64, z));
  const vr = viewer.getBoundingClientRect();
  const ax = anchor?.x ?? vr.left + vr.width / 2, ay = anchor?.y ?? vr.top + vr.height / 2;
  // find page under anchor and the fraction within it
  let target = views[0], fx = 0.5, fy = 0;
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    if (ay >= r.top - 9 && ay <= r.bottom + 9) { target = v; fx = (ax - r.left) / r.width; fy = (ay - r.top) / r.height; break; }
  }
  zoom = z;
  layout();
  if (target) {
    const r = target.el.getBoundingClientRect();
    viewer.scrollLeft += r.left + fx * r.width - ax;
    viewer.scrollTop += r.top + fy * r.height - ay;
  }
  scheduleRenderAfterZoom();
  if (editing) positionEditor();
}
// The tool rail floats over the left edge and the status capsule over the bottom of the viewer;
// .pages padding (styles.css) leaves room for them, and fits use the same numbers.
const PAD_X = 76 + 28 + 8, PAD_Y = 24 + 76;
function fitWidth() {
  const v = views[currentPage] ?? views[0];
  if (!v) return;
  setZoom(((viewer.clientWidth - PAD_X) / v.vp1.width) * (72 / 96));
  v.el.scrollIntoView({ block: 'start' });
  viewer.scrollTop -= 16;
}
function fitPage() {
  const v = views[currentPage] ?? views[0];
  if (!v) return;
  setZoom(Math.min((viewer.clientWidth - PAD_X) / v.vp1.width, (viewer.clientHeight - PAD_Y) / v.vp1.height) * (72 / 96));
  v.el.scrollIntoView({ block: 'center' });
}
function goToPage(i: number) {
  const v = views[Math.max(0, Math.min(views.length - 1, i))];
  if (!v) return;
  v.el.scrollIntoView({ block: 'start' });
  viewer.scrollTop -= 12;
}
function updateCurrentPage() {
  const vr = viewer.getBoundingClientRect();
  let best = currentPage < views.length ? currentPage : 0, bestA = -1;
  for (const v of visibleViews(0)) {
    const r = v.el.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
    if (a > bestA) { bestA = a; best = views.indexOf(v); }
  }
  if (best !== currentPage) {
    currentPage = best;
    $('.thumb.current')?.classList.remove('current');
    $(`.thumb[data-uid="${views[currentPage]?.ref.uid}"]`)?.classList.add('current');
    if (rightTab === 'scale') renderRight();
    updateStatus();
  }
  $<HTMLInputElement>('#page-input').value = String(views.length ? currentPage + 1 : 0);
}

viewer.addEventListener('scroll', () => { scheduleRender(60); updateCurrentPageSoon(); }, { passive: true });
// While the pages move (scroll, zoom), the side panels keep their translucent fill but skip the
// backdrop blur, so the compositor never re-blurs during a gesture. It comes back 160 ms after.
{
  const root = document.documentElement;
  let still = 0;
  const moving = () => { if (!root.classList.contains('moving')) root.classList.add('moving'); clearTimeout(still); still = window.setTimeout(() => root.classList.remove('moving'), 160); };
  viewer.addEventListener('scroll', moving, { passive: true });
  viewer.addEventListener('wheel', moving, { passive: true });
}
window.addEventListener('resize', () => scheduleRender(150));
let cpRaf = 0;
function updateCurrentPageSoon() { if (!cpRaf) cpRaf = requestAnimationFrame(() => { cpRaf = 0; updateCurrentPage(); }); }
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
  setZoom(zoom * f, { x: e.clientX, y: e.clientY });
}, { passive: false });
// Safari trackpad pinch
let gestureStart = 1;
viewer.addEventListener('gesturestart', (e: any) => { e.preventDefault(); gestureStart = zoom; });
viewer.addEventListener('gesturechange', (e: any) => { e.preventDefault(); setZoom(gestureStart * e.scale, { x: e.clientX, y: e.clientY }); });

// ───────────────────────── markup rendering (SVG) ─────────────────────────
const n3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
function pathD(p: Prim & { kind: 'path' }) {
  return p.d.map((c) => (c[0] === 'Z' ? 'Z' : `${c[0]}${c.slice(1).map((x) => n3(x as number)).join(' ')}`)).join('');
}
function primsSvg(prims: Prim[]) {
  let s = '';
  for (const p of prims) {
    if (p.kind === 'path') {
      const stroke = p.stroke && p.width > 0 && p.so > 0 ? `stroke="${p.stroke}" stroke-width="${n3(p.width)}" stroke-opacity="${p.so}" stroke-linecap="${['butt', 'round', 'square'][p.cap]}" stroke-linejoin="${['miter', 'round', 'bevel'][p.join]}"${p.dash ? ` stroke-dasharray="${p.dash.map(n3).join(' ')}"` : ''}` : 'stroke="none"';
      const fill = p.fill && p.fo > 0 ? `fill="${p.fill}" fill-opacity="${p.fo}"` : 'fill="none"';
      s += `<path d="${pathD(p)}" ${stroke} ${fill}/>`;
    } else {
      const lines = p.lines.filter((l) => l.s).map((l) => `<tspan x="${n3(l.x)}" y="${n3(l.y)}">${esc(l.s)}</tspan>`).join('');
      if (lines) s += `<text transform="matrix(${p.m.map(n3).join(',')})" font-family="Helvetica, Arial, sans-serif" font-size="${n3(p.size)}" fill="${p.color}" fill-opacity="${p.opacity}" style="white-space:pre">${lines}</text>`;
    }
  }
  return s;
}
function hitSvg(m: Markup, prims: Prim[]) {
  let s = '';
  for (const p of prims) {
    if (p.kind === 'path') {
      const filled = !!p.fill && p.fo > 0;
      s += `<path d="${pathD(p)}" stroke="transparent" stroke-width="10" vector-effect="non-scaling-stroke" fill="${filled ? 'transparent' : 'none'}" pointer-events="${filled ? 'all' : 'stroke'}"/>`;
    } else {
      const bb = primsBounds([p]);
      s += `<rect x="${n3(bb.x0)}" y="${n3(bb.y0)}" width="${n3(bb.x1 - bb.x0)}" height="${n3(bb.y1 - bb.y0)}" fill="transparent" pointer-events="all"/>`;
    }
  }
  if (m.type === 'text' || m.type === 'callout') {
    const r = rectPts(m.pts[0], m.pts[1]);
    s += `<path d="M${r.map((q) => q.join(' ')).join('L')}Z" fill="transparent" pointer-events="all"/>`;
  }
  return s;
}

const scaleOf = (ref: PageRef | undefined): ScaleCal => ref?.scale ?? PAPER_SCALE;
const layerVisible = (id: string) => doc?.layers.find((l) => l.id === id)?.visible !== false;
const layerLocked = (id: string) => !!doc?.layers.find((l) => l.id === id)?.locked;

function redrawMarkups(pageUid?: string) {
  if (!doc) return;
  for (const v of views) {
    if (pageUid && v.ref.uid !== pageUid) continue;
    let main = '', hl = '';
    for (const m of doc.markups) {
      if (m.page !== v.ref.uid || !layerVisible(m.layer)) continue;
      const prims = markupPrims(m, scaleOf(v.ref), v.rot);
      const vis = primsSvg(prims);
      const lock = layerLocked(m.layer) ? ' pointer-events="none"' : '';
      if (m.type === 'highlight') {
        hl += `<g>${vis}</g>`;
        main += `<g class="mk" data-id="${m.id}"${lock}>${hitSvg(m, prims)}</g>`;
      } else main += `<g class="mk" data-id="${m.id}"${lock}><g pointer-events="none">${vis}</g>${hitSvg(m, prims)}</g>`;
    }
    $('.mks', v.svg).innerHTML = main;
    $('.mks', v.hl).innerHTML = hl;
  }
  redrawSelection();
}

function viewOf(pageUid: string) {
  return views.find((v) => v.ref.uid === pageUid);
}

function handlesFor(m: Markup): { id: string; p: Pt }[] {
  if (RECT_TYPES.includes(m.type) || m.type === 'callout') {
    const r = rectPts(m.pts[0], m.pts[1]);
    const hs = r.map((p, i) => ({ id: `c${i}`, p }));
    if (m.type === 'callout') hs.push({ id: 'v2', p: m.pts[2] });
    return hs;
  }
  if (m.type === 'pen') return [];
  return m.pts.map((p, i) => ({ id: `v${i}`, p }));
}

function markupBounds(m: Markup, v: PV) {
  return primsBounds(markupPrims(m, scaleOf(v.ref), v.rot));
}

function redrawSelection() {
  if (!doc) return;
  const k = ptPx();
  const hs = 4.5 / k;
  for (const v of views) {
    let s = '';
    for (const m of doc.markups) {
      if (!selection.has(m.id) || m.page !== v.ref.uid) continue;
      const bb = markupBounds(m, v);
      s += `<rect class="selbox" x="${bb.x0}" y="${bb.y0}" width="${bb.x1 - bb.x0}" height="${bb.y1 - bb.y0}" stroke-width="${1 / k}" stroke-dasharray="${4 / k} ${3 / k}"/>`;
      if (selection.size === 1) {
        for (const hd of handlesFor(m)) s += `<rect class="handle" data-handle="${hd.id}" data-id="${m.id}" x="${hd.p[0] - hs}" y="${hd.p[1] - hs}" width="${hs * 2}" height="${hs * 2}" stroke-width="${1.2 / k}"/>`;
      }
    }
    $('.sel', v.svg).innerHTML = s;
  }
}

// ───────────────────────── interaction ─────────────────────────
interface Draft { type: ToolId; page: string; pts: Pt[]; downAt: [number, number]; dragged: boolean }
let draft: Draft | null = null;
let drag:
  | { kind: 'move'; page: string; start: Pt; before: string; orig: Map<string, Pt[]>; moved: boolean }
  | { kind: 'handle'; id: string; handle: string; before: string; moved: boolean }
  | { kind: 'marquee'; page: string; start: Pt; cur: Pt; add: boolean }
  | { kind: 'pan'; x: number; y: number; sl: number; st: number }
  | null = null;
let spaceDown = false;
let lastDown: { t: number; x: number; y: number } | null = null;

function setTool(t: ToolId) {
  cancelDraft();
  countTarget = null;
  tool = t;
  $$('.tool').forEach((b) => { b.classList.toggle('active', b.dataset.tool === t); b.setAttribute('aria-pressed', String(b.dataset.tool === t)); });
  viewer.classList.toggle('tool-pan', t === 'pan');
  viewer.classList.toggle('tool-select', t === 'select');
  viewer.classList.toggle('tool-draw', t !== 'pan' && t !== 'select');
  if (t !== 'select' && t !== 'pan' && selection.size) { selection.clear(); redrawSelection(); }
  renderRight();
  updateStatus();
}

function cancelDraft() {
  draft = null;
  for (const v of views) $('.draft', v.svg).innerHTML = '';
  $('#st-live') && ($('#st-live').textContent = '');
}

function pageViewAt(e: { target: EventTarget | null; clientX: number; clientY: number }): PV | undefined {
  const el = (e.target as Element)?.closest?.('.page') as HTMLElement | null;
  if (el) return views.find((v) => v.el === el);
  return views.find((v) => {
    const r = v.el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
}

function toUser(v: PV, cx: number, cy: number): Pt {
  const r = v.el.getBoundingClientRect();
  const k = ptPx();
  const [x, y] = v.vp1.convertToPdfPoint((cx - r.left) / k, (cy - r.top) / k);
  return [x, y];
}

function snapPt(v: PV, p: Pt, excludeId?: string): { p: Pt; snapped: boolean } {
  if (!snapOn || !doc) return { p, snapped: false };
  const tol = 9 / ptPx();
  let best: Pt | null = null, bd = tol;
  for (const m of doc.markups) {
    if (m.page !== v.ref.uid || m.id === excludeId || !layerVisible(m.layer)) continue;
    for (const q of snapPoints(m)) {
      const d = dist(p, q);
      if (d < bd) { bd = d; best = q; }
    }
  }
  if (draft && draft.pts.length > 2) {
    const q = draft.pts[0];
    if (dist(p, q) < bd) { best = q; }
  }
  return best ? { p: [best[0], best[1]], snapped: true } : { p, snapped: false };
}

/** Shift: constrain to 45° steps on screen. */
function ortho(v: PV, from: Pt, p: Pt): Pt {
  const [ax, ay] = v.vp1.convertToViewportPoint(from[0], from[1]);
  const [bx, by] = v.vp1.convertToViewportPoint(p[0], p[1]);
  const ang = Math.round(Math.atan2(by - ay, bx - ax) / (Math.PI / 4)) * (Math.PI / 4);
  const L = Math.hypot(bx - ax, by - ay);
  const [x, y] = v.vp1.convertToPdfPoint(ax + Math.cos(ang) * L, ay + Math.sin(ang) * L);
  return [x, y];
}

function drawDraft(v: PV, snapped = false) {
  if (!draft) return;
  const g = $('.draft', v.svg);
  if (draft.type === 'calibrate') {
    const [a, b] = draft.pts;
    const k = ptPx();
    g.innerHTML = `<path d="M${a.join(' ')}L${b.join(' ')}" stroke="#e11d48" stroke-width="${2 / k}" stroke-dasharray="${6 / k} ${4 / k}" fill="none"/>` +
      [a, b].map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="${4 / k}" fill="none" stroke="#e11d48" stroke-width="${1.5 / k}"/>`).join('');
    $('#st-live').textContent = `Calibration distance: ${fmtNum(dist(a, b), 2)} pt — click the second point of a known length`;
    return;
  }
  const m = draftMarkup();
  if (!m) return;
  let s = primsSvg(markupPrims(m, scaleOf(v.ref), v.rot));
  if (snapped) {
    const p = draft.pts[draft.pts.length - 1];
    const r = 6 / ptPx();
    s += `<rect class="snapmark" x="${p[0] - r}" y="${p[1] - r}" width="${2 * r}" height="${2 * r}" stroke-width="${1.5 / ptPx()}"/>`;
  }
  g.innerHTML = s;
  const mv = measureOf(m, scaleOf(v.ref));
  $('#st-live').textContent = mv ? `${TYPE_LABEL[m.type]}: ${mv.text}` : '';
}

function draftMarkup(): Markup | null {
  if (!draft || draft.type === 'calibrate') return null;
  const type = draft.type as MarkupType;
  let pts = draft.pts;
  if (type === 'callout') {
    const [tip, at] = pts;
    pts = [at, [at[0] + 140, at[1] - 36], tip];
  }
  if (type === 'text' && dist(pts[0], pts[1]) < 2) pts = [pts[0], [pts[0][0] + 160, pts[0][1] - 32]];
  return { id: 'draft', type, page: draft.page, layer: doc!.activeLayer, pts, style: toolStyles[type], text: type === 'text' || type === 'callout' ? '' : undefined, created: Date.now(), modified: Date.now() };
}

function finishDraft() {
  if (!draft || !doc) return;
  const d = draft;
  if (d.type === 'calibrate') {
    const L = dist(d.pts[0], d.pts[1]);
    cancelDraft();
    if (L < 0.5) return;
    openCalibrateDialog(L, d.page);
    return;
  }
  let pts = d.pts.slice();
  if (MULTI_POINT.includes(d.type)) {
    pts = pts.slice(0, -1); // remove rubber band point
    const k = ptPx();
    pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) * k > 2);
    const closed = d.type === 'polygon' || d.type === 'm-area' || d.type === 'm-perimeter';
    if (closed && pts.length > 3 && dist(pts[0], pts[pts.length - 1]) * k < 3) pts.pop();
    if (pts.length < (closed ? 3 : 2)) { cancelDraft(); return; }
  }
  const m = draftMarkup()!;
  m.pts = MULTI_POINT.includes(d.type) ? pts : m.pts;
  cancelDraft();
  if (TWO_POINT.includes(d.type) && d.type !== 'text' && d.type !== 'callout' && dist(m.pts[0], m.pts[1]) * ptPx() < 3) return;
  if (d.type === 'pen' && m.pts.length < 2) return;
  const created: Markup = { ...m, id: uid(), style: clone(m.style), author: author || undefined };
  mutate(() => doc!.markups.push(created));
  if (created.type === 'text' || created.type === 'callout') {
    selection = new Set([created.id]);
    redrawSelection();
    // open after the current mouse event finishes so the click doesn't steal focus
    setTimeout(() => openEditor(created.id, true), 0);
  }
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (!doc) return;
  viewer.focus({ preventScroll: true });
  if (editing) commitEditor();
  const pan = tool === 'pan' || spaceDown || e.button === 1;
  if (pan) {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: viewer.scrollLeft, st: viewer.scrollTop };
    viewer.classList.add('panning');
    pagesEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  const v = pageViewAt(e);
  if (!v) return;
  let p = toUser(v, e.clientX, e.clientY);

  if (tool === 'select') {
    const target = e.target as Element;
    const hEl = target.closest('[data-handle]') as HTMLElement | null;
    if (hEl) {
      drag = { kind: 'handle', id: hEl.dataset.id!, handle: hEl.dataset.handle!, before: snap(doc), moved: false };
      pagesEl.setPointerCapture(e.pointerId);
      return;
    }
    const mEl = target.closest('.mk') as HTMLElement | null;
    if (mEl) {
      const id = mEl.dataset.id!;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        selection.has(id) ? selection.delete(id) : selection.add(id);
      } else if (!selection.has(id)) selection = new Set([id]);
      redrawSelection();
      renderRight();
      const orig = new Map<string, Pt[]>();
      for (const m of doc.markups) if (selection.has(m.id) && m.page === v.ref.uid) orig.set(m.id, clone(m.pts));
      drag = { kind: 'move', page: v.ref.uid, start: p, before: snap(doc), orig, moved: false };
      pagesEl.setPointerCapture(e.pointerId);
      return;
    }
    if (!e.shiftKey) selection.clear();
    drag = { kind: 'marquee', page: v.ref.uid, start: p, cur: p, add: e.shiftKey };
    pagesEl.setPointerCapture(e.pointerId);
    redrawSelection();
    renderRight();
    return;
  }

  const s = snapPt(v, p);
  p = s.p;
  if (e.shiftKey && draft && draft.page === v.ref.uid) {
    const prev = draft.pts[draft.pts.length - 2] ?? draft.pts[0];
    if (!s.snapped) p = ortho(v, prev, p);
  }

  if (tool === 'm-count') {
    const existing = countTarget ? doc.markups.find((m) => m.id === countTarget && m.page === v.ref.uid) : null;
    if (existing) mutate(() => existing.pts.push(p));
    else {
      const m: Markup = { id: uid(), type: 'm-count', page: v.ref.uid, layer: doc.activeLayer, pts: [p], style: clone(toolStyles['m-count']), created: Date.now(), modified: Date.now(), author: author || undefined };
      mutate(() => doc!.markups.push(m));
      countTarget = m.id;
    }
    return;
  }
  if (tool === 'pen') {
    draft = { type: 'pen', page: v.ref.uid, pts: [p], downAt: [e.clientX, e.clientY], dragged: false };
    pagesEl.setPointerCapture(e.pointerId);
    return;
  }
  if (TWO_POINT.includes(tool)) {
    if (draft && draft.page === v.ref.uid) {
      draft.pts[1] = p;
      finishDraft();
      return;
    }
    draft = { type: tool, page: v.ref.uid, pts: [p, p], downAt: [e.clientX, e.clientY], dragged: false };
    pagesEl.setPointerCapture(e.pointerId);
    drawDraft(v);
    return;
  }
  if (MULTI_POINT.includes(tool)) {
    const now = performance.now();
    const quick = lastDown && now - lastDown.t < 450 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
    lastDown = { t: now, x: e.clientX, y: e.clientY };
    if (quick && draft && draft.page === v.ref.uid) {
      // second click of a double-click finishes the shape
      lastDown = null;
      finishDraft();
      return;
    }
    if (draft && draft.page === v.ref.uid) {
      draft.pts[draft.pts.length - 1] = p;
      draft.pts.push([p[0], p[1]]);
    } else draft = { type: tool, page: v.ref.uid, pts: [p, [p[0], p[1]]], downAt: [e.clientX, e.clientY], dragged: false };
    drawDraft(v);
  }
});

pagesEl.addEventListener('pointermove', (e) => {
  if (!doc) return;
  if (drag?.kind === 'pan') {
    viewer.scrollLeft = drag.sl - (e.clientX - drag.x);
    viewer.scrollTop = drag.st - (e.clientY - drag.y);
    return;
  }
  const v = drag && 'page' in drag ? viewOf(drag.page) : draft ? viewOf(draft.page) : pageViewAt(e);
  if (!v) return;
  let p = toUser(v, e.clientX, e.clientY);
  const sc = scaleOf(v.ref);
  $('#st-pos').textContent = `x ${fmtNum(p[0] * sc.factor, 2)}  y ${fmtNum(p[1] * sc.factor, 2)} ${UNIT_LABEL[sc.unit]}`;

  if (drag?.kind === 'move') {
    const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) * ptPx() < 2) return;
    drag.moved = true;
    for (const m of doc.markups) {
      const o = drag.orig.get(m.id);
      if (o && !layerLocked(m.layer)) m.pts = o.map(([x, y]) => [x + dx, y + dy]);
    }
    redrawMarkups(v.ref.uid);
    return;
  }
  if (drag?.kind === 'handle') {
    const dh = drag;
    const m = doc.markups.find((x) => x.id === dh.id);
    const mv = m && viewOf(m.page);
    if (!m || !mv) return;
    p = toUser(mv, e.clientX, e.clientY);
    p = snapPt(mv, p, m.id).p;
    drag.moved = true;
    if (dh.handle.startsWith('c')) {
      const i = +dh.handle.slice(1);
      const r = rectPts(m.pts[0], m.pts[1]);
      m.pts[0] = r[(i + 2) % 4];
      m.pts[1] = p;
    } else m.pts[+dh.handle.slice(1)] = p;
    redrawMarkups(m.page);
    return;
  }
  if (drag?.kind === 'marquee') {
    drag.cur = p;
    const [a, b] = [drag.start, drag.cur];
    const k = ptPx();
    $('.draft', v.svg).innerHTML = `<rect class="marquee" x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" stroke-width="${1 / k}"/>`;
    return;
  }
  if (!draft || draft.page !== v.ref.uid) return;
  if (Math.hypot(e.clientX - draft.downAt[0], e.clientY - draft.downAt[1]) > 4) draft.dragged = true;
  if (draft.type === 'pen') {
    if (dist(p, draft.pts[draft.pts.length - 1]) * ptPx() > 1.5) draft.pts.push(p);
    drawDraft(v);
    return;
  }
  const s = snapPt(v, p);
  p = s.p;
  if (e.shiftKey && !s.snapped) p = ortho(v, draft.pts[draft.pts.length - 2] ?? draft.pts[0], p);
  draft.pts[draft.pts.length - 1] = p;
  drawDraft(v, s.snapped);
});

pagesEl.addEventListener('pointerup', (e) => {
  if (!doc) return;
  if (drag?.kind === 'pan') {
    drag = null;
    viewer.classList.remove('panning');
    return;
  }
  if (drag?.kind === 'move' || drag?.kind === 'handle') {
    const d = drag;
    drag = null;
    if (d.moved) {
      for (const m of doc.markups) if (selection.has(m.id)) m.modified = Date.now();
      pushUndo(d.before);
      changed();
    }
    return;
  }
  if (drag?.kind === 'marquee') {
    const d = drag;
    drag = null;
    const v = viewOf(d.page)!;
    $('.draft', v.svg).innerHTML = '';
    const x0 = Math.min(d.start[0], d.cur[0]), x1 = Math.max(d.start[0], d.cur[0]);
    const y0 = Math.min(d.start[1], d.cur[1]), y1 = Math.max(d.start[1], d.cur[1]);
    if ((x1 - x0) * ptPx() > 3 || (y1 - y0) * ptPx() > 3) {
      for (const m of doc.markups) {
        if (m.page !== d.page || !layerVisible(m.layer) || layerLocked(m.layer)) continue;
        const b = markupBounds(m, v);
        if (b.x0 < x1 && b.x1 > x0 && b.y0 < y1 && b.y1 > y0) selection.add(m.id);
      }
    }
    redrawSelection();
    renderRight();
    return;
  }
  if (draft && (draft.type === 'pen' || (TWO_POINT.includes(draft.type) && (draft.dragged || draft.type === 'text')))) finishDraft();
});

pagesEl.addEventListener('dblclick', (e) => {
  if (draft && MULTI_POINT.includes(draft.type)) {
    finishDraft();
    return;
  }
  if (tool === 'select') {
    const mEl = (e.target as Element).closest('.mk') as HTMLElement | null;
    const m = mEl && doc?.markups.find((x) => x.id === mEl.dataset.id);
    if (m && (m.type === 'text' || m.type === 'callout')) openEditor(m.id, false);
  }
});

// ───────────────────────── text editing ─────────────────────────
let editing: { id: string; isNew: boolean; ta: HTMLTextAreaElement } | null = null;
function positionEditor() {
  if (!editing || !doc) return;
  const m = doc.markups.find((x) => x.id === editing!.id);
  const v = m && viewOf(m.page);
  if (!m || !v) return;
  const k = ptPx();
  const [ax, ay] = v.vp1.convertToViewportPoint(m.pts[0][0], m.pts[0][1]);
  const [bx, by] = v.vp1.convertToViewportPoint(m.pts[1][0], m.pts[1][1]);
  const ta = editing.ta;
  ta.style.left = `${Math.min(ax, bx) * k}px`;
  ta.style.top = `${Math.min(ay, by) * k}px`;
  ta.style.width = `${Math.max(40, Math.abs(bx - ax) * k)}px`;
  ta.style.height = `${Math.max(20, Math.abs(by - ay) * k)}px`;
  ta.style.fontSize = `${m.style.fontSize * k}px`;
  ta.style.color = m.style.textColor;
  if (v.el !== ta.parentElement) v.el.appendChild(ta);
}
function openEditor(id: string, isNew: boolean) {
  if (editing) commitEditor();
  const m = doc!.markups.find((x) => x.id === id);
  if (!m) return;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = m.text ?? '';
  ta.placeholder = 'Type text…';
  editing = { id, isNew, ta };
  positionEditor();
  ta.focus({ preventScroll: true });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitEditor(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => editing?.ta === ta && commitEditor(), 0));
  setTimeout(() => document.activeElement !== ta && ta.focus({ preventScroll: true }), 0);
}
function commitEditor() {
  if (!editing || !doc) return;
  const { id, isNew, ta } = editing;
  editing = null;
  ta.remove();
  const m = doc.markups.find((x) => x.id === id);
  if (!m) return;
  const text = ta.value;
  if (!text.trim() && isNew) {
    // discard empty new text boxes without leaving an undo step
    doc.markups = doc.markups.filter((x) => x.id !== id);
    hist().undo.pop();
    selection.delete(id);
    changed();
    return;
  }
  if (text !== m.text) mutate(() => { m.text = text; m.modified = Date.now(); });
}

// ───────────────────────── keyboard ─────────────────────────
const KEYMAP: Record<string, ToolId> = {
  v: 'select', h: 'pan', p: 'pen', l: 'line', a: 'arrow', y: 'polyline', g: 'polygon', r: 'rect', e: 'ellipse', c: 'cloud', t: 'text', q: 'callout', i: 'highlight',
  '1': 'm-length', '2': 'm-polylength', '3': 'm-perimeter', '4': 'm-area', '5': 'm-count', k: 'calibrate',
};
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, textarea, select') || t.isContentEditable || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); quickSave(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $<HTMLInputElement>('#file-open').click(); return; }
  if (mod && e.key.toLowerCase() === 'a' && doc) {
    e.preventDefault();
    const page = views[currentPage]?.ref.uid;
    selection = new Set(doc.markups.filter((m) => m.page === page && layerVisible(m.layer) && !layerLocked(m.layer)).map((m) => m.id));
    setTool('select');
    redrawSelection();
    renderRight();
    return;
  }
  if (mod && e.key.toLowerCase() === 'c' && doc) { clipboard = clone(doc.markups.filter((m) => selection.has(m.id))); return; }
  if (mod && e.key.toLowerCase() === 'v' && doc && clipboard.length) {
    e.preventDefault();
    const page = views[currentPage]?.ref.uid;
    const pasted = clipboard.map((m) => ({ ...clone(m), id: uid(), page: page ?? m.page, pts: m.pts.map(([x, y]) => [x + 12, y - 12] as Pt), created: Date.now(), modified: Date.now() }));
    mutate(() => doc!.markups.push(...pasted));
    clipboard = clone(pasted);
    selection = new Set(pasted.map((m) => m.id));
    redrawSelection();
    renderRight();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom * 1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(zoom / 1.25); return; }
  if (mod) return;
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (e.key === ' ') { spaceDown = true; viewer.classList.add('panning'); e.preventDefault(); return; }
  if (e.key === 'Escape') { cancelDraft(); countTarget = null; selection.clear(); redrawSelection(); renderRight(); return; }
  if (e.key === 'Enter' && draft && MULTI_POINT.includes(draft.type)) { finishDraft(); return; }
  if (e.key === 'Backspace' && draft && MULTI_POINT.includes(draft.type)) {
    e.preventDefault();
    if (draft.pts.length > 2) draft.pts.splice(draft.pts.length - 2, 1);
    else cancelDraft();
    const v = draft && viewOf(draft.page);
    if (v) drawDraft(v);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === '+' || e.key === '=') { setZoom(zoom * 1.25); return; }
  if (e.key === '-') { setZoom(zoom / 1.25); return; }
  if (e.key.startsWith('Arrow') && selection.size && doc) {
    e.preventDefault();
    const st = (e.shiftKey ? 10 : 1) / ptPx();
    const dv: Record<string, [number, number]> = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
    const [vx, vy] = dv[e.key];
    mutate(() => {
      for (const m of doc!.markups) {
        if (!selection.has(m.id)) continue;
        const v = viewOf(m.page)!;
        const [ox, oy] = v.vp1.convertToPdfPoint(0, 0);
        const [qx, qy] = v.vp1.convertToPdfPoint(vx, vy);
        m.pts = m.pts.map(([x, y]) => [x + qx - ox, y + qy - oy]);
      }
    });
    return;
  }
  const tl = KEYMAP[e.key.toLowerCase()];
  if (tl) setTool(tl);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; if (!drag) viewer.classList.remove('panning'); }
});

function deleteSelection() {
  if (!doc || !selection.size) return;
  mutate(() => { doc!.markups = doc!.markups.filter((m) => !selection.has(m.id) || layerLocked(m.layer)); });
  selection.clear();
  redrawSelection();
  renderRight();
}

// ───────────────────────── left panel: pages & tool chest ─────────────────────────
let pageSel = new Set<string>();
let thumbObserver: IntersectionObserver | null = null;
// Thumbnails are virtualised: every page gets a cheap placeholder, but only thumbnails near the
// visible part of the panel are rendered, and at most MAX_THUMBS bitmaps are kept.
const THUMB_W = 136, THUMB_H = 176, MAX_THUMBS = 90;
interface ThumbState { job?: Job; task?: RenderTask; key?: string; visible: boolean; seen: number }
const thumbEls = new Map<string, HTMLElement>();
const thumbState = new WeakMap<HTMLElement, ThumbState>();
const drawnThumbs = new Set<HTMLElement>();
function thumbBox(i: number) {
  const v = views[i];
  if (!v) return { w: THUMB_W, h: Math.round(THUMB_W * 1.29) };
  const k = Math.min(THUMB_W / v.vp1.width, THUMB_H / v.vp1.height);
  return { w: Math.round(v.vp1.width * k), h: Math.round(v.vp1.height * k) };
}
function renderLeft() {
  $$('[data-lt]').forEach((b) => { b.classList.toggle('active', b.dataset.lt === leftTab); b.setAttribute('aria-selected', String(b.dataset.lt === leftTab)); });
  $('#page-tools').style.display = leftTab === 'pages' && doc ? '' : 'none';
  const body = $('#left-body');
  if (leftTab === 'chest' || !doc) {
    thumbObserver?.disconnect();
    for (const el of thumbEls.values()) releaseThumb(el);
    thumbEls.clear();
    body.innerHTML = '';
    if (leftTab === 'chest') return renderChest(body);
    body.innerHTML = '<p class="muted small" style="padding:4px 6px">Open a file to see its pages.</p>';
    return;
  }
  let list = $('#thumbs', body);
  if (!list) { body.innerHTML = ''; list = h('<div class="thumbs" id="thumbs"></div>'); body.appendChild(list); }
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const el = en.target as HTMLElement;
      const st = thumbState.get(el);
      if (!st) continue;
      st.visible = en.isIntersecting;
      st.seen = performance.now();
      if (!en.isIntersecting) { st.job?.cancel(); st.job = undefined; }
    }
    queueThumbs();
  }, { root: body, rootMargin: '400px 0px' });
  if (!(body as any).__thumbScroll) { (body as any).__thumbScroll = true; body.addEventListener('scroll', () => queueThumbs(), { passive: true }); }
  const keepIds = new Set(doc.pages.map((p) => p.uid));
  for (const [id, el] of thumbEls) if (!keepIds.has(id)) { releaseThumb(el); thumbEls.delete(id); }
  const els: HTMLElement[] = [];
  doc.pages.forEach((p, i) => {
    const box = thumbBox(i);
    const rotKey = `${views[i]?.rot ?? 0}`;
    let t = thumbEls.get(p.uid);
    if (t && t.dataset.rot !== rotKey) { releaseThumb(t); t = undefined; }
    if (!t) {
      t = h(`<div class="thumb" draggable="true" data-uid="${p.uid}" data-rot="${rotKey}"><div class="tbox"><canvas width="0" height="0"></canvas></div><div class="lbl"></div></div>`);
      thumbEls.set(p.uid, t);
      thumbState.set(t, { visible: false, seen: 0 });
    }
    const tb = $('.tbox', t);
    tb.style.width = `${box.w}px`;
    tb.style.height = `${box.h}px`;
    $('.lbl', t).textContent = String(i + 1);
    t.classList.toggle('current', i === currentPage);
    t.classList.toggle('selected', pageSel.has(p.uid));
    t.onclick = (e) => {
      if (e.shiftKey && pageSel.size) {
        const idx = doc!.pages.findIndex((q) => pageSel.has(q.uid));
        const [a, b] = [Math.min(idx, i), Math.max(idx, i)];
        for (let j = a; j <= b; j++) pageSel.add(doc!.pages[j].uid);
      } else if (e.ctrlKey || e.metaKey) pageSel.has(p.uid) ? pageSel.delete(p.uid) : pageSel.add(p.uid);
      else pageSel = new Set([p.uid]);
      for (const x of thumbEls.values()) x.classList.toggle('selected', pageSel.has(x.dataset.uid!));
      goToPage(i);
    };
    t.ondragstart = (e) => {
      if (!pageSel.has(p.uid)) { pageSel = new Set([p.uid]); for (const x of thumbEls.values()) x.classList.toggle('selected', pageSel.has(x.dataset.uid!)); }
      e.dataTransfer!.setData('text/x-planmark-pages', [...pageSel].join(','));
      e.dataTransfer!.effectAllowed = 'move';
    };
    const tt = t;
    t.ondragover = (e) => {
      if (!e.dataTransfer?.types.includes('text/x-planmark-pages')) return;
      e.preventDefault();
      const r = tt.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      tt.classList.toggle('drop-after', after);
      tt.classList.toggle('drop-before', !after);
    };
    t.ondragleave = () => tt.classList.remove('drop-after', 'drop-before');
    t.ondrop = (e) => {
      const ids = e.dataTransfer?.getData('text/x-planmark-pages');
      tt.classList.remove('drop-after', 'drop-before');
      if (!ids) return;
      e.preventDefault();
      e.stopPropagation();
      const r = tt.getBoundingClientRect();
      movePages(ids.split(','), p.uid, e.clientY > r.top + r.height / 2);
    };
    els.push(t);
  });
  list.replaceChildren(...els);
  for (const t of els) thumbObserver.observe(t);
}

// Thumbnails render only once the panel has settled: a fling past 200 pages should not decode
// every map and photo on the way (each thumbnail needs the page's full-resolution images).
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function queueThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    for (const el of thumbEls.values()) if (thumbState.get(el)?.visible) drawThumb(el);
  }, 120);
}

function releaseThumb(el: HTMLElement) {
  const st = thumbState.get(el);
  st?.job?.cancel();
  st?.task?.cancel();
  if (st) { st.job = undefined; st.key = undefined; }
  const c = $<HTMLCanvasElement>('canvas', el);
  if (c && c.width) { const n = document.createElement('canvas'); n.width = n.height = 0; c.replaceWith(n); freeCanvas(c); }
  drawnThumbs.delete(el);
}

async function drawThumb(t: HTMLElement, force = false) {
  if (!doc) return;
  const st = thumbState.get(t);
  if (!st) return;
  const i = doc.pages.findIndex((p) => p.uid === t.dataset.uid);
  const ref = doc.pages[i];
  const v = views[i];
  if (!ref || !v) return;
  const { hidden, shown, hash } = ocgState(doc, ref.src);
  const key = `${v.rot}|${hash}`;
  if (!force && (st.key === key || st.job)) return;
  st.job?.cancel();
  st.task?.cancel();
  const box = thumbBox(i);
  const dpr = window.devicePixelRatio || 1;
  const s = (box.w / v.vp1.width) * dpr;
  const w = Math.max(1, Math.round(box.w * dpr)), hgt = Math.max(1, Math.round(box.h * dpr));
  let canvas: HTMLCanvasElement | null = null;
  if (useWorker) {
    ensureInRenderer(ref.src);
    const job = renderPage({ doc: ref.src, index: ref.index, scale: s, rotation: v.rot, width: w, height: hgt, hidden, shown, annotations: true, priority: 2 });
    st.job = job;
    const bm = await job.promise;
    if (st.job !== job) { bm?.close(); return; }
    st.job = undefined;
    if (!bm || !t.isConnected) { bm?.close(); return; }
    canvas = bitmapCanvas(bm, '');
  } else {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const task = v.proxy.render({ canvas: c, viewport: v.proxy.getViewport({ scale: s, rotation: v.rot }), optionalContentConfigPromise: ocgFor(doc, ref.src) });
    st.task = task;
    try { await task.promise; } catch { return; }
    st.task = undefined;
    canvas = c;
  }
  const old = $<HTMLCanvasElement>('canvas', t);
  old.replaceWith(canvas);
  freeCanvas(old);
  st.key = key;
  drawnThumbs.add(t);
  if (drawnThumbs.size > MAX_THUMBS) {
    const off = [...drawnThumbs].filter((x) => !thumbState.get(x)?.visible).sort((a, b) => thumbState.get(a)!.seen - thumbState.get(b)!.seen);
    for (const x of off.slice(0, drawnThumbs.size - MAX_THUMBS)) releaseThumb(x);
  }
}
function renderThumbs(force: boolean, srcId?: string) {
  for (const t of thumbEls.values()) {
    const ref = doc?.pages.find((p) => p.uid === t.dataset.uid);
    if (srcId && ref?.src !== srcId) continue;
    const st = thumbState.get(t);
    if (!st) continue;
    if (force) st.key = undefined;
    if (st.visible) drawThumb(t, force);
    else if (force) releaseThumb(t);
  }
}

function movePages(ids: string[], targetUid: string, after: boolean) {
  if (!doc || ids.includes(targetUid)) return;
  mutate(() => {
    const moving = doc!.pages.filter((p) => ids.includes(p.uid));
    const rest = doc!.pages.filter((p) => !ids.includes(p.uid));
    let at = rest.findIndex((p) => p.uid === targetUid);
    if (after) at++;
    rest.splice(at, 0, ...moving);
    doc!.pages = rest;
  }, { pages: true });
}
const selectedPages = () => (doc ? (pageSel.size ? doc.pages.filter((p) => pageSel.has(p.uid)) : [doc.pages[currentPage]].filter(Boolean)) : []);
function rotatePages(delta: number) {
  const sel = selectedPages();
  if (!sel.length) return;
  mutate(() => sel.forEach((p) => (p.rot = (((p.rot + delta) % 360) + 360) % 360)), { pages: true });
}
function deletePages() {
  if (!doc) return;
  const sel = selectedPages();
  if (!sel.length) return;
  if (sel.length >= doc.pages.length) { toast('A document needs at least one page.'); return; }
  if (!confirm(`Delete ${sel.length} page(s)? (You can undo.)`)) return;
  const ids = new Set(sel.map((p) => p.uid));
  mutate(() => {
    doc!.pages = doc!.pages.filter((p) => !ids.has(p.uid));
    doc!.markups = doc!.markups.filter((m) => !ids.has(m.page));
  }, { pages: true });
  pageSel.clear();
}
async function extractPages() {
  if (!doc) return;
  const sel = selectedPages();
  if (!sel.length) return;
  const d = doc;
  const bytes = await busy('Extracting…', async () => (await exportOffThread(d, { flatten: false, layersAsOcg: true, pageUids: sel.map((p) => p.uid), author })).bytes);
  download(bytes, d.name.replace(/\.pdf$/i, '') + `_pages_${sel.map((p) => d.pages.indexOf(p) + 1).join('-')}.pdf`.slice(0, 120));
}
async function insertFiles(files: File[]) {
  if (!doc || !files.length) return;
  const d = doc;
  await busy('Inserting…', async () => {
    const added: Doc[] = [];
    const pdfs = files.filter(isPdf), imgs = files.filter((f) => !isPdf(f));
    for (const f of pdfs) added.push(await openPdfBytes(f.name, new Uint8Array(await f.arrayBuffer())));
    if (imgs.length) added.push(await openPdfBytes('Images.pdf', await imagesToPdf(imgs)));
    mutate(() => {
      let at = currentPage + 1;
      for (const a of added) {
        mergeInto(d, a, at);
        at += a.pages.length;
      }
    }, { pages: true });
  });
}

/** Copy all pages, markups and layers of `src` into `dst` at a page index. */
function mergeInto(dst: Doc, src: Doc, at: number) {
  const map = new Map<string, string>();
  const pages = src.pages.map((p) => {
    const n = { ...clone(p), uid: uid() };
    map.set(p.uid, n.uid);
    return n;
  });
  dst.pages.splice(at, 0, ...pages);
  for (const l of src.layers) if (!dst.layers.some((x) => x.id === l.id)) dst.layers.push(clone(l));
  for (const m of src.markups) dst.markups.push({ ...clone(m), id: uid(), page: map.get(m.page)! });
  for (const [k, v] of Object.entries(src.ocgHidden)) dst.ocgHidden[k] = [...new Set([...(dst.ocgHidden[k] ?? []), ...v])];
  for (const [k, v] of Object.entries(src.ocgShown)) dst.ocgShown[k] = [...new Set([...(dst.ocgShown[k] ?? []), ...v])];
}

function renderChest(body: HTMLElement) {
  body.appendChild(h(`<p class="muted small">Styles you use often. Set one up in Style, then choose "Save to Tool Chest". Click a style to draw with it.</p>`));
  if (!presets.length) body.appendChild(h('<div class="chest-empty">' + ICONS.chest + '<span>Nothing saved yet</span></div>'));
  for (const pr of presets) {
    const el = h(`<div class="preset" data-preset="${pr.id}" tabindex="0" role="button"><span class="mic" style="--c:${pr.style.fill ?? pr.style.stroke}">${ICONS[pr.tool]}</span><span class="nm">${esc(pr.name)}<small>${TYPE_LABEL[pr.tool]}</small></span><button class="ib sm faint" aria-label="Delete ${esc(pr.name)}" data-tip="Delete">${ICONS.close}</button></div>`);
    const use = () => { toolStyles[pr.tool] = clone(pr.style); saveToolStyles(); setTool(pr.tool); toast(`Drawing with "${pr.name}"`); };
    el.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) {
        presets = presets.filter((x) => x.id !== pr.id);
        savePresets();
        renderLeft();
        return;
      }
      use();
    };
    el.onkeydown = (e) => { if (e.key === 'Enter') use(); };
    body.appendChild(el);
  }
}

// ───────────────────────── right panel ─────────────────────────
function renderRight() {
  $$('[data-rt]').forEach((b) => { b.classList.toggle('active', b.dataset.rt === rightTab); b.setAttribute('aria-selected', String(b.dataset.rt === rightTab)); });
  const body = $('#right-body');
  const st = body.scrollTop;
  body.innerHTML = '';
  if (rightTab === 'props') renderProps(body);
  else if (rightTab === 'markups') renderMarkupList(body);
  else if (rightTab === 'layers') renderLayers(body);
  else renderScalePanel(body);
  body.scrollTop = st;
}

const DASH_OPTS = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['cloud', 'Cloud border']];
const HEAD_OPTS = [['none', 'None'], ['open', 'Open arrow'], ['closed', 'Closed arrow'], ['circle', 'Dot'], ['square', 'Square'], ['slash', 'Slash / tick']];
const opts = (o: string[][], v: string) => o.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
// Field-friendly palette: survey red, wetland green, water blue, buffer violet, soils orange, plus ink.
const SWATCHES: [string, string][] = [['#e11d48', 'Red'], ['#f97316', 'Orange'], ['#facc15', 'Yellow'], ['#16a34a', 'Green'], ['#0ea5e9', 'Sky'], ['#1d4ed8', 'Blue'], ['#7c3aed', 'Violet'], ['#111827', 'Ink']];
const WIDTHS = [0.5, 1, 1.5, 2, 3, 5];
const dashArray = (d: string, w: number) => (d === 'dashed' ? `${w * 4} ${w * 3}` : d === 'dotted' ? `${Math.max(w, 0.1)} ${w * 2.2}` : '');
/** Live sample of the current style, drawn the way the markup will look. */
function stylePreview(type: MarkupType, st: Style) {
  const sw = Math.max(0.6, Math.min(st.width, 6)) * 1.6;
  const da = dashArray(st.dash, sw);
  const stroke = `stroke="${st.stroke}" stroke-opacity="${st.opacity}" stroke-width="${st.width ? sw : 0}" ${da ? `stroke-dasharray="${da}"` : ''} stroke-linecap="round" stroke-linejoin="round"`;
  const fill = st.fill ? `fill="${st.fill}" fill-opacity="${st.fillOpacity}"` : 'fill="none"';
  let body: string;
  if (type === 'highlight') body = `<rect x="24" y="20" width="192" height="28" rx="2" fill="${st.fill ?? st.stroke}" fill-opacity="${st.fillOpacity}"/>`;
  else if (type === 'text' || type === 'callout') body = `<rect x="70" y="10" width="140" height="44" rx="3" ${fill} ${stroke}/><text x="82" y="38" font-size="${Math.min(st.fontSize * 1.3, 22)}" fill="${st.textColor}" font-family="Helvetica, Arial">Note</text>${type === 'callout' ? `<path d="M70 40 L22 58" ${stroke} fill="none"/>` : ''}`;
  else if (['rect', 'ellipse', 'cloud', 'polygon', 'm-area', 'm-perimeter'].includes(type)) {
    const shape = type === 'ellipse' ? `<ellipse cx="120" cy="34" rx="92" ry="24" ${fill} ${stroke}/>` : type === 'rect' ? `<rect x="28" y="10" width="184" height="48" rx="2" ${fill} ${stroke}/>` : `<path d="M30 52 L58 12 L150 18 L210 40 L160 58 Z" ${fill} ${stroke}/>`;
    body = shape;
  } else if (type === 'pen') body = `<path d="M20 48 C 60 10, 90 60, 130 30 S 200 20, 220 36" fill="none" ${stroke}/>`;
  else if (type === 'm-count') body = [40, 90, 140, 190].map((x) => `<circle cx="${x}" cy="34" r="9" fill="${st.fill ?? st.stroke}" fill-opacity="${st.opacity}"/>`).join('');
  else body = `<path d="M24 50 L120 18 L216 40" fill="none" ${stroke}/>`;
  return `<svg viewBox="0 0 240 68" class="preview-svg" aria-hidden="true">${body}</svg>`;
}
// More colours, shown in a small popover: a light and a dark shade of each core hue, plus neutrals.
const MORE_SWATCHES: [string, string][] = [
  ['#fda4af', 'Light red'], ['#fdba74', 'Light orange'], ['#fde68a', 'Light yellow'], ['#86efac', 'Light green'], ['#7dd3fc', 'Light sky'], ['#93c5fd', 'Light blue'], ['#c4b5fd', 'Light violet'], ['#ffffff', 'White'],
  ['#9f1239', 'Dark red'], ['#c2410c', 'Dark orange'], ['#a16207', 'Dark yellow'], ['#166534', 'Dark green'], ['#0369a1', 'Dark sky'], ['#1e3a8a', 'Dark blue'], ['#5b21b6', 'Dark violet'], ['#6b7280', 'Grey'],
];
function swatchRow(forId: string, value: string, label: string) {
  const v = value.toLowerCase();
  const known = SWATCHES.some(([c]) => c.toLowerCase() === v);
  const sw = ([c, n]: [string, string]) => `<button class="sw ${c.toLowerCase() === v ? 'on' : ''}" style="--c:${c}" data-c="${c}" role="radio" aria-checked="${c.toLowerCase() === v}" aria-label="${n}" data-tip="${n}"></button>`;
  return `<div class="swatches" data-for="${forId}" role="radiogroup" aria-label="${label}">${SWATCHES.map(sw).join('')}<button class="sw more ${known ? '' : 'on'}" style="${known ? '' : `--c:${value}`}" data-tip="${known ? 'More colours' : `Custom colour ${value}`}" aria-label="More ${label.toLowerCase()}s" aria-haspopup="dialog">${ICONS.plus}</button><input type="color" class="sw-native" id="${forId}" value="${value}" aria-label="Custom ${label.toLowerCase()}" tabindex="-1"></div>`;
}
function openMorePop(row: HTMLElement, input: HTMLInputElement, fire: (el: HTMLElement) => void) {
  const anchor = $<HTMLElement>('.sw.more', row);
  const v = input.value.toLowerCase();
  const el = openPop(anchor, `<div class="hd">More colours</div><div class="grid" role="radiogroup" aria-label="More colours">${MORE_SWATCHES.map(([c, n]) => `<button class="sw ${c === v ? 'on' : ''}" style="--c:${c}" data-c="${c}" role="radio" aria-checked="${c === v}" aria-label="${n}" title="${n}"></button>`).join('')}</div>
    <div class="row2"><input type="text" class="hex" value="${esc(input.value)}" spellcheck="false" aria-label="Hex colour" maxlength="7"><button class="btn" data-pick>Custom…</button></div>`, 'more-pop', $('aside.right'));
  const set = (c: string) => { input.value = c; closePop(); fire(input); };
  el.querySelectorAll<HTMLElement>('[data-c]').forEach((b) => (b.onclick = () => set(b.dataset.c!)));
  const hex = el.querySelector<HTMLInputElement>('.hex')!;
  hex.onkeydown = (e) => { if (e.key === 'Enter') { const m = hex.value.trim().match(/^#?([0-9a-f]{6})$/i); if (m) set(`#${m[1].toLowerCase()}`); else hex.select(); } };
  el.querySelector<HTMLElement>('[data-pick]')!.onclick = () => { closePop(); try { (input as HTMLInputElement & { showPicker?: () => void }).showPicker?.() ?? input.click(); } catch { input.click(); } };
}
const pctSlider = (id: string, v: number, c: string) => `<div class="slider"><input type="range" id="${id}" min="0" max="100" value="${Math.round(v * 100)}" style="--v:${Math.round(v * 100)}%;--c:${c}"><output>${Math.round(v * 100)}%</output></div>`;

function renderProps(body: HTMLElement) {
  const sel = doc ? doc.markups.filter((m) => selection.has(m.id)) : [];
  const drawTool = tool !== 'select' && tool !== 'pan' && tool !== 'calibrate' ? (tool as MarkupType) : null;
  if (!sel.length && !drawTool) {
    body.innerHTML = `<div class="ph"><div class="ph-ic" style="--c:var(--ac)">${ICONS.sliders}</div><div><div class="ph-t">Style</div><div class="ph-s">Nothing selected</div></div></div>
      <p class="muted">Select a markup to change it, or pick a tool to set how new markups look.</p>
      <section><h4>Your name</h4><div class="field"><input type="text" id="p-author" value="${esc(author)}" placeholder="Shown as the author on markups" aria-label="Your name"></div></section>
      <section><h4>Shortcuts</h4><p class="muted small">Press <kbd>?</kbd> for the full list. Tools have single-key shortcuts; hover a tool to see it.</p></section>`;
    $<HTMLInputElement>('#p-author', body).onchange = (e) => { author = (e.target as HTMLInputElement).value; localStorage.setItem('pm.author', author); };
    return;
  }
  const first = sel[0];
  const st: Style = first ? first.style : toolStyles[drawTool!];
  const type: MarkupType = first ? first.type : drawTool!;
  const title = first ? (sel.length > 1 ? `${sel.length} markups` : TYPE_LABEL[first.type]) : TYPE_LABEL[drawTool!];
  const sub = first ? (sel.length > 1 ? 'Changes apply to all of them' : `Page ${(doc!.pages.findIndex((p) => p.uid === first.page) + 1) || '?'} · ${esc(doc!.layers.find((l) => l.id === first.layer)?.name ?? '')}`) : 'Style for new markups';
  let measureHtml = '';
  if (first && sel.length === 1 && isMeasure(first.type)) {
    const v = viewOf(first.page);
    const sc = scaleOf(v?.ref);
    const mv = measureOf(first, sc);
    if (mv) {
      const main = mv.kind === 'area' ? [fmtNum(mv.value, sc.precision), mv.unit] : mv.kind === 'count' ? [String(mv.value), mv.value === 1 ? 'item' : 'items'] : (() => { const m = mv.text.match(/^([\d.,\-]+)\s*(.*)$/); return m ? [m[1], m[2]] : [mv.text, '']; })();
      measureHtml = `<div class="measure" id="p-measure"><div class="m-main"><span class="m-v">${esc(main[0])}</span> <span class="m-u">${esc(main[1])}</span></div>`;
      if (mv.kind === 'area') measureHtml += `<div class="m-sub"><b>${fmtNum(mv.area2!, 4)}</b> ${mv.area2Unit === 'ac' ? 'acres' : 'hectares'}<i class="dotsep"></i>perimeter <b>${fmtNum(mv.perimeter!, 2)}</b> ${UNIT_LABEL[sc.unit]}</div>`;
      measureHtml += `<div class="m-scale">${ICONS.scale}<span>${esc(sc.label)}${v?.ref.scale ? '' : ' (not calibrated)'}</span><button class="link" id="p-goscale">Change</button></div></div>`;
    }
  }
  const showFill = !['pen', 'line', 'arrow', 'polyline', 'm-length', 'm-polylength', 'm-perimeter'].includes(type);
  const showHeads = ['line', 'arrow', 'polyline', 'm-length', 'm-polylength', 'callout'].includes(type);
  const showText = ['text', 'callout'].includes(type) || isMeasure(type);
  const layerOpts = doc ? doc.layers.map((l) => `<option value="${l.id}" ${first?.layer === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('') : '';
  body.innerHTML = `
    <div class="ph"><div class="ph-ic" style="--c:${st.stroke}">${ICONS[type] ?? ''}</div><div><div class="ph-t">${esc(title)}</div><div class="ph-s">${sub}</div></div></div>
    ${measureHtml}
    <div class="preview" id="p-preview">${stylePreview(type, st)}</div>
    <section><h4>Line</h4>
      ${swatchRow('p-stroke', st.stroke, 'Line colour')}
      <div class="field"><label for="p-opacity">Opacity</label>${pctSlider('p-opacity', st.opacity, st.stroke)}</div>
      <div class="field"><label>Width</label><div class="seg widths" role="radiogroup" aria-label="Line width">${WIDTHS.map((w) => `<button data-w="${w}" class="${Math.abs(st.width - w) < 0.01 ? 'on' : ''}" role="radio" aria-checked="${Math.abs(st.width - w) < 0.01}" aria-label="${w} pt"><svg viewBox="0 0 26 12"><path d="M2 6h22" stroke="currentColor" stroke-width="${Math.min(w * 1.3, 7)}" stroke-linecap="round"/></svg><span>${w}</span></button>`).join('')}</div></div>
      <div class="field"><label for="p-width">Exact</label><div class="numbox"><input type="number" id="p-width" min="0" max="72" step="0.25" value="${st.width}"><span>pt</span></div></div>
      <div class="field"><label>Style</label><div class="seg dashes" role="radiogroup" aria-label="Line style">${DASH_OPTS.map(([k, l]) => `<button data-dash="${k}" class="${st.dash === k ? 'on' : ''}" role="radio" aria-checked="${st.dash === k}" aria-label="${l}" data-tip="${l}">${k === 'cloud' ? `<svg viewBox="0 0 40 12"><path d="M2 9a4 4 0 018 0a4 4 0 018 0a4 4 0 018 0a4 4 0 018 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>` : `<svg viewBox="0 0 40 12"><path d="M3 6h34" stroke="currentColor" stroke-width="2" stroke-linecap="round" ${dashArray(k, 2) ? `stroke-dasharray="${dashArray(k, 2)}"` : ''}/></svg>`}</button>`).join('')}</div></div>
      <select id="p-dash" hidden aria-hidden="true" tabindex="-1">${opts(DASH_OPTS, st.dash)}</select>
      ${showHeads ? `<div class="field"><label for="p-start">Start</label><select id="p-start">${opts(HEAD_OPTS, st.startHead)}</select></div><div class="field"><label for="p-end">End</label><select id="p-end">${opts(HEAD_OPTS, st.endHead)}</select></div>` : ''}
    </section>
    ${showFill ? `<section><h4>Fill <label class="switch"><input type="checkbox" id="p-fill-on" ${st.fill ? 'checked' : ''} aria-label="Fill on"><i></i></label></h4>
      <div class="${st.fill ? '' : 'dim'}">${swatchRow('p-fill', st.fill ?? '#ffffff', 'Fill colour')}
      <div class="field"><label for="p-fill-opacity">Opacity</label>${pctSlider('p-fill-opacity', st.fillOpacity, st.fill ?? st.stroke)}</div></div></section>` : ''}
    ${showText ? `<section><h4>Text</h4><div class="field"><label for="p-font">Size</label><div class="numbox"><input type="number" id="p-font" min="4" max="144" step="1" value="${st.fontSize}"><span>pt</span></div></div>
      ${['text', 'callout'].includes(type) ? `<div class="field"><label>Colour</label>${swatchRow('p-textcolor', st.textColor, 'Text colour')}</div>` : ''}</section>` : ''}
    ${first ? `<section><h4>Markup</h4><div class="field"><label for="p-layer">Layer</label><select id="p-layer">${layerOpts}</select></div>
      <div class="field"><label for="p-comment">Note</label><input type="text" id="p-comment" value="${esc(first.comment ?? '')}" placeholder="Label or comment"></div>
      <div class="pf">${sel.length === 1 && ['text', 'callout'].includes(first.type) ? '<button class="btn" id="p-edit-text">Edit text</button>' : ''}<button class="btn" id="p-make-default" data-tip="New ${esc(TYPE_LABEL[first.type])} markups will look like this">Make default</button><button class="btn danger" id="p-delete">${ICONS.trash}Delete</button></div></section>` : ''}
    <div class="pf"><button class="btn" id="p-preset">${ICONS.chest}Save to Tool Chest</button>${!first ? '<button class="btn ghost" id="p-reset">Reset</button>' : ''}</div>
  `;
  const apply = (fn: (s: Style) => void) => {
    if (sel.length) mutate(() => sel.forEach((m) => { fn(m.style); m.modified = Date.now(); }));
    else { fn(toolStyles[drawTool!]); saveToolStyles(); renderRight(); }
  };
  const bind = (id: string, ev: string, fn: (el: HTMLInputElement) => void) => {
    const el = $<HTMLInputElement>(`#${id}`, body);
    if (el) el.addEventListener(ev, () => fn(el));
  };
  const fire = (el: HTMLElement) => el.dispatchEvent(new Event('change', { bubbles: true }));
  $$('.swatches', body).forEach((row) => {
    const input = $<HTMLInputElement>(`#${row.dataset.for}`, row);
    $$('.sw[data-c]', row).forEach((b) => (b.onclick = () => { input.value = b.dataset.c!; fire(input); }));
    $<HTMLElement>('.sw.more', row).onclick = () => (popEl?.classList.contains('more-pop') ? closePop() : openMorePop(row, input, fire));
  });
  $$('.seg.widths button', body).forEach((b) => (b.onclick = () => { const i = $<HTMLInputElement>('#p-width', body); i.value = b.dataset.w!; fire(i); }));
  $$('.seg.dashes button', body).forEach((b) => (b.onclick = () => { const i = $<HTMLSelectElement>('#p-dash', body); i.value = b.dataset.dash!; fire(i); }));
  const slide = (el: HTMLInputElement) => { el.style.setProperty('--v', `${el.value}%`); el.nextElementSibling!.textContent = `${el.value}%`; };
  bind('p-stroke', 'change', (el) => apply((s) => (s.stroke = el.value)));
  bind('p-fill-on', 'change', (el) => apply((s) => (s.fill = el.checked ? $<HTMLInputElement>('#p-fill', body)?.value ?? '#ffffff' : null)));
  bind('p-fill', 'change', (el) => { const on = $<HTMLInputElement>('#p-fill-on', body); if (on) on.checked = true; apply((s) => (s.fill = el.value)); });
  bind('p-opacity', 'input', slide);
  bind('p-opacity', 'change', (el) => apply((s) => (s.opacity = +el.value / 100)));
  bind('p-fill-opacity', 'input', slide);
  bind('p-fill-opacity', 'change', (el) => apply((s) => (s.fillOpacity = +el.value / 100)));
  bind('p-width', 'change', (el) => apply((s) => (s.width = Math.max(0, +el.value || 0))));
  bind('p-dash', 'change', (el) => apply((s) => (s.dash = el.value as Style['dash'])));
  bind('p-start', 'change', (el) => apply((s) => (s.startHead = el.value as Style['startHead'])));
  bind('p-end', 'change', (el) => apply((s) => (s.endHead = el.value as Style['endHead'])));
  bind('p-font', 'change', (el) => apply((s) => (s.fontSize = Math.max(4, +el.value || 12))));
  bind('p-textcolor', 'change', (el) => apply((s) => (s.textColor = el.value)));
  bind('p-layer', 'change', (el) => mutate(() => sel.forEach((m) => (m.layer = el.value))));
  bind('p-comment', 'change', (el) => mutate(() => sel.forEach((m) => (m.comment = el.value))));
  $('#p-goscale', body)?.addEventListener('click', () => { rightTab = 'scale'; renderRight(); });
  $('#p-edit-text', body)?.addEventListener('click', () => openEditor(first.id, false));
  $('#p-delete', body)?.addEventListener('click', deleteSelection);
  $('#p-make-default', body)?.addEventListener('click', () => { toolStyles[first.type] = clone(first.style); saveToolStyles(); toast(`New ${TYPE_LABEL[first.type].toLowerCase()} markups will use this style`); });
  $('#p-reset', body)?.addEventListener('click', () => { toolStyles[drawTool!] = clone(DEFAULT_STYLES[drawTool!]); saveToolStyles(); renderRight(); });
  $('#p-preset', body)?.addEventListener('click', () => {
    const name = prompt('Name this style', `${TYPE_LABEL[type]} ${presets.filter((p) => p.tool === type).length + 1}`);
    if (!name) return;
    presets.push({ id: uid(), name, tool: type, style: clone(st) });
    savePresets();
    if (leftTab === 'chest') renderLeft();
    toast(`Saved "${name}" to the Tool Chest`);
  });
}

interface Row { m: Markup; pageNo: number; mv: ReturnType<typeof measureOf>; scale: ScaleCal }
function markupRows(): Row[] {
  if (!doc) return [];
  const idx = new Map(doc.pages.map((p, i) => [p.uid, i]));
  return doc.markups
    .filter((m) => idx.has(m.page))
    .map((m) => {
      const ref = doc!.pages[idx.get(m.page)!];
      return { m, pageNo: idx.get(m.page)! + 1, mv: measureOf(m, scaleOf(ref)), scale: scaleOf(ref) };
    })
    .sort((a, b) => a.pageNo - b.pageNo || a.m.created - b.m.created);
}
function totalsOf(rows: Row[]) {
  const len = new Map<string, number>(), area = new Map<string, { v: number; a2: number; a2u: string }>();
  let count = 0;
  for (const r of rows) {
    if (!r.mv) continue;
    if (r.mv.kind === 'length') len.set(r.mv.unit, (len.get(r.mv.unit) ?? 0) + r.mv.value);
    else if (r.mv.kind === 'area') {
      const t = area.get(r.mv.unit) ?? { v: 0, a2: 0, a2u: r.mv.area2Unit! };
      t.v += r.mv.value;
      t.a2 += r.mv.area2!;
      area.set(r.mv.unit, t);
    } else count += r.mv.value;
  }
  return { len, area, count };
}
let listFilter: 'all' | 'page' | 'measure' = 'all';
function renderMarkupList(body: HTMLElement) {
  if (!doc) { body.innerHTML = '<p class="muted">No document open.</p>'; return; }
  let rows = markupRows();
  if (listFilter === 'page') rows = rows.filter((r) => r.pageNo === currentPage + 1);
  if (listFilter === 'measure') rows = rows.filter((r) => r.mv);
  const t = totalsOf(rows);
  const layerName = (id: string) => doc!.layers.find((l) => l.id === id)?.name ?? '';
  body.innerHTML = `
    <div class="mfilter"><select id="ml-filter" aria-label="Show"><option value="all">All markups</option><option value="page">This page</option><option value="measure">Measurements</option></select>
      <button class="btn" id="ml-csv" data-tip="Download every markup and measurement as a spreadsheet">${ICONS.export}CSV</button></div>
    <div class="mlist" id="mlist" role="listbox" aria-label="Markups">
    ${rows.map((r) => {
      const c = r.m.style.fill && r.m.type !== 'm-perimeter' ? r.m.style.fill : r.m.style.stroke;
      const val = r.mv ? (r.mv.kind === 'area' ? `${fmtNum(r.mv.value, r.scale.precision)} <small>${r.mv.unit} · ${fmtNum(r.mv.area2!, 3)} ${r.mv.area2Unit}</small>` : esc(r.mv.text)) : '';
      const note = r.m.comment || r.m.text || layerName(r.m.layer);
      return `<div class="mrow ${selection.has(r.m.id) ? 'on' : ''}" data-id="${r.m.id}" role="option" aria-selected="${selection.has(r.m.id)}" tabindex="0"><span class="mic" style="--c:${c}">${ICONS[r.m.type] ?? ''}</span><span class="mt"><b>${TYPE_LABEL[r.m.type]}</b><small>p.${r.pageNo} · ${esc(note)}</small></span><span class="mv">${val}</span></div>`;
    }).join('')}
    </div>
    ${rows.length ? '' : '<p class="muted">No markups yet. Pick a tool on the left and draw on the sheet.</p>'}
    <div class="totals" id="ml-totals"><h4>Totals</h4>
      ${[...t.len].map(([u, v]) => `<div><span>Length</span><b>${fmtNum(v)} <small>${u}</small></b></div>`).join('')}
      ${[...t.area].map(([u, v]) => `<div><span>Area</span><b>${fmtNum(v.v)} <small>${u}</small></b></div><div><span></span><b>${fmtNum(v.a2, 4)} <small>${v.a2u}</small></b></div>`).join('')}
      ${t.count ? `<div><span>Count</span><b>${t.count}</b></div>` : ''}
      ${!t.len.size && !t.area.size && !t.count ? '<div class="muted">No measurements</div>' : ''}
    </div>`;
  $<HTMLSelectElement>('#ml-filter', body).value = listFilter;
  $<HTMLSelectElement>('#ml-filter', body).onchange = (e) => { listFilter = (e.target as HTMLSelectElement).value as typeof listFilter; renderRight(); };
  $('#ml-csv', body).onclick = exportCsv;
  $$('.mrow[data-id]', body).forEach((row) => {
    const go = () => {
      const m = doc!.markups.find((x) => x.id === row.dataset.id)!;
      selection = new Set([m.id]);
      const v = viewOf(m.page);
      if (v) {
        const b = markupBounds(m, v);
        const [cx, cy] = v.vp1.convertToViewportPoint((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        const r = v.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
        viewer.scrollLeft += r.left + cx * ptPx() - (vr.left + vr.width / 2);
        viewer.scrollTop += r.top + cy * ptPx() - (vr.top + vr.height / 2);
      }
      redrawSelection();
      renderRight();
    };
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

function csvCell(v: unknown) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv() {
  if (!doc) return;
  const rows = markupRows();
  const head = ['Page', 'Type', 'Layer', 'Measurement', 'Value', 'Unit', 'Area (ac/ha)', 'Area unit 2', 'Perimeter', 'Count', 'Scale', 'Text', 'Comment', 'Color', 'Fill', 'Line width (pt)', 'Opacity', 'Author', 'Created'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const m = r.m, mv = r.mv;
    lines.push([
      r.pageNo, TYPE_LABEL[m.type], doc.layers.find((l) => l.id === m.layer)?.name, mv?.text ?? '', mv && mv.kind !== 'count' ? +mv.value.toFixed(6) : '', mv && mv.kind !== 'count' ? mv.unit : '',
      mv?.area2 !== undefined ? +mv.area2.toFixed(6) : '', mv?.area2Unit ?? '', mv?.perimeter !== undefined ? +mv.perimeter.toFixed(6) : '', mv?.kind === 'count' ? mv.value : '',
      mv ? r.scale.label : '', m.text ?? '', m.comment ?? '', m.style.stroke, m.style.fill ?? '', m.style.width, m.style.opacity, m.author ?? '', new Date(m.created).toISOString(),
    ].map(csvCell).join(','));
  }
  const t = totalsOf(rows);
  lines.push('');
  for (const [u, v] of t.len) lines.push(['TOTAL', 'Length', '', '', +v.toFixed(6), u].map(csvCell).join(','));
  for (const [u, v] of t.area) lines.push(['TOTAL', 'Area', '', '', +v.v.toFixed(6), u, +v.a2.toFixed(6), v.a2u].map(csvCell).join(','));
  if (t.count) lines.push(['TOTAL', 'Count', '', '', '', '', '', '', '', t.count].map(csvCell).join(','));
  download(new TextEncoder().encode(lines.join('\r\n')), doc.name.replace(/\.pdf$/i, '') + '_markups.csv');
}

async function renderLayers(body: HTMLElement) {
  if (!doc) { body.innerHTML = '<p class="muted small">No document open.</p>'; return; }
  const d = doc;
  body.innerHTML = `<section><h4>Markup layers <button class="link" id="ly-add">${ICONS.plus}New</button></h4><p class="muted small">New markups go on the highlighted layer. They are saved as PDF layers, so other PDF apps can toggle them too.</p><div id="app-layers"></div></section>
    <section><h4>Layers in the PDF</h4><div id="pdf-layers"><p class="muted small">Reading…</p></div></section>`;
  const al = $('#app-layers', body);
  for (const l of d.layers) {
    const n = d.markups.filter((m) => m.layer === l.id).length;
    const row = h(`<div class="layer ${l.id === d.activeLayer ? 'active' : ''}" data-layer="${l.id}">
      <input type="checkbox" class="ly-vis eye" aria-label="Show ${esc(l.name)}" data-tip="Show or hide" ${l.visible ? 'checked' : ''}>
      <span class="name" data-tip="Click to draw on this layer. Double-click to rename.">${esc(l.name)}</span><span class="lk">${n}</span>
      <button class="ib sm ly-lock ${l.locked ? 'on' : 'faint'}" aria-label="${l.locked ? 'Unlock' : 'Lock'} ${esc(l.name)}" data-tip="${l.locked ? 'Locked: click to unlock' : 'Lock so markups can’t be moved'}">${l.locked ? ICONS.lock : ICONS.unlock}</button>
      ${d.layers.length > 1 ? `<button class="ib sm faint ly-del" aria-label="Delete layer ${esc(l.name)}" data-tip="Delete layer (its markups move to the first layer)">${ICONS.close}</button>` : ''}</div>`);
    $<HTMLInputElement>('.ly-vis', row).onchange = (e) => mutate(() => (l.visible = (e.target as HTMLInputElement).checked));
    $('.name', row).onclick = () => mutate(() => (d.activeLayer = l.id));
    $('.name', row).ondblclick = () => {
      const name = prompt('Layer name', l.name);
      if (name) mutate(() => (l.name = name));
    };
    $('.ly-lock', row).onclick = () => mutate(() => (l.locked = !l.locked));
    $('.ly-del', row)?.addEventListener('click', () => {
      mutate(() => {
        d.layers = d.layers.filter((x) => x !== l);
        const to = d.layers[0].id;
        d.markups.forEach((m) => m.layer === l.id && (m.layer = to));
        if (d.activeLayer === l.id) d.activeLayer = to;
      });
    });
    al.appendChild(row);
  }
  $('#ly-add', body).onclick = () => {
    const name = prompt('New layer name', `Layer ${d.layers.length + 1}`);
    if (!name) return;
    const l: Layer = { id: uid(), name, visible: true };
    mutate(() => { d.layers.push(l); d.activeLayer = l.id; });
  };
  // PDF optional content groups
  const pl = $('#pdf-layers', body);
  let html = '';
  const srcIds = [...new Set(d.pages.map((p) => p.src))];
  for (const sid of srcIds) {
    const cfg = await ocgFor(d, sid);
    const groups: [string, any][] = [...cfg];
    if (!groups.length) continue;
    if (srcIds.length > 1) html += `<div class="muted small srcname">${esc(sources.get(sid)!.name)}</div>`;
    for (const [id, g] of groups) html += `<label class="layer"><input type="checkbox" class="ocg eye" data-src="${sid}" data-ocg="${esc(id)}" ${g.visible ? 'checked' : ''}><span class="name">${esc(g.name || id)}</span></label>`;
  }
  if (doc !== d || rightTab !== 'layers') return;
  pl.innerHTML = html || '<p class="muted small">This PDF has no layers of its own.</p>';
  $$<HTMLInputElement>('input.ocg', pl).forEach((cb) => (cb.onchange = () => {
    const sid = cb.dataset.src!, id = cb.dataset.ocg!;
    mutate(() => {
      const hid = new Set(d.ocgHidden[sid] ?? []), shw = new Set(d.ocgShown[sid] ?? []);
      if (cb.checked) { hid.delete(id); shw.add(id); } else { hid.add(id); shw.delete(id); }
      d.ocgHidden[sid] = [...hid];
      d.ocgShown[sid] = [...shw];
    });
    invalidateRender(sid);
  }));
}

function renderScalePanel(body: HTMLElement) {
  if (!doc || !views[currentPage]) { body.innerHTML = '<p class="muted">No document open.</p>'; return; }
  const ref = views[currentPage].ref;
  const s = scaleOf(ref);
  const units = [...IMPERIAL, ...METRIC];
  const set = !!ref.scale;
  const same = doc.pages.filter((p) => JSON.stringify(scaleOf(p)) === JSON.stringify(s)).length;
  body.innerHTML = `<div class="ph"><div class="ph-ic" style="--c:var(--ms)">${ICONS.scale}</div><div><div class="ph-t">Page ${currentPage + 1} scale</div><div class="ph-s">${set ? `${same} of ${doc.pages.length} pages use this scale` : 'Not calibrated yet'}</div></div></div>
    <div class="measure scalecard ${set ? '' : 'unset'}" id="sc-current"><div class="m-main"><span class="m-v">${esc(s.label)}</span></div><div class="m-sub">1 inch on paper = <b>${fmtNum(s.factor * 72, 4)}</b> ${UNIT_LABEL[s.unit]}</div></div>
    <div class="pf"><button class="btn primary" id="sc-cal" data-tip="Drag along a dimension you know (K)">${ICONS.calibrate}Calibrate</button><button class="btn" id="sc-set">${ICONS.scale}Set scale…</button></div>
    <section><h4>Display</h4>
      <div class="field"><label for="sc-unit">Unit</label><select id="sc-unit">${units.map((u) => `<option value="${u}" ${u === s.unit ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`).join('')}</select></div>
      <div class="field"><label for="sc-prec">Decimals</label><select id="sc-prec">${[0, 1, 2, 3, 4].map((p) => `<option value="${p}" ${p === s.precision ? 'selected' : ''}>${p}</option>`).join('')}</select></div></section>
    <div class="pf"><button class="btn" id="sc-all">Use on all pages</button>${set ? '<button class="btn danger" id="sc-clear">Clear</button>' : ''}</div>
    <p class="muted small">Areas show in square ${UNIT_LABEL[s.unit]} and ${METRIC.includes(s.unit) ? 'hectares' : 'acres'}. The scale is saved inside the PDF using the standard measurement format, so other PDF apps can read it.</p>`;
  $('#sc-cal', body).onclick = () => setTool('calibrate');
  $('#sc-set', body).onclick = () => openScaleDialog();
  $<HTMLSelectElement>('#sc-unit', body).onchange = (e) => mutate(() => (ref.scale = { ...withUnit(s, (e.target as HTMLSelectElement).value as Unit) }));
  $<HTMLSelectElement>('#sc-prec', body).onchange = (e) => mutate(() => (ref.scale = { ...s, precision: +(e.target as HTMLSelectElement).value }));
  $('#sc-all', body).onclick = () => mutate(() => doc!.pages.forEach((p) => (p.scale = clone(s))));
  $('#sc-clear', body)?.addEventListener('click', () => mutate(() => (ref.scale = undefined)));
}

function updateStatus() {
  const v = views[currentPage];
  const chip = $('#scalechip');
  const sc = v ? scaleOf(v.ref) : null;
  $('#st-scale').innerHTML = !v ? 'No document' : v.ref.scale ? `${esc(sc!.label)}<small>page ${currentPage + 1}</small>` : 'No scale<small>click to calibrate</small>';
  chip.classList.toggle('unset', !!v && !v.ref.scale);
  chip.hidden = !v;
  ($('#btn-undo') as HTMLButtonElement).disabled = !doc || !hist().undo.length;
  ($('#btn-redo') as HTMLButtonElement).disabled = !doc || !hist().redo.length;
}

// ───────────────────────── dialogs ─────────────────────────
function openShortcuts() {
  const k = (s: string) => s.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('');
  const rows = (list: [string, string][]) => list.map(([a, b]) => `<div class="kr"><span>${a}</span><span>${k(b)}</span></div>`).join('');
  const tools = (Object.keys(TOOL_NAMES) as ToolId[]).map((id) => { const m = TOOL_NAMES[id].match(/^(.*?) \((.*)\)$/)!; return [m[1], m[2].split(' / ')[0]] as [string, string]; });
  const dlg = dialog(`<div class="dlg wide"><h3>Keyboard shortcuts</h3><div class="kgrid">
    <div><h4>Tools</h4>${rows(tools)}</div>
    <div><h4>Editing</h4>${rows([['Undo', `${MOD}Z`], ['Redo', isMac ? '⇧⌘Z' : 'Ctrl+Y'], ['Copy / paste', `${MOD}C ${MOD}V`], ['Select all on page', `${MOD}A`], ['Delete', 'Delete'], ['Nudge (Shift = 10 px)', '← → ↑ ↓'], ['Finish polyline or area', 'Enter'], ['Remove last point', 'Backspace'], ['Constrain to 45°', 'Shift'], ['Cancel', 'Esc']])}
      <h4>View and files</h4>${rows([['Zoom in / out', '+ −'], ['Zoom at pointer', `${MOD}wheel`], ['Pan', 'Space drag'], ['Open', `${MOD}O`], ['Save', `${MOD}S`], ['This list', '?']])}</div>
  </div><div class="actions"><button class="btn primary" data-close>Done</button></div></div>`);
  void dlg;
}
function dialog(html: string): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); d.close(); }));
  d.showModal();
  return d;
}
const unitOptions = (sel: Unit) => [...IMPERIAL, ...METRIC].map((u) => `<option value="${u}" ${u === sel ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`).join('');

function applyScaleTo(scale: ScaleCal, target: string, pageUid: string) {
  mutate(() => {
    for (const p of doc!.pages) {
      if (target === 'all' || p.uid === pageUid || (target === 'same' && p.index === 0 && false)) p.scale = clone(scale);
    }
  });
  toast(`Scale set: ${scale.label}`);
}

function openCalibrateDialog(distPts: number, pageUid: string) {
  const cur = scaleOf(doc!.pages.find((p) => p.uid === pageUid));
  const dlg = dialog(`<form class="dlg" id="cal-form"><h3>Calibrate scale</h3>
    <p class="muted">You picked two points ${fmtNum(distPts, 2)} pt apart (${fmtNum(distPts / 72, 3)} in on paper). How long is that in the real world?</p>
    <div class="row"><label>Known length</label><input type="number" id="cal-value" step="any" min="0" required autofocus><select id="cal-unit">${unitOptions(cur.factor === PAPER_SCALE.factor ? 'ft' : cur.unit)}</select></div>
    <div class="row"><label>Precision</label><select id="cal-prec">${[0, 1, 2, 3, 4].map((p) => `<option ${p === 2 ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="row"><label>Apply to</label><select id="cal-target"><option value="page">This page</option><option value="all">All pages</option></select></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cal-ok" type="submit">Apply</button></div></form>`);
  $('#cal-form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = +$<HTMLInputElement>('#cal-value', dlg).value;
    if (!(v > 0)) return;
    const unit = $<HTMLSelectElement>('#cal-unit', dlg).value as Unit;
    const sc = scaleFromCalibration(distPts, v, unit, +$<HTMLSelectElement>('#cal-prec', dlg).value);
    applyScaleTo(sc, $<HTMLSelectElement>('#cal-target', dlg).value, pageUid);
    dlg.close();
    setTool('m-length');
  });
}

function openScaleDialog() {
  if (!doc) return;
  const ref = views[currentPage].ref;
  const groups = [...new Set(SCALE_PRESETS.map((p) => p.group))];
  const dlg = dialog(`<form class="dlg" id="sc-form"><h3>Set scale</h3>
    <label class="radio"><input type="radio" name="mode" value="preset" checked><div><b>Standard scale</b>
      <div class="row"><select id="sc-preset">${groups.map((g) => `<optgroup label="${g}">${SCALE_PRESETS.map((p, i) => (p.group === g ? `<option value="${i}">${esc(p.label)}</option>` : '')).join('')}</optgroup>`).join('')}</select></div></div></label>
    <label class="radio"><input type="radio" name="mode" value="custom"><div><b>Custom</b>
      <div class="row"><input type="number" id="sc-paper" value="1" step="any" style="width:70px"><select id="sc-paper-unit"><option value="in">in</option><option value="mm">mm</option><option value="cm">cm</option></select> =
      <input type="number" id="sc-real" value="100" step="any" style="width:80px"><select id="sc-real-unit">${unitOptions('ft')}</select></div></div></label>
    <div class="row"><label>Precision</label><select id="sc-prec2">${[0, 1, 2, 3, 4].map((p) => `<option ${p === 2 ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="row"><label>Apply to</label><select id="sc-target"><option value="page">This page (${currentPage + 1})</option><option value="all">All pages</option></select></div>
    <p class="muted small">Tip: if the drawing was printed at a different size, use Calibrate instead and click a known dimension.</p>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="sc-ok">Apply</button></div></form>`);
  $('#sc-form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = $<HTMLInputElement>('input[name=mode]:checked', dlg).value;
    const prec = +$<HTMLSelectElement>('#sc-prec2', dlg).value;
    let sc: ScaleCal;
    if (mode === 'preset') sc = { ...SCALE_PRESETS[+$<HTMLSelectElement>('#sc-preset', dlg).value].make(), precision: prec };
    else {
      const paper = +$<HTMLInputElement>('#sc-paper', dlg).value, real = +$<HTMLInputElement>('#sc-real', dlg).value;
      if (!(paper > 0 && real > 0)) return;
      sc = scaleFromRatio(paper, $<HTMLSelectElement>('#sc-paper-unit', dlg).value as Unit, real, $<HTMLSelectElement>('#sc-real-unit', dlg).value as Unit, undefined, prec);
    }
    applyScaleTo(sc, $<HTMLSelectElement>('#sc-target', dlg).value, ref.uid);
    dlg.close();
  });
}

/** Run exportPdf in a short-lived worker (falls back to the UI thread if workers fail). */
async function exportOffThread(d: Doc, opts: Parameters<typeof exportPdf>[2]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (typeof Worker === 'undefined' || /[?&]mainexport\b/.test(location.search)) return exportPdf(d, sources, opts);
  const ids = new Set(d.pages.map((p) => p.src));
  const srcs = [...ids].map((id) => sources.get(id)).filter(Boolean).map((s) => ({ id: s!.id, name: s!.name, bytes: s!.bytes }));
  let w: Worker;
  try { w = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' }); } catch { return exportPdf(d, sources, opts); }
  try {
    return await new Promise((res, rej) => {
      w.onmessage = (e) => (e.data.ok ? res({ bytes: e.data.bytes, pageCount: e.data.pageCount }) : rej(new Error(e.data.error)));
      w.onerror = (e) => { e.preventDefault(); rej(new Error(e.message || 'Export worker failed')); };
      // structured clone copies the source bytes; that copy is freed with the worker
      w.postMessage({ doc: JSON.parse(JSON.stringify(d)), sources: srcs, opts });
    });
  } finally {
    w.terminate();
  }
}
async function buildExport(flatten: boolean, layersAsOcg = true) {
  return exportOffThread(doc!, { flatten, layersAsOcg, author });
}
async function quickSave() {
  if (!doc) return;
  if (editing) commitEditor();
  const name = doc.name.replace(/\.pdf$/i, '') + '.pdf';
  const out = await busy('Saving…', () => buildExport(false));
  await saveBytes(out.bytes, name, false);
  if (!native) toast(`Saved ${name} (${fmtBytes(out.bytes.length)}) with editable markups`);
}

function openExportDialog() {
  if (!doc) return;
  if (editing) commitEditor();
  const base = doc.name.replace(/\.pdf$/i, '');
  const canPick = 'showSaveFilePicker' in window;
  const dlg = dialog(`<form class="dlg" id="ex-form"><h3>Save PDF</h3>
    <label class="radio"><input type="radio" name="ex-mode" value="editable" checked><div><b>Editable markups</b><small>Real PDF annotations that stay editable in SheetScale and most other PDF editors.</small></div></label>
    <label class="radio"><input type="radio" name="ex-mode" value="flatten"><div><b>Flattened</b><small>Markups are burned into the page content and can no longer be moved or edited.</small></div></label>
    <div class="row"><label>File name</label><input type="text" id="ex-name" value="${esc(base)}"><span class="muted">.pdf</span></div>
    <div class="row"><input type="checkbox" id="ex-ocg" checked><span>Save markup layers as PDF layers</span></div>
    <div class="row"><input type="checkbox" id="ex-reduce"><span>Also reduce file size (lossless)</span></div>
    ${canPick ? '<div class="row"><input type="checkbox" id="ex-pick"><span>Choose where to save</span></div>' : ''}
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="ex-ok">Save</button></div></form>`);
  $<HTMLInputElement>('#ex-name', dlg).addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  dlg.querySelectorAll('input[name=ex-mode]').forEach((r) => r.addEventListener('change', () => {
    const fl = $<HTMLInputElement>('input[name=ex-mode]:checked', dlg).value === 'flatten';
    const nm = $<HTMLInputElement>('#ex-name', dlg);
    nm.value = fl ? (nm.value.endsWith('_flattened') ? nm.value : `${nm.value}_flattened`) : nm.value.replace(/_flattened$/, '');
  }));
  $('#ex-form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const flatten = $<HTMLInputElement>('input[name=ex-mode]:checked', dlg).value === 'flatten';
    const name = ($<HTMLInputElement>('#ex-name', dlg).value.trim() || base) + '.pdf';
    const reduce = $<HTMLInputElement>('#ex-reduce', dlg).checked;
    const pick = !!$<HTMLInputElement>('#ex-pick', dlg)?.checked;
    const ocg = $<HTMLInputElement>('#ex-ocg', dlg).checked;
    dlg.close();
    let bytes = (await busy(flatten ? 'Flattening…' : 'Saving…', () => buildExport(flatten, ocg))).bytes;
    const before = bytes.length;
    if (reduce) {
      const r = await busy('Reducing size…', () => reduceLosslessConsume(bytes));
      if (r.error) toast(`Size reduction skipped: ${r.error}`);
      if (!r.bytes) { toast('Size reduction failed and the file could not be recovered. Please save again without reducing.'); return; }
      bytes = r.bytes;
    }
    await saveBytes(bytes, name, pick);
    if (!native) toast(`Saved ${name} — ${fmtBytes(bytes.length)}${reduce ? ` (was ${fmtBytes(before)})` : ''}`);
  });
}

function openCombineDialog() {
  let items: { kind: 'doc'; doc: Doc; on: boolean }[] = docs.map((d) => ({ kind: 'doc' as const, doc: d, on: true }));
  const dlg = dialog(`<div class="dlg"><h3>Combine PDFs</h3><p class="muted">Tick the files to combine and set their order. Markups, scales and layers come along. You can fine-tune page order afterwards by dragging thumbnails.</p>
    <div class="list-order" id="cb-list"></div>
    <div class="btn-row"><button class="btn" id="cb-add">Add files…</button><input type="file" id="cb-file" multiple accept=".pdf,application/pdf,image/*,.tif,.tiff" hidden></div>
    <div class="row"><label>New file name</label><input type="text" id="cb-name" value="Combined"></div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cb-ok">Combine</button></div></div>`);
  const draw = () => {
    const l = $('#cb-list', dlg);
    l.innerHTML = items.length ? '' : '<p class="muted small" style="padding:8px">Open or add at least two files.</p>';
    items.forEach((it, i) => {
      const row = h(`<div class="it"><input type="checkbox" ${it.on ? 'checked' : ''}><span class="nm">${esc(it.doc.name)}</span><span class="muted small">${it.doc.pages.length} pg</span><button title="Move up">↑</button><button title="Move down">↓</button></div>`);
      $<HTMLInputElement>('input', row).onchange = (e) => (it.on = (e.target as HTMLInputElement).checked);
      const [up, down] = $$('button', row);
      up.onclick = () => { if (i) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } };
      down.onclick = () => { if (i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } };
      l.appendChild(row);
    });
  };
  draw();
  $('#cb-add', dlg).onclick = () => $<HTMLInputElement>('#cb-file', dlg).click();
  $<HTMLInputElement>('#cb-file', dlg).onchange = async (e) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    for (const f of files) {
      const d = isPdf(f) ? await openPdfBytes(f.name, new Uint8Array(await f.arrayBuffer())) : await openPdfBytes(f.name.replace(/\.[^.]+$/, '.pdf'), await imagesToPdf([f]));
      docs.push(d);
      await persistDoc(d);
      items.push({ kind: 'doc', doc: d, on: true });
    }
    renderTabs();
    draw();
  };
  $('#cb-ok', dlg).onclick = async () => {
    const chosen = items.filter((i) => i.on).map((i) => i.doc);
    if (!chosen.length) return;
    const out = newDoc(($<HTMLInputElement>('#cb-name', dlg).value.trim() || 'Combined') + '.pdf');
    out.layers = [];
    for (const d of chosen) mergeInto(out, d, out.pages.length);
    if (!out.layers.length) out.layers = [clone(DEFAULT_LAYER)];
    out.activeLayer = out.layers[0].id;
    dlg.close();
    docs.push(out);
    await persistDoc(out);
    await activate(out);
    toast(`Combined ${chosen.length} files into ${out.pages.length} pages`);
  };
}

function openReduceDialog() {
  const dlg = dialog(`<div class="dlg"><h3>Reduce file size (lossless)</h3>
    <p class="muted">Rewrites the PDF structure with qpdf: compresses uncompressed streams, recompresses existing ones at maximum level, packs objects into object streams and drops unused objects and resources. <b>Images are never downsampled or re-encoded</b>, so pages look identical.</p>
    <div class="btn-row"><button class="btn primary" id="rd-pick">Choose PDF files…</button>${doc ? '<button class="btn" id="rd-current">Current document</button>' : ''}
    <input type="file" id="rd-input" multiple accept=".pdf,application/pdf" hidden></div>
    <div class="row"><input type="checkbox" id="rd-lin"><span>Also linearize (fast web view)</span></div>
    <table class="sizes" id="rd-table"><thead><tr><th>File</th><th>Before</th><th>After</th><th>Saved</th><th></th></tr></thead><tbody></tbody></table>
    <div class="actions"><button class="btn" data-close>Close</button></div></div>`);
  const tbody = $('#rd-table tbody', dlg);
  // `input` is moved into the qpdf worker (no copy); results are kept as Blobs, not JS buffers.
  const run = async (name: string, input: Uint8Array, original?: Blob) => {
    const size = input.length;
    const row = h(`<tr><td>${esc(name)}</td><td>${fmtBytes(size)}</td><td colspan="3" class="muted">Working…</td></tr>`);
    tbody.appendChild(row);
    const r = await reduceLosslessConsume(input, { linearize: $<HTMLInputElement>('#rd-lin', dlg).checked });
    if (r.error || !r.bytes) {
      row.innerHTML = `<td>${esc(name)}</td><td>${fmtBytes(size)}</td><td colspan="3" style="color:var(--danger)">${esc(r.error ?? 'Failed')}</td>`;
      return;
    }
    const better = r.reduced;
    const finalLen = r.bytes.length;
    const final = better || !original ? new Blob([r.bytes as BlobPart], { type: 'application/pdf' }) : original;
    const pct = ((1 - finalLen / size) * 100).toFixed(1);
    row.innerHTML = `<td>${esc(name)}</td><td class="rd-before" data-bytes="${size}">${fmtBytes(size)}</td><td class="rd-after" data-bytes="${finalLen}">${fmtBytes(finalLen)}</td><td>${better ? `${pct}%` : 'Already optimal'}</td><td><button class="btn rd-dl">Download</button></td>`;
    $('.rd-dl', row).onclick = () => download(final, name.replace(/\.pdf$/i, '') + (better ? '_reduced' : '') + '.pdf');
  };
  $('#rd-pick', dlg).onclick = () => $<HTMLInputElement>('#rd-input', dlg).click();
  $<HTMLInputElement>('#rd-input', dlg).onchange = async (e) => {
    for (const f of [...((e.target as HTMLInputElement).files ?? [])]) await run(f.name, new Uint8Array(await f.arrayBuffer()), f);
  };
  $('#rd-current', dlg)?.addEventListener('click', async () => {
    const out = await buildExport(false);
    await run(doc!.name, out.bytes);
  });
}

// ───────────────────────── wiring ─────────────────────────
$('#btn-open').onclick = () => $<HTMLInputElement>('#file-open').click();
$<HTMLInputElement>('#file-open').onchange = (e) => {
  const inp = e.target as HTMLInputElement;
  openFiles([...(inp.files ?? [])]).finally(() => (inp.value = ''));
};
$('#btn-save').onclick = () => quickSave();
$('#btn-export').onclick = () => openExportDialog();
$('#btn-combine').onclick = () => openCombineDialog();
$('#btn-reduce').onclick = () => openReduceDialog();
$('#btn-undo').onclick = () => undo();
$('#btn-redo').onclick = () => redo();
$('#zoom-in').onclick = () => setZoom(zoom * 1.25);
$('#zoom-out').onclick = () => setZoom(zoom / 1.25);
$('#fit-width').onclick = () => fitWidth();
$('#fit-page').onclick = () => fitPage();
$<HTMLInputElement>('#zoom-input').onchange = (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (v > 0) setZoom(v / 100);
};
$<HTMLInputElement>('#page-input').onchange = (e) => goToPage(+(e.target as HTMLInputElement).value - 1);
$('#btn-snap').onclick = () => { snapOn = !snapOn; $('#btn-snap').classList.toggle('on', snapOn); $('#btn-snap').setAttribute('aria-pressed', String(snapOn)); };
$('#pg-prev').onclick = () => goToPage(currentPage - 1);
$('#pg-next').onclick = () => goToPage(currentPage + 1);
$('#scalechip').onclick = () => { rightTab = 'scale'; if (app.classList.contains('no-right')) setPanels(!app.classList.contains('no-left'), true); renderRight(); };
$<HTMLInputElement>('#file-images').onchange = (e) => {
  const inp = e.target as HTMLInputElement;
  openFiles([...(inp.files ?? [])]).finally(() => (inp.value = ''));
};
$('#pg-rotl').onclick = () => rotatePages(-90);
$('#pg-rotr').onclick = () => rotatePages(90);
$('#pg-del').onclick = () => deletePages();
$('#pg-extract').onclick = () => extractPages();
$('#pg-insert').onclick = () => $<HTMLInputElement>('#file-insert').click();
$<HTMLInputElement>('#file-insert').onchange = (e) => {
  const inp = e.target as HTMLInputElement;
  insertFiles([...(inp.files ?? [])]).finally(() => (inp.value = ''));
};
$$('[data-lt]').forEach((b) => (b.onclick = () => { leftTab = b.dataset.lt as typeof leftTab; renderLeft(); }));
$$('[data-rt]').forEach((b) => (b.onclick = () => { rightTab = b.dataset.rt as typeof rightTab; renderRight(); }));

// drag & drop files anywhere
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  viewer.classList.add('drop-over');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) viewer.classList.remove('drop-over'); });
document.addEventListener('drop', (e) => {
  viewer.classList.remove('drop-over');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  openFiles([...e.dataTransfer.files]);
});

// Files opened via the installed app (PWA file handler)
if ('launchQueue' in window) {
  (window as any).launchQueue.setConsumer(async (p: any) => {
    const files: File[] = [];
    for (const fh of p.files ?? []) files.push(await fh.getFile());
    openFiles(files);
  });
}

// test / debugging hook (read-only views + helpers; no network)
(window as any).__pm = {
  get doc() { return doc; },
  get docs() { return docs; },
  get zoom() { return zoom; },
  get draft() { return draft; },
  get tool() { return tool; },
  setZoom: (z: number) => setZoom(z),
  measure: (id: string) => {
    const m = doc!.markups.find((x) => x.id === id)!;
    return measureOf(m, scaleOf(doc!.pages.find((p) => p.uid === m.page)));
  },
  pageBox: (i: number) => {
    const r = views[i].el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, rot: views[i].rot, vw: views[i].vp1.width, vh: views[i].vp1.height };
  },
  userToClient: (i: number, x: number, y: number) => {
    const v = views[i];
    const r = v.el.getBoundingClientRect();
    const [vx, vy] = v.vp1.convertToViewportPoint(x, y);
    return { x: r.left + vx * ptPx(), y: r.top + vy * ptPx() };
  },
  rendered: () => visibleViews(0).every((v) => v.baseScale > 0),
  renderStats: () => ({ ...renderQueueStats(), bases: views.filter((v) => v.baseScale > 0).length, tiles: views.reduce((n, v) => n + v.tileMap.size, 0), thumbs: drawnThumbs.size, worker: useWorker }),
  goToPage: (i: number) => goToPage(i),
  centerOn: (i: number, x: number, y: number) => {
    const v = views[i];
    const r = v.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
    const [vx, vy] = v.vp1.convertToViewportPoint(x, y);
    viewer.scrollLeft += r.left + vx * ptPx() - (vr.left + vr.width / 2);
    viewer.scrollTop += r.top + vy * ptPx() - (vr.top + vr.height / 2);
  },
  setSnap: (on: boolean) => { snapOn = on; $('#btn-snap').classList.toggle('on', on); $('#btn-snap').setAttribute('aria-pressed', String(on)); },
  setTheme: (m: ThemeMode) => { themeMode = m; applyTheme(); },
  setGlass: (on: boolean) => document.documentElement.classList.toggle('no-glass', !on),
  setPanels: (l: boolean, r: boolean) => setPanels(l, r),
  textWidth,
  selection: () => [...selection],
  close: (d: Doc) => closeDoc(d),
  organize: (op: 'delete' | 'move', start: number, count: number, to = 0) => {
    const ids = doc!.pages.slice(start, start + count).map((p) => p.uid);
    if (op === 'delete') { pageSel = new Set(ids); deletePages(); } else movePages(ids, doc!.pages[to].uid, false);
  },
};

// boot
setTool('select');
(async () => {
  try {
    if (!(await restoreSession())) await activate(null);
  } catch (e) {
    console.error(e);
    await activate(null);
  }
  document.body.dataset.ready = '1';
  native?.ready();
})();
if (native) {
  native.onOpenFiles((files) => openFiles(files.map((f) => new File([f.bytes as BlobPart], f.name, { type: /\.pdf$/i.test(f.name) ? 'application/pdf' : '' }))));
  native.onCommand((cmd) => {
    const ae = document.activeElement as HTMLElement | null;
    const inField = !!ae && (ae.matches('input, textarea, select') || ae.isContentEditable);
    const key = (k: string, extra: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, ...extra }));
    switch (cmd) {
      case 'save': quickSave(); break;
      case 'save-as': openExportDialog(); break;
      case 'combine': openCombineDialog(); break;
      case 'reduce': openReduceDialog(); break;
      case 'undo': inField ? document.execCommand('undo') : undo(); break;
      case 'redo': inField ? document.execCommand('redo') : redo(); break;
      case 'copy': inField ? document.execCommand('copy') : key('c'); break;
      case 'cut': inField ? document.execCommand('cut') : (key('c'), deleteSelection()); break;
      case 'paste': inField ? document.execCommand('paste') : key('v'); break;
      case 'select-all': inField ? document.execCommand('selectAll') : key('a'); break;
      case 'zoom-in': setZoom(zoom * 1.25); break;
      case 'zoom-out': setZoom(zoom / 1.25); break;
      case 'fit-width': fitWidth(); break;
      case 'fit-page': fitPage(); break;
    }
  });
}
if (!native && 'serviceWorker' in navigator && import.meta.env.PROD && !/[?&]nosw\b/.test(location.search)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// unused import guards
void bounds; void AREA_LABEL; void convertLen;
