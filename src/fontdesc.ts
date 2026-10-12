import { inflateSync } from 'node:zlib';
import {
  inflatedStream,
  join,
  LATIN1,
  objsByNum,
  trySplit,
  type Obj,
  type Parts,
} from './pdfparts.ts';

type Table = { offset: number; length: number };
type Sfnt = {
  unitsPerEm: number;
  macStyle: number;

  os2Version: number;
  sCapHeight: number;
  fsSelection: number;
  italicAngle: number;

  unicodeCmap: boolean;
  fixedPitch: boolean | undefined;
};

const u16 = (b: Buffer, at: number) => b.readUInt16BE(at);
const i16 = (b: Buffer, at: number) => b.readInt16BE(at);
const u32 = (b: Buffer, at: number) => b.readUInt32BE(at);

export function parseSfnt(font: Buffer): Sfnt | undefined {
  if (font.length < 12) return undefined;
  if (!isSfntTag(font)) return undefined;

  const numTables = u16(font, 4);
  if (numTables === 0 || 12 + numTables * 16 > font.length) return undefined;

  const tables = readTableDirectory(font, numTables);

  const head = tables.get('head');
  const os2 = tables.get('OS/2');
  const post = tables.get('post');
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

  if (os2 && out.os2Version >= 2 && os2.length >= 88) out.sCapHeight = i16(font, os2.offset + 86);

  if (post) readPost(font, post, out);
  out.unicodeCmap = hasUnicodeCmap(font, tables.get('cmap'));
  return out;
}

/** The sfnt magic number, whether big-endian CFF (`OTTO`) or TrueType (`true`/`0x00010000`). */
function isSfntTag(font: Buffer): boolean {
  return (
    font.readUInt32BE(0) === 0x00010000 ||
    font.subarray(0, 4).toString(LATIN1) === 'true' ||
    font.subarray(0, 4).toString(LATIN1) === 'OTTO'
  );
}

/** The table directory, keeping only tables whose extent lies inside the file. */
function readTableDirectory(font: Buffer, numTables: number): Map<string, Table> {
  const tables = new Map<string, Table>();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const name = font.subarray(at, at + 4).toString(LATIN1);
    const offset = u32(font, at + 8);
    const length = u32(font, at + 12);
    if (offset + length <= font.length) tables.set(name, { offset, length });
  }
  return tables;
}

/** Italic angle and fixed-pitch flag from the `post` table, when it is long enough. */
function readPost(font: Buffer, post: Table, out: Sfnt): void {
  if (post.length < 16) return;
  const fixedPitch = font.readUInt32BE(post.offset + 12);
  out.italicAngle = i16(font, post.offset + 4) / 65536;
  if (fixedPitch !== 0 && fixedPitch !== 0xffff_ffff) out.fixedPitch = true;
}

/** Whether the `cmap` table names a Unicode platform/encoding pair. */
function hasUnicodeCmap(font: Buffer, cmap: Table | undefined): boolean {
  if (!cmap || cmap.length < 4) return false;
  const n = u16(font, cmap.offset + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmap.offset + 4 + i * 8;
    if (rec + 8 > font.length) break;
    const platform = u16(font, rec);
    const encoding = u16(font, rec + 2);
    if (
      (platform === 3 && (encoding === 1 || encoding === 10)) ||
      (platform === 0 && encoding >= 4)
    )
      return true;
  }
  return false;
}

export function flagsFrom(font: Sfnt, current: number): number {
  let flags = current;
  const set = (bit: number, on: boolean) => {
    flags = on ? flags | bit : flags & ~bit;
  };

  set(4, !font.unicodeCmap);
  set(32, font.unicodeCmap);
  set(
    64,
    (font.macStyle & 0x02) !== 0 || font.italicAngle !== 0 || (font.fsSelection & 0x01) !== 0,
  );
  if (font.fixedPitch !== undefined) set(1, font.fixedPitch);
  return flags;
}

function embeddedFont(o: Obj): Buffer | undefined {
  if (!/\/Length1\s+\d+/.test(o.bytes.toString(LATIN1))) return undefined;
  return inflatedStream(o, inflateSync);
}

type DescriptorFix = { flags: number; capHeight?: number };

export function fixFontDescriptors(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = objsByNum(parts);
  const descriptorNums = referencedDescriptors(parts.objs);
  if (!descriptorNums.size) return pdf;

  const wanted = fixesFor(descriptorNums, byNum);
  return wanted.size ? applyDescriptorFixes(parts, wanted) : pdf;
}

/** The FontDescriptor numbers that CID/TrueType/Type3 fonts point at. */
function referencedDescriptors(objs: Obj[]): Set<number> {
  const nums = new Set<number>();
  for (const o of objs) {
    const text = o.bytes.toString(LATIN1);
    if (!/\/Subtype\s*\/(?:CIDFontType2|TrueType|Type3)\b/.test(text)) continue;
    const d = text.match(/\/FontDescriptor\s+(\d+) 0 R/);
    if (d) nums.add(Number(d[1]));
  }
  return nums;
}

/** The corrected flags/cap-height for each descriptor that needs one. */
function fixesFor(
  descriptorNums: Set<number>,
  byNum: Map<number, Obj>,
): Map<number, DescriptorFix> {
  const wanted = new Map<number, DescriptorFix>();
  for (const num of descriptorNums) {
    const desc = byNum.get(num);
    if (!desc) continue;
    const fix = descriptorFix(desc.bytes.toString(LATIN1), byNum);
    if (fix) wanted.set(num, fix);
  }
  return wanted;
}

/** The number captured by the first match of `re` in `text`, or `fallback` when absent. */
function numFrom(text: string, re: RegExp, fallback: number): number {
  return Number(text.match(re)?.[1] ?? fallback);
}

/** The CapHeight a descriptor should carry, where the font's own metrics improve on it. */
function capHeightFix(sfnt: Sfnt, cap: number): number | undefined {
  if (sfnt.sCapHeight > 0 && sfnt.os2Version >= 2 && (!Number.isFinite(cap) || cap <= 0)) {
    return Math.round((sfnt.sCapHeight / sfnt.unitsPerEm) * 1000);
  }
  return undefined;
}

/** New flags/cap-height for one descriptor, or undefined when nothing changes. */
function descriptorFix(text: string, byNum: Map<number, Obj>): DescriptorFix | undefined {
  const fileRef = text.match(/\/FontFile2\s+(\d+) 0 R/);
  if (!fileRef) return negativeCapHeightFix(text);

  const face = byNum.get(Number(fileRef[1]));
  if (!face) return undefined;
  const font = embeddedFont(face);
  if (!font) return undefined;
  const sfnt = parseSfnt(font);
  if (!sfnt) return undefined;

  const flags = numFrom(text, /\/Flags\s+(\d+)/, NaN);
  if (!Number.isFinite(flags)) return undefined;
  const newFlags = flagsFrom(sfnt, flags);
  const capHeight = capHeightFix(sfnt, numFrom(text, /\/CapHeight\s+(-?\d+)/, NaN));
  if (newFlags === flags && capHeight === undefined) return undefined;
  const next: DescriptorFix = { flags: newFlags };
  if (capHeight !== undefined) next.capHeight = capHeight;
  return next;
}

/** A descriptor with no embedded font, where a negative CapHeight exceeds XHeight. */
function negativeCapHeightFix(text: string): DescriptorFix | undefined {
  const cap = numFrom(text, /\/CapHeight\s+(-?\d+)/, NaN);
  const xHeight = numFrom(text, /\/XHeight\s+(-?\d+)/, NaN);
  if (!(Number.isFinite(cap) && cap < 0 && Number.isFinite(xHeight) && -cap > xHeight)) {
    return undefined;
  }
  return { flags: numFrom(text, /\/Flags\s+(\d+)/, 0), capHeight: -cap };
}

/** Rewrite the flagged descriptors, leaving every other object untouched. */
function applyDescriptorFixes(parts: Parts, wanted: Map<number, DescriptorFix>): Uint8Array {
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

export function unresolvedFontMetrics(
  pdf: Uint8Array,
): Array<{ fontName: string; capHeight: number }> {
  const out: Array<{ fontName: string; capHeight: number }> = [];
  const parts = trySplit(pdf);
  if (!parts) return out;
  for (const o of parts.objs) {
    const text = o.bytes.toString(LATIN1);
    if (!/\/Type\s*\/FontDescriptor\b/.test(text)) continue;
    const cap = Number(text.match(/\/CapHeight\s+(-?\d+)/)?.[1]);
    if (!(cap < 0)) continue;
    if (/\/FontFile\d?\s+\d+\s+0\s+R/.test(text)) continue;
    out.push({
      fontName: text.match(/\/FontName\s*\/([^\s/>\]]+)/)?.[1] ?? 'unnamed',
      capHeight: cap,
    });
  }
  return out;
}
