import { inflateSync } from "node:zlib";
import { inflatedStream, join, LATIN1, trySplit, type Obj } from "./pdfparts.ts";

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

  if (os2 && out.os2Version >= 2 && os2.length >= 88) out.sCapHeight = i16(font, os2.offset + 86);

  if (post && post.length >= 16) {
    const fixedPitch = font.readUInt32BE(post.offset + 12);
    out.italicAngle = i16(font, post.offset + 4) / 65536;
    if (fixedPitch !== 0 && fixedPitch !== 0xffff_ffff) out.fixedPitch = true;
  }

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

export function flagsFrom(font: Sfnt, current: number): number {
  let flags = current;
  const set = (bit: number, on: boolean) => {
    flags = on ? flags | bit : flags & ~bit;
  };

  set(4, !font.unicodeCmap);
  set(32, font.unicodeCmap);
  set(64, (font.macStyle & 0x02) !== 0 || font.italicAngle !== 0 || (font.fsSelection & 0x01) !== 0);
  if (font.fixedPitch !== undefined) set(1, font.fixedPitch);
  return flags;
}

function embeddedFont(o: Obj): Buffer | undefined {
  if (!/\/Length1\s+\d+/.test(o.bytes.toString(LATIN1))) return undefined;
  return inflatedStream(o, inflateSync);
}

export function fixFontDescriptors(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));

  const descriptorNums = new Set<number>();
  for (const o of parts.objs) {
    const text = o.bytes.toString(LATIN1);
    if (!/\/Subtype\s*\/(?:CIDFontType2|TrueType|Type3)\b/.test(text)) continue;
    const d = text.match(/\/FontDescriptor\s+(\d+) 0 R/);
    if (d) descriptorNums.add(Number(d[1]));
  }
  if (!descriptorNums.size) return pdf;

  const wanted = new Map<number, { flags: number; capHeight?: number }>();
  for (const num of descriptorNums) {
    const desc = byNum.get(num);
    if (!desc) continue;
    const text = desc.bytes.toString(LATIN1);
    const fileRef = text.match(/\/FontFile2\s+(\d+) 0 R/);
    if (!fileRef) {

      const cap = Number(text.match(/\/CapHeight\s+(-?\d+)/)?.[1] ?? NaN);
      const xHeight = Number(text.match(/\/XHeight\s+(-?\d+)/)?.[1] ?? NaN);
      if (Number.isFinite(cap) && cap < 0 && Number.isFinite(xHeight) && -cap > xHeight) {
        wanted.set(num, { flags: Number(text.match(/\/Flags\s+(\d+)/)?.[1] ?? 0), capHeight: -cap });
      }
      continue;
    }
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

export function unresolvedFontMetrics(pdf: Uint8Array): Array<{ fontName: string; capHeight: number }> {
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
      fontName: text.match(/\/FontName\s*\/([^\s/>\]]+)/)?.[1] ?? "unnamed",
      capHeight: cap,
    });
  }
  return out;
}
