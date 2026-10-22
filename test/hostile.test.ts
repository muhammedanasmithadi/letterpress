import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { cappedInflate, isEncrypted, trySplit } from '../src/pdfparts.ts';
import { stripRedundantSpans } from '../src/spans.ts';
import { setDocTitle } from '../src/meta.ts';
import { validate } from '../src/validate.ts';
import { verify } from '../src/verify.ts';
import { assemblePdf } from './fixtures.ts';

function pdf(objs: string[], trailer = '<< /Root 1 0 R >>'): Uint8Array {
  return new Uint8Array(
    Buffer.from(`%PDF-1.4\n${objs.join('')}trailer\n${trailer}\nstartxref\n0\n%%EOF\n`, 'latin1'),
  );
}

const PAGE = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
    '/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  '4 0 obj\n<< /Length 20 >>\nstream\nBT /F1 12 Tf (x) Tj ET\nendstream\nendobj\n',
];

describe('a document that says anything', () => {
  test('a width range of two billion does not take the memory', () => {
    const file = pdf([
      ...PAGE,
      '5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H ' +
        '/DescendantFonts [6 0 R] >>\nendobj\n',
      '6 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /W [0 2000000000 500] >>\nendobj\n',
    ]);
    expect(() => validate(file)).not.toThrow();
  }, 30_000);

  test('a stream that expands without bound is refused rather than expanded', () => {
    const zeros = deflateSync(Buffer.alloc(200 * 1024 * 1024));
    expect(() => cappedInflate(zeros)).toThrow();
    const file = pdf([
      ...PAGE,
      `5 0 obj\n<< /Length ${zeros.length} /Filter /FlateDecode >>\nstream\n${zeros.toString(
        'latin1',
      )}\nendstream\nendobj\n`,
    ]);
    expect(() => validate(file)).not.toThrow();
  }, 30_000);

  test('an object number of four hundred digits does not size a table', () => {
    const file = pdf([
      '1 0 obj\n<< /Type /Catalog >>\nendobj\n',
      `${'9'.repeat(400)} 0 obj\n<< >>\nendobj\n`,
    ]);
    expect(() => stripRedundantSpans(file)).not.toThrow();
    expect(() => setDocTitle(file, 'T')).not.toThrow();
  }, 30_000);
});

describe('a document a reader would open', () => {
  test('a little something in front of the header is still a document', () => {
    const file = Buffer.concat([
      Buffer.from('F9 junk before the header\n', 'latin1'),
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'),
    ]);
    const result = validate(new Uint8Array(file));
    expect(result.findings.map((f) => f.code)).not.toContain('not-a-pdf');
  });

  test('text in a stream that looks like an object header is not an object', () => {
    const content = 'BT /F1 12 Tf 72 700 Td (line one) Tj\n1 0 obj\n(line two) Tj ET';
    const file = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
      `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    ].join('');
    const text = `%PDF-1.4\n${file}trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n9\n%%EOF\n`;
    const parts = trySplit(new Uint8Array(Buffer.from(text, 'latin1')));
    expect(parts?.objs.map((o) => o.num)).toEqual([1, 2, 3, 4]);
  });

  test('objects written with more than one space are still objects', () => {
    const file = Buffer.from(
      '%PDF-1.4\n1  0  obj\n<< /Type /Catalog >>\nendobj\n' +
        'trailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n9\n%%EOF\n',
      'latin1',
    );
    const result = verify(new Uint8Array(file));
    expect(result.failures.filter((f) => f.includes('does not exist'))).toEqual([]);
  });
});

describe('a document with windows line endings', () => {
  const lf =
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF\n';

  test('an encrypted document is recognised whatever its line endings', () => {
    const crlf = new Uint8Array(Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1'));
    expect(isEncrypted(crlf)).toBe(true);
    expect(trySplit(crlf)).toBeDefined();
  });
});

describe('a length that points at another object', () => {
  test('a repair does not turn an indirect length into a reference to nothing', () => {
    const file = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
      '<< /Length 5 0 R >>',
      '<< /Length 20 >>',
    ]);
    const out = setDocTitle(file, 'A Title');
    expect(Buffer.from(out).toString('latin1')).not.toContain('/Length 55 0 R');
  });
});
