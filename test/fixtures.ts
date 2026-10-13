/**
 * Shared PDF builders for the suite.
 *
 * Four test files each assembled minimal PDFs by hand -- numbered objects, an xref
 * table, a trailer -- with the same loop written four ways. jscpd counts lines, so
 * every near-identical builder is duplication debt, and a fix to the assembly logic
 * would have to land in four places. One assembler, with the two real variations
 * (a binary stream payload, a custom trailer) as parameters and every byte otherwise
 * identical to what the inline builders produced.
 */
import { deflateSync } from 'node:zlib';

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
