type EncodingRecord = { platform: number; encoding: number; data: Buffer };

export function sfntWithCmap(subtables: EncodingRecord[]): Buffer {
  const n = subtables.length;
  const dirBlock = Buffer.alloc(4 + n * 8);
  dirBlock.writeUInt16BE(0, 0);
  dirBlock.writeUInt16BE(n, 2);
  const chunks: Buffer[] = [];
  let cursor = 4 + n * 8;
  subtables.forEach((sub, i) => {
    dirBlock.writeUInt16BE(sub.platform, 4 + i * 8);
    dirBlock.writeUInt16BE(sub.encoding, 6 + i * 8);
    if (cursor % 2 !== 0) {
      chunks.push(Buffer.from([0]));
      cursor++;
    }
    dirBlock.writeUInt32BE(cursor, 8 + i * 8);
    chunks.push(sub.data);
    cursor += sub.data.length;
  });
  const cmapTable = Buffer.concat([dirBlock, ...chunks]);

  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);

  const dir = Buffer.alloc(16);
  dir.write('cmap', 0, 'latin1');
  dir.writeUInt32BE(28, 8);
  dir.writeUInt32BE(cmapTable.length, 12);

  return Buffer.concat([header, dir, cmapTable]);
}

export function format4(
  segments: Array<[start: number, end: number, delta: number, rangeOffset: number]>,
  glyphIds: number[] = [],
): Buffer {
  const segCount = segments.length + 1;
  const x2 = segCount * 2;
  const body = Buffer.alloc(16 + x2 * 4 + glyphIds.length * 2);
  body.writeUInt16BE(4, 0);
  body.writeUInt16BE(body.length, 2);
  body.writeUInt16BE(x2, 6);
  const ends: number[] = [];
  const starts: number[] = [];
  const deltas: number[] = [];
  const rangeOffs: number[] = [];
  for (const [start, end, delta, rangeOffset] of segments) {
    ends.push(end);
    starts.push(start);
    deltas.push(delta);
    rangeOffs.push(rangeOffset);
  }
  ends.push(0xffff);
  starts.push(0xffff);
  deltas.push(1);
  rangeOffs.push(0);
  ends.forEach((n, i) => body.writeUInt16BE(n, 14 + i * 2));
  starts.forEach((n, i) => body.writeUInt16BE(n, 16 + x2 + i * 2));
  deltas.forEach((n, i) => body.writeInt16BE(n, 16 + x2 * 2 + i * 2));
  rangeOffs.forEach((n, i) => body.writeUInt16BE(n, 16 + x2 * 3 + i * 2));
  glyphIds.forEach((n, i) => body.writeUInt16BE(n, 16 + x2 * 4 + i * 2));
  return body;
}

export function format12(
  groups: Array<[startCp: number, endCp: number, startGlyph: number]>,
): Buffer {
  const body = Buffer.alloc(16 + groups.length * 12);
  body.writeUInt16BE(12, 0);
  body.writeUInt32BE(body.length, 4);
  body.writeUInt32BE(groups.length, 12);
  groups.forEach((g, i) => {
    body.writeUInt32BE(g[0], 16 + i * 12);
    body.writeUInt32BE(g[1], 20 + i * 12);
    body.writeUInt32BE(g[2], 24 + i * 12);
  });
  return body;
}

export const P3E1 = (data: Buffer): EncodingRecord => ({ platform: 3, encoding: 1, data });
export const P0E4 = (data: Buffer): EncodingRecord => ({ platform: 0, encoding: 4, data });
