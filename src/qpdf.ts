// Thin client for the qpdf WebAssembly worker (public/qpdf/qpdf-worker.js).
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: QpdfResult) => void>();

export interface QpdfResult { code: number; output: Uint8Array | null; input?: Uint8Array; out: string; err: string }

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('qpdf/qpdf-worker.js', document.baseURI));
    worker.onmessage = (e) => {
      const cb = pending.get(e.data.id);
      pending.delete(e.data.id);
      // A qpdf run grows the wasm heap to roughly 2-3x the file size and wasm memory never shrinks,
      // so retire the worker once it is idle; the next run starts with a fresh, small heap.
      if (!pending.size) { worker?.terminate(); worker = null; }
      cb?.(e.data);
    };
  }
  return worker;
}

/** Run qpdf. Use '@IN' and '@OUT' placeholders for the input/output paths.
 *  With consume=true the input buffer is moved to the worker (no copy) and handed back as
 *  result.input; the caller must not touch `input` afterwards. */
export function runQpdf(input: Uint8Array, args: string[], consume = false): Promise<QpdfResult> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const whole = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength && input.buffer instanceof ArrayBuffer;
    const send = consume && whole ? input : input.slice();
    getWorker().postMessage({ id, input: send, args, back: consume }, [send.buffer]);
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

/** Like reduceLossless, but moves `input` to the worker instead of copying it (big files).
 *  Returns the smaller of the two: the reduced output, or the original handed back. */
export async function reduceLosslessConsume(input: Uint8Array, opts: { linearize?: boolean } = {}) {
  const args = ['@IN', ...LOSSLESS_ARGS, ...(opts.linearize ? ['--linearize'] : []), '@OUT'];
  const before = input.length;
  const r = await runQpdf(input, args, true);
  const original = r.input ?? null;
  if (!r.output || (r.code !== 0 && r.code !== 3)) return { bytes: original, before, reduced: false, error: `qpdf failed (${r.code}): ${r.err || r.out}` };
  if (r.output.length < before) return { bytes: r.output, before, reduced: true };
  return { bytes: original ?? r.output, before, reduced: false };
}

export async function decrypt(input: Uint8Array, password = '') {
  const args = ['--decrypt', ...(password ? [`--password=${password}`] : []), '--warning-exit-0', '@IN', '@OUT'];
  const r = await runQpdf(input, args);
  if (!r.output || (r.code !== 0 && r.code !== 3)) throw new Error(r.err || 'Could not decrypt PDF');
  return r.output;
}
