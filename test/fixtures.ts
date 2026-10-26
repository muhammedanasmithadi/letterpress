import { expect } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { streamRange, trySplit } from '../src/pdfparts.ts';

export const LATIN1 = 'latin1' as BufferEncoding;

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type PdfObj = string | { dict: string; payload: Buffer };

export function assemblePdf(
  objs: PdfObj[],
  opts: {
    trailer?: (size: number, xrefAt: number) => string;
    endobj?: string;
  } = {},
): Buffer {
  const endobj = opts.endobj ?? 'endobj\n';
  const trailer =
    opts.trailer ??
    ((size: number, xrefAt: number) =>
      `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', LATIN1)];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(length);
    const o = objs[i]!;
    const bytes =
      typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}${endobj}`, LATIN1)
        : Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, LATIN1),
            o.payload,
            Buffer.from('\nendstream\nendobj\n', LATIN1),
          ]);
    chunks.push(bytes);
    length += bytes.length;
  }
  const xrefAt = length;
  const n = objs.length + 1;
  const table = [`xref\n0 ${n}\n0000000000 65535 f \n`];
  for (let k = 1; k < n; k++) {
    table.push(`${String(offsets[k - 1]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(Buffer.from(table.join(''), LATIN1));
  chunks.push(Buffer.from(trailer(n, xrefAt), LATIN1));
  return Buffer.concat(chunks);
}

export function deflated(data: string | Buffer): Buffer {
  return deflateSync(typeof data === 'string' ? Buffer.from(data, LATIN1) : data);
}

export function streamText(pdf: Uint8Array, num: number): string {
  const o = trySplit(pdf)!.objs.find((x) => x.num === num)!;
  const range = streamRange(o.bytes)!;
  const raw = o.bytes.subarray(range.start, range.end);
  return (/FlateDecode/.test(o.bytes.toString(LATIN1, 0, 120)) ? inflateSync(raw) : raw).toString(
    LATIN1,
  );
}

export function expectSoundXref(text: string): void {
  expect(text.match(/startxref/g)).toHaveLength(1);
  const at = Number(text.match(/startxref\s+(\d+)/)![1]);
  expect(text.slice(at, at + 4)).toBe('xref');
  const header = text.slice(at).match(/^xref\s+0\s+(\d+)\s*/)!;
  const size = Number(header[1]);
  const table = text.slice(at + header[0].length);
  let checked = 0;
  for (let n = 1; n < size; n++) {
    const entry = table.slice(n * 20, n * 20 + 20);
    if (entry[17] !== 'n') continue;
    checked++;
    expect(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + 20)).toStartWith(
      `${n} 0 obj`,
    );
  }
  expect(checked).toBeGreaterThan(0);
  expect(text).not.toContain('endobjxref');
}

export function expectSoundLengths(text: string): number {
  let streams = 0;
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    const len = body.split('stream')[0]!.match(/\/Length (\d+)/);
    const at = body.match(/stream\r?\n/);
    if (!len || !at || at.index === undefined) continue;
    streams++;
    const end = body.lastIndexOf('\nendstream');
    expect(Buffer.from(body, LATIN1).subarray(at.index + at[0].length, end).length).toBe(
      Number(len[1]),
    );
  }
  return streams;
}

export function encryptedFixture(): Buffer {
  return assemblePdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
      '<< /Producer (Fixture) >>',
      {
        dict: '<< /Length 58 >>',
        payload: Buffer.from(
          'BT\n/F1 10 Tf\n/Span<</ActualText (fi)>>BDC\n[<00>]TJ\nEMC\nET\n',
          LATIN1,
        ),
      },
      '<< /Filter /Standard /V 2 /Length 128 >>',
    ],
    {
      endobj: '\nendobj\n',
      trailer: (size: number, xrefAt: number) =>
        `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R /Encrypt 6 0 R >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`,
    },
  );
}
