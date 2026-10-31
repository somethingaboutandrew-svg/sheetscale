// Converts drawing primitives to PDF content-stream operators.
import type { Prim } from './geom';
import { winAnsiHex } from './font';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const rgb = (hex: string) => hexToRgb(hex).map(n).join(' ');

export class Resources {
  gs = new Map<string, { name: string; CA: number; ca: number; BM?: string }>();
  font = false;
  gsName(CA: number, ca: number, BM?: string) {
    const key = `${n(CA)}|${n(ca)}|${BM ?? ''}`;
    let g = this.gs.get(key);
    if (!g) {
      g = { name: `PMgs${this.gs.size}`, CA, ca, BM };
      this.gs.set(key, g);
    }
    return g.name;
  }
}

export const FONT_NAME = 'PMHelv';

export function primsToOps(prims: Prim[], res: Resources): string {
  const o: string[] = [];
  for (const p of prims) {
    if (p.kind === 'path') {
      const doStroke = !!p.stroke && p.width > 0 && p.so > 0;
      const doFill = !!p.fill && p.fo > 0;
      if (!doStroke && !doFill) continue;
      o.push('q');
      o.push(`/${res.gsName(doStroke ? p.so : 1, doFill ? p.fo : 1, p.blend)} gs`);
      if (doStroke) {
        o.push(`${n(p.width)} w ${p.cap} J ${p.join} j`);
        o.push(`[${(p.dash ?? []).map(n).join(' ')}] 0 d`);
        o.push(`${rgb(p.stroke!)} RG`);
      }
      if (doFill) o.push(`${rgb(p.fill!)} rg`);
      for (const c of p.d) {
        if (c[0] === 'M') o.push(`${n(c[1])} ${n(c[2])} m`);
        else if (c[0] === 'L') o.push(`${n(c[1])} ${n(c[2])} l`);
        else if (c[0] === 'C') o.push(`${n(c[1])} ${n(c[2])} ${n(c[3])} ${n(c[4])} ${n(c[5])} ${n(c[6])} c`);
        else o.push('h');
      }
      o.push(doStroke && doFill ? 'B' : doStroke ? 'S' : 'f');
      o.push('Q');
    } else {
      if (!p.lines.some((l) => l.s)) continue;
      res.font = true;
      const [a, b, c, d, e, f] = p.m;
      o.push('q');
      o.push(`/${res.gsName(p.opacity, p.opacity)} gs`);
      o.push('BT');
      o.push(`/${FONT_NAME} ${n(p.size)} Tf ${rgb(p.color)} rg`);
      for (const l of p.lines) {
        if (!l.s) continue;
        // frame (x right, y down) -> glyph space (y up): flip y around the baseline
        const tx = a * l.x + c * l.y + e;
        const ty = b * l.x + d * l.y + f;
        o.push(`${n(a)} ${n(b)} ${n(-c)} ${n(-d)} ${n(tx)} ${n(ty)} Tm ${winAnsiHex(l.s)} Tj`);
      }
      o.push('ET');
      o.push('Q');
    }
  }
  return o.join('\n');
}
