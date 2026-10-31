// Reading and writing PDFs with pdf-lib: load/clean sources, export editable or flattened, merge, images -> PDF.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef, PDFPage, PDFRawStream,
  PDFObjectCopier, decodePDFRawStream, degrees, PDFStream, PDFBool, PDFObject,
} from 'pdf-lib';
import type { Doc, Layer, Markup, PageRef, ScaleCal, SourceFile, Unit } from './types';
import { markupPrims, primsBounds, calloutGeometry, rectPts, type Prim, cloudArc } from './geom';
import { Resources, primsToOps, hexToRgb, FONT_NAME } from './pdfwrite';
import { AREA_LABEL, PAPER_SCALE, measureOf, UNIT_LABEL } from './measure';
import { sanitize } from './font';
import { decrypt } from './qpdf';

// Internal key for SheetScale's own data inside saved PDFs. It keeps the pre-rename value on purpose
// so PDFs saved by PlanMark (v1.0-1.1) reopen with editable markups, and new PDFs stay readable by old versions.
export const APP_KEY = 'PlanMark';
const PMID = PDFName.of('PMID');

export interface AppData {
  v: 1;
  pages: { scale?: ScaleCal }[];
  markups: (Omit<Markup, 'page'> & { page: number })[];
  layers: Layer[];
  activeLayer: string;
}

export interface LoadedSource {
  bytes: Uint8Array; // cleaned
  app: AppData | null;
  vpScales: (ScaleCal | undefined)[];
  pageCount: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function loadLib(bytes: Uint8Array) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}

function streamBytes(s: PDFObject | undefined): Uint8Array | null {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) return s.getContents();
  return null;
}

const UNIT_FROM_LABEL: Record<string, Unit> = {
  in: 'in', '"': 'in', inch: 'in', ft: 'ft', "'": 'ft', feet: 'ft', yd: 'yd', mi: 'mi', mm: 'mm', cm: 'cm', m: 'm', km: 'km',
};

function readVpScale(page: PDFPage): ScaleCal | undefined {
  try {
    const vp = page.node.lookupMaybe(PDFName.of('VP'), PDFArray);
    if (!vp || !vp.size()) return undefined;
    const v = vp.lookup(0, PDFDict);
    const meas = v.lookupMaybe(PDFName.of('Measure'), PDFDict);
    const x = meas?.lookupMaybe(PDFName.of('X'), PDFArray);
    if (!meas || !x || !x.size()) return undefined;
    let factor = 1;
    let unit: Unit | undefined;
    for (let i = 0; i < x.size(); i++) {
      const nf = x.lookup(i, PDFDict);
      factor *= nf.lookupMaybe(PDFName.of('C'), PDFNumber)?.asNumber() ?? 1;
      const u = nf.lookupMaybe(PDFName.of('U'), PDFString, PDFHexString)?.decodeText()?.trim().toLowerCase();
      if (u && UNIT_FROM_LABEL[u]) unit = UNIT_FROM_LABEL[u];
      if (i === 0 && unit) break;
    }
    if (!unit) return undefined;
    const r = meas.lookupMaybe(PDFName.of('R'), PDFString, PDFHexString)?.decodeText() ?? 'From PDF';
    return { factor, unit, label: r, precision: 2 };
  } catch {
    return undefined;
  }
}

/** Load a PDF: decrypt if needed, read SheetScale data, strip our own annotations so they can be edited live. */
export async function loadSource(raw: Uint8Array): Promise<LoadedSource> {
  let doc = await loadLib(raw);
  let bytes = raw;
  if (doc.isEncrypted) {
    bytes = await decrypt(raw);
    doc = await loadLib(bytes);
  }
  const pages = doc.getPages();
  const vpScales = pages.map(readVpScale);
  let app: AppData | null = null;
  const ref = doc.catalog.get(PDFName.of(APP_KEY));
  if (ref) {
    try {
      const data = streamBytes(doc.context.lookup(ref));
      if (data) app = JSON.parse(dec.decode(data));
    } catch (e) {
      console.warn('SheetScale data unreadable', e);
    }
  }
  if (app) {
    let changed = false;
    for (const p of pages) {
      const annots = p.node.Annots();
      if (!annots) continue;
      const keep = PDFArray.withContext(doc.context);
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookupMaybe(i, PDFDict);
        if (a && a.has(PMID)) { changed = true; continue; }
        keep.push(annots.get(i));
      }
      p.node.set(PDFName.of('Annots'), keep);
    }
    // remove app layer OCGs we wrote (they are recreated on export)
    const ocp = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
    if (ocp) stripAppOcgs(doc, ocp);
    if (changed || ocp) bytes = await doc.save({ useObjectStreams: true });
  }
  return { bytes, app, vpScales, pageCount: pages.length };
}

function stripAppOcgs(doc: PDFDocument, ocp: PDFDict) {
  const isApp = (o: PDFObject) => {
    const d = o instanceof PDFRef ? doc.context.lookup(o) : o;
    return d instanceof PDFDict && d.has(PMID);
  };
  const filterArr = (arr: PDFArray | undefined): PDFArray | undefined => {
    if (!arr) return arr;
    const out = PDFArray.withContext(doc.context);
    for (let i = 0; i < arr.size(); i++) {
      const it = arr.get(i);
      const val = it instanceof PDFRef ? doc.context.lookup(it) : it;
      if (val instanceof PDFArray) {
        const f = filterArr(val)!;
        const first = f.size() ? f.get(0) : undefined;
        const onlyLabel = f.size() === 1 && (first instanceof PDFString || first instanceof PDFHexString);
        if (f.size() && !onlyLabel) out.push(f);
      } else if (!isApp(it)) out.push(it);
    }
    return out;
  };
  const ocgs = ocp.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  if (ocgs) ocp.set(PDFName.of('OCGs'), filterArr(ocgs)!);
  const d = ocp.lookupMaybe(PDFName.of('D'), PDFDict);
  if (d) for (const k of ['Order', 'ON', 'OFF']) {
    const a = d.lookupMaybe(PDFName.of(k), PDFArray);
    if (a) d.set(PDFName.of(k), filterArr(a)!);
  }
  if (ocgs && filterArr(ocgs)!.size() === 0) doc.catalog.delete(PDFName.of('OCProperties'));
}

export interface ExportOptions {
  flatten: boolean;
  layersAsOcg: boolean;
  pageUids?: string[]; // subset/extract
  author?: string;
}

const pdfDate = (t: number) => {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

const TYPE_LABEL: Record<Markup['type'], string> = {
  pen: 'Pen', line: 'Line', arrow: 'Arrow', polyline: 'Polyline', polygon: 'Polygon', rect: 'Rectangle', ellipse: 'Ellipse',
  cloud: 'Cloud', text: 'Text Box', callout: 'Callout', highlight: 'Highlight', 'm-length': 'Length', 'm-polylength': 'Polylength',
  'm-perimeter': 'Perimeter', 'm-area': 'Area', 'm-count': 'Count',
};
export { TYPE_LABEL };

const LE: Record<string, string> = { none: 'None', open: 'OpenArrow', closed: 'ClosedArrow', circle: 'Circle', square: 'Square', slash: 'Slash' };

function measureDict(doc: PDFDocument, s: ScaleCal) {
  const ctx = doc.context;
  const nf = (u: string, c: number) => ctx.obj({ Type: 'NumberFormat', U: PDFString.of(u), C: c, D: 100, F: 'D' });
  return ctx.obj({
    Type: 'Measure', Subtype: 'RL', R: PDFString.of(sanitize(s.label)),
    X: [nf(UNIT_LABEL[s.unit], s.factor)], Y: [nf(UNIT_LABEL[s.unit], s.factor)], D: [nf(UNIT_LABEL[s.unit], 1)],
    A: [nf(AREA_LABEL[s.unit], 1)], T: [nf('°', 1)], S: [nf('', 1)], O: [0, 0], CYX: 1,
  });
}

interface Built {
  bytes: Uint8Array;
  pageCount: number;
}

function resourcesDict(doc: PDFDocument, res: Resources) {
  const ctx = doc.context;
  const gs = ctx.obj({});
  for (const g of res.gs.values()) {
    const d: Record<string, unknown> = { Type: 'ExtGState', CA: g.CA, ca: g.ca };
    if (g.BM) d.BM = g.BM;
    gs.set(PDFName.of(g.name), ctx.obj(d as never));
  }
  const r = ctx.obj({ ExtGState: gs });
  if (res.font) {
    r.set(PDFName.of('Font'), ctx.obj({ [FONT_NAME]: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) }));
  }
  return r;
}

function formXObject(doc: PDFDocument, prims: Prim[], bbox: number[], extra: Record<string, PDFObject> = {}) {
  const res = new Resources();
  const ops = primsToOps(prims, res);
  const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: resourcesDict(doc, res) });
  for (const [k, v] of Object.entries(extra)) dict.set(PDFName.of(k), v);
  const stream = doc.context.flateStream(ops, {});
  for (const [k, v] of dict.entries()) stream.dict.set(k, v);
  return doc.context.register(stream);
}

function colorArr(hex: string | null | undefined) {
  return hex ? hexToRgb(hex) : [];
}

/** Build one annotation (or several for counts) for a markup. */
function buildAnnots(doc: PDFDocument, m: Markup, scale: ScaleCal, rot: number, ocg: PDFRef | undefined, author: string): PDFRef[] {
  const ctx = doc.context;
  const s = m.style;
  const groups: { prims: Prim[]; idx?: number }[] = [];
  if (m.type === 'm-count') {
    m.pts.forEach((p, i) => {
      const one: Markup = { ...m, pts: m.pts.slice(0, i + 1) };
      const prims = markupPrims(one, scale, rot);
      groups.push({ prims: prims.slice(prims.length - 3), idx: i });
    });
  } else groups.push({ prims: markupPrims(m, scale, rot) });

  const mv = measureOf(m, scale);
  const refs: PDFRef[] = [];
  for (const g of groups) {
    if (!g.prims.length) continue;
    const bb = primsBounds(g.prims);
    const rect = [bb.x0, bb.y0, bb.x1, bb.y1];
    const ap = formXObject(doc, g.prims, rect);
    const base: Record<string, unknown> = {
      Type: 'Annot', Rect: rect, F: 4,
      NM: PDFString.of(g.idx !== undefined ? `${m.id}#${g.idx}` : m.id),
      T: PDFString.of(sanitize(m.author || author)), M: PDFString.of(pdfDate(m.modified)), CreationDate: PDFString.of(pdfDate(m.created)),
      Subj: PDFString.of(TYPE_LABEL[m.type]), C: colorArr(s.stroke), CA: s.opacity,
      BS: ctx.obj({ Type: 'Border', W: s.width, S: s.dash === 'dashed' || s.dash === 'dotted' ? 'D' : 'S', ...(s.dash === 'dashed' ? { D: [s.width * 3 + 3, s.width * 2 + 2] } : s.dash === 'dotted' ? { D: [1, s.width * 2 + 2] } : {}) }),
      AP: ctx.obj({ N: ap }),
    };
    let contents = m.comment ?? '';
    if (mv) contents = [mv.text, contents].filter(Boolean).join(' - ');
    const pts = (arr: number[][]) => arr.flat();
    const cloudBE = ctx.obj({ S: 'C', I: 1 });
    switch (m.type) {
      case 'pen':
        Object.assign(base, { Subtype: 'Ink', InkList: [pts(m.pts)] });
        break;
      case 'line': case 'arrow': case 'm-length':
        Object.assign(base, { Subtype: 'Line', L: pts([m.pts[0], m.pts[m.pts.length - 1]]), LE: [LE[s.startHead], LE[s.endHead]] });
        if (m.type === 'm-length') Object.assign(base, { IT: 'LineDimension', Measure: measureDict(doc, scale) });
        break;
      case 'polyline': case 'm-polylength':
        Object.assign(base, { Subtype: 'PolyLine', Vertices: pts(m.pts), LE: [LE[s.startHead], LE[s.endHead]] });
        if (m.type === 'm-polylength') Object.assign(base, { IT: 'PolyLineDimension', Measure: measureDict(doc, scale) });
        break;
      case 'polygon': case 'm-area': case 'm-perimeter':
        Object.assign(base, { Subtype: 'Polygon', Vertices: pts(m.pts) });
        if (s.fill && m.type !== 'm-perimeter') base.IC = colorArr(s.fill);
        if (s.dash === 'cloud') base.BE = cloudBE;
        if (m.type === 'm-area') Object.assign(base, { IT: 'PolygonDimension', Measure: measureDict(doc, scale) });
        if (m.type === 'm-perimeter') Object.assign(base, { IT: 'PolyLineDimension', Measure: measureDict(doc, scale) });
        break;
      case 'rect': case 'cloud':
        Object.assign(base, { Subtype: m.type === 'cloud' ? 'Polygon' : 'Square' });
        if (m.type === 'cloud') Object.assign(base, { Vertices: pts(rectPts(m.pts[0], m.pts[1])), BE: cloudBE, IT: 'PolygonCloud' });
        else if (s.dash === 'cloud') base.BE = cloudBE;
        if (s.fill) base.IC = colorArr(s.fill);
        break;
      case 'ellipse':
        Object.assign(base, { Subtype: 'Circle' });
        if (s.fill) base.IC = colorArr(s.fill);
        if (s.dash === 'cloud') base.BE = cloudBE;
        break;
      case 'highlight': {
        const r = rectPts(m.pts[0], m.pts[1]);
        Object.assign(base, { Subtype: 'Highlight', C: colorArr(s.fill ?? s.stroke), CA: s.fillOpacity, QuadPoints: [r[0][0], r[2][1], r[1][0], r[2][1], r[0][0], r[0][1], r[1][0], r[0][1]] });
        break;
      }
      case 'text': case 'callout': {
        const tc = hexToRgb(s.textColor).map((v) => +v.toFixed(3)).join(' ');
        Object.assign(base, {
          Subtype: 'FreeText', DA: PDFString.of(`/Helv ${s.fontSize} Tf ${tc} rg`),
          DS: PDFString.of(`font: Helvetica ${s.fontSize}pt; color: ${s.textColor}`),
        });
        contents = sanitize(m.text ?? '');
        if (s.fill) base.IC = colorArr(s.fill);
        if (m.type === 'callout') {
          const g2 = calloutGeometry(m);
          Object.assign(base, { IT: 'FreeTextCallout', CL: pts([g2.tip, g2.knee]), LE: LE[s.endHead] });
        }
        break;
      }
      case 'm-count':
        Object.assign(base, { Subtype: 'Circle', IC: colorArr(s.fill ?? s.stroke) });
        contents = `Count ${g.idx! + 1} of ${m.pts.length}${m.comment ? ' - ' + m.comment : ''}`;
        break;
    }
    if (m.type === 'cloud' || s.dash === 'cloud') base.BE = ctx.obj({ S: 'C', I: Math.min(2, cloudArc(s) / 10) });
    base.Contents = PDFHexString.fromText(contents);
    const dict = ctx.obj(base as never) as unknown as PDFDict;
    dict.set(PMID, PDFString.of(m.id));
    if (ocg) dict.set(PDFName.of('OC'), ocg);
    refs.push(ctx.register(dict));
  }
  return refs;
}

export async function exportPdf(docState: Doc, sources: Map<string, SourceFile>, opts: ExportOptions): Promise<Built> {
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setProducer('SheetScale (local browser app)');
  out.setCreator('SheetScale');
  out.setTitle(docState.name.replace(/\.pdf$/i, ''));
  out.setModificationDate(new Date());
  const ctx = out.context;
  const libs = new Map<string, PDFDocument>();
  const copiers = new Map<string, PDFObjectCopier>();
  const pageRefs = opts.pageUids ? docState.pages.filter((p) => opts.pageUids!.includes(p.uid)) : docState.pages;
  const outPages: { ref: PageRef; page: PDFPage }[] = [];

  for (const pr of pageRefs) {
    const src = sources.get(pr.src);
    if (!src) throw new Error('Missing source file for page');
    let lib = libs.get(pr.src);
    if (!lib) {
      lib = await loadLib(src.bytes);
      libs.set(pr.src, lib);
      copiers.set(pr.src, PDFObjectCopier.for(lib.context, ctx));
    }
    const srcPage = lib.getPage(pr.index);
    const leaf = copiers.get(pr.src)!.copy(srcPage.node);
    const page = PDFPage.of(leaf, ctx.register(leaf), out);
    out.addPage(page);
    const baseRot = srcPage.getRotation().angle;
    page.setRotation(degrees((((baseRot + pr.rot) % 360) + 360) % 360));
    outPages.push({ ref: pr, page });
  }

  // ---- Optional content (layers) ----
  const allOcgs: PDFObject[] = [];
  const order: PDFObject[] = [];
  const on: PDFObject[] = [];
  const off: PDFObject[] = [];
  for (const [sid, lib] of libs) {
    const ocp = lib.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
    if (!ocp) continue;
    const copier = copiers.get(sid)!;
    const ocgs = ocp.lookupMaybe(PDFName.of('OCGs'), PDFArray);
    if (!ocgs) continue;
    const hidden = new Set(docState.ocgHidden[sid] ?? []);
    const shown = new Set(docState.ocgShown[sid] ?? []);
    const d = ocp.lookupMaybe(PDFName.of('D'), PDFDict);
    const srcOff = new Set<string>();
    const offArr = d?.lookupMaybe(PDFName.of('OFF'), PDFArray);
    if (offArr) for (let i = 0; i < offArr.size(); i++) srcOff.add(String(offArr.get(i)));
    for (let i = 0; i < ocgs.size(); i++) {
      const r = ocgs.get(i);
      if (!(r instanceof PDFRef)) continue;
      const id = r.generationNumber ? `${r.objectNumber}R${r.generationNumber}` : `${r.objectNumber}R`;
      const nr = copier.copy(r) as PDFRef;
      allOcgs.push(nr);
      const isOff = hidden.has(id) || (srcOff.has(String(r)) && !shown.has(id));
      (isOff ? off : on).push(nr);
    }
    const ord = d?.lookupMaybe(PDFName.of('Order'), PDFArray);
    if (ord && ord.size()) {
      const copied = copier.copy(ord) as PDFArray;
      const name = sources.get(sid)?.name ?? 'Layers';
      order.push(libs.size > 1 ? ctx.obj([PDFString.of(name), ...copied.asArray()]) : copied);
      if (libs.size === 1) order.splice(order.length - 1, 1, ...copied.asArray());
    } else for (let i = 0; i < ocgs.size(); i++) {
      const r = ocgs.get(i);
      if (r instanceof PDFRef) order.push(copier.copy(r));
    }
  }
  const layerOcg = new Map<string, PDFRef>();
  if (opts.layersAsOcg) {
    const used = new Set(docState.markups.filter((m) => pageRefs.some((p) => p.uid === m.page)).map((m) => m.layer));
    const appOrder: PDFObject[] = [PDFString.of('SheetScale Markups')];
    for (const l of docState.layers) {
      if (!used.has(l.id)) continue;
      const dict = ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText(l.name), Intent: 'View' });
      dict.set(PMID, PDFString.of(l.id));
      const r = ctx.register(dict);
      layerOcg.set(l.id, r);
      allOcgs.push(r);
      appOrder.push(r);
      (l.visible ? on : off).push(r);
    }
    if (appOrder.length > 1) order.push(ctx.obj(appOrder));
  }
  if (allOcgs.length) {
    out.catalog.set(PDFName.of('OCProperties'), ctx.obj({
      OCGs: allOcgs, D: ctx.obj({ Name: PDFString.of('SheetScale'), BaseState: 'ON', Order: order, ON: on, OFF: off }),
    }));
  }

  // ---- Markups, scale viewports ----
  const author = opts.author || 'SheetScale';
  for (const { ref, page } of outPages) {
    const scale = ref.scale ?? PAPER_SCALE;
    const rot = page.getRotation().angle;
    const box = page.getCropBox();
    if (ref.scale) {
      page.node.set(PDFName.of('VP'), ctx.obj([ctx.obj({
        Type: 'Viewport', Name: PDFString.of('SheetScale scale'),
        BBox: [box.x, box.y, box.x + box.width, box.y + box.height], Measure: measureDict(out, ref.scale),
      })]));
    }
    const marks = docState.markups.filter((m) => m.page === ref.uid);
    if (!marks.length) continue;
    if (opts.flatten) {
      page.node.normalize();
      const byLayer = new Map<string, Markup[]>();
      for (const m of marks) byLayer.set(m.layer, [...(byLayer.get(m.layer) ?? []), m]);
      const resources = page.node.Resources()!;
      let xobjs = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjs) { xobjs = ctx.obj({}); resources.set(PDFName.of('XObject'), xobjs); }
      let props = resources.lookupMaybe(PDFName.of('Properties'), PDFDict);
      let ops = '';
      let k = 0;
      for (const [lid, ms] of byLayer) {
        const prims = ms.flatMap((m) => markupPrims(m, scale, rot));
        const big = [-1e5, -1e5, 1e5, 1e5];
        const xo = formXObject(out, prims, big);
        const name = `PMflat${k++}`;
        xobjs.set(PDFName.of(name), xo);
        const ocg = layerOcg.get(lid);
        if (ocg) {
          if (!props) { props = ctx.obj({}); resources.set(PDFName.of('Properties'), props); }
          const pn = `PMoc${k}`;
          props.set(PDFName.of(pn), ocg);
          ops += `/OC /${pn} BDC q /${name} Do Q EMC\n`;
        } else ops += `q /${name} Do Q\n`;
      }
      const pre = ctx.register(ctx.flateStream('q\n'));
      const post = ctx.register(ctx.flateStream(`\nQ\n${ops}`));
      page.node.wrapContentStreams(pre, post);
    } else {
      for (const m of marks) {
        for (const r of buildAnnots(out, m, scale, rot, layerOcg.get(m.layer), author)) {
          ctx.lookup(r, PDFDict).set(PDFName.of('P'), page.ref);
          page.node.addAnnot(r);
        }
      }
    }
  }

  // ---- App data so SheetScale can reopen markups as editable ----
  const uidIndex = new Map(outPages.map((p, i) => [p.ref.uid, i]));
  const app: AppData = {
    v: 1,
    pages: outPages.map((p) => ({ scale: p.ref.scale })),
    markups: opts.flatten ? [] : docState.markups.filter((m) => uidIndex.has(m.page)).map((m) => ({ ...m, page: uidIndex.get(m.page)! })),
    layers: docState.layers,
    activeLayer: docState.activeLayer,
  };
  const appStream = ctx.flateStream(enc.encode(JSON.stringify(app)), { Type: 'PlanMarkData' });
  out.catalog.set(PDFName.of(APP_KEY), ctx.register(appStream));
  if (!opts.flatten) out.catalog.set(PDFName.of('NeedsRendering'), PDFBool.False);
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pageCount: outPages.length };
}

// ---- Images -> PDF ----
export async function imageToPngBytes(source: CanvasImageSource, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(source, 0, 0);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function imagesToPdf(files: File[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer('SheetScale (local browser app)');
  const PX_TO_PT = 72 / 96;
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    const name = f.name.toLowerCase();
    const addImage = async (img: Awaited<ReturnType<typeof out.embedPng>>) => {
      const w = img.width * PX_TO_PT, h = img.height * PX_TO_PT;
      const p = out.addPage([w, h]);
      p.drawImage(img, { x: 0, y: 0, width: w, height: h });
    };
    if (/\.(jpe?g)$/.test(name) || (buf[0] === 0xff && buf[1] === 0xd8)) {
      await addImage(await out.embedJpg(buf));
    } else if (/\.png$/.test(name) || (buf[0] === 0x89 && buf[1] === 0x50)) {
      await addImage(await out.embedPng(buf));
    } else if (/\.tiff?$/.test(name) || (buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
      const UTIF = (await import('utif')).default as any;
      const ifds = UTIF.decode(buf.buffer);
      for (const ifd of ifds) {
        UTIF.decodeImage(buf.buffer, ifd);
        const rgba: Uint8Array = UTIF.toRGBA8(ifd);
        if (!ifd.width || !ifd.height) continue;
        const c = document.createElement('canvas');
        c.width = ifd.width;
        c.height = ifd.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba) as Uint8ClampedArray<ArrayBuffer>, ifd.width, ifd.height), 0, 0);
        await addImage(await out.embedPng(await imageToPngBytes(c, ifd.width, ifd.height)));
      }
    } else {
      const bmp = await createImageBitmap(new Blob([buf]));
      await addImage(await out.embedPng(await imageToPngBytes(bmp, bmp.width, bmp.height)));
    }
  }
  if (!out.getPageCount()) throw new Error('No images could be read');
  return out.save({ useObjectStreams: true });
}
