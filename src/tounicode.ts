import { deflateSync } from 'node:zlib';
import { inflateSync } from 'node:zlib';
import {
  inflatedStream,
  join,
  LATIN1,
  objsByNum,
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

  // Only inside a `beginbfchar` block.
  //
  // A `bfchar` entry is `<src> <dst>`. A `bfrange` line is `<lo> <hi> <dst>` and a
  // `codespacerange` line is `<lo> <hi>`, and the old pattern could not tell them apart:
  // its `\s*` between the operands matched a newline and its lookahead accepted the `<` that
  // begins the next line, so `<0041>` on one line paired with `<FB00>` on the next. The
  // result declared `2 beginbfrange` and supplied six operands on one line -- not a valid
  // `bfrange` at all -- and turned a codespace declaration into a three-byte destination.
  // `verify` cannot see inside a CMap, so both passed the gate and the report then said the
  // font was clean.
  //
  // Entries inside a block may still be one per line, so the separator is `[ \t]*` and the
  // lookahead accepts a line end -- a newline is now never consumed as a separator.
  const fixBlock = (body: string): string =>
    body.replace(
      /<([0-9A-Fa-f]+)>[ \t]*<([0-9A-Fa-f]{4})>(?=[ \t]*(?:<|\r?\n|$))/g,
      (match, key: string, destHex: string) => {
        const dest = readDest(destHex);
        if (dest === undefined || dest.length !== 1) return match;
        const expansion = ligatureExpansion(dest.charCodeAt(0));
        if (!expansion) return match;
        changed = true;
        return `<${key}> <${writeDest(expansion)}>`;
      },
    );

  const out = cmap.replace(
    /beginbfchar([\s\S]*?)endbfchar/g,
    (_whole, body: string) => `beginbfchar${fixBlock(body)}endbfchar`,
  );

  if (!changed) return undefined;

  return out;
}

/**
 * One row of a `bfrange` block, and the `bfchar` rows it becomes.
 *
 * Two forms, and they are genuinely different rather than two spellings of the same thing:
 * `<lo> <hi> <dst>` increments from a base, and `<lo> [ <d0> <d1> ... ]` lists one
 * destination per code from `<lo>` upwards. Treating the array's first elements as `hi` and
 * the base is how it used to be read, and it is why the report named codepoints the map does
 * not contain.
 *
 * `null` means the line is not a range row at all, and is kept verbatim. Otherwise `affected`
 * is false when nothing in the row needs expanding, and the line is kept too.
 */
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
  // An array form carries one destination per code from `<lo>` upwards. It was skipped
  // entirely: the line pattern below matched only `<lo> <hi> <dst>`, so a map written this
  // way was reported as having unresolved ligatures and never repaired -- and running the
  // checker over it afterwards reported more codepoints than before, because the checker
  // read the array's elements as the operands of an incremental range.
  const needsArray = [...cmap.matchAll(/<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)].some((m) =>
    [...m[2]!.matchAll(/<([0-9A-Fa-f]+)>/g)].some((d) =>
      [...d[1]!.matchAll(/.{4}/g)].some((u) => ligatureExpansion(parseInt(u[0], 16)) !== undefined),
    ),
  );
  if (!needsWork && !needsArray) return undefined;

  const blocks = [...cmap.matchAll(/(\d+) beginbfrange\r?\n([\s\S]*?)\r?\nendbfrange/g)];
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    const [whole, , body = ''] = block;
    const keep: string[] = [];
    const added: string[] = [];
    for (const raw of body.split('\n')) {
      // A row ends at the newline, and on a CRLF map that newline carries a \r with it.
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

  const byNum = objsByNum(parts);

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
    scanBfchar(cmap, note);
    scanBfrange(cmap, note);
  }
  return out;
}

/** `beginbfchar` blocks: one source code to one destination. */
function scanBfchar(cmap: string, note: (cp: number) => void): void {
  for (const m of cmap.matchAll(/beginbfchar\r?\n([\s\S]*?)\r?\nendbfchar/g)) {
    for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      for (let i = 0; i + 4 <= e[2]!.length; i += 4) note(parseInt(e[2]!.slice(i, i + 4), 16));
    }
  }
}

/** `beginbfrange` blocks: `<lo> <hi> <dst>` or `<lo> [ <d0> <d1> ... ]`. */
function scanBfrange(cmap: string, note: (cp: number) => void): void {
  for (const m of cmap.matchAll(/beginbfrange\r?\n([\s\S]*?)\r?\nendbfrange/g)) {
    for (const e of m[1]!.matchAll(
      // Either `<lo> <hi> <dst>` or `<lo> [ <d0> <d1> ... ]`.
      //
      // The array form is a third alternative after the first operand, not a fourth. The
      // old pattern demanded `<lo> <hex>` before it would consider a bracket, so an array
      // line failed to match at `<lo>`, the engine advanced, and it started matching at
      // the first array element -- reading elements one and two as lo and hi and element
      // three as the increment base. A two-element array therefore reported nothing at
      // all, and a four-element array reported codepoints the map does not contain while
      // missing two that it does.
      /<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>|\[\s*([\s\S]*?)\s*\])/g,
    )) {
      const lo = parseInt(e[1]!, 16);
      if (e[2]) {
        const hi = parseInt(e[2]!, 16);
        const base = parseInt(e[3]!.slice(0, 4), 16);
        for (let gid = lo; gid <= hi && gid - lo <= 0xffff; gid++) note(base + (gid - lo));
      } else {
        // An array supplies one destination per code from `<lo>` upwards, and each
        // destination is a codepoint like any other.
        for (const d of (e[4] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)) {
          for (let k = 0; k + 4 <= d[1]!.length; k += 4) note(parseInt(d[1]!.slice(k, k + 4), 16));
        }
      }
    }
  }
}
