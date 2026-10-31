// Client for the render worker: a priority queue of cancellable page renders.
// Priority 0 = visible page base, 1 = zoomed detail tile, 2 = thumbnails, 3 = prefetch.
export interface RenderJob {
  doc: string; index: number; scale: number; rotation: number; width: number; height: number;
  transform?: number[]; hidden?: string[]; shown?: string[]; annotations?: boolean; priority: number;
}
interface Pending extends RenderJob { job: number; resolve: (b: ImageBitmap | null) => void; sent: boolean }

let worker: Worker | null = null;
let ok = true;
let seq = 0;
const queue: Pending[] = [];
const running = new Map<number, Pending>();
const opened = new Set<string>();
const MAX_RUNNING = 2;

export function workerRenderingAvailable() {
  return ok && typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined' && 'transferToImageBitmap' in OffscreenCanvas.prototype;
}

function getWorker(opts: Record<string, unknown>) {
  if (!worker) {
    worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => { console.warn('render worker failed; falling back to main thread', e.message); ok = false; for (const p of [...running.values(), ...queue]) p.resolve(null); running.clear(); queue.length = 0; };
    worker.onmessage = (e) => {
      const p = running.get(e.data.job);
      running.delete(e.data.job);
      if (p) p.resolve(e.data.bitmap ?? null);
      pump();
    };
    worker.postMessage({ type: 'init', opts });
  }
  return worker;
}

let initOpts: Record<string, unknown> = {};
export function initRenderer(opts: Record<string, unknown>) { initOpts = opts; }

export function openInRenderer(doc: string, bytes: Uint8Array) {
  if (opened.has(doc) || !workerRenderingAvailable()) return;
  opened.add(doc);
  const copy = bytes.slice();
  getWorker(initOpts).postMessage({ type: 'open', doc, bytes: copy }, [copy.buffer]);
}
export function closeInRenderer(doc: string) {
  if (!opened.delete(doc)) return;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].doc === doc) { queue[i].resolve(null); queue.splice(i, 1); }
  worker?.postMessage({ type: 'close', doc });
}

function pump() {
  if (!worker) return;
  while (running.size < MAX_RUNNING && queue.length) {
    queue.sort((a, b) => a.priority - b.priority || a.job - b.job);
    const p = queue.shift()!;
    running.set(p.job, p);
    const { resolve: _r, sent: _s, priority: _p, ...msg } = p;
    worker.postMessage({ type: 'render', ...msg });
  }
}

/** Queue a render; resolves to an ImageBitmap, or null if cancelled/failed. `cancel` drops it. */
export function renderPage(j: RenderJob): { promise: Promise<ImageBitmap | null>; cancel: () => void } {
  const job = ++seq;
  let p!: Pending;
  const promise = new Promise<ImageBitmap | null>((resolve) => { p = { ...j, job, resolve, sent: false }; });
  queue.push(p);
  getWorker(initOpts);
  pump();
  return {
    promise,
    cancel: () => {
      const i = queue.indexOf(p);
      if (i >= 0) { queue.splice(i, 1); p.resolve(null); return; }
      if (running.has(job)) worker?.postMessage({ type: 'cancel', job });
    },
  };
}
export const renderQueueStats = () => ({ queued: queue.length, running: running.size });
