// Helvetica metrics shared by the on-screen renderer and the PDF writer so text wraps identically.
import { Font, FontNames, Encodings } from '@pdf-lib/standard-fonts';

let helv: Font | null = null;
const cache = new Map<number, number>();
function font() {
  return (helv ??= Font.load(FontNames.Helvetica));
}

/** Replace characters Helvetica/WinAnsi cannot encode. */
export function sanitize(s: string) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10) out += '\n';
    else if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) out += ch;
    else out += '?';
  }
  return out;
}

export function charWidth(cp: number): number {
  let w = cache.get(cp);
  if (w === undefined) {
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) w = 556;
    else w = (font().getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name) as number) ?? 556;
    cache.set(cp, w);
  }
  return w;
}

export function textWidth(s: string, size: number) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return (w * size) / 1000;
}

/** Hex string of WinAnsi codes for a PDF Tj operator. */
export function winAnsiHex(s: string) {
  let h = '';
  for (const ch of sanitize(s)) {
    const cp = ch.codePointAt(0)!;
    const code = Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp) ? Encodings.WinAnsi.encodeUnicodeCodePoint(cp).code : 63;
    h += code.toString(16).padStart(2, '0');
  }
  return `<${h}>`;
}

/** Greedy word wrap to a maximum width. Hard newlines are respected. */
export function wrap(text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of sanitize(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const cand = line + w;
      if (line && textWidth(cand.trimEnd(), size) > maxW && w.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
        // break very long words
        while (textWidth(line, size) > maxW && line.length > 1) {
          let i = line.length - 1;
          while (i > 1 && textWidth(line.slice(0, i), size) > maxW) i--;
          out.push(line.slice(0, i));
          line = line.slice(i);
        }
      } else line = cand;
    }
    out.push(line.trimEnd());
  }
  return out;
}
