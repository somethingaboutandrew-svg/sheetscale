/// <reference lib="webworker" />
// Builds the output PDF with pdf-lib off the UI thread. pdf-lib parses every source file into
// objects (several hundred MB for a 300-page set); running it in a throwaway worker keeps the
// UI responsive and returns all of that memory the moment the worker is terminated.
import { exportPdf } from './pdfio';
import type { Doc, SourceFile } from './types';

declare const self: DedicatedWorkerGlobalScope;
self.onmessage = async (e: MessageEvent<{ doc: Doc; sources: SourceFile[]; opts: Parameters<typeof exportPdf>[2] }>) => {
  try {
    const { doc, sources, opts } = e.data;
    const out = await exportPdf(doc, new Map(sources.map((s) => [s.id, s])), opts);
    self.postMessage({ ok: true, bytes: out.bytes, pageCount: out.pageCount }, [out.bytes.buffer]);
  } catch (err: any) {
    self.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
};
