import { LATIN1 } from './pdfparts.ts';

const u16 = (b: Buffer, at: number): number => b.readUInt16BE(at);
const i16 = (b: Buffer, at: number): number => b.readInt16BE(at);
const u32 = (b: Buffer, at: number): number => b.readUInt32BE(at);

const MAX_GID = 0xffff;
const MAX_CODEPOINT_SCAN = 0x40000;

type CmapSubtable = {
  platform: number;
  encoding: number;
  format: number;
  offset: number;
};

export function parseFontCmap(font: Buffer): Map<number, number> {
  try {
    return parseSfntCmap(font);
  } catch {
    return new Map();
  }
}

function parseSfntCmap(font: Buffer): Map<number, number> {
  const out = new Map<number, number>();
  if (!isSfnt(font) || font.length < 12) return out;

  const cmapOffset = findCmapOffset(font);
  if (cmapOffset === -1 || cmapOffset + 4 > font.length) return out;

  const candidates = collectCmapSubtables(font, cmapOffset);
  if (candidates.length === 0) return out;

  candidates.sort((a, b) => Number(b.format === 12) - Number(a.format === 12));

  for (const sub of candidates) {
    const parsed = parseSubtable(font, sub.offset, sub.format);
    if (parsed.size > 0) return parsed;
  }
  return out;
}

function isSfnt(font: Buffer): boolean {
  const tag = font.subarray(0, 4).toString(LATIN1);
  return ['true', 'OTTO', '\x00\x01\x00\x00'].includes(tag);
}

function findCmapOffset(font: Buffer): number {
  const numTables = u16(font, 4);
  if (numTables === 0 || 12 + numTables * 16 > font.length) return -1;

  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const name = font.subarray(at, at + 4).toString(LATIN1);
    if (name === 'cmap') return u32(font, at + 8);
  }
  return -1;
}

function collectCmapSubtables(font: Buffer, cmapOffset: number): CmapSubtable[] {
  const version = u16(font, cmapOffset);
  const numSubtables = u16(font, cmapOffset + 2);
  if (version !== 0) return [];

  const candidates: CmapSubtable[] = [];
  for (let i = 0; i < numSubtables; i++) {
    const rec = cmapOffset + 4 + i * 8;
    if (rec + 8 > font.length) break;
    const platform = u16(font, rec);
    const encoding = u16(font, rec + 2);
    const offset = u32(font, rec + 4);
    const at = cmapOffset + offset;
    if (at + 2 > font.length) continue;
    const format = u16(font, at);
    if (
      (platform === 0 && encoding >= 4) ||
      (platform === 3 && (encoding === 1 || encoding === 10))
    ) {
      candidates.push({ platform, encoding, format, offset: cmapOffset + offset });
    }
  }
  return candidates;
}

function parseSubtable(font: Buffer, offset: number, format: number): Map<number, number> {
  if (format === 4) return parseFormat4(font, offset);
  if (format === 12) return parseFormat12(font, offset);
  return new Map();
}

function parseFormat4(font: Buffer, offset: number): Map<number, number> {
  const out = new Map<number, number>();
  if (offset + 16 > font.length) return out;
  const segCountX2 = u16(font, offset + 6);
  const segCount = segCountX2 / 2;
  if (segCount === 0 || offset + 16 + segCountX2 * 4 > font.length) return out;

  const endCodeOff = offset + 14;
  const startCodeOff = endCodeOff + segCountX2 + 2;
  const idDeltaOff = startCodeOff + segCountX2;
  const idRangeOffsetOff = idDeltaOff + segCountX2;
  const glyphArrayOff = idRangeOffsetOff + segCountX2;
  let scanned = 0;

  for (let i = 0; i < segCount; i++) {
    const endCode = u16(font, endCodeOff + i * 2);
    const startCode = u16(font, startCodeOff + i * 2);
    const idDelta = i16(font, idDeltaOff + i * 2);
    const idRangeOffset = u16(font, idRangeOffsetOff + i * 2);
    if (startCode === 0xffff) continue;

    for (let cp = startCode; cp <= endCode; cp++) {
      if (++scanned > MAX_CODEPOINT_SCAN) return out;
      const gid = resolveGid(
        font,
        idRangeOffset,
        glyphArrayOff,
        segCount,
        i,
        cp,
        startCode,
        idDelta,
      );
      if (gid !== 0 && !out.has(gid)) out.set(gid, cp);
    }
  }
  return out;
}

function resolveGid(
  font: Buffer,
  idRangeOffset: number,
  glyphArrayOff: number,
  segCount: number,
  segIndex: number,
  cp: number,
  startCode: number,
  idDelta: number,
): number {
  if (idRangeOffset === 0) return (cp + idDelta) & 0xffff;
  const idx = idRangeOffset / 2 + (cp - startCode) - (segCount - segIndex);
  const gidOff = glyphArrayOff + idx * 2;
  if (gidOff + 2 > font.length) return 0;
  const gid = u16(font, gidOff);
  return gid !== 0 ? (gid + idDelta) & 0xffff : 0;
}

function parseFormat12(font: Buffer, offset: number): Map<number, number> {
  const out = new Map<number, number>();
  if (offset + 16 > font.length) return out;
  const nGroups = u32(font, offset + 12);
  let goff = offset + 16;
  let scanned = 0;
  for (let i = 0; i < nGroups; i++) {
    if (goff + 12 > font.length) break;
    const startCp = u32(font, goff);
    const endCp = u32(font, goff + 4);
    const startGlyph = u32(font, goff + 8);
    for (let j = 0; j <= endCp - startCp; j++) {
      if (++scanned > MAX_CODEPOINT_SCAN) return out;
      const gid = startGlyph + j;
      if (gid > MAX_GID) break;
      if (gid !== 0 && !out.has(gid)) out.set(gid, startCp + j);
    }
    goff += 12;
  }
  return out;
}
