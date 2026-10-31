// Single source of truth for how every markup looks. Produces drawing primitives in PDF
// user space that are rendered both to SVG (on screen) and to PDF content (export/flatten).
import type { Head, Markup, Pt, ScaleCal, Style } from './types';
import { centroid, measureOf, polyArea, polyLen } from './measure';
import { textWidth, wrap, sanitize } from './font';

export type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
export type Mat = [number, number, number, number, number, number];

export interface PathPrim {
  kind: 'path';
  d: Cmd[];
  stroke?: string;
  fill?: string;
  width: number;
  dash?: number[];
  cap: 0 | 1 | 2;
  join: 0 | 1 | 2;
  so: number; // stroke opacity
  fo: number; // fill opacity
  blend?: 'Multiply';
}
export interface TextPrim {
  kind: 'text';
  lines: { s: string; x: number; y: number }[];
  size: number;
  color: string;
  m: Mat; // frame (x right, y down, in pt) -> user space
  opacity: number;
}
export type Prim = PathPrim | TextPrim;

export const K = 0.5522847498;
const LINE_H = 1.2;
const PAD = 3;

export function bounds(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function rectPts(a: Pt, b: Pt): Pt[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function polyPath(pts: Pt[], closed: boolean): Cmd[] {
  const d: Cmd[] = pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]] as Cmd);
  if (closed) d.push(['Z']);
  return d;
}

export function ellipsePath(a: Pt, b: Pt): Cmd[] {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  const kx = rx * K, ky = ry * K;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}

export function circlePath(c: Pt, r: number): Cmd[] {
  return ellipsePath([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]);
}

export function ellipsePoly(a: Pt, b: Pt, n = 32): Pt[] {
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)] as Pt);
}

/** Revision-cloud outline: outward-bulging semicircular scallops along each edge. */
export function cloudPath(pts: Pt[], arc: number): Cmd[] {
  if (pts.length < 2) return [];
  const ccw = polyArea(pts) > 0;
  const d: Cmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const n = Math.max(1, Math.round(len / arc));
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    // outward normal: for CCW polygon (y up) it is (uy, -ux)
    const nx = ccw ? uy : -uy, ny = ccw ? -ux : ux;
    const seg = len / n, r = seg / 2;
    for (let j = 0; j < n; j++) {
      const sx = p[0] + ux * seg * j, sy = p[1] + uy * seg * j;
      const ex = sx + ux * seg, ey = sy + uy * seg;
      const tx = sx + ux * r + nx * r, ty = sy + uy * r + ny * r;
      d.push(['C', sx + nx * r * K, sy + ny * r * K, tx - ux * r * K, ty - uy * r * K, tx, ty]);
      d.push(['C', tx + ux * r * K, ty + uy * r * K, ex + nx * r * K, ey + ny * r * K, ex, ey]);
    }
  }
  d.push(['Z']);
  return d;
}

export function dashArray(s: Style): number[] | undefined {
  const w = Math.max(s.width, 0.25);
  if (s.dash === 'dashed') return [w * 3 + 3, w * 2 + 2];
  if (s.dash === 'dotted') return [0, w * 2 + 2];
  return undefined;
}

function headSize(s: Style) {
  return 6 + s.width * 3;
}

function headPrims(tip: Pt, from: Pt, head: Head, s: Style): Prim[] {
  if (head === 'none') return [];
  const L = headSize(s);
  const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
  const dx = (tip[0] - from[0]) / len, dy = (tip[1] - from[1]) / len;
  const rot = (a: number): Pt => {
    const c = Math.cos(a), sn = Math.sin(a);
    return [tip[0] - L * (dx * c - dy * sn), tip[1] - L * (dx * sn + dy * c)];
  };
  const base: PathPrim = { kind: 'path', d: [], stroke: s.stroke, width: s.width, cap: 0, join: 0, so: s.opacity, fo: s.opacity };
  switch (head) {
    case 'open': {
      const a = rot(0.45), b = rot(-0.45);
      return [{ ...base, d: [['M', a[0], a[1]], ['L', tip[0], tip[1]], ['L', b[0], b[1]]], join: 0 }];
    }
    case 'closed': {
      const a = rot(0.4), b = rot(-0.4);
      return [{ ...base, fill: s.stroke, d: [['M', a[0], a[1]], ['L', tip[0], tip[1]], ['L', b[0], b[1]], ['Z']] }];
    }
    case 'circle':
      return [{ ...base, fill: s.stroke, d: circlePath(tip, L / 3) }];
    case 'square': {
      const h = L / 3;
      return [{ ...base, fill: s.stroke, d: polyPath([[tip[0] - h, tip[1] - h], [tip[0] + h, tip[1] - h], [tip[0] + h, tip[1] + h], [tip[0] - h, tip[1] + h]], true) }];
    }
    case 'slash': {
      const h = L / 2, c = Math.cos(Math.PI / 4), sn = Math.sin(Math.PI / 4);
      const vx = dx * c - dy * sn, vy = dx * sn + dy * c;
      return [{ ...base, d: [['M', tip[0] - vx * h, tip[1] - vy * h], ['L', tip[0] + vx * h, tip[1] + vy * h]] }];
    }
  }
  return [];
}

/** Text frame for a page rotation: u = reading direction, v = "down" on screen, both in user space. */
export function frameDirs(rot: number) {
  const r = (((rot % 360) + 360) % 360) * (Math.PI / 180);
  const c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  const u: Pt = [c, s]; // rotate (1,0) CCW by rot
  const v: Pt = [s, -c]; // rotate (0,-1) CCW by rot
  return { u, v };
}

export function boxFrame(a: Pt, b: Pt, rot: number) {
  const { u, v } = frameDirs(rot);
  const corners = rectPts(a, b);
  let best = corners[0], bv = Infinity;
  for (const c of corners) {
    const sc = c[0] * u[0] + c[1] * u[1] + c[0] * v[0] + c[1] * v[1];
    if (sc < bv) { bv = sc; best = c; }
  }
  const W = Math.abs(b[0] - a[0]), H = Math.abs(b[1] - a[1]);
  const swap = Math.abs(u[0]) < 0.5;
  return { m: [u[0], u[1], v[0], v[1], best[0], best[1]] as Mat, w: swap ? H : W, h: swap ? W : H };
}

function textInBox(text: string, a: Pt, b: Pt, rot: number, s: Style): TextPrim {
  const f = boxFrame(a, b, rot);
  const lines = wrap(text, s.fontSize, Math.max(4, f.w - PAD * 2));
  return {
    kind: 'text', size: s.fontSize, color: s.textColor, m: f.m, opacity: s.opacity,
    lines: lines.map((ln, i) => ({ s: ln, x: PAD, y: PAD + s.fontSize * (0.8 + i * LINE_H) })),
  };
}

/** A centered label with a white backing box. Offset is in frame units (x right, y down). */
function label(text: string, at: Pt, rot: number, s: Style, offset: Pt = [0, 0]): Prim[] {
  const size = s.fontSize;
  const t = sanitize(text);
  const w = textWidth(t, size) + PAD * 2, h = size * LINE_H + PAD;
  const { u, v } = frameDirs(rot);
  const ox = at[0] + u[0] * (offset[0] - w / 2) + v[0] * (offset[1] - h / 2);
  const oy = at[1] + u[1] * (offset[0] - w / 2) + v[1] * (offset[1] - h / 2);
  const m: Mat = [u[0], u[1], v[0], v[1], ox, oy];
  const P = (fx: number, fy: number): Pt => [ox + u[0] * fx + v[0] * fy, oy + u[1] * fx + v[1] * fy];
  return [
    { kind: 'path', d: polyPath([P(0, 0), P(w, 0), P(w, h), P(0, h)], true), fill: '#ffffff', width: 0, cap: 0, join: 0, so: 0, fo: 0.85 },
    { kind: 'text', size, color: s.stroke, m, opacity: 1, lines: [{ s: t, x: PAD, y: PAD / 2 + size * 0.92 }] },
  ];
}

function strokeOf(s: Style, extra: Partial<PathPrim> = {}): PathPrim {
  return {
    kind: 'path', d: [], stroke: s.width > 0 ? s.stroke : undefined, width: s.width,
    dash: dashArray(s), cap: s.dash === 'dotted' ? 1 : 0, join: 1, so: s.opacity, fo: s.fillOpacity, ...extra,
  };
}

function shapeWithFill(d: Cmd[], s: Style): PathPrim {
  return { ...strokeOf(s), d, fill: s.fill ?? undefined };
}

export function cloudArc(s: Style) {
  return 10 + s.width * 3;
}

/** Outline points for closed shapes (used for cloud borders). */
function closedOutline(m: Markup): Pt[] | null {
  if (m.type === 'rect' || m.type === 'cloud') return rectPts(m.pts[0], m.pts[1]);
  if (m.type === 'ellipse') return ellipsePoly(m.pts[0], m.pts[1], 16);
  if (m.type === 'polygon' || m.type === 'm-area' || m.type === 'm-perimeter') return m.pts;
  return null;
}

export function calloutGeometry(m: Markup) {
  const [a, b, tip] = m.pts;
  const r = rectPts(a, b);
  const mids: Pt[] = [
    [(r[0][0] + r[1][0]) / 2, r[0][1]], [r[1][0], (r[1][1] + r[2][1]) / 2],
    [(r[2][0] + r[3][0]) / 2, r[2][1]], [r[0][0], (r[0][1] + r[3][1]) / 2],
  ];
  let knee = mids[0], bd = Infinity;
  for (const p of mids) {
    const d = Math.hypot(p[0] - tip[0], p[1] - tip[1]);
    if (d < bd) { bd = d; knee = p; }
  }
  return { rect: r, knee, tip };
}

export function markupPrims(m: Markup, scale: ScaleCal, rot: number): Prim[] {
  const s = m.style;
  const P = m.pts;
  const out: Prim[] = [];
  if (!P.length) return out;
  const cloudy = s.dash === 'cloud';
  switch (m.type) {
    case 'pen':
      out.push({ ...strokeOf(s), d: polyPath(P, false), cap: 1, join: 1 });
      break;
    case 'line':
    case 'arrow':
    case 'polyline':
    case 'm-length':
    case 'm-polylength': {
      out.push({ ...strokeOf(s), d: polyPath(P, false) });
      if (P.length >= 2) {
        out.push(...headPrims(P[0], P[1], s.startHead, s));
        out.push(...headPrims(P[P.length - 1], P[P.length - 2], s.endHead, s));
      }
      break;
    }
    case 'polygon':
    case 'm-area':
    case 'm-perimeter':
      if (P.length >= 3 && cloudy) out.push(shapeWithFill(cloudPath(P, cloudArc(s)), s));
      else out.push(shapeWithFill(polyPath(P, true), s));
      if (m.type === 'm-perimeter') out[out.length - 1] = { ...(out[out.length - 1] as PathPrim), fill: undefined };
      break;
    case 'rect':
    case 'cloud':
      if (P.length < 2) break;
      if (cloudy || m.type === 'cloud') out.push(shapeWithFill(cloudPath(closedOutline(m)!, cloudArc(s)), s));
      else out.push(shapeWithFill(polyPath(rectPts(P[0], P[1]), true), s));
      break;
    case 'ellipse':
      if (P.length < 2) break;
      if (cloudy) out.push(shapeWithFill(cloudPath(closedOutline(m)!, cloudArc(s)), s));
      else out.push(shapeWithFill(ellipsePath(P[0], P[1]), s));
      break;
    case 'highlight':
      if (P.length < 2) break;
      out.push({ kind: 'path', d: polyPath(rectPts(P[0], P[1]), true), fill: s.fill ?? s.stroke, width: 0, cap: 0, join: 0, so: 0, fo: s.fillOpacity, blend: 'Multiply' });
      break;
    case 'text':
      if (P.length < 2) break;
      if (s.fill || s.width > 0) out.push(shapeWithFill(polyPath(rectPts(P[0], P[1]), true), { ...s, dash: s.dash === 'cloud' ? 'solid' : s.dash }));
      out.push(textInBox(m.text ?? '', P[0], P[1], rot, s));
      break;
    case 'callout': {
      if (P.length < 3) break;
      const g = calloutGeometry(m);
      out.push({ ...strokeOf({ ...s, dash: 'solid' }), d: polyPath([g.knee, g.tip], false) });
      out.push(...headPrims(g.tip, g.knee, s.endHead, s));
      out.push(shapeWithFill(polyPath(g.rect, true), { ...s, dash: s.dash === 'cloud' ? 'solid' : s.dash }));
      out.push(textInBox(m.text ?? '', P[0], P[1], rot, s));
      break;
    }
    case 'm-count': {
      const r = 4 + s.width;
      P.forEach((p, i) => {
        out.push({ kind: 'path', d: circlePath(p, r), fill: s.fill ?? s.stroke, stroke: s.stroke, width: Math.max(0.5, s.width / 2), cap: 0, join: 0, so: s.opacity, fo: s.opacity });
        out.push(...label(String(i + 1), p, rot, { ...s, fontSize: Math.max(6, s.fontSize * 0.75) }, [r + 8, -r - 4]));
      });
      return out;
    }
  }
  // measurement label
  const mv = measureOf(m, scale);
  if (mv && P.length >= 2) {
    let at: Pt;
    let off: Pt = [0, 0];
    if (m.type === 'm-area' || m.type === 'm-perimeter') {
      at = P.length >= 3 ? centroid(P) : P[0];
    } else {
      // midpoint along the path, label nudged above the line on screen
      const total = polyLen(P);
      let acc = 0, i = 1;
      for (; i < P.length; i++) {
        const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
        if (acc + l >= total / 2) break;
        acc += l;
      }
      i = Math.min(i, P.length - 1);
      const a = P[i - 1], b = P[i];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = (total / 2 - acc) / l;
      at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      off = [0, -(s.fontSize * 0.8 + s.width + 2)];
    }
    out.push(...label(mv.text, at, rot, s, off));
  }
  return out;
}

/** All vertices that can be snapped to. */
export function snapPoints(m: Markup): Pt[] {
  if (m.type === 'rect' || m.type === 'cloud' || m.type === 'highlight' || m.type === 'text') return m.pts.length >= 2 ? rectPts(m.pts[0], m.pts[1]) : m.pts;
  if (m.type === 'pen') return [m.pts[0], m.pts[m.pts.length - 1]];
  return m.pts;
}

export function primsBounds(prims: Prim[]) {
  const pts: Pt[] = [];
  for (const p of prims) {
    if (p.kind === 'path') {
      for (const c of p.d) {
        if (c[0] === 'M' || c[0] === 'L') pts.push([c[1], c[2]]);
        else if (c[0] === 'C') pts.push([c[1], c[2]], [c[3], c[4]], [c[5], c[6]]);
      }
    } else {
      const [a, b, cc, d, e, f] = p.m;
      const w = Math.max(...p.lines.map((l) => textWidth(l.s, p.size) + l.x), 1);
      const h = p.lines.length ? p.lines[p.lines.length - 1].y + p.size * 0.3 : p.size;
      for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) pts.push([a * x + cc * y + e, b * x + d * y + f]);
    }
  }
  const bb = bounds(pts);
  const pad = Math.max(2, ...prims.map((p) => (p.kind === 'path' ? p.width : 0)));
  return { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
}
