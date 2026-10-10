/**
 * The gate has to notice a repair that damages the file, and the damage that matters most
 * is the damage nobody can see.
 *
 * A repair that moves a glyph shows up in the pixels. One that truncates an object body
 * does not: the splitter clamps the object at the next header, the writer recomputes a
 * self-consistent cross-reference table around whatever survived, and the file still
 * parses. It looks fine to every tool that opens it, and half the dictionary is gone.
 */
import { describe, expect, test } from 'bun:test';
import { verify } from '../src/verify.ts';
import { join } from '../src/pdfparts.ts';

const obj = (num: number, body: string) => ({
  num,
  bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
});

function wellFormed(): Uint8Array {
  return join(
    Buffer.from('%PDF-1.4\n', 'latin1'),
    [
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      obj(
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << >> >> /Contents 4 0 R >>',
      ),
      {
        num: 4,
        bytes: Buffer.from('4 0 obj\n<< /Length 3 >>\nstream\nq Q\nendstream\nendobj\n', 'latin1'),
      },
    ],
    Buffer.from('trailer\n<< /Root 1 0 R /Size 5 >>\n', 'latin1'),
  );
}

describe('a file that lost something', () => {
  test('a complete file passes', () => {
    expect(verify(wellFormed())).toEqual({ ok: true, failures: [] });
  });

  test('a dictionary that is opened and never closed is refused', () => {
    // `>>` removed. The cross-reference table still points at object 3, the object is
    // still found, and the file still parses -- the dictionary is simply half gone.
    const damaged = join(
      Buffer.from('%PDF-1.4\n', 'latin1'),
      [
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << >> '),
        {
          num: 4,
          bytes: Buffer.from(
            '4 0 obj\n<< /Length 3 >>\nstream\nq Q\nendstream\nendobj\n',
            'latin1',
          ),
        },
      ],
      Buffer.from('trailer\n<< /Root 1 0 R /Size 5 >>\n', 'latin1'),
    );
    const result = verify(damaged);
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/object 3/);
  });

  test('a file with no end-of-file marker is refused', () => {
    // A reader reaching the end without %%EOF throws away the cross-reference table and
    // rebuilds one by scanning for object headers. That is a reconstruction, and it is
    // what a truncated write looks like.
    const truncated = Buffer.from(wellFormed());
    const at = truncated.length - Buffer.byteLength('%%EOF\n');
    expect(verify(truncated.subarray(0, at)).ok).toBe(false);
    expect(verify(truncated.subarray(0, at)).failures.join(' ')).toMatch(/%%EOF/);
  });
});
