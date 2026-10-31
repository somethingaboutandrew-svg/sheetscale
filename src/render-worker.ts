/// <reference lib="webworker" />
// Off-main-thread page rasteriser: a private pdf.js instance drawing into OffscreenCanvas.
// Results go back as transferable ImageBitmaps, so the UI thread never runs PDF drawing code.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

declare const self: DedicatedWorkerGlobalScope;

class OffscreenCanvasFactory {
  constructor(_o: unknown) {}
  create(w: number, h: number) {
    const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: false }) };
  }
  reset(cc: { canvas: OffscreenCanvas }, w: number, h: number) { cc.canvas.width = Math.max(1, w); cc.canvas.height = Math.max(1, h); }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) { if (cc.canvas) cc.canvas.width = cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}
class NoFilterFactory {
  constructor(_o: unknown) {}
  addFilter() { return 'none'; } addHCMFilter() { return 'none'; } addAlphaFilter() { return 'none'; } addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; } addHighlightHCMFilter() { return 'none'; } addSelectionHCMFilter() { return 'none'; } addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; } destroy() {}
}

const hasFonts = !!(self as any).fonts;
// pdf.js only needs `fonts` (FontFace registration) from its "document".
const fakeDoc = { fonts: (self as any).fonts, baseURI: self.location.href, createElement: () => { throw new Error('no DOM in worker'); } };
pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });

const docs = new Map<string, Promise<PDFDocumentProxy>>();
const tasks = new Map<number, RenderTask>();
const cancelled = new Set<number>();
// Pages whose decoded resources (images, fonts) are kept; others are cleaned up to bound memory.
const hot: { key: string; page: PDFPageProxy }[] = [];
const HOT_MAX = 4;
let baseOpts: Record<string, unknown> = {};
// When the queue goes idle, drop each document's shared caches (images reused across pages live
// in commonObjs and are only freed by doc.cleanup()). Fonts re-parse lazily on the next render.
let dirty = new Set<string>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleIdleCleanup() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (tasks.size) return scheduleIdleCleanup();
    const ids = [...dirty];
    dirty = new Set();
    hot.length = 0;
    for (const id of ids) {
      try { await (await docs.get(id))?.cleanup(); } catch { dirty.add(id); }
    }
  }, 700);
}

function touch(key: string, page: PDFPageProxy) {
  const i = hot.findIndex((x) => x.key === key);
  if (i >= 0) hot.splice(i, 1);
  hot.push({ key, page });
  while (hot.length > HOT_MAX) hot.shift()!.page.cleanup(); // pdf.js defers this while a render is running
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') { baseOpts = m.opts; return; }
    if (m.type === 'open') {
      docs.set(m.doc, pdfjs.getDocument({
        ...baseOpts, data: m.bytes, ownerDocument: fakeDoc, useWorkerFetch: true, disableFontFace: !hasFonts,
        CanvasFactory: OffscreenCanvasFactory, FilterFactory: NoFilterFactory, isOffscreenCanvasSupported: true, ...baseOpts,
      } as any).promise);
      return;
    }
    if (m.type === 'close') {
      const d = docs.get(m.doc); docs.delete(m.doc);
      for (let i = hot.length - 1; i >= 0; i--) if (hot[i].key.startsWith(m.doc + '|')) hot.splice(i, 1);
      ((await d) as any)?.loadingTask?.destroy?.();
      return;
    }
    if (m.type === 'cancel') { cancelled.add(m.job); tasks.get(m.job)?.cancel(); return; }
    if (m.type === 'render') {
      const { job } = m;
      if (cancelled.delete(job)) return self.postMessage({ job, cancelled: true });
      const doc = await docs.get(m.doc)!;
      const page = await doc.getPage(m.index + 1);
      if (cancelled.delete(job)) return self.postMessage({ job, cancelled: true });
      const vp = page.getViewport({ scale: m.scale, rotation: m.rotation });
      const canvas = new OffscreenCanvas(m.width, m.height);
      let ocg: any;
      if (m.hidden?.length || m.shown?.length) {
        ocg = await doc.getOptionalContentConfig();
        for (const id of m.hidden ?? []) ocg.setVisibility(id, false);
        for (const id of m.shown ?? []) ocg.setVisibility(id, true);
      }
      const task = page.render({
        canvas: canvas as any, viewport: vp, transform: m.transform ?? undefined,
        annotationMode: m.annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE,
        ...(ocg ? { optionalContentConfigPromise: Promise.resolve(ocg) } : {}),
        background: 'white',
      } as any);
      tasks.set(job, task);
      try {
        await task.promise;
      } finally {
        tasks.delete(job);
        touch(`${m.doc}|${m.index}`, page);
        dirty.add(m.doc);
        scheduleIdleCleanup();
      }
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ job, bitmap }, [bitmap]);
    }
  } catch (err: any) {
    if (m.job !== undefined) self.postMessage({ job: m.job, cancelled: err?.name === 'RenderingCancelledException', error: String(err?.message ?? err) });
  }
};
