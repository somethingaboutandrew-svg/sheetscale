// Original demo drawing set for the v2 App Store screenshots: a fictional single-storey medical
// office building drawn from scratch (ARCH D 36x24 in, 1/4" = 1'-0"). Three sheets: A-101 floor plan,
// M-101 HVAC plan, E-101 lighting plan. The plan content sits on PDF layers (OCGs) like a CAD export.
import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const W = 2592, H = 1728; // 36 x 24 in
const F = 18; // 1/4" = 1'-0": 18 pt per foot
const OX = 240, OY = 330; // building origin (outer face, SW corner)
const BW = 88, BH = 60; // building outside dimensions in feet
const X = (ft) => OX + ft * F, Y = (ft) => OY + ft * F;
const n = (v) => (Math.round(v * 100) / 100).toString();
const K = 0.5523;

const d = await PDFDocument.create();
d.setTitle('Harbor Point Medical Office - Construction Documents (demo)');
d.setAuthor('SheetScale demo');
const fR = await d.embedFont(StandardFonts.Helvetica);
const fB = await d.embedFont(StandardFonts.HelveticaBold);
const ctx = d.context;

function sheet() {
  let ops = '';
  const o = (s) => { ops += s + '\n'; };
  const api = {
    o,
    get ops() { return ops; },
    rg: (r, g = r, b = r) => o(`${n(r)} ${n(g)} ${n(b)} rg`),
    RG: (r, g = r, b = r) => o(`${n(r)} ${n(g)} ${n(b)} RG`),
    w: (v) => o(`${n(v)} w`),
    dash: (a = [], p = 0) => o(`[${a.join(' ')}] ${p} d`),
    line: (x1, y1, x2, y2) => o(`${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`),
    rect: (x, y, w, h, op = 'S') => o(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re ${op}`),
    circle(cx, cy, r, op = 'S') {
      const k = r * K;
      o(`${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c ${op}`);
    },
    ellipse(cx, cy, rx, ry, op = 'S') {
      const kx = rx * K, ky = ry * K;
      o(`${n(cx + rx)} ${n(cy)} m ${n(cx + rx)} ${n(cy + ky)} ${n(cx + kx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c ${n(cx - kx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ky)} ${n(cx - rx)} ${n(cy)} c ${n(cx - rx)} ${n(cy - ky)} ${n(cx - kx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c ${n(cx + kx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ky)} ${n(cx + rx)} ${n(cy)} c ${op}`);
    },
    poly(pts, op = 's') { o(pts.map((p, i) => `${n(p[0])} ${n(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' ' + op); },
    text(s, x, y, size = 8, bold = false, align = 'left', color = null) {
      const font = bold ? fB : fR;
      const w = font.widthOfTextAtSize(s, size);
      const dx = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
      if (color) api.rg(...color);
      o(`BT /${bold ? 'FB' : 'FR'} ${n(size)} Tf ${n(x + dx)} ${n(y)} Td ${font.encodeText(s).toString()} Tj ET`);
      if (color) api.rg(0);
    },
    tw: (s, size, bold = false) => (bold ? fB : fR).widthOfTextAtSize(s, size),
    layer: (tag, fn) => { o(`/OC /${tag} BDC`); fn(); o('EMC'); },
  };
  return api;
}

// ── plan geometry (feet) ──
// walls: [x1, y1, x2, y2] centre-line segments with thickness and openings along their length
const EXT = 1, INT = 0.5;
const walls = [
  // exterior (centre line 0.5 ft in from the outer face)
  { a: [0, 0.5], b: [88, 0.5], t: EXT, open: [[1.5, 6.5, 'win'], [8, 14, 'door2'], [24, 32, 'win'], [38, 46, 'win'], [50, 58, 'win']] },
  { a: [0, 59.5], b: [88, 59.5], t: EXT, open: [[3, 9, 'win'], [15, 21, 'win'], [27, 33, 'win'], [39, 45, 'win'], [52, 66, 'win'], [74, 84, 'win']] },
  { a: [0.5, 1], b: [0.5, 59], t: EXT, open: [[6, 20, 'win'], [27.5, 30.5, 'door'], [40, 52, 'win']] },
  { a: [87.5, 1], b: [87.5, 59], t: EXT, open: [[5, 9, 'door'], [27.5, 30.5, 'door'], [40, 52, 'win']] },
  // corridor
  { a: [1, 32], b: [87, 32], t: INT, open: [[8, 11], [20, 23], [32, 35], [44, 47], [64, 67], [73, 76]] },
  { a: [1, 26], b: [87, 26], t: INT, open: [[3, 20], [30, 33], [38, 44], [67.5, 70.5], [72.5, 75.5], [80, 83]] },
  // north rooms
  ...[12, 24, 36, 48, 70].map((x) => ({ a: [x, 32], b: [x, 59], t: INT, open: [] })),
  // south rooms
  { a: [22, 1], b: [22, 26], t: INT, open: [] },
  { a: [34, 1], b: [34, 26], t: INT, open: [] },
  { a: [66, 1], b: [66, 26], t: INT, open: [[4, 7]] },
  { a: [71, 14], b: [71, 26], t: INT, open: [] },
  { a: [66, 14], b: [76, 14], t: INT, open: [] },
  { a: [76, 1], b: [76, 26], t: INT, open: [] },
];
// door swings: hinge (ft), along-wall unit, into-room unit, width
const doors = [
  // offices + conference + break (swing into the room, north)
  ...[[8, 101], [20, 102], [32, 103], [44, 104], [64, 105], [73, 106]].map(([x, tag]) => ({ h: [x, 32.25], u: [1, 0], v: [0, 1], w: 3, tag })),
  { h: [33, 25.75], u: [-1, 0], v: [0, -1], w: 3, tag: 111 },
  { h: [67.5, 25.75], u: [1, 0], v: [0, -1], w: 3, tag: 113 },
  { h: [75.5, 25.75], u: [-1, 0], v: [0, -1], w: 3, tag: 114 },
  { h: [83, 25.75], u: [-1, 0], v: [0, -1], w: 3, tag: 115 },
  { h: [65.75, 7], u: [0, -1], v: [-1, 0], w: 3, tag: 116 },
  { h: [0, 30.5], u: [0, -1], v: [-1, 0], w: 3, tag: 'E1' },
  { h: [88, 27.5], u: [0, 1], v: [1, 0], w: 3, tag: 'E2' },
  { h: [88, 9], u: [0, -1], v: [1, 0], w: 4, tag: 'E3' },
  { h: [8, 0], u: [1, 0], v: [0, -1], w: 3, tag: 'E4' },
  { h: [14, 0], u: [-1, 0], v: [0, -1], w: 3, tag: null },
];
const rooms = [
  ['OFFICE', 101, 6, 39.5, 324], ['OFFICE', 102, 18, 39.5, 324], ['OFFICE', 103, 30, 39.5, 324], ['OFFICE', 104, 42, 39.5, 324],
  ['CONFERENCE', 105, 59, 53.4, 594], ['BREAK ROOM', 106, 77, 35.8, 459], ['CORRIDOR', 107, 54, 29, 516],
  ['LOBBY', 110, 11, 21.5, 525], ['RECEPTION', 111, 28, 18, 300], ['OPEN OFFICE', 112, 50, 22.3, 800],
  ['TOILET', 113, 68.5, 21, 60], ['TOILET', 114, 73.5, 21, 60], ['STORAGE', 116, 71, 3.5, 130], ['MECH / ELEC', 115, 81, 11, 300],
];
const GX = [0.5, 22, 44, 66, 87.5], GY = [0.5, 20, 40, 59.5];
const GXL = ['A', 'B', 'C', 'D', 'E'], GYL = ['1', '2', '3', '4'];

function wallRects(wl) {
  const out = [];
  const horiz = wl.a[1] === wl.b[1];
  const lo = horiz ? wl.a[0] : wl.a[1], hi = horiz ? wl.b[0] : wl.b[1], c = horiz ? wl.a[1] : wl.a[0];
  let s = lo;
  for (const [a, b] of [...wl.open].sort((p, q) => p[0] - q[0])) { if (a > s) out.push([s, a]); s = b; }
  if (hi > s) out.push([s, hi]);
  return out.map(([p, q]) => horiz ? [X(p), Y(c - wl.t / 2), (q - p) * F, wl.t * F] : [X(c - wl.t / 2), Y(p), wl.t * F, (q - p) * F]);
}
function ftIn(ft) {
  const tot = Math.round(ft * 12), f = Math.floor(tot / 12), i = tot - f * 12;
  return `${f}'-${i}"`;
}

function drawArch(S, mode) {
  const grey = mode !== 'A';
  const ink = grey ? 0.62 : 0;
  // grid lines + bubbles
  S.layer('grid', () => {
    S.RG(grey ? 0.7 : 0.35); S.w(0.5); S.dash([18, 4, 3, 4]);
    GX.forEach((g) => S.line(X(g), 228, X(g), 1508));
    GY.forEach((g) => S.line(140, Y(g), 1860, Y(g)));
    S.dash(); S.w(0.9); S.RG(grey ? 0.55 : 0);
    GX.forEach((g, i) => { for (const cy of [206, 1530]) { S.rg(1); S.circle(X(g), cy, 20, 'B'); S.rg(0); S.text(GXL[i], X(g), cy - 5.5, 15, true, 'center', grey ? [0.5, 0.5, 0.5] : null); } });
    GY.forEach((g, i) => { S.rg(1); S.circle(118, Y(g), 20, 'B'); S.rg(0); S.text(GYL[i], 118, Y(g) - 5.5, 15, true, 'center', grey ? [0.5, 0.5, 0.5] : null); });
  });
  // walls
  S.layer('wall', () => {
    const ext = walls.filter((w) => w.t === EXT).flatMap(wallRects), int = walls.filter((w) => w.t === INT).flatMap(wallRects);
    for (const [set, lw, fill] of [[ext, 1.7, grey ? 0.86 : 0.78], [int, 1.1, grey ? 0.88 : 0.8]]) {
      S.RG(ink); S.w(lw * 2);
      set.forEach((r) => S.rect(...r));
      S.rg(fill); S.o(set.map((r) => `${r.map(n).join(' ')} re`).join(' ') + ' f');
      if (set === ext) {
        // 45-degree hatch inside the exterior walls
        S.o('q ' + set.map((r) => `${r.map(n).join(' ')} re`).join(' ') + ' W n');
        S.RG(grey ? 0.6 : 0.25); S.w(0.35);
        for (let k = -1800; k < 2000; k += 5) S.line(OX - 20 + k, OY - 20, OX - 20 + k + 1200, OY - 20 + 1200);
        for (let k = -1800; k < 2000; k += 5) S.line(OX - 20 + k, OY + 600, OX - 20 + k + 1200, OY + 1800);
        S.o('Q');
      }
      S.rg(0);
    }
    // windows in exterior openings: jambs + 3 glass lines
    S.RG(ink); S.w(0.6);
    for (const wl of walls.filter((w) => w.t === EXT)) {
      const horiz = wl.a[1] === wl.b[1], c = horiz ? wl.a[1] : wl.a[0];
      for (const [a, b, kind] of wl.open) {
        if (kind !== 'win') continue;
        for (const off of [-0.5, -0.08, 0.08, 0.5]) horiz ? S.line(X(a), Y(c + off), X(b), Y(c + off)) : S.line(X(c + off), Y(a), X(c + off), Y(b));
      }
    }
    // columns at grid intersections
    S.rg(grey ? 0.55 : 0);
    GX.forEach((gx) => GY.forEach((gy) => S.rect(X(gx) - 7, Y(gy) - 7, 14, 14, 'f')));
    S.rg(0);
  });
  // doors
  S.layer('door', () => {
    S.RG(ink);
    for (const dr of doors) {
      const [hx, hy] = [X(dr.h[0]), Y(dr.h[1])], w = dr.w * F;
      const tip = [hx + dr.v[0] * w, hy + dr.v[1] * w], jamb = [hx + dr.u[0] * w, hy + dr.u[1] * w];
      S.w(1.6); S.line(hx, hy, tip[0], tip[1]);
      S.w(0.45);
      S.o(`${n(tip[0])} ${n(tip[1])} m ${n(tip[0] + dr.u[0] * w * K)} ${n(tip[1] + dr.u[1] * w * K)} ${n(jamb[0] + dr.v[0] * w * K)} ${n(jamb[1] + dr.v[1] * w * K)} ${n(jamb[0])} ${n(jamb[1])} c S`);
      if (dr.tag && !grey) {
        const tx = hx + dr.u[0] * w * 0.5 - dr.v[0] * 30, ty = hy + dr.u[1] * w * 0.5 - dr.v[1] * 30;
        S.w(0.5); S.rg(1); S.circle(tx, ty, 9, 'B'); S.rg(0);
        S.text(String(dr.tag), tx, ty - 2.4, 6.5, false, 'center');
      }
    }
  });
  if (mode === 'A') drawFurniture(S);
  // room tags
  S.layer('anno', () => {
    for (const [name, num, cx, cy, sf] of rooms) {
      const x = X(cx), y = Y(cy);
      S.text(name, x, y + 6, 9, true, 'center', grey ? [0.45, 0.45, 0.45] : null);
      const bw = S.tw(String(num), 8.5) + 12;
      S.RG(grey ? 0.5 : 0); S.w(0.6); S.rg(1); S.rect(x - bw / 2, y - 13, bw, 14, 'B'); S.rg(0);
      S.text(String(num), x, y - 9.5, 8.5, false, 'center', grey ? [0.45, 0.45, 0.45] : null);
      if (mode === 'A') S.text(`${sf} SF`, x, y - 25, 6.5, false, 'center', [0.3, 0.3, 0.3]);
    }
  });
  if (mode !== 'A') return;
  // dimensions
  S.layer('dims', () => {
    S.RG(0.15); S.w(0.45);
    const tick = (x, y) => { S.w(1.3); S.line(x - 4, y - 4, x + 4, y + 4); S.w(0.45); };
    const dimH = (xs, y, from) => {
      S.line(X(xs[0]) - 8, y, X(xs[xs.length - 1]) + 8, y);
      xs.forEach((x) => { S.line(X(x), from, X(x), y + (y > from ? 6 : -6)); tick(X(x), y); });
      for (let i = 1; i < xs.length; i++) S.text(ftIn(xs[i] - xs[i - 1]), (X(xs[i]) + X(xs[i - 1])) / 2, y + 3.5, 7.5, false, 'center', [0.1, 0.1, 0.1]);
    };
    const dimV = (ys, x, from) => {
      S.line(x, Y(ys[0]) - 8, x, Y(ys[ys.length - 1]) + 8);
      ys.forEach((y) => { S.line(from, Y(y), x - 6, Y(y)); tick(x, Y(y)); });
      for (let i = 1; i < ys.length; i++) {
        const cy = (Y(ys[i]) + Y(ys[i - 1])) / 2, s = ftIn(ys[i] - ys[i - 1]);
        S.o(`BT /FR 7.5 Tf 0 1 -1 0 ${n(x - 3.5)} ${n(cy - S.tw(s, 7.5) / 2)} Tm ${fR.encodeText(s).toString()} Tj ET`);
      }
    };
    dimH(GX, 1452, 1420); dimH([0, 88], 1478, 1420);
    dimH([0, 1.5, 6.5, 8, 14, 24, 32, 38, 46, 50, 58, 88], 290, 318);
    dimH([0, 88], 264, 318);
    dimV(GY, 198, 230); dimV([0, 60], 172, 230);
  });
  // drawing title, north arrow, detail callout, section marker
  S.layer('anno', () => {
    S.RG(0); S.w(0.9); S.rg(1); S.circle(262, 122, 22, 'B'); S.rg(0); S.line(240, 122, 284, 122);
    S.text('1', 262, 127, 12, true, 'center'); S.text('A-101', 262, 108, 7, false, 'center');
    S.text('FLOOR PLAN - LEVEL 1', 300, 124, 16, true); S.w(1.6); S.line(300, 116, 760, 116); S.w(0.5); S.line(300, 112, 760, 112);
    S.text('SCALE: 1/4" = 1\'-0"', 300, 98, 8.5);
    // graphic scale 0-4-8-16 ft
    const gx = 520;
    [[0, 4, 1], [4, 8, 0], [8, 16, 1]].forEach(([a, b, f]) => { S.w(0.6); S.rect(gx + a * F, 94, (b - a) * F, 6, f ? 'B' : 'S'); });
    [0, 4, 8, 16].forEach((v) => S.text(String(v), gx + v * F, 84, 6.5, false, 'center'));
    S.text('FEET', gx + 16 * F + 12, 84, 6.5);
    // north arrow
    const nx = 1760, ny = 130;
    S.w(0.8); S.circle(nx, ny, 30); S.poly([[nx, ny + 38], [nx - 11, ny - 16], [nx, ny - 6], [nx + 11, ny - 16]], 'b');
    S.rg(1); S.poly([[nx, ny + 38], [nx, ny - 6], [nx + 11, ny - 16]], 'f'); S.rg(0); S.poly([[nx, ny + 38], [nx - 11, ny - 16], [nx, ny - 6], [nx + 11, ny - 16]], 's');
    S.text('N', nx, ny + 44, 12, true, 'center'); S.text('PLAN NORTH', nx, ny - 46, 6, false, 'center');
    // detail callout around the toilet rooms
    S.RG(0); S.w(0.9); S.dash([10, 4]);
    const [cx, cy] = [X(71), Y(20)];
    S.o(`${n(cx - 118)} ${n(cy - 96)} m ${n(cx + 118)} ${n(cy - 96)} l ${n(cx + 118)} ${n(cy + 120)} l ${n(cx - 118)} ${n(cy + 120)} l h S`);
    S.dash(); S.w(0.6); S.line(cx - 118, cy - 96, X(60), Y(9.5));
    S.rg(1); S.circle(X(60) - 12, Y(9.5) - 10, 17, 'B'); S.rg(0); S.line(X(60) - 29, Y(9.5) - 10, X(60) + 5, Y(9.5) - 10);
    S.text('3', X(60) - 12, Y(9.5) - 6, 10, true, 'center'); S.text('A-501', X(60) - 12, Y(9.5) - 21, 6, false, 'center');
    S.text('ENLARGED TOILET', X(60) + 10, Y(9.5) - 26, 6, true); S.text('ROOM PLAN', X(60) + 10, Y(9.5) - 34, 6, true);
    // building section marker on the west side
    const sx = X(-5.5), sy = Y(36);
    S.w(2.2); S.line(sx + 16, sy, X(-0.3), sy); S.w(0.9);
    S.rg(1); S.circle(sx, sy, 15, 'B'); S.rg(0); S.poly([[sx - 15, sy], [sx, sy + 23], [sx + 15, sy]], 'f');
    S.rg(1); S.circle(sx, sy, 13, 'f'); S.rg(0); S.line(sx - 13, sy, sx + 13, sy);
    S.text('A', sx, sy + 3, 8, true, 'center'); S.text('A-301', sx, sy - 9, 5, false, 'center');
    // keynote tags
    for (const [k, fx, fy] of [[4, 11, 1.8], [7, 62, 31.2], [9, 86, 13]]) {
      const x = X(fx), y = Y(fy);
      S.w(0.6); S.rg(1); S.poly([[x - 8, y], [x - 4, y + 7], [x + 4, y + 7], [x + 8, y], [x + 4, y - 7], [x - 4, y - 7]], 'b'); S.rg(0);
      S.text(String(k), x, y - 2.5, 7, true, 'center');
    }
  });
}

function drawFurniture(S) {
  S.layer('furn', () => {
    S.RG(0.42); S.w(0.45);
    // offices: desk, task chair, two guest chairs, shelving
    for (const x0 of [0, 12, 24, 36]) {
      const x = X(x0 + 1.5), y = Y(54);
      S.rect(x, y, 6.5 * F, 2.5 * F); S.rect(x + 7 * F, Y(52.5), 2.5 * F, 6 * F);
      S.circle(X(x0 + 4.7), Y(56.8 + 1.6), 0.9 * F); S.rect(X(x0 + 2.4), Y(50.6), 1.8 * F, 1.8 * F); S.rect(X(x0 + 5.4), Y(50.6), 1.8 * F, 1.8 * F);
      S.dash([3, 2]); S.rect(X(x0 + 1.2), Y(33.5), 9.6 * F, 1.4 * F); S.dash();
    }
    // conference table + chairs + credenza + screen
    const tx = X(52.5), ty = Y(43), tw = 13 * F, th = 5 * F;
    S.o(`${n(tx + 30)} ${n(ty)} m ${n(tx + tw - 30)} ${n(ty)} l ${n(tx + tw)} ${n(ty)} ${n(tx + tw)} ${n(ty + th)} ${n(tx + tw - 30)} ${n(ty + th)} c ${n(tx + 30)} ${n(ty + th)} l ${n(tx)} ${n(ty + th)} ${n(tx)} ${n(ty)} ${n(tx + 30)} ${n(ty)} c S`);
    for (let i = 0; i < 5; i++) { S.circle(X(54.4 + i * 2.3), Y(41.9), 0.85 * F); S.circle(X(54.4 + i * 2.3), Y(49.1), 0.85 * F); }
    S.circle(X(51.2), Y(45.5), 0.85 * F); S.circle(X(66.8), Y(45.5), 0.85 * F);
    S.rect(X(52), Y(56.9), 14 * F, 1.6 * F); S.w(1.4); S.line(X(49.5), Y(38), X(49.5), Y(53)); S.w(0.45);
    S.text('DISPLAY', X(49.7), Y(36.6), 5.5, false, 'left', [0.4, 0.4, 0.4]);
    // break room: L counter with sink, fridge, two tables
    S.rect(X(71), Y(56.5), 15.5 * F, 2 * F); S.rect(X(84.5), Y(42), 2 * F, 14.5 * F);
    S.rect(X(76), Y(56.8), 3.4 * F, 1.4 * F); S.rect(X(76.2), Y(56.95), 1.5 * F, 1.1 * F); S.rect(X(77.7), Y(56.95), 1.5 * F, 1.1 * F);
    S.rect(X(71.2), Y(52.2), 2.8 * F, 3 * F); S.text('REF', X(72.6), Y(53.4), 5.5, false, 'center', [0.4, 0.4, 0.4]);
    for (const [cx, cy] of [[75.5, 50.5], [79, 43]]) {
      S.circle(X(cx), Y(cy), 1.8 * F);
      for (const [dx, dy] of [[0, 2.9], [0, -2.9], [2.9, 0], [-2.9, 0]]) S.circle(X(cx + dx), Y(cy + dy), 0.75 * F);
    }
    // lobby: sofa, chairs, coffee table, planter
    S.rect(X(2.2), Y(9), 2.8 * F, 9 * F); S.rect(X(2.2), Y(9), 0.8 * F, 9 * F);
    S.rect(X(7.2), Y(11.5), 3.5 * F, 4 * F);
    for (const cy of [8.5, 16]) S.rect(X(12.5), Y(cy), 2.8 * F, 2.8 * F);
    S.circle(X(19), Y(3.6), 1.4 * F); S.circle(X(19), Y(3.6), 0.6 * F);
    // reception desk (L) + chair + files
    S.rect(X(23.2), Y(19), 9 * F, 2.3 * F); S.rect(X(23.2), Y(11), 2.3 * F, 8 * F);
    S.circle(X(28), Y(16.8), 0.9 * F); S.rect(X(29.5), Y(2), 3.8 * F, 2 * F); S.rect(X(23.5), Y(2), 3.8 * F, 2 * F);
    // open office workstations: 2 rows of 5 benching desks with chairs
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) {
      const x = X(36.5 + c * 5.6), y = Y(r ? 12.5 : 3.3);
      S.rect(x, y, 5 * F, 2.5 * F); S.rect(x, y + 2.5 * F, 5 * F, 2.5 * F);
      S.circle(x + 2.5 * F, y - 0.9 * F, 0.85 * F); S.circle(x + 2.5 * F, y + 5.9 * F, 0.85 * F);
    }
    // toilet rooms: WC, lav, grab bars, 1 ft floor tile
    S.o('q'); S.RG(0.72); S.w(0.25);
    for (let x = 66.25; x <= 75.75; x += 1) S.line(X(x), Y(14.25), X(x), Y(25.75));
    for (let y = 14.25; y <= 25.75; y += 1) S.line(X(66.25), Y(y), X(75.75), Y(y));
    S.o('Q');
    for (const x0 of [66.25, 71.25]) {
      S.rg(1); S.rect(X(x0 + 0.3), Y(17.5), 2.2 * F, 0.8 * F, 'B'); S.ellipse(X(x0 + 1.4), Y(16.4), 0.75 * F, 1.1 * F, 'B');
      S.rect(X(x0 + 2.9), Y(21.6), 1.4 * F, 1.9 * F, 'B'); S.ellipse(X(x0 + 3.7), Y(22.55), 0.4 * F, 0.65 * F, 'S'); S.rg(0);
      S.w(1); S.line(X(x0 + 0.15), Y(15), X(x0 + 0.15), Y(19.5)); S.w(0.45);
    }
    // mechanical / electrical
    S.rect(X(78), Y(15.5), 7.5 * F, 6 * F); S.line(X(78), Y(15.5), X(85.5), Y(21.5)); S.line(X(78), Y(21.5), X(85.5), Y(15.5));
    S.rg(1); S.rect(X(80.4), Y(18), 2.7 * F, 1 * F, 'f'); S.rg(0); S.text('AHU-1', X(81.75), Y(18.25), 6, true, 'center', [0.25, 0.25, 0.25]);
    S.rect(X(77), Y(2), 3 * F, 1 * F); S.rect(X(80.6), Y(2), 2.2 * F, 1 * F); S.circle(X(85), Y(3.5), 1.4 * F);
    S.text('MDP', X(78.5), Y(3.4), 5.5, false, 'center', [0.4, 0.4, 0.4]); S.text('LP-1', X(81.7), Y(3.4), 5.5, false, 'center', [0.4, 0.4, 0.4]); S.text('WH', X(85), Y(3.25), 5.5, false, 'center', [0.4, 0.4, 0.4]);
    // storage shelving
    S.dash([3, 2]); S.rect(X(66.6), Y(1.4), 9 * F, 1.5 * F); S.rect(X(66.6), Y(10.8), 9 * F, 1.5 * F); S.dash();
    S.rg(0);
  });
}

function drawMech(S) {
  S.layer('hvac', () => {
    const duct = (pts, wFt) => {
      // double-line rectangular duct along an orthogonal path
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]], horiz = a[1] === b[1], hw = (wFt * F) / 2;
        S.rg(0.94, 0.97, 1); S.RG(0.05, 0.25, 0.6); S.w(0.9);
        horiz ? S.rect(Math.min(X(a[0]), X(b[0])), Y(a[1]) - hw, Math.abs(X(b[0]) - X(a[0])), hw * 2, 'B') : S.rect(X(a[0]) - hw, Math.min(Y(a[1]), Y(b[1])), hw * 2, Math.abs(Y(b[1]) - Y(a[1])), 'B');
      }
      S.rg(0);
    };
    duct([[80, 23], [80, 29], [3, 29]], 1.6);
    const diff = (fx, fy) => { const x = X(fx), y = Y(fy), s = F; S.RG(0.05, 0.25, 0.6); S.w(0.7); S.rect(x - s, y - s, 2 * s, 2 * s); S.line(x - s, y - s, x + s, y + s); S.line(x - s, y + s, x + s, y - s); };
    const branch = (x, y1, y2) => { S.RG(0.05, 0.25, 0.6); S.w(0.8); S.line(X(x) - 5, Y(y1), X(x) - 5, Y(y2)); S.line(X(x) + 5, Y(y1), X(x) + 5, Y(y2)); };
    for (const x of [6, 18, 30, 42]) { branch(x, 29.8, 50); diff(x, 51); S.text('8"Ø', X(x) + 8, Y(37), 6.5, false, 'left', [0.05, 0.25, 0.6]); }
    for (const x of [54, 64]) { branch(x, 29.8, 41); diff(x, 42); diff(x, 50); branch(x, 43, 49); }
    for (const x of [74, 82]) { branch(x, 29.8, 43); diff(x, 44); }
    for (const x of [40, 50, 60]) for (const y of [8, 19]) { branch(x, 28.2, y + 1); diff(x, y); }
    for (const [x, y] of [[11, 14], [28, 9], [10, 29]]) diff(x, y);
    // return grilles
    S.RG(0.6, 0.1, 0.1); S.w(0.7);
    for (const [x, y] of [[9, 40], [21, 40], [33, 40], [45, 40], [59, 55], [79, 53], [16, 21], [55, 13], [30, 22]]) { S.rect(X(x) - F, Y(y) - F, 2 * F, 2 * F); S.line(X(x) - F, Y(y) - F, X(x) + F, Y(y) + F); }
    // VAV boxes + thermostats + labels
    for (const [x, y, t] of [[14, 29, 'VAV-1'], [38, 29, 'VAV-2'], [60, 29, 'VAV-3']]) {
      S.rg(1); S.RG(0.05, 0.25, 0.6); S.w(1); S.rect(X(x) - 1.6 * F, Y(y) - 1.2 * F, 3.2 * F, 2.4 * F, 'B'); S.rg(0);
      S.text(t, X(x), Y(y) - 2.5, 6.5, true, 'center', [0.05, 0.25, 0.6]);
    }
    for (const [x, y] of [[11, 38], [23, 38], [35, 38], [47, 38], [68.5, 45], [24, 9]]) { S.RG(0.05, 0.25, 0.6); S.w(0.6); S.rg(1); S.circle(X(x), Y(y), 7, 'B'); S.rg(0); S.text('T', X(x), Y(y) - 3, 8, true, 'center', [0.05, 0.25, 0.6]); }
    S.text('24x14 SA', X(26), Y(29) - 3, 7, true, 'center', [0.05, 0.25, 0.6]);
    S.text('20x12 SA', X(48), Y(29) - 3, 7, true, 'center', [0.05, 0.25, 0.6]);
    S.text('16x10 SA', X(70), Y(29) - 3, 7, true, 'center', [0.05, 0.25, 0.6]);
  });
}

function drawElec(S) {
  S.layer('lite', () => {
    const trof = (fx, fy) => { S.RG(0.55, 0.3, 0); S.w(0.7); S.rg(1, 0.98, 0.92); S.rect(X(fx) - F, Y(fy) - 2 * F, 2 * F, 4 * F, 'B'); S.rg(0); S.line(X(fx) - F, Y(fy) - 2 * F, X(fx) + F, Y(fy) + 2 * F); };
    for (const x0 of [0, 12, 24, 36]) { trof(x0 + 4, 46); trof(x0 + 8, 46); }
    for (const x of [53, 59, 65]) for (const y of [42, 50]) trof(x, y);
    for (const x of [74, 80]) for (const y of [38, 48]) trof(x, y);
    for (const x of [39, 45, 51, 57, 63]) for (const y of [7, 18]) trof(x, y);
    for (const [x, y] of [[26, 8], [26, 18], [80, 12]]) trof(x, y);
    S.RG(0.55, 0.3, 0); S.w(0.7);
    for (let x = 4; x < 87; x += 8) { S.rg(1); S.circle(X(x), Y(29), 0.8 * F, 'B'); S.rg(0); S.circle(X(x), Y(29), 0.3 * F, 'f'); }
    for (const [x, y] of [[6, 15], [14, 8], [14, 19], [68.5, 21], [73.5, 21]]) { S.rg(1); S.circle(X(x), Y(y), 0.8 * F, 'B'); S.rg(0); S.circle(X(x), Y(y), 0.3 * F, 'f'); }
    // exit signs
    for (const [x, y] of [[2, 29], [86, 29], [11, 2.2], [86, 7]]) { S.rg(1); S.rect(X(x) - 0.9 * F, Y(y) - 0.5 * F, 1.8 * F, F, 'B'); S.rg(0); S.text('EXIT', X(x), Y(y) - 2, 5, true, 'center', [0.75, 0.1, 0.1]); }
    // switches
    for (const [x, y] of [[11.4, 34], [23.4, 34], [35.4, 34], [47.4, 34], [67.5, 34], [76.5, 34], [32.5, 24], [21, 24.5]]) S.text('$', X(x), Y(y), 9, true, 'center', [0.55, 0.3, 0]);
    // circuit homeruns
    S.dash([6, 3]); S.w(0.6);
    for (const [x, y] of [[8, 44], [57, 40], [43, 16]]) S.o(`${n(X(x))} ${n(Y(y))} m ${n(X(x) + 60)} ${n(Y(y) - 70)} ${n(X(81) - 20)} ${n(Y(6) + 60)} ${n(X(81.7))} ${n(Y(3.9))} c S`);
    S.dash();
    S.text('LP-1', X(81.7), Y(3.4), 6, true, 'center', [0.55, 0.3, 0]);
  });
}

function titleBlock(S, sheet) {
  const L = 2232, R = 2556, T = 1692, B = 36, cx = (L + R) / 2;
  S.RG(0); S.w(2.4); S.rect(36, 36, 2520, 1656); S.w(1.2); S.line(L, B, L, T);
  const hr = (y, w = 0.8) => { S.w(w); S.line(L, y, R, y); };
  const cap = (s, x, y) => S.text(s, x, y, 5.5, false, 'left', [0.4, 0.4, 0.4]);
  // firm
  S.rg(0.12, 0.29, 0.55); S.rect(L + 18, 1616, 46, 46, 'f'); S.rg(1); S.text('AF', L + 41, 1631, 18, true, 'center'); S.rg(0);
  S.text('ARCADIA FIELD', L + 74, 1646, 15, true); S.text('ARCHITECTURE + INTERIORS', L + 74, 1630, 7.5, false, 'left', [0.3, 0.3, 0.3]);
  S.text('Fictional firm for demonstration only', L + 74, 1619, 6, false, 'left', [0.5, 0.5, 0.5]);
  hr(1598);
  cap('CONSULTANTS', L + 14, 1584);
  [['STRUCTURAL', 'Keel & Span Engineers'], ['MEP', 'Brightwater Building Systems'], ['CIVIL', 'Tidewater Site Group'], ['LANDSCAPE', 'Fernway Studio']].forEach(([k, v], i) => {
    S.text(k, L + 14, 1566 - i * 22, 6.5, true); S.text(v, L + 92, 1566 - i * 22, 7);
  });
  hr(1470);
  cap('PROJECT', L + 14, 1456);
  S.text('HARBOR POINT', L + 14, 1432, 17, true); S.text('MEDICAL OFFICE', L + 14, 1412, 17, true);
  S.text('Tenant Improvement - Level 1', L + 14, 1394, 8);
  S.text('1200 Example Parkway, Suite 100', L + 14, 1380, 7, false, 'left', [0.35, 0.35, 0.35]);
  hr(1360);
  // seal + key plan
  S.w(0.6); S.dash([4, 3]); S.circle(L + 82, 1270, 62); S.dash();
  S.text('ARCHITECT SEAL', L + 82, 1272, 6, false, 'center', [0.5, 0.5, 0.5]); S.text('(DEMO - NOT FOR', L + 82, 1262, 5.5, false, 'center', [0.5, 0.5, 0.5]); S.text('CONSTRUCTION)', L + 82, 1253, 5.5, false, 'center', [0.5, 0.5, 0.5]);
  cap('KEY PLAN', L + 176, 1336);
  S.w(0.6); S.rect(L + 176, 1220, 130, 100); S.rg(0.75); S.rect(L + 176, 1220, 72, 52, 'f'); S.rg(0); S.rect(L + 176, 1220, 130, 100);
  S.text('SUITE 100', L + 212, 1243, 5.5, true, 'center');
  hr(1180);
  // revisions
  cap('REVISIONS', L + 14, 1166);
  S.text('NO.', L + 14, 1148, 6, true); S.text('DATE', L + 44, 1148, 6, true); S.text('DESCRIPTION', L + 104, 1148, 6, true);
  S.w(0.4); S.line(L + 10, 1143, R - 10, 1143);
  [['1', '09/18/26', 'PERMIT SET'], ['2', '10/14/26', 'PLAN REVIEW COMMENTS'], ['3', '11/04/26', 'OWNER REVISIONS']].forEach(([a, b, c], i) => {
    const y = 1128 - i * 17; S.w(0.6); S.poly([[L + 20, y + 8], [L + 14, y - 2], [L + 26, y - 2]], 's');
    S.text(a, L + 20, y - 0.5, 5.5, true, 'center'); S.text(b, L + 44, y, 6.5); S.text(c, L + 104, y, 6.5);
  });
  hr(1060);
  // project data
  const kv = [['PROJECT NO.', '2604'], ['DATE', '11/04/2026'], ['DRAWN BY', 'JRM'], ['CHECKED BY', 'AP'], ['PHASE', 'CONSTRUCTION DOCUMENTS'], ['SCALE', sheet.scale]];
  kv.forEach(([k, v], i) => { const y = 1040 - i * 26; cap(k, L + 14, y); S.text(v, L + 14, y - 12, 8.5, true); });
  hr(880);
  cap('SHEET TITLE', L + 14, 864);
  sheet.title.forEach((t, i) => S.text(t, L + 14, 836 - i * 22, 16, true));
  hr(300, 1.2);
  cap('SHEET NUMBER', L + 14, 284);
  S.text(sheet.no, cx, 170, 64, true, 'center');
  S.text(`${sheet.idx} OF 3`, cx, 120, 9, false, 'center', [0.3, 0.3, 0.3]);
  S.text('DEMO DRAWING - FICTIONAL PROJECT', cx, 56, 6, false, 'center', [0.5, 0.5, 0.5]);
}

function notes(S, kind) {
  const x0 = 1912, w = 300;
  let y = 1648;
  const head = (s) => { S.text(s, x0, y, 9, true); S.w(0.8); S.line(x0, y - 4, x0 + w, y - 4); y -= 20; };
  const para = (num, s) => {
    const words = s.split(' '); let line = ''; const lines = [];
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (S.tw(t, 6.5) > w - 16) { lines.push(line); line = wd; } else line = t; }
    lines.push(line);
    S.text(`${num}.`, x0, y, 6.5, true);
    lines.forEach((l) => { S.text(l, x0 + 14, y, 6.5); y -= 9.5; });
    y -= 4;
  };
  const sets = {
    A: [['GENERAL NOTES', [
      'DO NOT SCALE DRAWINGS. WRITTEN DIMENSIONS GOVERN. VERIFY ALL DIMENSIONS AND CONDITIONS IN THE FIELD BEFORE STARTING WORK.',
      'DIMENSIONS ARE TO FACE OF STUD AT PARTITIONS AND TO FACE OF MASONRY AT EXTERIOR WALLS UNLESS NOTED OTHERWISE.',
      'ALL INTERIOR PARTITIONS EXTEND TO 6" ABOVE FINISHED CEILING UNLESS NOTED AS FULL HEIGHT.',
      'PROVIDE FIRE-TREATED WOOD BLOCKING AT ALL WALL-MOUNTED CASEWORK, GRAB BARS, SHELVING AND EQUIPMENT.',
      'ALIGN NEW FINISHES FLUSH WITH ADJACENT SURFACES. PATCH AND REPAIR ALL DISTURBED WORK TO MATCH EXISTING.',
      'COORDINATE ALL FLOOR, WALL AND CEILING PENETRATIONS WITH MEP DRAWINGS PRIOR TO ROUGH-IN.',
      'TOILET ROOMS SHALL COMPLY WITH ICC A117.1 ACCESSIBILITY REQUIREMENTS. SEE ENLARGED PLANS 3/A-501.',
    ]], ['KEYNOTES', [
      'NEW ALUMINUM STOREFRONT ENTRY WITH PAIR OF 3\'-0" X 7\'-0" DOORS AND AUTOMATIC OPERATOR.',
      'RECESSED FIRE EXTINGUISHER CABINET. MOUNT HANDLE AT 48" A.F.F. MAX.',
      'NEW 3\'-0" X 7\'-0" HOLLOW METAL DOOR AND FRAME WITH 10" CLOSER, KEYED LOCKSET.',
    ]]],
    M: [['MECHANICAL NOTES', [
      'ALL DUCTWORK SHALL BE GALVANIZED STEEL CONSTRUCTED PER SMACNA STANDARDS. SEAL ALL JOINTS TO CLASS A.',
      'SUPPLY DIFFUSERS: 24x24 LAY-IN, 4-WAY THROW. BALANCE TO AIRFLOW SCHEDULED ON M-601.',
      'PROVIDE MANUAL VOLUME DAMPER AT EACH BRANCH TAKE-OFF. LOCATE WITHIN 10\'-0" OF MAIN.',
      'MOUNT THERMOSTATS AT 48" A.F.F. COORDINATE FINAL LOCATIONS WITH ARCHITECT.',
      'FLEXIBLE DUCT RUNS SHALL NOT EXCEED 6\'-0" IN LENGTH.',
    ]]],
    E: [['LIGHTING NOTES', [
      'ALL FIXTURES SHALL BE LED, 3500K, 80 CRI MINIMUM. SEE FIXTURE SCHEDULE ON E-601.',
      'PROVIDE OCCUPANCY SENSORS IN ALL ENCLOSED OFFICES, TOILET ROOMS AND STORAGE.',
      'EXIT SIGNS SHALL HAVE 90-MINUTE BATTERY BACKUP. CONNECT TO UNSWITCHED LEG OF LOCAL CIRCUIT.',
      'COORDINATE FIXTURE LOCATIONS WITH REFLECTED CEILING PLAN A-121 AND HVAC DIFFUSERS.',
    ]]],
  };
  for (const [t, items] of sets[kind]) { head(t); items.forEach((s, i) => para(i + 1, s)); y -= 12; }
  if (kind === 'A') {
    head('WALL LEGEND');
    S.RG(0); S.w(1.4); S.rect(x0, y - 8, 46, 14); S.o(`q ${x0} ${n(y - 8)} 46 14 re W n`); S.w(0.35);
    for (let k = -20; k < 60; k += 5) S.line(x0 + k, y - 8, x0 + k + 14, y + 6);
    S.o('Q'); S.text('EXTERIOR WALL - 8" CMU WITH', x0 + 56, y + 1, 6.5); S.text('BRICK VENEER AND RIGID INSULATION', x0 + 56, y - 8, 6.5); y -= 28;
    S.rg(0.8); S.w(1.1); S.rect(x0, y - 4, 46, 8, 'B'); S.rg(0);
    S.text('INTERIOR PARTITION - 3-5/8" METAL', x0 + 56, y + 1, 6.5); S.text('STUD, 5/8" GYP. BD. EACH SIDE', x0 + 56, y - 8, 6.5); y -= 28;
    S.rect(x0 + 16, y - 7, 14, 14, 'f'); S.text('STEEL COLUMN - SEE STRUCTURAL', x0 + 56, y - 2, 6.5);
    y -= 40;
    head('ROOM FINISH SCHEDULE');
    const cols = [0, 30, 100, 150, 190, 240], hd = ['NO.', 'ROOM', 'FLOOR', 'BASE', 'WALLS', 'CEILING'];
    hd.forEach((t, i) => S.text(t, x0 + cols[i], y, 6, true));
    S.w(0.4); S.line(x0, y - 4, x0 + w, y - 4); y -= 14;
    const fin = { OFFICE: ['CPT-1', 'RB-1', 'PT-1', 'ACT-1'], CONFERENCE: ['CPT-2', 'RB-1', 'PT-2', 'ACT-2'], 'BREAK ROOM': ['LVT-1', 'RB-1', 'PT-1', 'ACT-1'], CORRIDOR: ['LVT-2', 'RB-1', 'PT-1', 'ACT-1'], LOBBY: ['PT-3', 'WD-1', 'PT-3', 'GWB'], RECEPTION: ['LVT-2', 'RB-1', 'PT-1', 'ACT-1'], 'OPEN OFFICE': ['CPT-1', 'RB-1', 'PT-1', 'ACT-1'], TOILET: ['PT-4', 'PT-4', 'CT-1', 'GWB'], STORAGE: ['SC', 'RB-2', 'PT-1', 'EXP'], 'MECH / ELEC': ['SC', 'RB-2', 'PT-5', 'EXP'] };
    for (const [name, num] of [...rooms].sort((a, b) => a[1] - b[1])) {
      [String(num), name, ...fin[name]].forEach((t, i) => S.text(t, x0 + cols[i], y, 6));
      S.RG(0.8); S.w(0.3); S.line(x0, y - 4, x0 + w, y - 4); S.RG(0); y -= 12.5;
    }
  }
}

const SHEETS = [
  { no: 'A-101', idx: 1, title: ['FLOOR PLAN', 'LEVEL 1'], scale: '1/4" = 1\'-0"', mode: 'A' },
  { no: 'M-101', idx: 2, title: ['HVAC PLAN', 'LEVEL 1'], scale: '1/4" = 1\'-0"', mode: 'M' },
  { no: 'E-101', idx: 3, title: ['LIGHTING PLAN', 'LEVEL 1'], scale: '1/4" = 1\'-0"', mode: 'E' },
];
const ocg = (name) => ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
const OCGS = { grid: ocg('A-GRID'), wall: ocg('A-WALL'), door: ocg('A-DOOR'), furn: ocg('A-FURN'), dims: ocg('A-DIMS'), anno: ocg('A-ANNO'), hvac: ocg('M-HVAC'), lite: ocg('E-LITE') };
for (const sh of SHEETS) {
  const p = d.addPage([W, H]);
  const S = sheet();
  S.o('1 J 1 j');
  drawArch(S, sh.mode);
  if (sh.mode === 'M') drawMech(S);
  if (sh.mode === 'E') drawElec(S);
  notes(S, sh.mode);
  if (sh.mode !== 'A') {
    S.text(`1  ${sh.title[0]} - LEVEL 1`, 300, 124, 16, true); S.w(1.6); S.line(300, 116, 760, 116);
    S.text('SCALE: 1/4" = 1\'-0"', 300, 98, 8.5);
  }
  titleBlock(S, sh);
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(S.ops)));
  p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { FR: fR.ref, FB: fB.ref }, Properties: OCGS }));
}
const all = Object.values(OCGS);
d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: all, D: { Order: all, ON: all } }));
const out = new URL('../tests/fixtures/', import.meta.url).pathname;
writeFileSync(out + 'harbor-point-CD-set.pdf', await d.save());
// bloated copies for the lossless-reduce screenshot: uncompressed content, no object streams
{
  const src = await PDFDocument.load(await d.save());
  for (const pg of src.getPages()) {
    const c = pg.node.Contents();
    const raw = src.context.lookup(c);
    const { decodePDFRawStream } = await import('pdf-lib');
    const bytes = decodePDFRawStream(raw).decode();
    pg.node.set(PDFName.of('Contents'), src.context.register(src.context.stream(bytes)));
  }
  writeFileSync(out + 'cad-export-uncompressed.pdf', await src.save({ useObjectStreams: false }));
  const pm = await PDFDocument.create();
  const pf = await pm.embedFont(StandardFonts.TimesRoman), pfb = await pm.embedFont(StandardFonts.TimesRomanBold);
  const words = 'contractor shall provide submittals for review prior to fabrication and installation of all work including materials products and systems specified herein in accordance with the contract documents and applicable codes'.split(' ');
  for (let i = 0; i < 300; i++) {
    let ops = `BT /B 12 Tf 72 720 Td ${pfb.encodeText(`SECTION ${String(Math.floor(i / 12) + 1).padStart(2, '0')} ${String((i % 12) * 100 + 1000).padStart(4, '0')} - PART ${(i % 3) + 1}`).toString()} Tj ET\n`;
    for (let l = 0; l < 52; l++) {
      const t = Array.from({ length: 13 }, (_, k) => words[(i * 7 + l * 13 + k) % words.length]).join(' ');
      ops += `BT /R 10 Tf 72 ${690 - l * 12.4} Td ${pf.encodeText(`${l % 9 === 0 ? `${(l / 9) + 1}.${i % 10} ` : ''}${t}.`).toString()} Tj ET\n`;
    }
    const pg = pm.addPage([612, 792]);
    pg.node.set(PDFName.of('Contents'), pm.context.register(pm.context.stream(ops)));
    pg.node.set(PDFName.of('Resources'), pm.context.obj({ Font: { R: pf.ref, B: pfb.ref } }));
  }
  writeFileSync(out + 'project-manual-uncompressed.pdf', await pm.save({ useObjectStreams: false }));
}
console.log('CAD demo set written');
