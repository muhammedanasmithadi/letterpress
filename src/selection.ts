import { inflateSync } from 'node:zlib';
import { LATIN1, dictOf, maskStrings, streamRange, trySplit, type Parts } from './pdfparts.ts';
import { cmapStreams, fontsByContent, type FontTable } from './textfont.ts';

const MIN_FLOW = 0.102;
const MAX_FLOW = 0.6;
const NEGATIVE = -0.2;
const VERTICAL = 0.25;

type TextFlow = {
  glyphs: number;
  gaps: number;
  breaks: number;
  tooWide: number;
  jump: number;
  tooThin: number;
  backwards: number;
  lines: number;
  widest: number;
  widestAll: number;
  narrowest: number;
  spans: number;
  unreadable: number;
  streams: number;
  read: number;
};

const WORD_GAP_MAX = 3;

const EMPTY: TextFlow = {
  glyphs: 0,
  gaps: 0,
  breaks: 0,
  tooWide: 0,
  jump: 0,
  tooThin: 0,
  backwards: 0,
  lines: 0,
  widest: 0,
  widestAll: 0,
  narrowest: Number.POSITIVE_INFINITY,
  spans: 0,
  unreadable: 0,
  streams: 0,
  read: 0,
};

function invisible(table: FontTable, cid: number): boolean {
  const u = table.unicodeOf(cid);
  if (u === '') return false;
  for (const ch of u) {
    if (ch !== ' ' && ch !== '\u00a0' && ch !== '\u2009' && ch !== '\u202f') return false;
  }
  return true;
}

type Placed = {
  unknown?: boolean;
  x: number;
  y: number;
  size: number;
  table: FontTable;
  cid: number;
  blank: boolean;
};

function glyphsOf(stream: string, fonts: Map<string, FontTable>): Placed[] | null {
  const out: Placed[] = [];
  let size = 0;
  let table: FontTable | null = null;
  let x = 0;
  let y = 0;
  let lx = 0;
  let ly = 0;

  const tok =
    /\b(BT|ET|Tz|Tc|Tw|TL|T\*|TJ)\b|\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|\[([^\]]*)\]\s*TJ/g;

  const show = (hex: string): void => {
    if (!table) {
      out.push({ x, y, size, unknown: true } as Placed);
      return;
    }
    const step = table.codeBytes * 2;
    if (hex.length % step !== 0) return;
    for (let i = 0; i < hex.length; i += step) {
      const cid = parseInt(hex.slice(i, i + step), 16);
      out.push({ x, y, size, table, cid, blank: invisible(table, cid) });
      x += (table.widthOf(cid) / 1000) * size;
    }
  };

  for (let m = tok.exec(stream); m; m = tok.exec(stream)) {
    if (m[0] === 'BT') {
      x = lx = y = ly = 0;
      size = 0;
      table = null;
      continue;
    }
    if (m[0] === 'ET') continue;
    if (m[1] !== undefined) return null;
    if (m[2] !== undefined) {
      size = Number(m[3]);
      table = fonts.get(m[2]!) ?? null;
      continue;
    }
    if (m[4] !== undefined) {
      if (Number(m[4]) !== 1 || Number(m[5]) !== 0 || Number(m[6]) !== 0) return null;
      if (Number(m[7]) !== 1 && Number(m[7]) !== -1) return null;
      x = lx = Number(m[8]);
      y = ly = Number(m[9]);
      continue;
    }
    if (m[10] !== undefined) {
      lx += Number(m[10]);
      ly += Number(m[11]);
      x = lx;
      y = ly;
      continue;
    }
    if (m[12] !== undefined) show(m[12]!);
    else if (m[13] !== undefined) {
      for (const piece of m[13]!.split(/\s+/)) {
        if (!piece) continue;
        const hex = /^<([0-9A-Fa-f]*)>$/.exec(piece);
        if (hex) show(hex[1]!);
        else {
          const n = Number(piece);
          if (!Number.isFinite(n)) return null;
          x -= (n / 1000) * size;
        }
      }
    } else return null;
  }
  return out;
}

const NOT_A_SPACE = 0.03;

class LastChars {
  private two = [' ', ' '];
  private pos = 0;

  reset(): void {
    this.two = [' ', ' '];
    this.pos = 0;
  }

  due(): boolean {
    return this.two[this.pos] !== ' ' && this.two[(this.pos + 1) % 2] === ' ';
  }

  save(ch: string): void {
    const next = (this.pos + 1) % 2;
    this.two[this.pos] = ch;
    this.pos = next;
  }
}

export function textFlow(pdf: Uint8Array): TextFlow | null {
  const parts: Parts | undefined = trySplit(pdf);
  if (!parts) return null;
  const cmaps = cmapStreams(pdf);
  const fonts = fontsByContent(parts, (num) => cmaps.get(num) ?? null);
  if (!fonts.size) return null;

  const flow: TextFlow = { ...EMPTY };

  for (const o of parts.objs) {
    const dict = dictOf(o);
    const range = streamRange(o.bytes);
    if (!range) continue;
    let text: string;
    try {
      const raw = o.bytes.subarray(range.start, range.end);
      text = (/FlateDecode/.test(dict) ? inflateSync(raw) : Buffer.from(raw)).toString(LATIN1);
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(text)) continue;
    flow.streams++;
    flow.spans += (text.match(/\/ActualText/g) ?? []).length;

    const pageFonts = fonts.get(o.num);
    if (!pageFonts) continue;
    const glyphs = glyphsOf(maskStrings(text), pageFonts);
    if (!glyphs) continue;
    flow.read++;
    flow.lines++;

    const last = new LastChars();
    let prev: Placed | null = null;
    for (const g of glyphs) {
      if (g.unknown) {
        flow.glyphs++;
        flow.unreadable++;
        last.reset();
        prev = null;
        continue;
      }
      if (g.blank) {
        flow.glyphs++;
        last.save(' ');
        continue;
      }
      flow.glyphs++;
      if (prev) {
        const size = prev.size;
        const gap = g.x - (prev.x + (prev.table.widthOf(prev.cid) / 1000) * prev.size);
        const rise = Math.abs(g.y - prev.y);

        if (rise > VERTICAL * size) {
          flow.lines++;
          last.reset();
          prev = null;
          continue;
        }
        if (gap < NEGATIVE * size) {
          flow.breaks++;
          flow.backwards++;
          last.reset();
        } else {
          flow.gaps++;
          const em = gap / size;
          if (em > flow.widest && em <= WORD_GAP_MAX) flow.widest = em;
          if (em > flow.widestAll) flow.widestAll = em;
          if (em < flow.narrowest) flow.narrowest = em;
          if (em <= NOT_A_SPACE) last.reset();
          if (em <= MIN_FLOW) {
            if (last.due()) {
              flow.breaks++;
              flow.tooThin++;
              last.reset();
            }
          } else if (em > MAX_FLOW) {
            flow.breaks++;
            if (em <= WORD_GAP_MAX) flow.tooWide++;
            else flow.jump++;
          }
        }
      }
      last.save(glyphText(g));
      prev = g;
    }
  }
  if (flow.narrowest === Number.POSITIVE_INFINITY) flow.narrowest = 0;
  if (flow.read === 0) return null;
  return flow;
}

function glyphText(g: Placed): string {
  const u = g.table.unicodeOf(g.cid);
  return u === '' ? ' ' : u[0]!;
}
