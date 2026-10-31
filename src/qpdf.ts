// Thin client for the qpdf WebAssembly worker (public/qpdf/qpdf-worker.js).
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: QpdfResult) => void>();

export interface QpdfResult { code: number; output: Uint8Array | null; out: string; err: string }

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('qpdf/qpdf-worker.js', document.baseURI));
    worker.onmessage = (e) => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      cb?.(e.data);
    };
  }
  return worker;
}

/** Run qpdf. Use '@IN' and '@OUT' placeholders for the input/output paths. */
export function runQpdf(input: Uint8Array, args: string[]): Promise<QpdfResult> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const copy = input.slice();
    getWorker().postMessage({ id, input: copy, args }, [copy.buffer]);
  });
}

/** Lossless optimisation: no image resampling or re-encoding of lossy data. */
export const LOSSLESS_ARGS = [
  '--object-streams=generate',
  '--compress-streams=y',
  '--recompress-flate',
  '--compression-level=9',
  '--decode-level=generalized',
  '--remove-unreferenced-resources=yes',
  '--warning-exit-0',
];

export async function reduceLossless(input: Uint8Array, opts: { linearize?: boolean } = {}) {
  const args = ['@IN', ...LOSSLESS_ARGS, ...(opts.linearize ? ['--linearize'] : []), '@OUT'];
  const r = await runQpdf(input, args);
  if (!r.output || (r.code !== 0 && r.code !== 3)) throw new Error(`qpdf failed (${r.code}): ${r.err || r.out}`);
  return r.output;
}

export async function decrypt(input: Uint8Array, password = '') {
  const args = ['--decrypt', ...(password ? [`--password=${password}`] : []), '--warning-exit-0', '@IN', '@OUT'];
  const r = await runQpdf(input, args);
  if (!r.output || (r.code !== 0 && r.code !== 3)) throw new Error(r.err || 'Could not decrypt PDF');
  return r.output;
}
