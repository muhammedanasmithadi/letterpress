/**
 * One PDF assembler for the four suites that built fixtures by hand, with the two
 * real variations (a binary stream payload, a custom trailer) as parameters.
 * Byte-identical to the inline builders it replaced.
 */
import { expect } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { streamRange, trySplit } from '../src/pdfparts.ts';

export const LATIN1 = 'latin1' as BufferEncoding;

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type PdfObj = string | { dict: string; payload: Buffer };

/**
 * Numbered objects, a correct xref table, and a trailer.
 *
 * A plain string becomes `N 0 obj\nBODY` followed by `endobj`; a {dict, payload}
 * pair becomes a stream object with the raw bytes spliced between `stream` and
 * `endstream`. The trailer defaults to `<</Size N /Root 1 0 R>>`.
 *
 * `endobj` defaults to `endobj\n`, glued to the body the way the historic inline
 * builders wrote it. meta's builder put a newline between them (`\nendobj\n`); pass
 * that explicitly rather than normalising, because fixtures must stay byte-identical
 * to what the tests were written against.
 */
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

/** The deflated-then-assembled round trip every font/CMap fixture needs. */
export function deflated(data: string | Buffer): Buffer {
  return deflateSync(typeof data === 'string' ? Buffer.from(data, LATIN1) : data);
}

/**
 * The decoded body of one stream object, so a fixture can be checked rather than assumed.
 *
 * A fixture that quietly differs from the one the test was written against passes for a
 * reason that has nothing to do with the thing under test, and a test that asserts against
 * the wrong fixture is worse than no test. `FlateDecode` is detected from the first bytes of
 * the object rather than from a flag, because the flag is what is being faked here.
 */
export function streamText(pdf: Uint8Array, num: number): string {
  const o = trySplit(pdf)!.objs.find((x) => x.num === num)!;
  const range = streamRange(o.bytes)!;
  const raw = o.bytes.subarray(range.start, range.end);
  return (/FlateDecode/.test(o.bytes.toString(LATIN1, 0, 120)) ? inflateSync(raw) : raw).toString(
    LATIN1,
  );
}

/**
 * The xref table points every live entry at its object header, in one table.
 * Shared because the same eighteen lines sat in two suites word for word, and
 * the failure messages below name the exact break -- which a boolean helper
 * would swallow.
 */
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

/**
 * Every stream's declared /Length matches its payload bytes. Returns the
 * streams checked; the caller asserts the count its document promises.
 */
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
