import './styles.css';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Doc, Layer, Markup, MarkupType, PageRef, Pt, ScaleCal, SourceFile, Style, ToolId, Unit } from './types';
import { markupPrims, snapPoints, rectPts, bounds, primsBounds, type Prim } from './geom';
import { AREA_LABEL, IMPERIAL, METRIC, PAPER_SCALE, SCALE_PRESETS, UNIT_LABEL, convertLen, dist, fmtNum, isMeasure, measureOf, scaleFromCalibration, scaleFromRatio, withUnit } from './measure';
import { exportPdf, imagesToPdf, loadSource, TYPE_LABEL } from './pdfio';
import { reduceLossless } from './qpdf';
import * as store from './store';
import { ICONS } from './icons';
import { textWidth } from './font';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const BASE = document.baseURI;
const PDFJS_OPTS = {
  cMapUrl: new URL('pdfjs/cmaps/', BASE).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('pdfjs/standard_fonts/', BASE).href,
  wasmUrl: new URL('pdfjs/wasm/', BASE).href,
  isEvalSupported: false,
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
  const el = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
async function busy<T>(msg: string, fn: () => Promise<T>): Promise<T> {
  const el = h(`<div class="busy">${esc(msg)}</div>`);
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
}
const native = (window as any).planmarkNative as NativeBridge | undefined;
async function nativeSave(bytes: Uint8Array, name: string) {
  const path = await native!.saveFile(name, bytes);
  if (path) toast(`Saved ${fmtBytes(bytes.length)} to ${path}`, 4000);
  return path;
}
function download(bytes: Uint8Array, name: string) {
  if (native) { void nativeSave(bytes, name); return; }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: name.endsWith('.csv') ? 'text/csv' : 'application/pdf' }));
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
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="topbar">
  <div class="brand"><img src="icons/icon.svg" alt="">PlanMark</div>
  <button class="tb-btn" id="btn-open" title="Open PDFs or images (Ctrl+O)">${ICONS.open}Open</button>
  <button class="tb-btn" id="btn-save" title="Save PDF with editable markups (Ctrl+S)">${ICONS.save}Save</button>
  <button class="tb-btn" id="btn-export" title="Save options: editable or flattened">${ICONS.flatten}Save as / Flatten…</button>
  <span class="tb-sep"></span>
  <button class="tb-btn" id="btn-combine" title="Combine PDFs">${ICONS.combine}Combine</button>
  <button class="tb-btn" id="btn-reduce" title="Reduce file size (lossless)">${ICONS.reduce}Reduce size</button>
  <span class="tb-sep"></span>
  <button class="tb-btn" id="btn-undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
  <button class="tb-btn" id="btn-redo" title="Redo (Ctrl+Y)">${ICONS.redo}</button>
  <span class="tb-sep"></span>
  <span class="zoom">
    <button class="tb-btn" id="zoom-out" title="Zoom out (-)">${ICONS.minus}</button>
    <input id="zoom-input" value="100%" title="Zoom" />
    <button class="tb-btn" id="zoom-in" title="Zoom in (+)">${ICONS.plus}</button>
    <button class="tb-btn" id="fit-width" title="Fit width">${ICONS.fitw}</button>
    <button class="tb-btn" id="fit-page" title="Fit page">${ICONS.fitp}</button>
  </span>
  <span class="pagenav">Page <input id="page-input" value="0" /> / <span id="page-count">0</span></span>
  <button class="tb-btn toggle on" id="btn-snap" title="Snap to markup endpoints">${ICONS.magnet}Snap</button>
  <span class="spacer"></span>
  <span class="local-badge" title="PlanMark runs entirely in your browser. Files are never uploaded.">${ICONS.shield}<span>Files stay on this device</span></span>
  <input type="file" id="file-open" multiple accept=".pdf,application/pdf,image/*,.tif,.tiff" hidden />
  <input type="file" id="file-insert" multiple accept=".pdf,application/pdf,image/*,.tif,.tiff" hidden />
</header>
<nav class="toolbar" id="toolbar"></nav>
<div class="tabs" id="tabs"></div>
<main>
  <aside class="left">
    <div class="ptabs"><button data-lt="pages" class="active">Pages</button><button data-lt="chest">Tool Chest</button></div>
    <div class="page-tools" id="page-tools">
      <button class="btn" id="pg-rotl" title="Rotate left">${ICONS.rotl.replace('<svg', '<svg width="14" height="14"')}</button>
      <button class="btn" id="pg-rotr" title="Rotate right">${ICONS.rotr.replace('<svg', '<svg width="14" height="14"')}</button>
      <button class="btn" id="pg-del" title="Delete selected pages">${ICONS.trash.replace('<svg', '<svg width="14" height="14"')}</button>
      <button class="btn" id="pg-extract" title="Extract selected pages to a new PDF">${ICONS.extract.replace('<svg', '<svg width="14" height="14"')}</button>
      <button class="btn" id="pg-insert" title="Insert pages from file after current page">${ICONS.insert.replace('<svg', '<svg width="14" height="14"')}</button>
    </div>
    <div class="pbody" id="left-body"></div>
  </aside>
  <section class="viewer" id="viewer" tabindex="0">
    <div class="pages" id="pages"></div>
  </section>
  <aside class="right">
    <div class="ptabs"><button data-rt="props" class="active">Properties</button><button data-rt="markups">Markups</button><button data-rt="layers">Layers</button><button data-rt="scale">Scale</button></div>
    <div class="pbody" id="right-body"></div>
  </aside>
</main>
<footer class="status"><span id="st-scale">No document</span><span id="st-live" class="live"></span><span class="spacer"></span><span id="st-pos"></span><span id="st-save"></span></footer>
`;

const viewer = $('#viewer');
const pagesEl = $('#pages');
let leftTab: 'pages' | 'chest' = 'pages';
let rightTab: 'props' | 'markups' | 'layers' | 'scale' = 'props';

// toolbar
{
  const groups: [string, ToolId[]][] = [
    ['', ['select', 'pan']],
    ['Markup', ['pen', 'line', 'arrow', 'polyline', 'polygon', 'rect', 'ellipse', 'cloud', 'text', 'callout', 'highlight']],
    ['Measure', ['calibrate', 'm-length', 'm-polylength', 'm-perimeter', 'm-area', 'm-count']],
  ];
  const tb = $('#toolbar');
  groups.forEach(([label, ids], gi) => {
    if (gi) tb.appendChild(h('<span class="tsep"></span>'));
    if (label) tb.appendChild(h(`<span class="tgroup-label">${label}</span>`));
    for (const id of ids) {
      const b = h(`<button class="tool" data-tool="${id}" title="${TOOL_NAMES[id]}" aria-label="${TOOL_NAMES[id]}">${ICONS[id]}</button>`);
      b.onclick = () => setTool(id);
      tb.appendChild(b);
    }
  });
}

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
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await store.putDoc(d);
    await store.putMeta('open', { ids: docs.map((x) => x.id), active: doc?.id });
    $('#st-save').textContent = 'All changes saved in this browser';
  }, 300);
}

async function restoreSession() {
  const meta = await store.getMeta<{ ids: string[]; active?: string }>('open');
  if (!meta?.ids?.length) return false;
  for (const id of meta.ids) {
    const d = await store.getDoc(id);
    if (!d) continue;
    d.ocgHidden ??= {};
    d.ocgShown ??= {};
    let ok = true;
    for (const sid of new Set(d.pages.map((p) => p.src))) {
      if (sources.has(sid)) continue;
      const s = await store.getSource(sid);
      if (!s) { ok = false; break; }
      const pdf = await pdfjs.getDocument({ ...PDFJS_OPTS, data: s.bytes.slice() }).promise;
      sources.set(sid, { ...s, pdf });
    }
    if (ok) docs.push(d);
  }
  const act = docs.find((d) => d.id === meta.active) ?? docs[0];
  if (act) await activate(act);
  return docs.length > 0;
}

async function closeDoc(d: Doc) {
  docs = docs.filter((x) => x !== d);
  history.delete(d.id);
  await store.delDoc(d.id);
  const used = new Set(docs.flatMap((x) => x.pages.map((p) => p.src)));
  for (const sid of new Set(d.pages.map((p) => p.src))) {
    if (!used.has(sid)) {
      (sources.get(sid)?.pdf as any)?.loadingTask?.destroy?.();
      sources.delete(sid);
      await store.delSource(sid);
    }
  }
  await store.putMeta('open', { ids: docs.map((x) => x.id), active: docs[0]?.id });
  if (doc === d) {
    doc = null;
    await activate(docs[docs.length - 1] ?? null);
  } else renderTabs();
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
  if (d) store.putMeta('open', { ids: docs.map((x) => x.id), active: d.id });
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const d of docs) {
    const t = h(`<div class="tab ${d === doc ? 'active' : ''}" title="${esc(d.name)}"><span>${esc(d.name)}</span><button title="Close">×</button></div>`);
    t.onclick = (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      if (d !== doc) activate(d);
    };
    t.querySelector('button')!.onclick = async () => {
      if (d.markups.length && !confirm(`Close "${d.name}"? Its markups are only kept if you saved the PDF.`)) return;
      closeDoc(d);
    };
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
interface PV {
  ref: PageRef;
  el: HTMLDivElement;
  base: HTMLCanvasElement;
  detail: HTMLCanvasElement;
  hl: SVGSVGElement;
  svg: SVGSVGElement;
  proxy: PDFPageProxy;
  vp1: PageViewport;
  rot: number;
  baseScale: number;
  baseTask?: RenderTask;
  detailTask?: RenderTask;
  detailKey?: string;
  ocgHash?: string;
}
let views: PV[] = [];
const SVGNS = 'http://www.w3.org/2000/svg';

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

async function buildViewer(keepScroll = false) {
  const st = { l: viewer.scrollLeft, t: viewer.scrollTop };
  for (const v of views) { v.baseTask?.cancel(); v.detailTask?.cancel(); }
  views = [];
  pagesEl.innerHTML = '';
  $('.empty', viewer)?.remove();
  if (!doc) {
    viewer.appendChild(h(`<div class="empty"><div class="card"><img src="icons/icon.svg" width="56" alt=""><h2>PlanMark</h2>
      <p>Open or drop PDFs (or PNG / JPG / TIFF images) to mark up, measure, combine, flatten and shrink them.<br><b>Everything runs locally</b>; your files are never uploaded.</p>
      <button class="btn primary" id="empty-open">Open files…</button></div></div>`));
    $('#empty-open').onclick = () => $<HTMLInputElement>('#file-open').click();
    $('#page-count').textContent = '0';
    return;
  }
  const d = doc;
  const proxies = await Promise.all(d.pages.map((p) => sources.get(p.src)!.pdf.getPage(p.index + 1)));
  if (doc !== d) return;
  d.pages.forEach((ref, i) => {
    const proxy = proxies[i];
    const rot = pageRot(proxy, ref);
    const vp1 = proxy.getViewport({ scale: 1, rotation: rot });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.uid = ref.uid;
    el.innerHTML = `<span class="pnum">${i + 1}</span>`;
    const base = document.createElement('canvas');
    base.className = 'base';
    const detail = document.createElement('canvas');
    detail.className = 'detail';
    detail.style.display = 'none';
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
    el.append(base, detail, hl, svg);
    pagesEl.appendChild(el);
    views.push({ ref, el, base, detail, hl, svg, proxy, vp1, rot, baseScale: 0 });
  });
  $('#page-count').textContent = String(d.pages.length);
  layout();
  redrawMarkups();
  if (keepScroll) { viewer.scrollLeft = st.l; viewer.scrollTop = st.t; }
  scheduleRender(0);
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

let renderTimer: number | undefined;
function scheduleRender(ms = 120) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderVisible, ms);
}

function visibleViews(margin = 0.5) {
  const vr = viewer.getBoundingClientRect();
  const mh = vr.height * margin;
  return views.filter((v) => {
    const r = v.el.getBoundingClientRect();
    return r.bottom > vr.top - mh && r.top < vr.bottom + mh && r.right > vr.left && r.left < vr.right;
  });
}

async function renderVisible() {
  const vis = visibleViews();
  for (const v of vis) {
    renderBase(v);
    renderDetail(v);
  }
  updateCurrentPage();
}

const MAX_PIXELS = 12e6;
async function renderBase(v: PV) {
  const dpr = window.devicePixelRatio || 1;
  const want = ptPx() * dpr;
  const cap = Math.min(Math.sqrt(MAX_PIXELS / (v.vp1.width * v.vp1.height)), 8192 / Math.max(v.vp1.width, v.vp1.height));
  const s = Math.min(want, cap);
  const ocg = await ocgFor(doc!, v.ref.src);
  const hash = ocg.getHash();
  if (v.baseScale && Math.abs(v.baseScale - s) / s < 0.05 && v.ocgHash === hash) return;
  v.baseTask?.cancel();
  const vp = v.proxy.getViewport({ scale: s, rotation: v.rot });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  c.className = 'base';
  const task = v.proxy.render({ canvas: c, viewport: vp, optionalContentConfigPromise: Promise.resolve(ocg), annotationMode: pdfjs.AnnotationMode.ENABLE });
  v.baseTask = task;
  try {
    await task.promise;
    v.base.replaceWith(c);
    v.base = c;
    v.baseScale = s;
    v.ocgHash = hash;
    v.el.dataset.rendered = String(+v.el.dataset.rendered! + 1 || 1);
  } catch (e) {
    if ((e as Error)?.name !== 'RenderingCancelledException') console.warn(e);
  }
}

async function renderDetail(v: PV) {
  const dpr = window.devicePixelRatio || 1;
  const want = ptPx() * dpr;
  if (!v.baseScale || v.baseScale >= want * 0.97) {
    v.detail.style.display = 'none';
    v.detailKey = undefined;
    return;
  }
  const vr = viewer.getBoundingClientRect();
  const r = v.el.getBoundingClientRect();
  const x0 = Math.max(0, vr.left - r.left), y0 = Math.max(0, vr.top - r.top);
  const x1 = Math.min(r.width, vr.right - r.left), y1 = Math.min(r.height, vr.bottom - r.top);
  if (x1 <= x0 || y1 <= y0) return;
  const ocg = await ocgFor(doc!, v.ref.src);
  const key = `${want}|${Math.round(x0)}|${Math.round(y0)}|${Math.round(x1)}|${Math.round(y1)}|${ocg.getHash()}`;
  if (key === v.detailKey) return;
  v.detailTask?.cancel();
  const vp = v.proxy.getViewport({ scale: want, rotation: v.rot });
  const c = document.createElement('canvas');
  c.width = Math.ceil((x1 - x0) * dpr);
  c.height = Math.ceil((y1 - y0) * dpr);
  c.className = 'detail';
  const task = v.proxy.render({ canvas: c, viewport: vp, transform: [1, 0, 0, 1, -x0 * dpr, -y0 * dpr], optionalContentConfigPromise: Promise.resolve(ocg) });
  v.detailTask = task;
  try {
    await task.promise;
    c.style.left = `${x0}px`;
    c.style.top = `${y0}px`;
    c.style.width = `${x1 - x0}px`;
    c.style.height = `${y1 - y0}px`;
    v.detail.replaceWith(c);
    v.detail = c;
    v.detailKey = key;
  } catch (e) {
    if ((e as Error)?.name !== 'RenderingCancelledException') console.warn(e);
  }
}

function invalidateRender(srcId?: string) {
  for (const v of views) if (!srcId || v.ref.src === srcId) { v.baseScale = 0; v.detailKey = undefined; }
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
  scheduleRender(150);
  if (editing) positionEditor();
}
function fitWidth() {
  const v = views[currentPage] ?? views[0];
  if (!v) return;
  setZoom(((viewer.clientWidth - 64) / v.vp1.width) * (72 / 96));
  v.el.scrollIntoView({ block: 'start' });
}
function fitPage() {
  const v = views[currentPage] ?? views[0];
  if (!v) return;
  setZoom(Math.min((viewer.clientWidth - 64) / v.vp1.width, (viewer.clientHeight - 56) / v.vp1.height) * (72 / 96));
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
  let best = 0, bestA = -1;
  views.forEach((v, i) => {
    const r = v.el.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
    if (a > bestA) { bestA = a; best = i; }
  });
  if (best !== currentPage) {
    currentPage = best;
    $$('.thumb').forEach((t, i) => t.classList.toggle('current', i === currentPage));
    if (rightTab === 'scale') renderRight();
    updateStatus();
  }
  $<HTMLInputElement>('#page-input').value = String(views.length ? currentPage + 1 : 0);
}

viewer.addEventListener('scroll', () => scheduleRender(100), { passive: true });
window.addEventListener('resize', () => scheduleRender(150));
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
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
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
function renderLeft() {
  $$('[data-lt]').forEach((b) => b.classList.toggle('active', b.dataset.lt === leftTab));
  $('#page-tools').style.display = leftTab === 'pages' && doc ? '' : 'none';
  const body = $('#left-body');
  body.innerHTML = '';
  if (leftTab === 'chest') return renderChest(body);
  if (!doc) { body.innerHTML = '<p class="muted small">No document open.</p>'; return; }
  const list = h('<div class="thumbs" id="thumbs"></div>');
  body.appendChild(list);
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) drawThumb(en.target as HTMLElement);
  }, { root: body, rootMargin: '200px' });
  doc.pages.forEach((p, i) => {
    const t = h(`<div class="thumb ${i === currentPage ? 'current' : ''} ${pageSel.has(p.uid) ? 'selected' : ''}" draggable="true" data-uid="${p.uid}"><canvas width="120" height="155"></canvas><div class="lbl">${i + 1}</div></div>`);
    t.onclick = (e) => {
      if (e.shiftKey && pageSel.size) {
        const idx = doc!.pages.findIndex((q) => pageSel.has(q.uid));
        const [a, b] = [Math.min(idx, i), Math.max(idx, i)];
        for (let j = a; j <= b; j++) pageSel.add(doc!.pages[j].uid);
      } else if (e.ctrlKey || e.metaKey) pageSel.has(p.uid) ? pageSel.delete(p.uid) : pageSel.add(p.uid);
      else pageSel = new Set([p.uid]);
      $$('.thumb').forEach((x) => x.classList.toggle('selected', pageSel.has(x.dataset.uid!)));
      goToPage(i);
    };
    t.ondragstart = (e) => {
      if (!pageSel.has(p.uid)) { pageSel = new Set([p.uid]); $$('.thumb').forEach((x) => x.classList.toggle('selected', pageSel.has(x.dataset.uid!))); }
      e.dataTransfer!.setData('text/x-planmark-pages', [...pageSel].join(','));
      e.dataTransfer!.effectAllowed = 'move';
    };
    t.ondragover = (e) => {
      if (!e.dataTransfer?.types.includes('text/x-planmark-pages')) return;
      e.preventDefault();
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      t.classList.toggle('drop-after', after);
      t.classList.toggle('drop-before', !after);
    };
    t.ondragleave = () => t.classList.remove('drop-after', 'drop-before');
    t.ondrop = (e) => {
      const ids = e.dataTransfer?.getData('text/x-planmark-pages');
      t.classList.remove('drop-after', 'drop-before');
      if (!ids) return;
      e.preventDefault();
      e.stopPropagation();
      const r = t.getBoundingClientRect();
      movePages(ids.split(','), p.uid, e.clientY > r.top + r.height / 2);
    };
    list.appendChild(t);
    thumbObserver!.observe(t);
  });
}

async function drawThumb(t: HTMLElement, force = false) {
  if (!doc) return;
  if (t.dataset.drawn && !force) return;
  t.dataset.drawn = '1';
  const ref = doc.pages.find((p) => p.uid === t.dataset.uid);
  if (!ref) return;
  const src = sources.get(ref.src)!;
  const proxy = await src.pdf.getPage(ref.index + 1);
  const rot = pageRot(proxy, ref);
  const vp1 = proxy.getViewport({ scale: 1, rotation: rot });
  const s = Math.min(120 / vp1.width, 155 / vp1.height) * (window.devicePixelRatio || 1);
  const vp = proxy.getViewport({ scale: s, rotation: rot });
  const c = t.querySelector('canvas')!;
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  c.style.width = `${vp.width / (window.devicePixelRatio || 1)}px`;
  c.style.height = `${vp.height / (window.devicePixelRatio || 1)}px`;
  try {
    await proxy.render({ canvas: c, viewport: vp, optionalContentConfigPromise: ocgFor(doc, ref.src) }).promise;
  } catch { /* ignore */ }
}
function renderThumbs(force: boolean, srcId?: string) {
  for (const t of $$('.thumb')) {
    const ref = doc?.pages.find((p) => p.uid === t.dataset.uid);
    if (!srcId || ref?.src === srcId) { if (force) delete t.dataset.drawn; drawThumb(t, force); }
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
  const bytes = await busy('Extracting…', async () => (await exportPdf(d, sources, { flatten: false, layersAsOcg: true, pageUids: sel.map((p) => p.uid), author })).bytes);
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
  body.appendChild(h('<p class="muted small">Saved tool presets. Set up a style in Properties, then use "Save as preset". Click a preset to use it.</p>'));
  if (!presets.length) body.appendChild(h('<p class="muted small"><i>No presets yet.</i></p>'));
  for (const pr of presets) {
    const el = h(`<div class="preset" data-preset="${pr.id}">${ICONS[pr.tool]}<span class="swatch" style="background:${pr.style.fill ?? pr.style.stroke}"></span><span class="nm">${esc(pr.name)}</span><button class="btn" title="Delete">×</button></div>`);
    el.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) {
        presets = presets.filter((x) => x.id !== pr.id);
        savePresets();
        renderLeft();
        return;
      }
      toolStyles[pr.tool] = clone(pr.style);
      saveToolStyles();
      setTool(pr.tool);
      toast(`Using preset "${pr.name}"`);
    };
    body.appendChild(el);
  }
}

// ───────────────────────── right panel ─────────────────────────
function renderRight() {
  $$('[data-rt]').forEach((b) => b.classList.toggle('active', b.dataset.rt === rightTab));
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

function renderProps(body: HTMLElement) {
  const sel = doc ? doc.markups.filter((m) => selection.has(m.id)) : [];
  const drawTool = tool !== 'select' && tool !== 'pan' && tool !== 'calibrate' ? (tool as MarkupType) : null;
  if (!sel.length && !drawTool) {
    body.innerHTML = `<h4>Properties</h4><p class="muted small">Select a markup to edit it, or pick a markup tool to set its default style.</p>
      <h4>Your name (author on markups)</h4><div class="row"><input type="text" id="p-author" value="${esc(author)}" placeholder="e.g. A. Pocta"></div>
      <h4>Shortcuts</h4><p class="muted small" style="line-height:1.6">V select · H pan (or hold Space) · P pen · L line · A arrow · Y polyline · G polygon · R rect · E ellipse · C cloud · T text · Q callout · I highlight · K calibrate · 1 length · 2 polylength · 3 perimeter · 4 area · 5 count<br>Double-click or Enter finishes polylines/areas; Backspace removes the last point; Shift constrains to 45°; Ctrl/⌘+wheel zooms; Delete removes; Ctrl+Z / Ctrl+Y undo/redo; Ctrl+C / Ctrl+V copy/paste.</p>`;
    $<HTMLInputElement>('#p-author', body).onchange = (e) => { author = (e.target as HTMLInputElement).value; localStorage.setItem('pm.author', author); };
    return;
  }
  const first = sel[0];
  const st: Style = first ? first.style : toolStyles[drawTool!];
  const type: MarkupType = first ? first.type : drawTool!;
  const title = first ? (sel.length > 1 ? `${sel.length} markups selected` : TYPE_LABEL[first.type]) : `${TYPE_LABEL[drawTool!]} — tool defaults`;
  let measureHtml = '';
  if (first && sel.length === 1 && isMeasure(first.type)) {
    const v = viewOf(first.page);
    const mv = measureOf(first, scaleOf(v?.ref));
    if (mv) {
      measureHtml = `<div class="measure-box" id="p-measure"><b>${esc(mv.kind === 'area' ? `${fmtNum(mv.value, scaleOf(v?.ref).precision)} ${mv.unit}` : mv.text)}</b>`;
      if (mv.kind === 'area') measureHtml += `<div>${fmtNum(mv.area2!, 4)} ${mv.area2Unit === 'ac' ? 'acres' : 'hectares'}</div><div class="muted small">Perimeter ${fmtNum(mv.perimeter!, 2)} ${UNIT_LABEL[scaleOf(v?.ref).unit]}</div>`;
      measureHtml += `<div class="muted small">Scale: ${esc(scaleOf(v?.ref).label)}</div></div>`;
    }
  }
  const showFill = !['pen', 'line', 'arrow', 'polyline', 'm-length', 'm-polylength', 'm-perimeter'].includes(type);
  const showHeads = ['line', 'arrow', 'polyline', 'm-length', 'm-polylength', 'callout'].includes(type);
  const showText = ['text', 'callout'].includes(type) || isMeasure(type);
  const layerOpts = doc ? doc.layers.map((l) => `<option value="${l.id}" ${first?.layer === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('') : '';
  body.innerHTML = `
    <h4>${esc(title)}</h4>${measureHtml}
    <div class="row"><label>Line color</label><input type="color" id="p-stroke" value="${st.stroke}"></div>
    ${showFill ? `<div class="row"><label>Fill</label><input type="checkbox" id="p-fill-on" ${st.fill ? 'checked' : ''}><input type="color" id="p-fill" value="${st.fill ?? '#ffffff'}"></div>` : ''}
    <div class="row"><label>Line opacity</label><input type="range" id="p-opacity" min="0" max="100" value="${Math.round(st.opacity * 100)}"><span class="val">${Math.round(st.opacity * 100)}%</span></div>
    ${showFill ? `<div class="row"><label>Fill opacity</label><input type="range" id="p-fill-opacity" min="0" max="100" value="${Math.round(st.fillOpacity * 100)}"><span class="val">${Math.round(st.fillOpacity * 100)}%</span></div>` : ''}
    <div class="row"><label>Line width (pt)</label><input type="number" id="p-width" min="0" max="72" step="0.25" value="${st.width}"></div>
    <div class="row"><label>Line style</label><select id="p-dash">${opts(DASH_OPTS, st.dash)}</select></div>
    ${showHeads ? `<div class="row"><label>Start</label><select id="p-start">${opts(HEAD_OPTS, st.startHead)}</select></div><div class="row"><label>End</label><select id="p-end">${opts(HEAD_OPTS, st.endHead)}</select></div>` : ''}
    ${showText ? `<div class="row"><label>Font size</label><input type="number" id="p-font" min="4" max="144" step="1" value="${st.fontSize}"></div>` : ''}
    ${['text', 'callout'].includes(type) ? `<div class="row"><label>Text color</label><input type="color" id="p-textcolor" value="${st.textColor}"></div>` : ''}
    ${first ? `<h4>Markup</h4><div class="row"><label>Layer</label><select id="p-layer">${layerOpts}</select></div>
      <div class="row"><label>Comment</label><input type="text" id="p-comment" value="${esc(first.comment ?? '')}" placeholder="Note / label"></div>
      ${sel.length === 1 && ['text', 'callout'].includes(first.type) ? '<div class="btn-row"><button class="btn" id="p-edit-text">Edit text</button></div>' : ''}
      <div class="btn-row"><button class="btn" id="p-make-default">Use as tool default</button><button class="btn danger" id="p-delete">Delete</button></div>` : ''}
    <div class="btn-row"><button class="btn" id="p-preset">Save as preset…</button>${!first ? '<button class="btn" id="p-reset">Reset tool style</button>' : ''}</div>
  `;
  const apply = (fn: (s: Style) => void) => {
    if (sel.length) mutate(() => sel.forEach((m) => { fn(m.style); m.modified = Date.now(); }));
    else { fn(toolStyles[drawTool!]); saveToolStyles(); }
  };
  const bind = (id: string, ev: string, fn: (el: HTMLInputElement) => void) => {
    const el = $<HTMLInputElement>(`#${id}`, body);
    if (el) el.addEventListener(ev, () => fn(el));
  };
  bind('p-stroke', 'change', (el) => apply((s) => (s.stroke = el.value)));
  bind('p-fill-on', 'change', (el) => apply((s) => (s.fill = el.checked ? $<HTMLInputElement>('#p-fill', body).value : null)));
  bind('p-fill', 'change', (el) => { $<HTMLInputElement>('#p-fill-on', body).checked = true; apply((s) => (s.fill = el.value)); });
  bind('p-opacity', 'input', (el) => (el.nextElementSibling!.textContent = `${el.value}%`));
  bind('p-opacity', 'change', (el) => apply((s) => (s.opacity = +el.value / 100)));
  bind('p-fill-opacity', 'input', (el) => (el.nextElementSibling!.textContent = `${el.value}%`));
  bind('p-fill-opacity', 'change', (el) => apply((s) => (s.fillOpacity = +el.value / 100)));
  bind('p-width', 'change', (el) => apply((s) => (s.width = Math.max(0, +el.value || 0))));
  bind('p-dash', 'change', (el) => apply((s) => (s.dash = el.value as Style['dash'])));
  bind('p-start', 'change', (el) => apply((s) => (s.startHead = el.value as Style['startHead'])));
  bind('p-end', 'change', (el) => apply((s) => (s.endHead = el.value as Style['endHead'])));
  bind('p-font', 'change', (el) => apply((s) => (s.fontSize = Math.max(4, +el.value || 12))));
  bind('p-textcolor', 'change', (el) => apply((s) => (s.textColor = el.value)));
  bind('p-layer', 'change', (el) => mutate(() => sel.forEach((m) => (m.layer = el.value))));
  bind('p-comment', 'change', (el) => mutate(() => sel.forEach((m) => (m.comment = el.value))));
  $('#p-edit-text', body)?.addEventListener('click', () => openEditor(first.id, false));
  $('#p-delete', body)?.addEventListener('click', deleteSelection);
  $('#p-make-default', body)?.addEventListener('click', () => { toolStyles[first.type] = clone(first.style); saveToolStyles(); toast(`${TYPE_LABEL[first.type]} tool now uses this style`); });
  $('#p-reset', body)?.addEventListener('click', () => { toolStyles[drawTool!] = clone(DEFAULT_STYLES[drawTool!]); saveToolStyles(); renderRight(); });
  $('#p-preset', body)?.addEventListener('click', () => {
    const name = prompt('Preset name', `${TYPE_LABEL[type]} ${presets.filter((p) => p.tool === type).length + 1}`);
    if (!name) return;
    presets.push({ id: uid(), name, tool: type, style: clone(st) });
    savePresets();
    if (leftTab === 'chest') renderLeft();
    toast(`Saved preset "${name}" to the Tool Chest`);
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
  if (!doc) { body.innerHTML = '<p class="muted small">No document open.</p>'; return; }
  let rows = markupRows();
  if (listFilter === 'page') rows = rows.filter((r) => r.pageNo === currentPage + 1);
  if (listFilter === 'measure') rows = rows.filter((r) => r.mv);
  const t = totalsOf(rows);
  body.innerHTML = `
    <div class="row"><select id="ml-filter"><option value="all">All markups</option><option value="page">Current page</option><option value="measure">Measurements only</option></select>
      <button class="btn" id="ml-csv">Export CSV</button></div>
    <table class="mlist" id="mlist"><thead><tr><th>Pg</th><th>Type</th><th>Value / text</th><th>Layer</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-id="${r.m.id}" class="${selection.has(r.m.id) ? 'sel' : ''}"><td>${r.pageNo}</td><td><span class="swatch" style="background:${r.m.style.fill && r.m.type !== 'm-perimeter' ? r.m.style.fill : r.m.style.stroke}"></span>${TYPE_LABEL[r.m.type]}</td><td class="val">${esc(r.mv?.text ?? (r.m.text || r.m.comment || ''))}${r.mv && r.m.comment ? `<div class="muted small">${esc(r.m.comment)}</div>` : ''}</td><td>${esc(doc!.layers.find((l) => l.id === r.m.layer)?.name ?? '')}</td></tr>`).join('')}
    </tbody></table>
    ${rows.length ? '' : '<p class="muted small">No markups yet.</p>'}
    <div class="totals" id="ml-totals"><b>Totals</b>
      ${[...t.len].map(([u, v]) => `<div><span>Length</span><span>${fmtNum(v)} ${u}</span></div>`).join('')}
      ${[...t.area].map(([u, v]) => `<div><span>Area</span><span>${fmtNum(v.v)} ${u}</span></div><div><span></span><span>${fmtNum(v.a2, 4)} ${v.a2u}</span></div>`).join('')}
      ${t.count ? `<div><span>Count</span><span>${t.count}</span></div>` : ''}
      ${!t.len.size && !t.area.size && !t.count ? '<div class="muted">No measurements</div>' : ''}
    </div>`;
  $<HTMLSelectElement>('#ml-filter', body).value = listFilter;
  $<HTMLSelectElement>('#ml-filter', body).onchange = (e) => { listFilter = (e.target as HTMLSelectElement).value as typeof listFilter; renderRight(); };
  $('#ml-csv', body).onclick = exportCsv;
  $$('tr[data-id]', body).forEach((tr) => (tr.onclick = () => {
    const m = doc!.markups.find((x) => x.id === tr.dataset.id)!;
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
  }));
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
  body.innerHTML = `<h4>Markup layers</h4><p class="muted small">New markups go on the highlighted layer. Saved as PDF layers (OCGs).</p><div id="app-layers"></div>
    <div class="btn-row"><button class="btn" id="ly-add">+ New layer</button></div>
    <h4>PDF layers in the file</h4><div id="pdf-layers"><p class="muted small">Reading…</p></div>`;
  const al = $('#app-layers', body);
  for (const l of d.layers) {
    const n = d.markups.filter((m) => m.layer === l.id).length;
    const row = h(`<div class="layer ${l.id === d.activeLayer ? 'active' : ''}" data-layer="${l.id}">
      <input type="checkbox" class="ly-vis" title="Show / hide" ${l.visible ? 'checked' : ''}>
      <span class="name" title="Click to make active, double-click to rename">${esc(l.name)}</span><span class="muted small">${n}</span>
      <button class="ly-lock" title="${l.locked ? 'Unlock' : 'Lock'}" style="opacity:${l.locked ? 1 : 0.35}">${ICONS.lock.replace('<svg', '<svg width="14" height="14"')}</button>
      ${d.layers.length > 1 ? '<button class="ly-del" title="Delete layer (markups move to first layer)">×</button>' : ''}</div>`);
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
    if (srcIds.length > 1) html += `<div class="muted small" style="margin-top:6px">${esc(sources.get(sid)!.name)}</div>`;
    for (const [id, g] of groups) html += `<div class="layer"><input type="checkbox" class="ocg" data-src="${sid}" data-ocg="${esc(id)}" ${g.visible ? 'checked' : ''}><span class="name">${esc(g.name || id)}</span></div>`;
  }
  if (doc !== d || rightTab !== 'layers') return;
  pl.innerHTML = html || '<p class="muted small">This PDF has no layers.</p>';
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
  if (!doc || !views[currentPage]) { body.innerHTML = '<p class="muted small">No document open.</p>'; return; }
  const ref = views[currentPage].ref;
  const s = scaleOf(ref);
  const units = [...IMPERIAL, ...METRIC];
  body.innerHTML = `<h4>Page ${currentPage + 1} scale</h4>
    <div class="measure-box" id="sc-current"><b>${esc(s.label)}</b><div class="muted small">1 inch on paper = ${fmtNum(s.factor * 72, 4)} ${UNIT_LABEL[s.unit]}</div></div>
    <div class="btn-row"><button class="btn primary" id="sc-cal">Calibrate…</button><button class="btn" id="sc-set">Set scale…</button></div>
    <div class="row"><label>Display unit</label><select id="sc-unit">${units.map((u) => `<option value="${u}" ${u === s.unit ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`).join('')}</select></div>
    <div class="row"><label>Precision</label><select id="sc-prec">${[0, 1, 2, 3, 4].map((p) => `<option value="${p}" ${p === s.precision ? 'selected' : ''}>${p} decimals</option>`).join('')}</select></div>
    <div class="btn-row"><button class="btn" id="sc-all">Apply to all pages</button>${ref.scale ? '<button class="btn danger" id="sc-clear">Clear scale</button>' : ''}</div>
    <p class="muted small">Areas show in square ${UNIT_LABEL[s.unit]} plus ${METRIC.includes(s.unit) ? 'hectares' : 'acres'}. The scale is saved inside the PDF (standard PDF measurement dictionaries), so other PDF apps can read it too.</p>`;
  $('#sc-cal', body).onclick = () => setTool('calibrate');
  $('#sc-set', body).onclick = () => openScaleDialog();
  $<HTMLSelectElement>('#sc-unit', body).onchange = (e) => mutate(() => (ref.scale = { ...withUnit(s, (e.target as HTMLSelectElement).value as Unit) }));
  $<HTMLSelectElement>('#sc-prec', body).onchange = (e) => mutate(() => (ref.scale = { ...s, precision: +(e.target as HTMLSelectElement).value }));
  $('#sc-all', body).onclick = () => mutate(() => doc!.pages.forEach((p) => (p.scale = clone(s))));
  $('#sc-clear', body)?.addEventListener('click', () => mutate(() => (ref.scale = undefined)));
}

function updateStatus() {
  const v = views[currentPage];
  $('#st-scale').textContent = v ? `Page ${currentPage + 1}: ${scaleOf(v.ref).label}` : 'No document';
  ($('#btn-undo') as HTMLButtonElement).disabled = !doc || !hist().undo.length;
  ($('#btn-redo') as HTMLButtonElement).disabled = !doc || !hist().redo.length;
}

// ───────────────────────── dialogs ─────────────────────────
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

async function buildExport(flatten: boolean, layersAsOcg = true) {
  const d = doc!;
  return exportPdf(d, sources, { flatten, layersAsOcg, author });
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
    <label class="radio"><input type="radio" name="ex-mode" value="editable" checked><div><b>Editable markups</b><small>Markups are real PDF annotations (Acrobat, Foxit, Bluebeam and PlanMark can edit them).</small></div></label>
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
      try {
        const r = await busy('Reducing size…', () => reduceLossless(bytes));
        if (r.length < bytes.length) bytes = r;
      } catch (err) { toast(`Size reduction skipped: ${(err as Error).message}`); }
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
  const run = async (name: string, input: Uint8Array) => {
    const row = h(`<tr><td>${esc(name)}</td><td>${fmtBytes(input.length)}</td><td colspan="3" class="muted">Working…</td></tr>`);
    tbody.appendChild(row);
    try {
      const out = await reduceLossless(input, { linearize: $<HTMLInputElement>('#rd-lin', dlg).checked });
      const better = out.length < input.length;
      const final = better ? out : input;
      const pct = ((1 - final.length / input.length) * 100).toFixed(1);
      row.innerHTML = `<td>${esc(name)}</td><td class="rd-before" data-bytes="${input.length}">${fmtBytes(input.length)}</td><td class="rd-after" data-bytes="${final.length}">${fmtBytes(final.length)}</td><td>${better ? `${pct}%` : 'Already optimal'}</td><td><button class="btn rd-dl">Download</button></td>`;
      $('.rd-dl', row).onclick = () => download(final, name.replace(/\.pdf$/i, '') + (better ? '_reduced' : '') + '.pdf');
    } catch (e) {
      row.innerHTML = `<td>${esc(name)}</td><td>${fmtBytes(input.length)}</td><td colspan="3" style="color:var(--danger)">${esc((e as Error).message)}</td>`;
    }
  };
  $('#rd-pick', dlg).onclick = () => $<HTMLInputElement>('#rd-input', dlg).click();
  $<HTMLInputElement>('#rd-input', dlg).onchange = async (e) => {
    for (const f of [...((e.target as HTMLInputElement).files ?? [])]) await run(f.name, new Uint8Array(await f.arrayBuffer()));
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
$('#btn-snap').onclick = () => { snapOn = !snapOn; $('#btn-snap').classList.toggle('on', snapOn); };
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
  rendered: () => views.every((v) => !visibleViews().includes(v) || v.baseScale > 0),
  goToPage: (i: number) => goToPage(i),
  centerOn: (i: number, x: number, y: number) => {
    const v = views[i];
    const r = v.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
    const [vx, vy] = v.vp1.convertToViewportPoint(x, y);
    viewer.scrollLeft += r.left + vx * ptPx() - (vr.left + vr.width / 2);
    viewer.scrollTop += r.top + vy * ptPx() - (vr.top + vr.height / 2);
  },
  setSnap: (on: boolean) => { snapOn = on; $('#btn-snap').classList.toggle('on', on); },
  textWidth,
  selection: () => [...selection],
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
