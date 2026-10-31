// Large-document performance: three ~100-page reports (125 MB) combined into ~300 pages, plus a dense plan sheet.
// Prints a results table and writes test-results/perf.json. Run: npx playwright test -c playwright.perf.config.ts
import { test, expect, chromium, type Page, type Browser } from '@playwright/test';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MemSampler, browserPid, startRecording, stopRecording, pct, r1 , heapReport } from './harness';

const BIG = new URL('../fixtures/big/', import.meta.url).pathname;
const OUTD = new URL('../../test-results/perf/', import.meta.url).pathname;
const BASE = process.env.PM_BASE_URL || 'http://localhost:4173/';
const results: Record<string, unknown> = {};
const log = (k: string, v: unknown) => { results[k] = v; console.log(`[perf] ${k}: ${JSON.stringify(v)}`); };
test.setTimeout(30 * 60_000);

let browser: Browser; let page: Page; let mem: MemSampler;
const marker = `--pm-perf-${Date.now()}`;
const t0 = () => performance.now();
const since = (t: number) => Math.round(performance.now() - t);
const idle = (p: Page) => p.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 600_000 });
const firstRendered = (p: Page) => p.waitForFunction(() => { const pg = document.querySelector('.page'); return !!pg && +((pg as HTMLElement).dataset.rendered || 0) > 0; }, null, { timeout: 600_000 });

test.beforeAll(async () => {
  mkdirSync(OUTD, { recursive: true });
  browser = await chromium.launch({ args: [marker] });
  mem = new MemSampler(browserPid(marker));
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
});
test.afterAll(async () => {
  writeFileSync(OUTD + 'perf.json', JSON.stringify(results, null, 2));
  await browser?.close();
});

test('300 pages: open, combine, scroll, organise, save, reduce, autosave', async () => {
  await page.goto(BASE + '?nosw' + (process.env.PERF_QS ?? ''));
  await page.waitForSelector('body[data-ready="1"]');
  log('memBaselineMB', r1(mem.now()));
  mem.start();

  // open one 42 MB report: time to first rendered page
  let t = t0();
  await page.setInputFiles('#file-open', BIG + 'report-1.pdf');
  await firstRendered(page); await idle(page);
  log('open1_report_42MB_ttfp_ms', since(t));
  // open the other two
  t = t0();
  await page.setInputFiles('#file-open', [BIG + 'report-2.pdf', BIG + 'report-3.pdf']);
  await idle(page); await firstRendered(page);
  log('open2_more_reports_ms', since(t)); log('peak_open_MB', mem.phase());

  // combine all three -> ~300 pages
  t = t0();
  await page.click('#btn-combine');
  await page.click('#cb-ok');
  await page.waitForFunction(() => (window as any).__pm.doc?.pages.length >= 300, null, { timeout: 600_000 });
  await firstRendered(page); await idle(page);
  const nPages = await page.evaluate(() => (window as any).__pm.doc.pages.length);
  log('combine_300_pages_ms', since(t)); log('combinedPages', nPages); log('peak_combine_MB', mem.phase());

  // scroll through every page in the viewer (fast fling: 600 px per frame = ~36,000 px/s)
  await startRecording(page);
  t = t0();
  await page.evaluate(async () => {
    const v = document.getElementById('viewer')!;
    await new Promise<void>((res) => { const step = () => { v.scrollTop += 600; if (v.scrollTop + v.clientHeight >= v.scrollHeight - 2) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
  });
  log('scroll_all_pages_ms', since(t));
  log('scroll_frames', { ...(await stopRecording(page)), events: undefined });
  log('memAfterFastScrollMB', r1(mem.now())); log('memBreakdownAfterScroll', mem.breakdown());
  if (process.env.PERF_STOP === 'scroll') { await page.waitForTimeout(1500); log('memAfterIdleMB', r1(mem.now())); log('memPeakMB', r1(mem.stop())); return; }
  // reading-speed scroll back up through 40 pages (~1,500 px/s): how often is a visible page still blank?
  await startRecording(page);
  const blank = await page.evaluate(async () => {
    const v = document.getElementById('viewer')!;
    const pm = (window as any).__pm;
    let samples = 0, blankFrames = 0;
    const target = v.scrollTop - 40 * (v.scrollHeight / pm.doc.pages.length);
    await new Promise<void>((res) => { const step = () => { v.scrollTop -= 25; samples++; if (!pm.rendered()) blankFrames++; if (v.scrollTop <= target || v.scrollTop <= 0) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
    return { samples, blankFramePct: Math.round((blankFrames / samples) * 1000) / 10 };
  });
  log('read_scroll_frames', { ...(await stopRecording(page)), events: undefined });
  log('read_scroll_blank', blank);
  log('renderStatsAfterScroll', await page.evaluate(() => (window as any).__pm.renderStats()));
  log('canvasMBAfterScroll', await page.evaluate(() => Math.round([...document.querySelectorAll('canvas')].reduce((s, c) => s + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height * 4, 0) / 1048576)));
  // ctrl+wheel zoom on the 300-page document
  {
    const vb = (await page.locator('#viewer').boundingBox())!;
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await startRecording(page);
    await page.keyboard.down('Control');
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -50);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 50);
    await page.keyboard.up('Control');
    await page.waitForTimeout(400);
    log('zoom300_frames', { ...(await stopRecording(page)), events: undefined });
  }

  // scroll the thumbnail panel end to end
  await startRecording(page);
  t = t0();
  await page.evaluate(async () => {
    const b = document.getElementById('left-body')!;
    await new Promise<void>((res) => { const step = () => { b.scrollTop += 400; if (b.scrollTop + b.clientHeight >= b.scrollHeight - 2) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
  });
  log('thumbs_scroll_ms', since(t));
  log('thumbs_frames', { ...(await stopRecording(page)), events: undefined });
  log('thumbsRenderedLive', await page.evaluate(() => [...document.querySelectorAll('.thumb canvas')].filter((c) => (c as HTMLCanvasElement).width > 0).length));
  log('memAfterThumbScrollMB', r1(mem.now())); log('peak_scroll_and_thumbs_MB', mem.phase());
  if (process.env.PERF_HEAP) { log('heapAfterThumbs', await heapReport(page)); log('heapAfterThumbsGC', await heapReport(page, true)); await page.waitForTimeout(500); log('memAfterThumbsGC_MB', r1(mem.now())); log('breakdownAfterThumbsGC', mem.breakdown()); }

  // page organiser at 300 pages: rotate, delete 10, move 5 to the front, undo
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => (window as any).__pm.goToPage(150));
  const op = async (name: string, fn: () => Promise<unknown>) => { const s = t0(); await fn(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await idle(page); log(name, since(s)); };
  await op('rotate_page_ms', () => page.click('#pg-rotr'));
  await op('delete_10_pages_ms', () => page.evaluate(() => (window as any).__pm.organize('delete', 140, 10)));
  await op('move_5_pages_ms', () => page.evaluate(() => (window as any).__pm.organize('move', 200, 5, 0)));
  await op('undo_ms', () => page.keyboard.press('Control+z'));
  log('pagesAfterOrganise', await page.evaluate(() => (window as any).__pm.doc.pages.length)); log('peak_organise_MB', mem.phase());

  // a few markups so save has work to do
  await page.evaluate(() => (window as any).__pm.goToPage(0));
  // save editable
  t = t0();
  const [d1] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), page.click('#btn-save')]);
  const f1 = OUTD + 'combined.pdf'; await d1.saveAs(f1);
  log('save_editable_ms', since(t)); log('memAfterSaveMB', r1(mem.now())); log('memBreakdownAfterSave', mem.breakdown()); log('save_editable_MB', r1(statSync(f1).size / 1e6)); log('peak_save_editable_MB', mem.phase());
  log('save_editable_pages', +execFileSync('pdfinfo', [f1], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)![1]);
  // save flattened
  t = t0();
  await page.click('#btn-export');
  await page.check('input[name=ex-mode][value=flatten]');
  const [d2] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), page.click('#ex-ok')]);
  const f2 = OUTD + 'combined_flat.pdf'; await d2.saveAs(f2);
  log('save_flattened_ms', since(t)); log('save_flattened_MB', r1(statSync(f2).size / 1e6)); log('peak_save_flattened_MB', mem.phase());
  if (process.env.PERF_HEAP) { log('heapAfterSave', await heapReport(page)); log('heapAfterSaveGC', await heapReport(page, true)); await page.waitForTimeout(500); log('memAfterSaveGC_MB', r1(mem.now())); mem.phase(); }
  // lossless reduce of the 300-page result
  t = t0();
  await page.click('#btn-reduce');
  await page.setInputFiles('#rd-input', f1);
  await page.waitForSelector('.rd-after, #rd-table td[style*="danger"]', { timeout: 600_000 });
  log('reduce_300_pages_ms', since(t)); log('memPeakSoFarMB', r1(mem.peak)); log('peak_reduce_MB', mem.phase());
  log('reduce_result', await page.evaluate(() => { const a = document.querySelector('.rd-after') as HTMLElement | null; const b = document.querySelector('.rd-before') as HTMLElement | null; return a ? { beforeMB: +(b!.dataset.bytes!) / 1e6, afterMB: +(a.dataset.bytes!) / 1e6 } : document.querySelector('#rd-table tbody')!.textContent; }));
  await page.keyboard.press('Escape');

  // autosave + restore after reload (IndexedDB holds the 125 MB of sources)
  t = t0();
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 600_000 });
  await firstRendered(page);
  log('reload_restore_session_ttfp_ms', since(t));
  log('restoredDocs', await page.evaluate(() => (window as any).__pm.docs.map((d: any) => d.pages.length))); log('peak_reload_restore_MB', mem.phase());
  log('memPeakMB', mem.stop());
});

test('large plan sheet: first page, zoom, pan, draw, input latency', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.goto(BASE + '?nosw');
  await p2.waitForSelector('body[data-ready="1"]');
  await p2.evaluate(async () => { for (const d of [...(window as any).__pm.docs]) await (window as any).__pm.close(d); });
  let t = t0();
  await p2.setInputFiles('#file-open', BIG + 'big-plan.pdf');
  await firstRendered(p2);
  log('plan_ttfp_ms', since(t));
  await p2.waitForTimeout(500);
  const vb = (await p2.locator('#viewer').boundingBox())!;
  const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
  // zoom: 40 ctrl+wheel steps in, 40 out
  await startRecording(p2);
  await p2.mouse.move(cx, cy);
  await p2.keyboard.down('Control');
  for (let i = 0; i < 40; i++) { await p2.mouse.wheel(0, -60); }
  for (let i = 0; i < 40; i++) { await p2.mouse.wheel(0, 60); }
  await p2.keyboard.up('Control');
  await p2.waitForTimeout(300);
  log('plan_zoom_frames', { ...(await stopRecording(p2)), events: undefined });
  // zoom to 400% and pan by dragging with the hand tool
  await p2.evaluate(() => (window as any).__pm.setZoom(4));
  await p2.waitForTimeout(800);
  await p2.keyboard.press('h');
  await startRecording(p2);
  await p2.mouse.move(cx, cy); await p2.mouse.down();
  for (let i = 0; i < 120; i++) await p2.mouse.move(cx - i * 6, cy - Math.sin(i / 10) * 200);
  await p2.mouse.up();
  await p2.waitForTimeout(300);
  log('plan_pan_frames', { ...(await stopRecording(p2)), events: undefined });
  // draw: pen stroke with 300 moves, then a 40-vertex area
  await p2.keyboard.press('p');
  await startRecording(p2);
  await p2.mouse.move(cx - 300, cy); await p2.mouse.down();
  for (let i = 0; i < 300; i++) await p2.mouse.move(cx - 300 + i * 2, cy + Math.sin(i / 15) * 120);
  await p2.mouse.up();
  await p2.keyboard.press('4');
  for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; await p2.mouse.click(cx + Math.cos(a) * 250, cy + Math.sin(a) * 180); await p2.mouse.move(cx + Math.cos(a + 0.05) * 250, cy + Math.sin(a + 0.05) * 180); }
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(300);
  const dr = await stopRecording(p2);
  const ptr = dr.events.filter((e) => /pointer|mouse|click/.test(e.name)).map((e) => e.dur);
  log('plan_draw_frames', { ...dr, events: undefined });
  log('plan_input_latency_ms', { eventsOver16ms: ptr.length, p50: r1(pct(ptr, 50)), p95: r1(pct(ptr, 95)), max: r1(Math.max(0, ...ptr)) });
  // keypress -> next frame latency for tool switching
  const kl: number[] = [];
  for (const k of ['v', 'p', '1', '4', 'v']) {
    kl.push(await p2.evaluate((key) => new Promise<number>((res) => { const s = performance.now(); window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); requestAnimationFrame(() => res(performance.now() - s)); }), k));
  }
  log('key_to_frame_ms', { p50: r1(pct(kl, 50)), max: r1(Math.max(...kl)) });
  expect(await p2.evaluate(() => (window as any).__pm.doc.markups.length)).toBeGreaterThanOrEqual(2);
  await p2.close();
});
