// Perf helpers: frame times (rAF deltas), long tasks, input latency (Event Timing API) and
// memory (PSS of the whole Chromium process tree, from /proc; Linux only).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { Page } from '@playwright/test';

export const pct = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export const r1 = (n: number) => Math.round(n * 10) / 10;

function treePids(rootPid: number): number[] {
  const out = execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const kids = new Map<number, number[]>();
  for (const l of out.trim().split('\n')) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const res: number[] = [];
  const st = [rootPid];
  while (st.length) { const p = st.pop()!; res.push(p); st.push(...(kids.get(p) ?? [])); }
  return res;
}
function pssKb(pid: number) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
    return m ? +m[1] : 0;
  } catch { return 0; }
}
/** Find the browser process whose command line contains a marker we passed as an argument. */
export function browserPid(marker: string): number {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (cmd.includes(marker) && !cmd.includes('--type=')) return +d;
    } catch { /* gone */ }
  }
  throw new Error('browser pid not found');
}
export class MemSampler {
  peak = 0; phasePeak = 0; samples: number[] = []; private t?: NodeJS.Timeout;
  constructor(private root: number) {}
  now() { return treePids(this.root).reduce((s, p) => s + pssKb(p), 0) / 1024; }
  /** Peak since the previous call (sampled every 200 ms), then reset. */
  phase() { const v = Math.max(this.phasePeak, this.now()); this.phasePeak = 0; return r1(v); }
  breakdown() {
    const out: Record<string, number> = {};
    for (const p of treePids(this.root)) {
      let type = 'browser';
      try { const m = readFileSync(`/proc/${p}/cmdline`, 'utf8').match(/--type=([a-z-]+)/); if (m) type = m[1]; } catch {}
      if (type === 'utility') { try { if (/network/i.test(readFileSync(`/proc/${p}/cmdline`, 'utf8'))) type = 'network'; } catch {} }
      out[type] = Math.round((out[type] || 0) + pssKb(p) / 1024);
    }
    return out;
  }
  start(ms = 200) { this.peak = 0; this.t = setInterval(() => { const v = this.now(); this.samples.push(v); this.peak = Math.max(this.peak, v); this.phasePeak = Math.max(this.phasePeak, v); }, ms); return this; }
  stop() { clearInterval(this.t); const v = this.now(); this.peak = Math.max(this.peak, v); return r1(this.peak); }
}

/** Start recording in the page: rAF frame deltas, long tasks, event timings. */
export async function startRecording(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__perf = { frames: [] as number[], long: [] as number[], events: [] as { name: string; dur: number; delay: number }[], on: true };
    let last = performance.now();
    const loop = (t: number) => { if (!w.__perf.on) return; w.__perf.frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) w.__perf.events.push({ name: e.name, dur: e.duration, delay: e.processingStart - e.startTime }); })
        .observe({ type: 'event', durationThreshold: 16, buffered: false } as any);
    } catch {}
  });
}
export async function stopRecording(page: Page) {
  const p = await page.evaluate(() => { const w = window as any; w.__perf.on = false; return w.__perf; });
  const f = p.frames.slice(1) as number[];
  return {
    frames: f.length, p50: r1(pct(f, 50)), p95: r1(pct(f, 95)), p99: r1(pct(f, 99)), max: r1(Math.max(...f)),
    over50ms: f.filter((x: number) => x > 50).length, longTasks: p.long.length, longestTask: r1(Math.max(0, ...p.long)),
    events: p.events as { name: string; dur: number; delay: number }[],
  };
}

/** Per-context JS heap + ArrayBuffer backing stores for the page and every (nested) worker, via CDP.
 *  With gc=true each context is garbage-collected first. */
export async function heapReport(page: Page, gc = false) {
  const cdp = await page.context().newCDPSession(page);
  const fmt = (r: any) => r && ({ usedMB: Math.round(r.usedSize / 1048576), backingMB: Math.round((r.backingStorageSize ?? 0) / 1048576) });
  let id = 1;
  const pending = new Map<number, (v: any) => void>();
  type Ctx = { path: string[]; url: string };
  const ctxs: Ctx[] = [];
  // send a message through a chain of non-flat sessions
  const send = (path: string[], method: string, params: any = {}): Promise<any> => {
    if (!path.length) return cdp.send(method as any, params).catch(() => null);
    const mid = id++;
    let msg = JSON.stringify({ id: mid, method, params });
    for (let i = path.length - 1; i >= 1; i--) msg = JSON.stringify({ id: id++, method: 'Target.sendMessageToTarget', params: { sessionId: path[i], message: msg } });
    return new Promise((res) => {
      pending.set(mid, res);
      setTimeout(() => { if (pending.delete(mid)) res(null); }, 5000);
      cdp.send('Target.sendMessageToTarget' as any, { sessionId: path[0], message: msg }).catch(() => res(null));
    });
  };
  const handle = (path: string[], raw: string) => {
    const m = JSON.parse(raw);
    if (m.method === 'Target.receivedMessageFromTarget') return handle([...path, m.params.sessionId], m.params.message);
    if (m.method === 'Target.attachedToTarget') { const p = [...path, m.params.sessionId]; ctxs.push({ path: p, url: m.params.targetInfo.url }); send(p, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }); return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  cdp.on('Target.receivedMessageFromTarget' as any, (e: any) => handle([e.sessionId], e.message));
  cdp.on('Target.attachedToTarget' as any, (e: any) => { const p = [e.sessionId]; ctxs.push({ path: p, url: e.targetInfo.url }); send(p, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }); });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false } as any);
  await new Promise((r) => setTimeout(r, 800));
  const out: Record<string, any> = {};
  const all: Ctx[] = [{ path: [], url: 'main' }, ...ctxs];
  for (const c of all) {
    if (gc) await send(c.path, 'HeapProfiler.collectGarbage');
    const name = `${'>'.repeat(c.path.length)}${c.url.split('/').pop()!.replace(/-[\w-]{8}\.(m?js)$/, '.$1')}`;
    out[name] = fmt(await send(c.path, 'Runtime.getHeapUsage'));
  }
  await cdp.detach().catch(() => {});
  return out;
}
