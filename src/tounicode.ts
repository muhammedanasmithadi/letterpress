import { deflateSync } from 'node:zlib';
import {
  dictOf,
  inflatedStream,
  isEncrypted,
  join,
  LATIN1,
  objsByNum,
  trySplit,
  type Obj,
  type Parts,
  cappedInflate,
} from './pdfparts.ts';
import { parseFontCmap } from './fontcmap.ts';

const PRESENTATION_FORMS: ReadonlyArray<readonly [number, number]> = [
  [0xfb00, 0xfb4f],
  [0xfe10, 0xfe1f],
  [0xfe50, 0xfe6f],
  [0xfe70, 0xfeff],
  [0xff00, 0xffef],
];

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
  if (!/^\p{L}+$/u.test(expanded)) return undefined;
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

function ligatureFixBlock(body: string): string {
  return body.replace(
    /<([0-9A-Fa-f]+)>[ \t]*<([0-9A-Fa-f]{4})>(?=[ \t]*(?:<|\r?\n|$))/g,
    (match, key: string, destHex: string) => {
      const dest = readDest(destHex);
      if (dest === undefined || dest.length !== 1) return match;
      const expansion = ligatureExpansion(dest.charCodeAt(0));
      if (!expansion) return match;
      return `<${key}> <${writeDest(expansion)}>`;
    },
  );
}

export function fixCMap(cmap: string): string | undefined {
  let changed = false;
  const out = cmap.replace(/beginbfchar([\s\S]*?)endbfchar/g, (_whole, body: string) => {
    const fixed = ligatureFixBlock(body);
    if (fixed !== body) changed = true;
    return `beginbfchar${fixed}endbfchar`;
  });
  if (!changed) return undefined;
  return out;
}

function rangeRow(line: string): { entries: string[]; affected: boolean } | null {
  const arr = line.match(/^<([0-9A-Fa-f]+)>\s*\[([\s\S]*)\]$/);
  const inc = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>$/);

  const destinations: Array<{ gid: number; cp: number }> = [];
  if (arr) {
    const lo = parseInt(arr[1]!, 16);
    [...arr[2]!.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((d, i) =>
      destinations.push({ gid: lo + i, cp: parseInt(d[1]!.slice(0, 4), 16) }),
    );
  } else if (inc) {
    const lo = parseInt(inc[1]!, 16);
    const hi = parseInt(inc[2]!, 16);
    const base = parseInt(inc[3]!, 16);
    if (hi < lo) return null;
    for (let gid = lo; gid <= hi && gid - lo <= 0xffff; gid++)
      destinations.push({ gid, cp: base + (gid - lo) });
  } else {
    return null;
  }

  const entries: string[] = [];
  let affected = false;
  for (const { gid, cp } of destinations) {
    const expansion = ligatureExpansion(cp);
    if (expansion) affected = true;
    entries.push(`<${hex(gid)}> <${writeDest(expansion ?? String.fromCharCode(cp))}>`);
  }
  return { entries, affected };
}

function fixRanges(cmap: string): string | undefined {
  let hit = false;

  const needsWork =
    [...cmap.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>/g)].some((m) => {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const base = parseInt(m[3]!, 16);
      if (hi < lo || hi - lo > 0xffff) return false;
      for (let gid = lo; gid <= hi; gid++) {
        if (ligatureExpansion(base + (gid - lo)) !== undefined) return true;
      }
      return false;
    }) ||
    [...cmap.matchAll(/^<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]\s*$/gm)].some((m) => {
      for (const d of m[2]!.matchAll(/<([0-9A-Fa-f]{1,4})>/g)) {
        if (ligatureExpansion(parseInt(d[1]!, 16)) !== undefined) return true;
      }
      return false;
    });
  if (!needsWork) return undefined;

  const blocks = [...cmap.matchAll(/(\d+) beginbfrange\r?\n([\s\S]*?)\r?\nendbfrange/g)];
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    const [whole, , body = ''] = block;
    const keep: string[] = [];
    const added: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const row = rangeRow(line);
      if (row === null) {
        keep.push(line);
        continue;
      }
      if (row.affected) {
        added.push(...row.entries);
        hit = true;
      } else keep.push(line);
    }
    out += cmap.slice(cursor, block.index);
    cursor = block.index + whole.length;
    if (added.length > 0) {
      const pieces: string[] = [];
      if (keep.length) pieces.push(`${keep.length} beginbfrange\n${keep.join('\n')}\nendbfrange`);
      if (added.length) pieces.push(`${added.length} beginbfchar\n${added.join('\n')}\nendbfchar`);
      out += pieces.join('\n');
    } else {
      out += whole;
    }
  }
  out += cmap.slice(cursor);

  return hit ? out : undefined;
}

export function fixCMapBoth(cmap: string): string | undefined {
  const ranged = fixRanges(cmap);
  const chars = fixCMap(ranged ?? cmap);
  if (ranged === undefined && chars === undefined) return undefined;
  return chars ?? ranged;
}

type ToUnicodeTarget = { tunicodeNum: number; fontNum: number | null };

function collectFontBuffers(parts: Parts, byNum: Map<number, Obj>): Map<number, Buffer> {
  const fontBuffers = new Map<number, Buffer>();
  for (const o of parts.objs) {
    if (!/\/Type\s*\/Font\b/.test(o.bytes.toString(LATIN1))) continue;
    const fontFile = embeddedFontForFace(o, byNum);
    if (fontFile) fontBuffers.set(o.num, fontFile);
  }
  return fontBuffers;
}

function embeddedFontForFace(o: Obj, byNum: Map<number, Obj>): Buffer | undefined {
  const text = o.bytes.toString(LATIN1);
  const direct = ownDescriptorFontFile(o, byNum);
  if (direct) return direct;
  const descendant = text.match(/\/DescendantFonts\s*\[\s*(\d+) 0 R\s*\]/);
  if (!descendant) return undefined;
  const child = byNum.get(Number(descendant[1]));
  return child ? ownDescriptorFontFile(child, byNum) : undefined;
}

function ownDescriptorFontFile(o: Obj, byNum: Map<number, Obj>): Buffer | undefined {
  const fdRef = o.bytes.toString(LATIN1).match(/\/FontDescriptor\s+(\d+) 0 R/);
  if (!fdRef) return undefined;
  const fontDesc = byNum.get(Number(fdRef[1]));
  if (!fontDesc) return undefined;
  const fileRef =
    fontDesc.bytes.toString(LATIN1).match(/\/FontFile2\s+(\d+) 0 R/) ??
    fontDesc.bytes.toString(LATIN1).match(/\/FontFile3\s+(\d+) 0 R/);
  if (!fileRef) return undefined;
  const file = byNum.get(Number(fileRef[1]));
  return file ? embeddedFont(file) : undefined;
}

function findToUnicodeTargets(parts: Parts): ToUnicodeTarget[] {
  const targets: ToUnicodeTarget[] = [];
  for (const o of parts.objs) {
    const text = o.bytes.toString(LATIN1);
    const m = text.match(/\/ToUnicode\s+(\d+) 0 R/);
    if (!m) continue;
    const tunicodeNum = Number(m[1]);
    let fontNum: number | null = null;
    for (const fo of parts.objs) {
      const ft = fo.bytes.toString(LATIN1);
      if (/\/Type\s*\/Font\b/.test(ft) && ft.includes(`/ToUnicode ${tunicodeNum} 0 R`)) {
        fontNum = fo.num;
        break;
      }
    }
    targets.push({ tunicodeNum, fontNum });
  }
  return targets;
}

export function fixToUnicode(pdf: Uint8Array): Uint8Array {
  if (isEncrypted(pdf)) return pdf;
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = objsByNum(parts);
  const fontBuffers = collectFontBuffers(parts, byNum);
  const targets = findToUnicodeTargets(parts);
  if (targets.length === 0) return pdf;

  const fixed = new Map<number, string>();
  for (const { tunicodeNum, fontNum } of targets) {
    const tunicodeObj = byNum.get(tunicodeNum);
    if (!tunicodeObj) continue;
    const raw = inflatedStream(tunicodeObj, cappedInflate);
    if (!raw) continue;
    const cmapText = raw.toString(LATIN1);

    const fontBuffer = fontNum !== null ? (fontBuffers.get(fontNum) ?? null) : null;

    let next = fixCMapBoth(cmapText);
    if (next === undefined) next = cmapText;

    if (fontBuffer) {
      const tunicodeMap = new ToUnicodeMap(next, fontBuffer);
      const replacements = buildReplacements(tunicodeMap);
      if (replacements.size > 0) {
        next = applyReplacementsToCMap(next, replacements);
      }
    }

    if (next !== cmapText) fixed.set(tunicodeNum, next);
  }
  if (fixed.size === 0) return pdf;

  const objs = parts.objs.map((o) => {
    const cmap = fixed.get(o.num);
    return cmap === undefined ? o : { num: o.num, bytes: rewrittenStream(o, cmap) };
  });
  return join(parts.head, objs, parts.trailer);
}

export class ToUnicodeMap {
  private map: Map<number, number>;
  private fontCmap: Map<number, number> | null;

  constructor(cmapText: string, fontBuffer: Buffer | null) {
    this.map = new Map();
    this.fontCmap = fontBuffer ? parseFontCmap(fontBuffer) : null;
    this.parse(cmapText);
  }

  private parse(cmapText: string): void {
    for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      const body = m[1] ?? '';
      for (const e of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{1,4})>/g)) {
        const gid = parseInt(e[1]!, 16);
        const cp = parseInt(e[2]!, 16);
        if (Number.isInteger(gid) && Number.isInteger(cp)) this.map.set(gid, cp);
      }
    }
    for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const body = m[1] ?? '';
      parseBfrangeIncremental(body, (gid, cp) => this.map.set(gid, cp));
    }
    for (const e of cmapText.matchAll(
      /^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]\s*$/gm,
    )) {
      const lo = parseInt(e[1]!, 16);
      const hi = parseInt(e[2]!, 16);
      const codes: number[] = [];
      for (const d of e[3]!.matchAll(/<([0-9A-Fa-f]{1,4})>/g)) {
        codes.push(parseInt(d[1]!, 16));
      }
      for (let i = 0; i <= hi - lo && i < codes.length; i++) {
        const code = codes[i];
        if (code !== undefined) this.map.set(lo + i, code);
      }
    }
  }

  resolve(gid: number): number | undefined {
    const fromMap = this.map.get(gid);
    if (fromMap !== undefined && fromMap !== 0) return fromMap;
    const fromFont = this.fontCmap?.get(gid);
    if (fromFont !== undefined && fromFont !== 0) return fromFont;
    return undefined;
  }

  unmappedGlyphs(): number[] {
    const out: number[] = [];
    for (const [gid, cp] of this.map) {
      if (cp === 0) out.push(gid);
    }
    return out;
  }

  size(): number {
    return this.map.size;
  }
}

function parseBfrangeIncremental(body: string, note: (gid: number, cp: number) => void): void {
  for (const line of body.split('\n')) {
    const inc = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{1,4})>$/);
    if (!inc) continue;
    const lo = parseInt(inc[1]!, 16);
    const hi = parseInt(inc[2]!, 16);
    const base = parseInt(inc[3]!, 16);
    if (hi < lo || hi - lo > 0xffff) continue;
    for (let gid = lo; gid <= hi; gid++) note(gid, base + (gid - lo));
  }
}

function buildReplacements(tunicode: ToUnicodeMap): Map<number, number> {
  const replacements = new Map<number, number>();

  const unmapped = tunicode.unmappedGlyphs();
  for (const gid of unmapped) {
    const real = tunicode.resolve(gid);
    if (real !== undefined && real !== 0) {
      replacements.set(gid, real);
    }
  }

  return replacements;
}

function applyReplacementsToCMap(cmapText: string, replacements: Map<number, number>): string {
  let next = cmapText;
  for (const [gid, real] of replacements) {
    const gidHex = hex(gid, 4);
    const realHex = hex(real, 4);
    next = next.replace(
      new RegExp(`<${gidHex}>\\s*<0000>(?=[\\s\\r\\n]|<|$)`),
      `<${gidHex}> <${realHex}>`,
    );
  }
  return next;
}

function embeddedFont(o: Obj): Buffer | undefined {
  if (!/\/Length1\s+\d+/.test(o.bytes.toString(LATIN1))) return undefined;
  return inflatedStream(o, cappedInflate);
}

function rewrittenStream(o: Obj, cmap: string): Buffer {
  const compressed = deflateSync(Buffer.from(cmap, LATIN1));
  const dict = dictOf(o).replace(/\/Length\s+(?:\d+\s+0\s+R|\d+)/, `/Length ${compressed.length}`);
  return Buffer.concat([
    Buffer.from(`${dict}\nstream\n`, LATIN1),
    compressed,
    Buffer.from('\nendstream\nendobj\n', LATIN1),
  ]);
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
    const raw = inflatedStream(o, cappedInflate);
    if (!raw) continue;
    const cmap = raw.toString(LATIN1);
    scanBfchar(cmap, note);
    scanBfrange(cmap, note);
  }
  return out;
}

function scanBfchar(cmap: string, note: (cp: number) => void): void {
  for (const m of cmap.matchAll(/beginbfchar\r?\n([\s\S]*?)\r?\nendbfchar/g)) {
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      for (let i = 0; i + 4 <= e[2]!.length; i += 4) note(parseInt(e[2]!.slice(i, i + 4), 16));
    }
  }
}

function scanBfrange(cmap: string, note: (cp: number) => void): void {
  for (const m of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = m[1] ?? '';
    parseBfrangeIncremental(body, (_gid, cp) => note(cp));
    for (const e of body.matchAll(
      /^<([0-9A-Fa-f]+)>(?:\s*<([0-9A-Fa-f]+)>)?\s*\[([\s\S]*?)\]\s*$/gm,
    )) {
      for (const d of e[3]!.matchAll(/<([0-9A-Fa-f]{1,4})>/g)) {
        const cp = parseInt(d[1]!, 16);
        note(cp);
      }
    }
  }
}
