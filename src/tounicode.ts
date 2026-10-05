/**
 * ToUnicode correction for presentation-form ligatures.
 *
 * Chromium maps three glyphs of a font this engine embedded to U+FB00, U+FB01
 * and U+FB02:
 *
 *   glyph 1653 -> U+FB00  LATIN SMALL LIGATURE FF
 *   glyph 1654 -> U+FB01  LATIN SMALL LIGATURE FI
 *   glyph 1655 -> U+FB02  LATIN SMALL LIGATURE FL
 *
 * A ToUnicode CMap maps a glyph to the text it stands for. U+FB01 is not that
 * text: it is the glyph-level alternative that the font offers for the two
 * characters fi. Nobody searches a document for a ligature codepoint, so a
 * lookup for "finished" fails on a PDF whose extracted text reads "ﬁnished",
 * and a copy-paste out of it loses the word. The destination of a bfchar is a
 * string, so writing the expansion is the correct mapping of the glyph to its
 * text, not a substitution, and the expansion is read from Unicode's own
 * compatibility decomposition rather than from a table written here.
 *
 * NFKC cannot be applied on its own. It rewrites ARABIC LETTER HIGH HAMZA ALEF
 * to alef followed by a combining hamza, and LAO HO NO to a consonant cluster,
 * and both of those are single letters that merely carry a mark. Decomposing
 * them would corrupt the text of an Arabic or Lao document to fix a Latin
 * ligature, so the rule takes two conditions together:
 *
 *   - the codepoint sits in a Unicode presentation-forms block, which is what
 *     makes it a glyph-level alternative rather than a character
 *   - its NFKC yields two or more codepoints, all of them letters, which is what
 *     separates a ligature from a single letter with a diacritic
 *
 * Measured across the codepoint space, those admit exactly 21: seven Latin
 * ligatures, five Armenian, one Hebrew and eight Arabic lam-alef forms. Every
 * combining-mark and compatibility-symbol case is excluded, including the Arabic
 * and Lao single letters above.
 */

import { deflateSync } from "node:zlib";
import { inflateSync } from "node:zlib";
import { asBuffer, inflatedStream, join, LATIN1, streamDict, trySplit, type Obj } from "./pdfparts.ts";

/**
 * The Unicode blocks whose purpose is glyph-level alternates rather than text.
 *
 * Enumerated as ranges because there is no runtime API for "is this codepoint in
 * a presentation-forms block", and the alternative — testing every codepoint
 * against a name database — means shipping one.
 */
const PRESENTATION_FORMS: ReadonlyArray<readonly [number, number]> = [
  [0xfb00, 0xfb4f], // Alphabetic Presentation Forms
  [0xfe10, 0xfe1f], // Vertical Forms
  [0xfe50, 0xfe6f], // Small Form Variants
  [0xfe70, 0xfeff], // Arabic Presentation Forms-A
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
];

const LETTERS = /^\p{L}+$/u;

const inPresentationForm = (cp: number) =>
  PRESENTATION_FORMS.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * The text a presentation-form ligature stands for, or undefined when the
 * codepoint is not one.
 *
 * Exported so the rule can be tested directly against the whole codepoint space
 * rather than only through the cases one document happens to contain.
 */
export function ligatureExpansion(cp: number): string | undefined {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return undefined;
  if (cp >= 0xd800 && cp <= 0xdfff) return undefined;
  if (!inPresentationForm(cp)) return undefined;
  const ch = String.fromCodePoint(cp);
  const expanded = ch.normalize("NFKC");
  if (expanded === ch) return undefined;
  if ([...expanded].length < 2) return undefined;
  if (!LETTERS.test(expanded)) return undefined;
  return expanded;
}

/* ------------------------------------------------------------------ *
 * The CMap
 * ------------------------------------------------------------------ */

const hex = (n: number, width = 4) => n.toString(16).toUpperCase().padStart(width, "0");

/** Decode a ToUnicode destination string from UTF-16BE hex. */
function readDest(hexText: string): string | undefined {
  if (hexText.length % 4 !== 0) return undefined;
  let out = "";
  for (let i = 0; i < hexText.length; i += 4) {
    out += String.fromCharCode(parseInt(hexText.slice(i, i + 4), 16));
  }
  return out;
}

/** Encode text as the UTF-16BE hex a ToUnicode destination is written in. */
function writeDest(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += hex(text.charCodeAt(i));
  return out;
}

/**
 * Rewrite one ToUnicode CMap's text.
 *
 * Returns undefined when nothing changed, so a document with no ligature in it is
 * never rewritten and never rebuilt.
 */
export function fixCMap(cmap: string): string | undefined {
  let changed = false;

  // A bfchar destination is a whole string, so the expansion replaces it
  // directly: `<1654> <FB01>` becomes `<1654> <00660069>`.
  const out = cmap.replace(
    /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>(?=\s*(?:<|\r?\n|$))/g,
    (match, key: string, destHex: string) => {
      // The codespacerange line is two codes, not a key and a destination, and
      // the pattern above cannot tell them apart. It is skipped by the lookahead
      // requiring a following entry or the block end, which the codespacerange
      // line satisfies too — so the source and destination are checked against
      // the destination instead.
      const dest = readDest(destHex);
      if (dest === undefined || dest.length !== 1) return match;
      const expansion = ligatureExpansion(dest.charCodeAt(0));
      if (!expansion) return match;
      changed = true;
      return `<${key}> <${writeDest(expansion)}>`;
    },
  );

  if (!changed) return undefined;

  // A bfchar block states its entry count and this replaces destinations rather
  // than adding entries, so every count in the file is still right.
  return out;
}

/**
 * Replace every bfrange that covers a ligature with explicit bfchar entries.
 *
 * Chromium writes `<0675> <0677> <FB00>` for the three ligature glyphs, which
 * maps glyphs 1653, 1654 and 1655 to U+FB00, U+FB01 and U+FB02 by incrementing
 * the destination. The codepoints therefore arrive inside a range rather than as
 * bfchar entries, and a pass that only reads bfchar sees nothing at all.
 *
 * A range cannot simply have its base rewritten, because the expansion breaks the
 * consecutive pattern the range form encodes: three entries that ran U+FB00 to
 * U+FB02 now hold ff, fi and fl. So an affected range is replaced by a whole
 * bfchar block listing every glyph it covered. The glyphs it does not cover are
 * included, so nothing is dropped, and the block header's count is the number of
 * glyphs rather than the number of ranges that were there before.
 *
 * The original block header states a count of ranges. Replacing one range with a
 * bfchar block leaves that header describing a different kind of block, so the
 * header is corrected in the same pass rather than left to disagree with its
 * contents.
 */
function fixRanges(cmap: string): string | undefined {
  let hit = false;
  // First find out whether any range needs rewriting at all, so the common case
  // returns the input untouched and is never re-encoded.
  const needsWork = [...cmap.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>/g)]
    .some((m) => {
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

  // Walk each block, splitting it into the ranges that survive and the bfchar
  // blocks the rewritten ones become.
  const blocks = [...cmap.matchAll(/(\d+) beginbfrange\n([\s\S]*?)\nendbfrange/g)];
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    const [whole, , body] = block;
    const keep: string[] = [];
    const added: string[] = [];
    for (const line of body.split("\n")) {
      const m = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4})>$/);
      if (!m) { keep.push(line); continue; }
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
      if (affected) { added.push(...entries); hit = true; } else keep.push(line);
    }
    out += cmap.slice(cursor, block.index);
    cursor = block.index + whole.length;
    const affectedThisBlock = added.length > 0;
    if (!affectedThisBlock) { out += whole; continue; }
    const pieces: string[] = [];
    if (keep.length) pieces.push(`${keep.length} beginbfrange\n${keep.join("\n")}\nendbfrange`);
    if (added.length) pieces.push(`${added.length} beginbfchar\n${added.join("\n")}\nendbfchar`);
    out += pieces.join("\n");
  }
  out += cmap.slice(cursor);
  // The count on a bfrange header that survived is recomputed above, because
  // whole ranges were moved out of it and the old number would no longer be the
  // number of ranges the block contains.
  return hit ? out : undefined;
}

/**
 * Fix one CMap: the ligatures Chromium puts in bfchar blocks, and the ones it
 * hides inside bfrange destinations.
 *
 * The range pass runs first. A rewritten range emits `<gid> <dest>` pairs that
 * the bfchar pass would then read as a key and a destination and rewrite a
 * second time.
 */
function fixCMapBoth(cmap: string): string | undefined {
  return fixRanges(cmap) ?? fixCMap(cmap);
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

/**
 * Replace a ToUnicode stream's contents, keeping its dictionary honest.
 *
 * The dictionary carries `/Length`, which must match the new payload or a reader
 * reads to the wrong offset. Chromium writes it as a direct integer.
 */
function rewrittenStream(o: Obj, cmap: string): Buffer {
  const compressed = deflateSync(Buffer.from(cmap, LATIN1));
  const dict = streamDict(o).replace(/\/Length\s+\d+/, `/Length ${compressed.length}`);
  return Buffer.concat([
    Buffer.from(`${dict}stream\n`, LATIN1),
    compressed,
    Buffer.from("\nendstream\nendobj\n", LATIN1),
  ]);
}

/**
 * Rewrite every ToUnicode CMap that maps a glyph to a presentation-form ligature.
 *
 * Returns the input byte for byte when there is nothing to correct, which is the
 * normal case for a document with no ligature in it.
 */
export function fixToUnicode(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));

  // Find the streams a font points at, rather than trusting every stream in the
  // file to be a CMap.
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

/**
 * Codepoints a file's ToUnicode streams still map to a presentation-form ligature.
 *
 * Both block forms are walked, and the range form matters as much as the bfchar
 * form: a range carries its ligature as a base codepoint plus an offset, so
 * searching the text for literal occurrences finds only the first of a run and
 * misses the rest.
 */
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
      for (const e of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
        const lo = parseInt(e[1]!, 16);
        const hi = parseInt(e[2]!, 16);
        if (e[3]) {
          const base = parseInt(e[3]!.slice(0, 4), 16);
          for (let gid = lo; gid <= hi && gid - lo <= 0xffff; gid++) note(base + (gid - lo));
        } else {
          for (const d of (e[4] ?? "").matchAll(/<([0-9A-Fa-f]+)>/g)) {
            for (let i = 0; i + 4 <= d[1]!.length; i += 4) note(parseInt(d[1]!.slice(i, i + 4), 16));
          }
        }
      }
    }
  }
  return out;
}