import type { Markup, Pt, ScaleCal, Unit } from './types';

export const UNIT_TO_M: Record<Unit, number> = {
  in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344,
  mm: 0.001, cm: 0.01, m: 1, km: 1000,
};
export const IMPERIAL: Unit[] = ['in', 'ft', 'yd', 'mi'];
export const METRIC: Unit[] = ['mm', 'cm', 'm', 'km'];
export const isMetric = (u: Unit) => METRIC.includes(u);

export const AREA_LABEL: Record<Unit, string> = {
  in: 'sq in', ft: 'sq ft', yd: 'sq yd', mi: 'sq mi', mm: 'mm²', cm: 'cm²', m: 'm²', km: 'km²',
};
export const UNIT_LABEL: Record<Unit, string> = {
  in: 'in', ft: 'ft', yd: 'yd', mi: 'mi', mm: 'mm', cm: 'cm', m: 'm', km: 'km',
};

export const SQM_PER_ACRE = 4046.8564224;
export const SQM_PER_HA = 10000;

/** Default for pages that have not been calibrated: real paper inches. */
export const PAPER_SCALE: ScaleCal = { factor: 1 / 72, unit: 'in', label: 'Not calibrated (paper inches)', precision: 2 };

export function convertLen(v: number, from: Unit, to: Unit) {
  return (v * UNIT_TO_M[from]) / UNIT_TO_M[to];
}

/** Scale from "paper length = real length", e.g. 1 in = 20 ft. */
export function scaleFromRatio(paper: number, paperUnit: Unit, real: number, realUnit: Unit, label?: string, precision = 2): ScaleCal {
  const paperPts = (convertLen(paper, paperUnit, 'in')) * 72;
  return { factor: real / paperPts, unit: realUnit, label: label ?? `${fmtNum(paper)} ${paperUnit} = ${fmtNum(real)} ${realUnit}`, precision };
}

/** Scale from a 1:N ratio expressed in the given real unit. */
export function scaleFromOneTo(n: number, unit: Unit, precision = 2): ScaleCal {
  const paperM = (1 / 72) * 0.0254; // one PDF point in metres
  return { factor: (paperM * n) / UNIT_TO_M[unit], unit, label: `1:${n}`, precision };
}

/** Calibrate from a measured distance in points and a known real-world length. */
export function scaleFromCalibration(distPts: number, real: number, unit: Unit, precision = 2): ScaleCal {
  return { factor: real / distPts, unit, label: `Calibrated: 1 in = ${fmtNum((real / distPts) * 72, 2)} ${unit}`, precision };
}

export function withUnit(s: ScaleCal, unit: Unit): ScaleCal {
  return { ...s, factor: convertLen(s.factor, s.unit, unit), unit };
}

export interface ScalePreset { group: string; label: string; make: () => ScaleCal }
const eng = [10, 20, 30, 40, 50, 60, 80, 100, 200, 300, 400, 500, 1000, 2000];
const arch: [string, number][] = [
  ['1/16" = 1\'-0"', 1 / 16], ['3/32" = 1\'-0"', 3 / 32], ['1/8" = 1\'-0"', 1 / 8], ['3/16" = 1\'-0"', 3 / 16],
  ['1/4" = 1\'-0"', 1 / 4], ['3/8" = 1\'-0"', 3 / 8], ['1/2" = 1\'-0"', 1 / 2], ['3/4" = 1\'-0"', 3 / 4],
  ['1" = 1\'-0"', 1], ['1-1/2" = 1\'-0"', 1.5], ['3" = 1\'-0"', 3],
];
const ratios = [100, 200, 250, 500, 1000, 1200, 2000, 2400, 2500, 4800, 5000, 10000, 24000, 25000, 50000];
export const SCALE_PRESETS: ScalePreset[] = [
  ...eng.map((n) => ({ group: 'Engineering', label: `1" = ${n}'`, make: () => scaleFromRatio(1, 'in', n, 'ft', `1" = ${n}'`) })),
  ...arch.map(([l, inch]) => ({ group: 'Architectural', label: l, make: () => scaleFromRatio(inch, 'in', 1, 'ft', l) })),
  ...ratios.map((n) => ({ group: 'Ratio (feet)', label: `1:${n} (ft)`, make: () => ({ ...withUnit(scaleFromOneTo(n, 'm'), 'ft'), label: `1:${n}` }) })),
  ...ratios.map((n) => ({ group: 'Ratio (metric)', label: `1:${n} (m)`, make: () => scaleFromOneTo(n, 'm') })),
];

export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function polyLen(pts: Pt[], closed = false) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
  return s;
}
export function polyArea(pts: Pt[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2; // signed, pt²
}
export function centroid(pts: Pt[]): Pt {
  const a = polyArea(pts);
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function fmtNum(v: number, digits = 2) {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const trimNum = (v: number) => String(+v.toFixed(6));
export { trimNum };

export interface MeasureValue {
  kind: 'length' | 'area' | 'count';
  value: number; // length in unit, area in unit², count
  unit: string; // display unit label
  area2?: number; // acres or hectares
  area2Unit?: string;
  perimeter?: number;
  text: string; // label drawn on the page
}

export function isMeasure(t: Markup['type']) {
  return t.startsWith('m-');
}

export function measureOf(m: Markup, s: ScaleCal): MeasureValue | null {
  const p = s.precision;
  const u = UNIT_LABEL[s.unit];
  switch (m.type) {
    case 'm-length':
    case 'm-polylength':
    case 'm-perimeter': {
      const v = polyLen(m.pts, m.type === 'm-perimeter') * s.factor;
      return { kind: 'length', value: v, unit: u, text: `${fmtNum(v, p)} ${u}` };
    }
    case 'm-area': {
      const aU = Math.abs(polyArea(m.pts)) * s.factor * s.factor; // unit²
      const sqm = aU * UNIT_TO_M[s.unit] ** 2;
      const metric = isMetric(s.unit);
      const a2 = metric ? sqm / SQM_PER_HA : sqm / SQM_PER_ACRE;
      const a2u = metric ? 'ha' : 'ac';
      const per = polyLen(m.pts, true) * s.factor;
      return {
        kind: 'area', value: aU, unit: AREA_LABEL[s.unit], area2: a2, area2Unit: a2u, perimeter: per,
        text: `${fmtNum(aU, p)} ${AREA_LABEL[s.unit]} (${fmtNum(a2, Math.max(p, 3))} ${a2u})`,
      };
    }
    case 'm-count':
      return { kind: 'count', value: m.pts.length, unit: 'ea', text: `${m.pts.length}` };
    default:
      return null;
  }
}
