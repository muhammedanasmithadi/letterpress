/**
 * Font descriptor correction.
 *
 * Chromium writes `/CapHeight -714` and `/Flags 4` into every font descriptor it
 * emits. Both are wrong, and neither can be fixed by supplying a better value,
 * because a negative cap height is not a wrong number — it is an absent one. The
 * answer is already in the document: the embedded font declares it.
 *
 * Measured on a font this engine embedded, NotoSans-Regular at 30,280 bytes:
 *
 *   Chromium   /CapHeight -714   /Flags 4
 *   the font   OS/2 sCapHeight 536, USE_TYPO_METRICS set
 *              head.macStyle 0, post.italicAngle 0, OS/2.fsSelection 0x00C0
 *
 * `sCapHeight` is what the PDF specification asks for — the height of `H` — and
 * the font states it. The flags follow from the same tables: a font with a
 * Unicode cmap that is neither italic nor monospaced is a non-symbolic upright
 * text font, so Flags carries Nonsymbolic rather than Symbolic.
 *
 * Reading the value out of the font is the difference between this being correct
 * for every font in every document and being correct for the shapes this one
 * happens to use.
 *
 * Scope is bounded by what is derivable. Serif and Script are not reliably
 * decidable from the tables and are left alone. A font with no sfnt directory,
 * which means CFF or Type 1, is skipped. So is one whose OS/2 predates version 2
 * or whose sCapHeight is not positive, because then there is nothing to read.
 */

import { inflateSync } from "node:zlib";

const LATIN1 = "latin1" as BufferEncoding;
const NEWLINE = Buffer.from("\n", LATIN1);

/* ------------------------------------------------------------------ *
 * Whole-file surgery
 * ------------------------------------------------------------------ */

type Obj = { num: number; bytes: Buffer };

/**
 * Split a PDF into header, indirect objects and trailer.
 *
 * Object offsets are what the cross-reference table stores, so anything that
 * changes a stream's length invalidates the table and it must be rebuilt.
 */
function split(raw: Buffer): { head: Buffer; objs: Obj[]; trailer: Buffer } {
  const text = raw.toString(LATIN1);
  const starts: Array<{ num: number; at: number }> = [];
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)) {
    starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== "0" ? 1 : 0) });
  }
  const trailerAt = text.indexOf("\ntrailer\n");
  if (!starts.length || trailerAt === -1) throw new Error("not a linear pdf");
  const objs: Obj[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    // An object ends at its own `endobj`, not at the next header: a stream
    // payload may contain bytes that look like one.
    const endObj = text.indexOf("endobj", from);
    const next = i + 1 < starts.length ? starts[i + 1].at : trailerAt;
    const to = endObj !== -1 && endObj + 6 <= next ? endObj + 6 : next;
    objs.push({ num: starts[i].num, bytes: raw.subarray(from, to) });
  }
  // The trailer stops at the file's own `startxref`, not at `%%EOF`. Slicing to
  // `%%EOF` carried the old pointer along, and appending a fresh one produced two
  // `startxref` lines: readers disagreed about which to honour, and the stale
  // offset pointed into the middle of the rebuilt table.
  const oldStartxref = text.indexOf("\nstartxref", trailerAt);
  if (oldStartxref === -1) throw new Error("no startxref");
  return {
    head: raw.subarray(0, starts[0].at),
    objs,
    trailer: raw.subarray(trailerAt + 1, oldStartxref),
  };
}

/** Reassemble objects into a file with a freshly computed cross-reference table. */
function join(head: Buffer, objs: Obj[], trailer: Buffer): Buffer {
  const parts: Buffer[] = [head];
  const at = new Map<number, number>();
  let length = head.length;
  for (const o of objs) {
    at.set(o.num, length);
    parts.push(o.bytes);
    length += o.bytes.length;
    // A newline after every object, so the last one does not end glued to the
    // keyword that follows. `endobjxref` is one token to a reader: ghostscript
    // reported "object lacks an endobj" and stopped there, while poppler happened
    // to recover and read the file anyway.
    parts.push(NEWLINE);
    length += 1;
  }
  const size = Math.max(...objs.map((o) => o.num)) + 1;
  const xrefAt = length;
  parts.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, LATIN1));
  for (let n = 1; n < size; n++) {
    const off = at.get(n);
    // Chromium numbers its objects contiguously, so a free entry here means the
    // input had a gap. It is written as the tail of the free list, which no
    // reference can reach.
    parts.push(Buffer.from(
      off === undefined ? "0000000000 65535 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`, LATIN1));
  }
  // /Size is one past the highest object number. Trusting the input's value is
  // how a rebuilt table ends up contradicting itself.
  const fixed = Buffer.from(trailer.toString(LATIN1).replace(/\/Size\s+\d+/, `/Size ${size}`), LATIN1);
  parts.push(fixed, NEWLINE, Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, LATIN1));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * sfnt
 * ------------------------------------------------------------------ */

type Table = { offset: number; length: number };
type Sfnt = {
  unitsPerEm: number;
  macStyle: number;
  /** OS/2 table version, or 0 when there is none. */
  os2Version: number;
  sCapHeight: number;
  fsSelection: number;
  italicAngle: number;
  /** True when the font carries a cmap that maps Unicode rather than symbols. */
  unicodeCmap: boolean;
  fixedPitch: boolean | undefined;
};

const u16 = (b: Buffer, at: number) => b.readUInt16BE(at);
const i16 = (b: Buffer, at: number) => b.readInt16BE(at);
const u32 = (b: Buffer, at: number) => b.readUInt32BE(at);

/**
 * Read the tables this fix needs out of an embedded sfnt font.
 *
 * Returns undefined for anything that is not a TrueType/OpenType outline font:
 * a CFF or Type 1 face has no table directory to read, and guessing at its
 * metrics from the PDF descriptor would be inventing them.
 */
export function parseSfnt(font: Buffer): Sfnt | undefined {
  if (font.length < 12) return undefined;
  // 0x00010000 is TrueType outlines, "true" and "OTTO" are the other two.
  const tag = font.readUInt32BE(0);
  const isSfnt = tag === 0x00010000 || font.subarray(0, 4).toString(LATIN1) === "true"
    || font.subarray(0, 4).toString(LATIN1) === "OTTO";
  if (!isSfnt) return undefined;

  const numTables = u16(font, 4);
  if (numTables === 0 || 12 + numTables * 16 > font.length) return undefined;

  const tables = new Map<string, Table>();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const name = font.subarray(at, at + 4).toString(LATIN1);
    const offset = u32(font, at + 8);
    const length = u32(font, at + 12);
    if (offset + length <= font.length) tables.set(name, { offset, length });
  }

  const head = tables.get("head");
  const os2 = tables.get("OS/2");
  const post = tables.get("post");
  if (!head || head.length < 54) return undefined;

  const out: Sfnt = {
    unitsPerEm: u16(font, head.offset + 18) || 1000,
    macStyle: u16(font, head.offset + 44),
    os2Version: os2 ? u16(font, os2.offset) : 0,
    sCapHeight: 0,
    fsSelection: os2 && os2.length >= 64 ? u16(font, os2.offset + 62) : 0,
    italicAngle: 0,
    unicodeCmap: false,
    fixedPitch: undefined,
  };

  // sCapHeight was added in OS/2 version 2. Version 0 and 1 have no such field,
  // so reading it would return whatever sits at that offset.
  if (os2 && out.os2Version >= 2 && os2.length >= 88) out.sCapHeight = i16(font, os2.offset + 86);

  if (post && post.length >= 16) {
    const fixedPitch = font.readUInt32BE(post.offset + 12);
    out.italicAngle = i16(font, post.offset + 4) / 65536;
    if (fixedPitch !== 0 && fixedPitch !== 0xffff_ffff) out.fixedPitch = true;
  }

  // Symbolic versus not: a font whose cmap maps Unicode is a text font, and the
  // specification says a text font is Nonsymbolic.
  const cmap = tables.get("cmap");
  if (cmap && cmap.length >= 4) {
    const n = u16(font, cmap.offset + 2);
    for (let i = 0; i < n; i++) {
      const rec = cmap.offset + 4 + i * 8;
      if (rec + 8 > font.length) break;
      const platform = u16(font, rec);
      const encoding = u16(font, rec + 2);
      const unicode = (platform === 3 && (encoding === 1 || encoding === 10))
        || (platform === 0 && encoding >= 4);
      if (unicode) { out.unicodeCmap = true; break; }
    }
  }
  return out;
}

/**
 * The Flags value the font's own tables describe.
 *
 * Only bits that are decidable are set. Serif and Script are not, so whatever the
 * producer wrote is preserved.
 */
export function flagsFrom(font: Sfnt, current: number): number {
  let flags = current;
  const set = (bit: number, on: boolean) => {
    flags = on ? flags | bit : flags & ~bit;
  };
  // PDF FontFlags: 1 FixedPitch, 3 Symbolic, 7 Nonsymbolic, 8 Italic.
  set(4, !font.unicodeCmap);
  set(32, font.unicodeCmap);
  set(64, (font.macStyle & 0x02) !== 0 || font.italicAngle !== 0 || (font.fsSelection & 0x01) !== 0);
  if (font.fixedPitch !== undefined) set(1, font.fixedPitch);
  return flags;
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

/** The FontFile2 payload of an object, decompressed. */
function embeddedFont(o: Obj): Buffer | undefined {
  const text = o.bytes.toString(LATIN1);
  if (!/\/Length1\s+\d+/.test(text)) return undefined;
  const marker = text.match(/stream\r?\n/);
  if (!marker || marker.index === undefined) return undefined;
  const at = marker.index + marker[0].length;
  const end = text.lastIndexOf("\nendstream");
  if (end <= at) return undefined;
  try {
    return inflateSync(o.bytes.subarray(at, end));
  } catch {
    return undefined;
  }
}

/**
 * A Buffer view over any Uint8Array, without copying.
 *
 * `pdf as Buffer` is a type assertion, not a conversion, and it leaves a
 * Uint8Array in place. Its toString ignores the encoding argument and returns no
 * bytes at all, so split found no objects and every function here passed its
 * input through untouched and silently. That is the failure this exists to stop.
 */
function asBuffer(pdf: Uint8Array): Buffer {
  return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}

/**
 * Rewrite every font descriptor the embedded fonts can speak for.
 *
 * Returns the input byte for byte when there is nothing to correct, which is the
 * normal case for a file whose descriptors are already right.
 */
export function fixFontDescriptors(pdf: Uint8Array): Uint8Array {
  const raw = asBuffer(pdf);
  let parts: { head: Buffer; objs: Obj[]; trailer: Buffer };
  try {
    parts = split(raw);
  } catch {
    return pdf;
  }

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  // CIDFontType2 and simple TrueType fonts both name a descriptor and a face.
  const descriptorNums = new Set<number>();
  for (const o of parts.objs) {
    const text = o.bytes.toString(LATIN1);
    if (!/\/Subtype\s*\/(?:CIDFontType2|TrueType)\b/.test(text)) continue;
    const d = text.match(/\/FontDescriptor\s+(\d+) 0 R/);
    if (d) descriptorNums.add(Number(d[1]));
  }
  if (!descriptorNums.size) return pdf;

  // Resolve each descriptor's flags and cap height from its own face.
  const wanted = new Map<number, { flags: number; capHeight?: number }>();
  for (const num of descriptorNums) {
    const desc = byNum.get(num);
    if (!desc) continue;
    const text = desc.bytes.toString(LATIN1);
    const fileRef = text.match(/\/FontFile2\s+(\d+) 0 R/);
    if (!fileRef) continue; // CFF or Type 1: nothing to read, so nothing to do.
    const face = byNum.get(Number(fileRef[1]));
    if (!face) continue;
    const font = embeddedFont(face);
    if (!font) continue;
    const sfnt = parseSfnt(font);
    if (!sfnt) continue;

    const flags = Number(text.match(/\/Flags\s+(\d+)/)?.[1] ?? NaN);
    if (!Number.isFinite(flags)) continue;
    const cap = Number(text.match(/\/CapHeight\s+(-?\d+)/)?.[1] ?? NaN);

    const next: { flags: number; capHeight?: number } = { flags: flagsFrom(sfnt, flags) };
    // Only replace a cap height that is not usable. A font with no sCapHeight to
    // read keeps whatever the producer wrote, wrong or not, because inventing one
    // would be worse than leaving it.
    if (sfnt.sCapHeight > 0 && sfnt.os2Version >= 2 && (!Number.isFinite(cap) || cap <= 0)) {
      next.capHeight = Math.round((sfnt.sCapHeight / sfnt.unitsPerEm) * 1000);
    }
    if (next.flags !== flags || next.capHeight !== undefined) wanted.set(num, next);
  }
  if (!wanted.size) return pdf;

  const objs = parts.objs.map((o) => {
    const fix = wanted.get(o.num);
    if (!fix) return o;
    let text = o.bytes.toString(LATIN1);
    text = text.replace(/\/Flags\s+\d+/, `/Flags ${fix.flags}`);
    if (fix.capHeight !== undefined) {
      text = text.replace(/\/CapHeight\s+-?\d+/, `/CapHeight ${fix.capHeight}`);
    }
    return { num: o.num, bytes: Buffer.from(text, LATIN1) };
  });

  return join(parts.head, objs, parts.trailer);
}

/**
 * Descriptors still carrying a cap height that nothing in the file can answer for.
 *
 * Chromium emits a Type 3 font when it cannot embed a face — most often for CJK
 * and emoji — and a Type 3 font's glyphs are drawing procedures with no font
 * program at all. There is no OS/2 table to read and no sibling face guaranteed to
 * be the same weight, so the metric is not derivable and is left as it arrived.
 *
 * This is not a cosmetic leftover. The specification calls a negative CapHeight
 * an error for a viewer to render text over, so it is reported rather than passed
 * over in silence.
 *
 * Called on the output of `fixFontDescriptors`, anything it names is by
 * definition a descriptor with no embedded font to derive from.
 */
export function unresolvedFontMetrics(pdf: Uint8Array): Array<{ fontName: string; capHeight: number }> {
  const out: Array<{ fontName: string; capHeight: number }> = [];
  let parts: { head: Buffer; objs: Obj[]; trailer: Buffer };
  try {
    parts = split(asBuffer(pdf));
  } catch {
    return out;
  }
  for (const o of parts.objs) {
    const text = o.bytes.toString(LATIN1);
    if (!/\/Type\s*\/FontDescriptor\b/.test(text)) continue;
    const cap = Number(text.match(/\/CapHeight\s+(-?\d+)/)?.[1]);
    if (!(cap < 0)) continue;
    if (/\/FontFile\d?\s+\d+\s+0\s+R/.test(text)) continue;
    out.push({
      fontName: text.match(/\/FontName\s*\/([^\s/>\]]+)/)?.[1] ?? "unnamed",
      capHeight: cap,
    });
  }
  return out;
}