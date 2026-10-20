import { inflateSync } from 'node:zlib';
import {
  LATIN1,
  dictOf,
  objsByNum,
  streamRange,
  trySplit,
  type Obj,
  type Parts,
} from './pdfparts.ts';

export type FontTable = {
  codeBytes: 1 | 2;
  widthOf: (code: number) => number;
  unicodeOf: (code: number) => string;
};

function subDictOf(dict: string, key: string): string {
  const at = new RegExp(`/${key}\\s*<<`).exec(dict);
  if (!at) return '';
  let depth = 0;
  for (let i = at.index + at[0].length - 2; i < dict.length - 1; i++) {
    const pair = dict.slice(i, i + 2);
    if (pair === '<<') {
      depth++;
      i++;
      continue;
    }
    if (pair === '>>') {
      depth--;
      i++;
      if (depth === 0) return dict.slice(at.index + at[0].length, i - 1);
    }
  }
  return '';
}

/** The body of the `/Font` dictionary, to its matching `>>`. */
function fontDictOf(dict: string): string {
  return subDictOf(dict, 'Font');
}

/**
 * The `/W` array, read with balanced brackets.
 *
 * The grammar has two forms and taking only the first is a quiet way to move text:
 *
 *     /W [ 0 [600 0 0 260] 15 17 250 38 [614] ]
 *              ^^^^^^^^^   ^^^^^^^^^^^
 *              c [w...]    cFirst cLast w
 *
 * Reading `15 17 250` as three unrelated numbers leaves CIDs 15 to 17 with no width, they
 * fall back to `/DW`, and every adjustment computed from them is short by the difference.
 * The page still rasterises identically and still extracts the right characters, so only
 * the word boxes move -- and the reader that has to live with that is the one copying the
 * text.
 */
export function parseW(dict: string): Map<number, number> {
  const at = /\/(?:W|w)\s*\[/.exec(dict);
  if (!at) return new Map();
  const end = bracketEnd(dict, at.index + at[0].length - 1);
  if (end === -1) return new Map();

  const out = new Map<number, number>();
  const toks = dict
    .slice(at.index + at[0].length, end)
    .replace(/[[\]]/g, ' $& ')
    .split(/\s+/)
    .filter(Boolean);

  let cid: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === '[') {
      const from = cid;
      let j = i + 1;
      for (; j < toks.length && toks[j] !== ']'; j++) {
        const w = Number(toks[j]);
        if (from !== null && Number.isFinite(w)) out.set(from + (j - i - 1), w);
      }
      cid = last = null;
      i = j;
      continue;
    }
    const n = Number(tok);
    if (!Number.isFinite(n)) continue;
    if (cid === null) cid = n;
    else if (last === null) last = n;
    else {
      for (let c = cid; c <= last; c++) out.set(c, n);
      cid = last = null;
    }
  }
  return out;
}

/** UTF-16BE hex to a string, which is what a ToUnicode destination holds. */
function utf16be(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** CID to character, from both forms of the CMap body. */
export function parseCMap(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of cmap.matchAll(/beginbfchar\s*([\s\S]*?)\s*endbfchar/g)) {
    for (const pair of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      out.set(parseInt(pair[1]!, 16), utf16be(pair[2]!));
    }
  }
  for (const m of cmap.matchAll(/beginbfrange\s*([\s\S]*?)\s*endbfrange/g)) {
    for (const row of m[1]!.split('\n')) {
      const r = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/.exec(row);
      if (!r) continue;
      const lo = parseInt(r[1]!, 16);
      const hi = parseInt(r[2]!, 16);
      if (r[4]) {
        const list = [...r[4]!.matchAll(/<([0-9A-Fa-f]+)>/g)].map((h) => utf16be(h[1]!));
        for (let i = 0; lo + i <= hi && i < list.length; i++) out.set(lo + i, list[i]!);
      } else if (r[3]) {
        // The destination is text, and this engine writes two-character ligature
        // expansions, so stepping one code point gives one character where there were two
        // and every character after it lands in the wrong plane.
        const base = r[3]!;
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          let hex = '';
          for (let k = 0; k < base.length; k += 4) {
            hex += ((parseInt(base.slice(k, k + 4), 16) + (c - lo)) & 0xffff)
              .toString(16)
              .toUpperCase()
              .padStart(4, '0');
          }
          out.set(c, utf16be(hex));
        }
      }
    }
  }
  return out;
}

/**
 * Tables per page font resource, keyed first by the content stream that uses them.
 *
 * A resource name is page-local: `/F1` on page one and `/F1` on page two are two different
 * fonts. One flat map keyed by name lets the last page that binds `/F1` overwrite the
 * widths for every other page, and a width read from the wrong font moves every number
 * computed from it. The glyphs still land where they did, so nothing looks broken and the
 * measurement is simply wrong.
 *
 * The outer key is the object number of a content stream, which is what a caller walking
 * streams in file order has in hand.
 */
export function fontsByContent(
  parts: Parts,
  cmapOf: (num: number) => string | null,
): Map<number, Map<string, FontTable>> {
  const byNum = objsByNum(parts);
  const out = new Map<number, Map<string, FontTable>>();
  for (const page of parts.objs) {
    const dict = dictOf(page);
    if (!/\/Type\s*\/Page\b/.test(dict)) continue;
    // A non-greedy search for the next ">>" lands inside whatever dictionary precedes
    // /Font -- /Resources carries /ExtGState <</G3 3 0 R>> first -- and reads a font
    // dictionary that is not there.
    let resDict = fontDictOf(dict);
    const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
    // A page can name a resource object the file does not contain, and a `!` here is a
    // compile-time assertion with no runtime effect: the measurement stage would throw and
    // take the render with it.
    const resObj = ref ? byNum.get(Number(ref)) : undefined;
    if (resObj) resDict = fontDictOf(dictOf(resObj)) || resDict;

    const fonts = tableOf(resDict, byNum, cmapOf);

    for (const n of contentsOf(dict, byNum)) out.set(n, fonts);

    for (const [n, f] of formsOf(dict, byNum, cmapOf)) {
      if (!out.has(n)) out.set(n, f);
    }
  }
  return out;
}

/**
 * Font tables for the Form XObjects a page draws through, keyed by the form's own
 * object number -- which is also the object number of the stream that draws it.
 *
 * Chromium does not put a page's text in the page's `/Contents`. It puts it in a Form
 * XObject that the page's contents draws with a single `Do`, and the fonts that text
 * uses are in *that form's* `/Resources`, not the page's:
 *
 *     2 0 obj <</Type /Page /Resources <</XObject <</X23 23 0 R>> /Font <</F4 4 0 R>>>> /Contents 24 0 R>>
 *    23 0 obj <</Type /XObject /Subtype /Form /Resources <</Font <</F4 4 0 R /F7 7 0 R ...>>> /Length 19645>>
 *
 * The page's own `/Font` here names two fonts and the form's names six, so binding
 * tables from the page alone gives the stream that draws no glyphs a table and the
 * stream that draws every glyph none at all.
 *
 * Everything downstream reads the table by content stream, so on real output the
 * ligature-span repair found no font in force at any span and kept every one of them,
 * and the selection report could not read a stream with text in it. The page-level
 * loop above never saw the form objects because they are not `/Type /Page`.
 *
 * Forms nest, so this walks the `/XObject` tree rather than one level. Resource names
 * are scoped to the form that declares them for the same reason they are scoped to a
 * page, so each form gets its own table rather than inheriting the page's.
 */
function formsOf(
  pageDict: string,
  byNum: Map<number, Obj>,
  cmapOf: (num: number) => string | null,
): Map<number, Map<string, FontTable>> {
  const out = new Map<number, Map<string, FontTable>>();
  const root = resourcesDictOf(pageDict, byNum);
  const queue = [subDictOf(root, 'XObject'), pageDict];
  const seen = new Set<string>();
  while (queue.length) {
    const res = queue.shift()!;
    // Two forms can share a resource dictionary, and a form that draws itself would
    // otherwise loop: the queue is keyed by the dictionary, not by the object.
    if (seen.has(res)) continue;
    seen.add(res);
    for (const n of refsIn(res)) {
      const target = byNum.get(n);
      if (!target) continue;
      const dict = dictOf(target);
      // An image XObject is drawn by the same operator and carries no content stream
      // of its own, so there is nothing to key a table to.
      if (!/\/Subtype\s*\/Form\b/.test(dict)) continue;
      const own = resourcesDictOf(dict, byNum);
      out.set(n, tableOf(fontDictOf(own) || fontDictOf(dict), byNum, cmapOf));
      queue.push(own);
    }
  }
  return out;
}

/** The page's or form's `/Resources` dictionary, following it if it is an indirect reference. */
function resourcesDictOf(dict: string, byNum: Map<number, Obj>): string {
  const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
  const target = ref ? byNum.get(Number(ref)) : undefined;
  return target ? dictOf(target) : dict;
}

/** Every indirect object a `/Font` or `/XObject` sub-dictionary names. */
function refsIn(dict: string): number[] {
  return [...dict.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
}

/** Font tables for the `/Name N 0 R` entries of one `/Font` sub-dictionary. */
function tableOf(
  resDict: string,
  byNum: Map<number, Obj>,
  cmapOf: (num: number) => string | null,
): Map<string, FontTable> {
  const fonts = new Map<string, FontTable>();
  for (const m of resDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
    const target = byNum.get(Number(m[2]));
    if (!target) continue;
    const parent = dictOf(target);
    // `/DescendantFonts` names an array, and the array may itself be an indirect
    // reference. Reading only the inline form leaves the parent, which carries no /W,
    // and every glyph then falls back to the default width.
    // The array may hold an indirect reference, an indirect array, or the dictionary
    // itself, and a font that resolves to none of those has no readable widths. Saying so
    // is the point: falling back to `/DW` and then to 1000 makes every glyph one em wide,
    // which invents a gap where there is a letter fit.
    const table = simpleTable(parent, target, byNum, cmapOf) ?? cidTable(parent, byNum, cmapOf);
    if (table) fonts.set(m[1]!, table);
  }
  return fonts;
}

/**
 * A font with one-byte codes, whose advances live in a `/Widths` array indexed from
 * `/FirstChar`.
 *
 * These are the Type 3 subsets Chromium emits for a fallback face, and every CJK, Arabic
 * and Devanagari glyph in a document arrives through one. Leaving them out made a page of
 * eighteen of them report nothing at all, and reading them as if they were CID fonts made
 * every glyph one em wide because their code is half as long.
 *
 * A Type 3 glyph is drawn in the space its `/FontMatrix` describes, and that matrix is
 * where the units differ from a CID font's: Chromium writes `.001`, so a glyph 500 units
 * wide advances half an em. Scaling by the matrix puts the result back in the same
 * thousand-units-per-em the rest of the report works in.
 */
function simpleTable(
  parent: string,
  target: Obj,
  byNum: Map<number, Obj>,
  cmapOf: (num: number) => string | null,
): FontTable | null {
  const subtype = /\/Subtype\s*\/(Type3|TrueType|Type1|MMType1)/.exec(parent)?.[1];
  if (!subtype) return null;

  const first = Number(/\/FirstChar\s+(\d+)/.exec(parent)?.[1] ?? 0);
  // A Type 3 subset often has no `/FontDescriptor` at all, and one may name an object the
  // file does not contain. `!` on a map lookup is a compile-time assertion with no runtime
  // effect, and this runs in the render path, so the descriptor is read only if it is there.
  const descriptorNum = Number(/\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? NaN);
  const descriptor = Number.isFinite(descriptorNum) ? byNum.get(descriptorNum) : undefined;
  const missing = Number(
    descriptor ? (/\/MissingWidth\s+(-?[\d.]+)/.exec(dictOf(descriptor))?.[1] ?? 0) : 0,
  );
  const widths = parseWidths(parent);

  // The matrix maps glyph space to text space, so it carries the unit conversion. It is
  // absent for everything except Type 3, which works in a thousand-unit em.
  const matrix = Number(/\/FontMatrix\s*\[\s*(-?[\d.eE]+)/.exec(parent)?.[1] ?? 1);
  const scale = subtype === 'Type3' && matrix !== 0 ? matrix * 1000 : 1;

  const cmap = parseCMap(
    cmapOf(Number(/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? -1)) ?? '',
  );
  void target;
  return {
    codeBytes: 1,
    widthOf: (code: number) => (widths.get(code - first) ?? missing) * scale,
    unicodeOf: (code: number) => cmap.get(code) ?? '',
  };
}

function bracketEnd(dict: string, from: number): number {
  let depth = 0;
  for (let i = from; i < dict.length; i++) {
    if (dict[i] === '[') depth++;
    else if (dict[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `/Widths` array, which starts at `/FirstChar` and runs to `/LastChar`. */
function parseWidths(dict: string): Map<number, number> {
  const at = /\/Widths\s*\[/.exec(dict);
  if (!at) return new Map();
  const end = bracketEnd(dict, at.index + at[0].length - 1);
  if (end === -1) return new Map();
  const out = new Map<number, number>();
  let n = 0;
  for (const tok of dict.slice(at.index + at[0].length, end).split(/\s+/)) {
    const w = Number(tok);
    if (Number.isFinite(w)) out.set(n++, w);
  }
  return out;
}

/** A font whose codes are two bytes, with its advances in a `/W` array. */
function cidTable(
  parent: string,
  byNum: Map<number, Obj>,
  cmapOf: (num: number) => string | null,
): FontTable | null {
  // A font may be the descendant itself, with no `/Type0` parent above it.
  const inline = /\/Subtype\s*\/CIDFontType2/.test(parent);
  const kidObj = inline ? undefined : descendant(byNum, parent);
  const font = inline ? parent : kidObj ? dictOf(kidObj) : undefined;
  if (!font || !/\/Subtype\s*\/CIDFontType2/.test(font)) return null;

  const dw = Number(/\/DW\s+(-?[\d.]+)/.exec(font)?.[1] ?? 1000);
  const widths = parseW(font);
  const cmap = parseCMap(
    cmapOf(Number(/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? -1)) ?? '',
  );
  return {
    codeBytes: 2,
    widthOf: (cid: number) => widths.get(cid) ?? dw,
    unicodeOf: (cid: number) => cmap.get(cid) ?? '',
  };
}

/** The descendant a `/Type0` font names, in any of the three forms it may take. */
function descendant(byNum: Map<number, Obj>, parent: string): Obj | undefined {
  const inline = /\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(parent)?.[1];
  if (inline !== undefined) return byNum.get(Number(inline));
  const arrNum = /\/DescendantFonts\s+(\d+)\s+0\s+R/.exec(parent)?.[1];
  if (arrNum !== undefined) {
    const arr = byNum.get(Number(arrNum));
    const first = arr ? /(\d+)\s+0\s+R/.exec(dictOf(arr))?.[1] : undefined;
    if (first !== undefined) return byNum.get(Number(first));
  }
  // `/DescendantFonts [<< /Subtype /CIDFontType2 ... >>]`: the dictionary in the array.
  const direct = /\/DescendantFonts\s*\[\s*(<<)/.exec(parent);
  if (direct) {
    const start = direct.index + direct[0].length - 2;
    let depth = 0;
    for (let i = start; i < parent.length - 1; i++) {
      const pair = parent.slice(i, i + 2);
      if (pair === '<<') {
        depth++;
        i++;
      } else if (pair === '>>') {
        depth--;
        i++;
        if (depth === 0)
          return { num: -1, bytes: Buffer.from(parent.slice(start, i - 1), 'latin1') };
      }
    }
  }
  return undefined;
}

/**
 * Every content stream object a page draws through.
 *
 * `/Contents 12 0 R` is allowed to name an *array* object, `12 0 obj [13 0 R 14 0 R]`,
 * and treating 12 as a stream finds nothing for the page that uses it.
 */
function contentsOf(dict: string, byNum: Map<number, Obj>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (n: number): void => {
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  for (const m of dict.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) {
    const n = Number(m[1]);
    const target = byNum.get(n);
    // `dictOf` keeps the `N 0 obj` header, so the bracket is not the first thing in it.
    const isArray = target && /^\s*(?:\d+ \d+ obj\s*)?\[/.test(dictOf(target));
    if (isArray) for (const r of dictOf(target!).matchAll(/(\d+)\s+0\s+R/g)) push(Number(r[1]));
    else push(n);
  }
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? '';
  for (const n of array.matchAll(/(\d+)\s+0\s+R/g)) push(Number(n[1]));
  return out;
}

/**
 * Decoded ToUnicode CMap for every font that has one, keyed by object number.
 *
 * The CMap is a stream, usually Flate-compressed, so the body has to be inflated before it
 * can be read: matching the compressed bytes for `beginbfchar` finds nothing, every
 * character reads as unmapped, and every glyph looks drawn when it is a space.
 */
export function cmapStreams(pdf: Uint8Array): Map<number, string> {
  const parts = trySplit(pdf);
  const out = new Map<number, string>();
  if (!parts) return out;
  for (const o of parts.objs) {
    const range = streamRange(o.bytes);
    if (!range) continue;
    const raw = o.bytes.subarray(range.start, range.end);
    let text: string;
    try {
      text = (/FlateDecode/.test(dictOf(o)) ? inflateSync(raw) : Buffer.from(raw)).toString(LATIN1);
    } catch {
      continue;
    }
    if (/beginbfchar|beginbfrange/.test(text)) out.set(o.num, text);
  }
  return out;
}
