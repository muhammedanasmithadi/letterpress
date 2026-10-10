import { deflateSync } from 'node:zlib';
import { inflateSync } from 'node:zlib';
import {
  asBuffer,
  inflatedStream,
  join,
  LATIN1,
  streamDict,
  trySplit,
  type Obj,
} from './pdfparts.ts';

const PRESENTATION_FORMS: ReadonlyArray<readonly [number, number]> = [
  [0xfb00, 0xfb4f],
  [0xfe10, 0xfe1f],
  [0xfe50, 0xfe6f],
  [0xfe70, 0xfeff],
  [0xff00, 0xffef],
];

const LETTERS = /^\p{L}+$/u;

const inPresentationForm = (cp: number) =>
  PRESENTATION_FORMS.some(([lo, hi]) => cp >= lo && cp <= hi);

export function ligatureExpansion(cp: number): string | undefined {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return undefined;
  if (cp >= 0xd800 && cp <= 0xdfff) return undefined;
  if (!inPresentationForm(cp)) return undefined;
  const ch = String.fromCodePoint(cp);
  const expanded = ch.normalize('NFKC');
  if (expanded === ch) return undefined;
  if ([...expanded].length < 2) return undefined;
  if (!LETTERS.test(expanded)) return undefined;
  return expanded;
}

const hex = (n: number, width = 4) => n.toString(16).toUpperCase().padStart(width, '0');

function readDest(hexText: string): string | undefined {
  if (hexText.length % 4 !== 0) return undefined;
  let out = '';
  for (let i = 0; i < hexText.length; i += 4) {
    out += String.fromCharCode(parseInt(hexText.slice(i, i + 4), 16));
  }
  return out;
}

function writeDest(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += hex(text.charCodeAt(i));
  return out;
}

export function fixCMap(cmap: string): string | undefined {
  let changed = false;

  const out = cmap.replace(
    /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>(?=\s*(?:<|\r?\n|$))/g,
    (match, key: string, destHex: string) => {
      const dest = readDest(destHex);
      if (dest === undefined || dest.length !== 1) return match;
      const expansion = ligatureExpansion(dest.charCodeAt(0));
      if (!expansion) return match;
      changed = true;
      return `<${key}> <${writeDest(expansion)}>`;
    },
  );

  if (!changed) return undefined;

  return out;
}

function fixRanges(cmap: string): string | undefined {
  let hit = false;

  const needsWork = [
    ...cmap.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>/g),
  ].some((m) => {
    const lo = parseInt(m[1]!, 16);
    const hi = parseInt(m[2]!, 16);
    const base = parseInt(m[3]!, 16);
    if (hi < lo || hi - lo > 0xffff) return false;
    for (let gid = lo; gid <= hi; gid++) {
      if (ligatureExpansion(base + (gid - lo)) !== undefined) return true;
    }
    return false;
  });
  if (!needsWork) return undefined;

  const blocks = [...cmap.matchAll(/(\d+) beginbfrange\n([\s\S]*?)\nendbfrange/g)];
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    const [whole, , body] = block;
    const keep: string[] = [];
    const added: string[] = [];
    for (const line of body.split('\n')) {
      const m = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>$/);
      if (!m) {
        keep.push(line);
        continue;
      }
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const base = parseInt(m[3]!, 16);
      const entries: string[] = [];
      let affected = false;
      for (let gid = lo; gid <= hi; gid++) {
        const cp = base + (gid - lo);
        const expansion = ligatureExpansion(cp);
        if (expansion) affected = true;
        entries.push(`<${hex(gid)}> <${writeDest(expansion ?? String.fromCharCode(cp))}>`);
      }
      if (affected) {
        added.push(...entries);
        hit = true;
      } else keep.push(line);
    }
    out += cmap.slice(cursor, block.index);
    cursor = block.index + whole.length;
    const affectedThisBlock = added.length > 0;
    if (!affectedThisBlock) {
      out += whole;
      continue;
    }
    const pieces: string[] = [];
    if (keep.length) pieces.push(`${keep.length} beginbfrange\n${keep.join('\n')}\nendbfrange`);
    if (added.length) pieces.push(`${added.length} beginbfchar\n${added.join('\n')}\nendbfchar`);
    out += pieces.join('\n');
  }
  out += cmap.slice(cursor);

  return hit ? out : undefined;
}

function fixCMapBoth(cmap: string): string | undefined {
  const ranged = fixRanges(cmap);
  const chars = fixCMap(ranged ?? cmap);
  if (ranged === undefined && chars === undefined) return undefined;
  return chars ?? ranged;
}

function rewrittenStream(o: Obj, cmap: string): Buffer {
  const compressed = deflateSync(Buffer.from(cmap, LATIN1));
  const dict = streamDict(o).replace(/\/Length\s+\d+/, `/Length ${compressed.length}`);
  return Buffer.concat([
    Buffer.from(`${dict}stream\n`, LATIN1),
    compressed,
    Buffer.from('\nendstream\nendobj\n', LATIN1),
  ]);
}

export function fixToUnicode(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));

  const targets = new Set<number>();
  for (const o of parts.objs) {
    const m = o.bytes.toString(LATIN1).match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (m) targets.add(Number(m[1]));
  }
  if (!targets.size) return pdf;

  const fixed = new Map<number, string>();
  for (const num of targets) {
    const o = byNum.get(num);
    if (!o) continue;
    const raw = inflatedStream(o, inflateSync);
    if (!raw) continue;
    const next = fixCMapBoth(raw.toString(LATIN1));
    if (next !== undefined) fixed.set(num, next);
  }
  if (!fixed.size) return pdf;

  const objs = parts.objs.map((o) => {
    const cmap = fixed.get(o.num);
    return cmap === undefined ? o : { num: o.num, bytes: rewrittenStream(o, cmap) };
  });
  return join(parts.head, objs, parts.trailer);
}

export function unresolvedLigatures(pdf: Uint8Array): Array<{ cp: number; expansion: string }> {
  const parts = trySplit(pdf);
  if (!parts) return [];
  const out: Array<{ cp: number; expansion: string }> = [];
  const seen = new Set<number>();
  const note = (cp: number) => {
    const expansion = ligatureExpansion(cp);
    if (expansion && !seen.has(cp)) {
      seen.add(cp);
      out.push({ cp, expansion });
    }
  };
  for (const o of parts.objs) {
    const raw = inflatedStream(o, inflateSync);
    if (!raw) continue;
    const cmap = raw.toString(LATIN1);
    for (const m of cmap.matchAll(/beginbfchar\n([\s\S]*?)\nendbfchar/g)) {
      for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        for (let i = 0; i + 4 <= e[2]!.length; i += 4) note(parseInt(e[2]!.slice(i, i + 4), 16));
      }
    }
    for (const m of cmap.matchAll(/beginbfrange\n([\s\S]*?)\nendbfrange/g)) {
      for (const e of m[1]!.matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g,
      )) {
        const lo = parseInt(e[1]!, 16);
        const hi = parseInt(e[2]!, 16);
        if (e[3]) {
          const base = parseInt(e[3]!.slice(0, 4), 16);
          for (let gid = lo; gid <= hi && gid - lo <= 0xffff; gid++) note(base + (gid - lo));
        } else {
          for (const d of (e[4] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)) {
            for (let i = 0; i + 4 <= d[1]!.length; i += 4)
              note(parseInt(d[1]!.slice(i, i + 4), 16));
          }
        }
      }
    }
  }
  return out;
}
