import { describe, expect, test } from 'bun:test';
import { parseFontCmap } from '../src/fontcmap.ts';
import { format12, format4, P0E4, P3E1, sfntWithCmap } from './sfnt.ts';

describe('parseFontCmap', () => {
  test('format 4 segments map a codepoint range through idDelta', () => {
    const font = sfntWithCmap([P3E1(format4([[0x0041, 0x0043, 5, 0]]))]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(3);
    expect(map.get(0x46)).toBe(0x41);
    expect(map.get(0x47)).toBe(0x42);
    expect(map.get(0x48)).toBe(0x43);
    expect(map.has(0x45)).toBe(false);
  });

  test('format 4 glyph arrays resolve through indirection', () => {
    const font = sfntWithCmap([P3E1(format4([[0x0061, 0x0062, 0, 4]], [0x2a, 0x2b]))]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(2);
    expect(map.get(0x2a)).toBe(0x61);
    expect(map.get(0x2b)).toBe(0x62);
  });

  test('a glyph id of zero is never mapped, whatever the codepoint', () => {
    const font = sfntWithCmap([P3E1(format4([[0xfffa, 0xfffc, 6, 0]]))]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(2);
    expect(map.get(0x1)).toBe(0xfffb);
    expect(map.get(0x2)).toBe(0xfffc);
    expect(map.has(0)).toBe(false);
    expect(map.has(0xfffa)).toBe(false);
  });

  test('format 12 groups map ranges directly', () => {
    const font = sfntWithCmap([P0E4(format12([[0x0100, 0x0102, 0x0abc]]))]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(3);
    expect(map.get(0xabc)).toBe(0x100);
    expect(map.get(0xabd)).toBe(0x101);
    expect(map.get(0xabe)).toBe(0x102);
  });

  test('a format 12 subtable wins even when it is listed second', () => {
    const font = sfntWithCmap([
      P3E1(format4([[0x0041, 0x0041, 0x10, 0]])),
      P0E4(format12([[0x0061, 0x0061, 0x22]])),
    ]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(1);
    expect(map.get(0x22)).toBe(0x61);
    expect(map.has(0x51)).toBe(false);
  });

  test('a codepoint range extending beyond the font bytes is refused without throwing', () => {
    const good = sfntWithCmap([P3E1(format4([[0x0041, 0x0043, 5, 0]]))]);
    const at = good.length;
    const corrupt = Buffer.concat([good, Buffer.alloc(200)]);
    corrupt.writeUInt32BE(at + 160, 20);
    corrupt.writeUInt16BE(0, at + 160);
    corrupt.writeUInt16BE(1, at + 162);
    corrupt.writeUInt16BE(3, at + 164);
    corrupt.writeUInt16BE(1, at + 166);
    corrupt.writeUInt32BE(8, at + 168);
    corrupt.writeUInt16BE(4, at + 176);
    corrupt.writeUInt16BE(100, at + 182);
    const map = parseFontCmap(corrupt);
    expect(map.size).toBe(0);
  });

  test('a subtable record offset past the end of the font is skipped', () => {
    const good = sfntWithCmap([P0E4(format12([[0x0041, 0x0041, 0x77]]))]);
    const bad = Buffer.from(good);
    bad.writeUInt32BE(bad.length, 36);
    const map = parseFontCmap(bad);
    expect(map.size).toBe(0);
  });

  test('a hostile group claiming four billion codepoints terminates', () => {
    const font = sfntWithCmap([
      P0E4(
        format12([
          [0, 0xffffffff, 0xfffffff0],
          [0, 0xffffffff, 0xfffffff0],
          [0, 0xffffffff, 0xfffffff0],
        ]),
      ),
    ]);
    expect(parseFontCmap(font).size).toBe(0);
  });

  test('the codepoint scan budget bounds a flood of over-full format 4 segments', () => {
    const segments: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 8000; i++) segments.push([0x0001, 0xffff, i & 0x7fff, 0]);
    const font = sfntWithCmap([P3E1(format4(segments))]);
    const map = parseFontCmap(font);
    expect(map.size).toBeLessThanOrEqual(0x10000);
    expect(map.size).toBeGreaterThan(0);
  });

  test('the codepoint scan budget bounds a flood of re-scanning format 12 groups', () => {
    const groups: Array<[number, number, number]> = [];
    for (let i = 0; i < 64000; i++) groups.push([0, 0xffffffff, 1]);
    const font = sfntWithCmap([P0E4(format12(groups))]);
    const map = parseFontCmap(font);
    expect(map.size).toBe(65535);
    expect(map.has(1)).toBe(true);
    expect(map.has(0xffff)).toBe(true);
    expect(map.has(0)).toBe(false);
  });

  test('non-sfnt input yields no entries', () => {
    expect(parseFontCmap(Buffer.from('not a font at all')).size).toBe(0);
    expect(parseFontCmap(Buffer.alloc(0)).size).toBe(0);
    expect(
      parseFontCmap(Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.alloc(8)])).size,
    ).toBe(0);
  });
});
