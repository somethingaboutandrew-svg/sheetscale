# Performance

Measured with `npm run test:perf` (tests/perf/big.perf.ts) in headless Chromium on a Linux box, 1440×900 at 1× scale, software GPU. Frame times come from requestAnimationFrame deltas (16.7 ms = 60 fps). Memory is the proportional set size (PSS) of **every** Chromium process (browser, renderer, GPU, network), sampled every 200 ms, so it's the real cost to the machine, not just the page's JS heap.

**Fixtures** (`scripts/make-big-fixtures.mjs`): three reports of 101, 98 and 101 pages (42 MB, 41 MB and 42 MB), mostly text, with photo pages (two 1800×1350 JPEGs each) and full-sheet map pages (4400×2850 JPEGs). There is also a 36×24 in vector plan sheet with about 2,600 contour lines.

## v1.1: Liquid Glass theme (frosted panels), before and after

The new default theme blurs what is behind the side panels (`backdrop-filter`). Rules that keep it cheap:

- Only the two side panels and the start-screen cards are blurred. They sit over the static stage background, never over the pages. The tool rail, status capsule, tooltip, toast and popovers float over the pages, so they use an opaque frosted fill with no blur. (v1.0 blurred the rail and status capsule.)
- While the pages scroll or zoom, the side panels keep their translucent fill but drop the blur. It returns 160 ms after the pages stop moving, so the compositor never re-blurs during a gesture.
- Reduced transparency, or a browser without `backdrop-filter`, gets solid panels.

Frame times on the same box and the same day. A *run* is one pass of the 300-page flow. This box is noisy: two runs of the same build can differ by a whole frame at p95, so these are several runs, not one.

| | v1.0 Studio Pro (2 runs) | v1.1, glass off (5 runs) | v1.1, glass on (5 runs + final) |
|---|---|---|---|
| Fling through 300 pages, frame p95 | 16.8 / 33.4 ms | 16.7–16.8 ms | 16.7–16.8 ms |
| Fling, frames over 50 ms (sum) | 3 | 6 | 8 (+2 final) |
| Zoom on the 300-page doc, frame p95 | 33.3 / 50 ms | 16.8–33.3 ms | 16.8–33.3 ms |
| Zoom, frames over 50 ms (sum) | 9 | 10 | 7 (+2 final) |
| Thumbnail scroll, frame p95 | 16.8 ms | 16.8 ms | 16.7 ms |
| Plan sheet zoom / pan p95 | 16.8–33.3 / 16.8–33.4 ms | 33.3 / 33.4 ms (2 runs) | 16.8 / 16.7 ms (final) |
| Peak memory, whole flow | 2,620 / 2,648 MB | 2,726 / 2,781 MB (2 full runs) | 2,417–2,934 MB (5 full runs) |

Before adding the pause, glass-on fling scrolls had worst frames of 100–133 ms vs 33–100 ms with glass off. With the pause they match. Peak memory isn't affected by the glass: the glass-off runs peaked no lower. The spread comes from when garbage collection runs during reduce.

Final v1.1 run, full numbers: [perf-run.txt](perf-run.txt). The v1.0 tables below are kept for history.

## 300-page flow

| Step | Before (v0.9 UI, main-thread rendering) | Now (v1.0 Studio Pro) |
|---|---|---|
| Open report 1 (42 MB), time to first page | 623 ms | 825 ms |
| Open reports 2 and 3 | 1,116 ms | 1,335 ms |
| Combine into one 300-page document | 290 ms | 214–1,159 ms (varies run to run) |
| Fling through all 300 pages (36,000 px/s) | 9.9 s, pages mostly blank while moving | 8.7 s, frames p95 16.8 ms, 0 frames over 50 ms |
| Reading-speed scroll, visible page still blank | not measured | 4.6 % of frames |
| Zoom (ctrl+wheel) on the 300-page doc | – | p50 16.7 ms, p95 33.4 ms |
| Thumbnail panel, scroll all 300 | p95 133 ms, 30 frames over 50 ms, longest task 204 ms | p95 16.7 ms, 0 frames over 50 ms, no long tasks |
| Rotate / delete 10 / move 5 / undo | 357 / 144 / 293 / 160 ms | 125 / 95 / 91 / 109 ms |
| Save editable (290 pages, 120.5 MB) | 1,235 ms | 1,791 ms (now in a worker, UI stays live) |
| Save flattened | 1,281 ms | 2,122 ms (worker) |
| Lossless reduce (qpdf) | 5.6 s | 5.6 s |
| Reload, restore session from IndexedDB | 1,065 ms | 1,484 ms |
| **Peak memory, whole flow** | **3,275 MB** | **2,577 MB** (during reduce) |

Peak memory by phase (now): open 976 MB · combine 1,057 MB · scroll and thumbnails 1,706 MB · organise 1,627 MB · save editable 1,924 MB · save flattened 2,162 MB · reduce 2,577 MB · reload 1,579 MB.

## Large plan sheet (36×24 in vector)

| | Before | Now |
|---|---|---|
| Time to first page | 335 ms | 512 ms |
| Zoom 80 steps, frames p50 / p95 / max | 16.7 / 16.8 / 33.4 ms | 16.7 / 16.8 / 33.3 ms |
| Pan at 400 %, p95 | 16.7 ms | 16.8 ms |
| Drawing (300-point pen stroke and a 40-point area), p95 | 16.8 ms | 16.7 ms |
| Key press to next frame | 14.6 ms | 14.0 ms |
| Pointer Event Timing duration, p50 / max | 40 / 56 ms | 32 / 40 ms |

## What changed

- **Rendering is off the main thread.** A dedicated worker runs its own pdf.js and draws into an OffscreenCanvas, and only finished bitmaps come back. A priority queue renders visible pages first, then tiles, then thumbnails, then prefetch. Jobs for pages scrolled past are cancelled.
- **Bounded caches.** At most 10 rendered pages and 60 high-zoom tiles (1024 px) are kept. pdf.js page caches are cleaned for all but the 4 most recent pages, and document caches are cleaned when the queue goes idle.
- **The biggest single fix:** pdf.js's WebCodecs JPEG decoder kept decoded frames in native memory. Turning it off (`isImageDecoderSupported: false`) cut memory after a full scroll from about 3.5 GB to 1.3 GB, and frames got smoother too.
- **Thumbnails are virtualised.** Every page gets a placeholder, but only those near the visible part of the panel render, and only after the panel settles for 120 ms. At most 90 bitmaps are kept.
- **Saving runs in a short-lived worker.** pdf-lib parses every source into objects (several hundred MB for this set). Terminating the worker returns that memory at once, and the UI keeps running.
- **Reduce moves the file to the qpdf worker instead of copying it.** The worker is retired after each run, because wasm memory never shrinks.
- **UI motion** animates only transform and opacity, all under 150 ms, and none of it runs with reduced motion on (both checked in tests/ui.spec.ts). Blur is used only on the small floating tool rail, status capsule and tooltips; the side panels are solid and never overlap the scrolling sheet.

## Limits and caveats

- These numbers are from headless Chromium with a software GPU. A real Mac or PC with a GPU should be at least as smooth. Safari and Firefox were not measured.
- Event Timing durations (pointer events) include time to the next presented frame. Headless Chromium reports them in 8 ms steps, and they sit near two frames. Key to frame, measured directly, is 14 ms.
- Peak memory during reduce on a 120 MB file is about 2.6 GB for the whole browser, comfortably within a 16 GB machine. Memory scales with total file size more than page count: plan on roughly 15–20× the combined file size at the peak of a reduce.
- The combined document references its source files rather than copying them, so combining is fast. Saving writes one new PDF.
- `docs/perf-run.txt` holds the raw output of the run summarised above.
