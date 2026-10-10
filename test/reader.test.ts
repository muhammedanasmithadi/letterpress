/**
 * Defects found by auditing the output path, each of which made a number or a verdict
 * wrong without making the page look wrong.
 *
 * The common shape is that something reads a grammar or a structure slightly wrong and then
 * reports confidently. A glyph drawn at the wrong place is visible; an advance width taken
 * from the wrong page, a line break booked as a backwards move, a CMap that parsed as empty
 * and reported a page full of spaces as a page full of drawn glyphs -- none of those show
 * up until someone measures.
 */
import { describe, expect, test } from 'bun:test';
import { parseCMap } from '../src/textfont.ts';
import { verify } from '../src/verify.ts';

const CMAP = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  '3 beginbfchar',
  '<0001> <0020>',
  '<0002> <0041>',
  '<0003> <0061>',
  'endbfchar',
  '1 beginbfrange',
  '<0010> <0012> <0062>',
  'endbfrange',
  'endcmap',
].join('\n');

describe('reading a CMap', () => {
  test('the same map written with CRLF line endings parses identically', () => {
    const lf = parseCMap(CMAP);
    const crlf = parseCMap(CMAP.replace(/\n/g, '\r\n'));
    expect(lf.size).toBe(6);
    // A parser that needs a bare \n finds nothing at all, and a map that parses as empty
    // makes every space look like a drawn glyph, which empties the gap report.
    expect([...crlf.entries()]).toEqual([...lf.entries()]);
    expect(crlf.get(1)).toBe(' ');
    expect(crlf.get(0x10)).toBe('b');
  });

  test('both forms of a range are read', () => {
    const m = parseCMap(CMAP);
    expect(m.get(0x11)).toBe('c');
    const listed = parseCMap(
      [
        'begincmap',
        '1 beginbfrange',
        '<0010> <0011> [<0078> <0079>]',
        'endbfrange',
        'endcmap',
      ].join('\n'),
    );
    expect(listed.get(0x10)).toBe('x');
    expect(listed.get(0x11)).toBe('y');
  });
});

describe('a dangling reference', () => {
  const file = (ref: string): Uint8Array => {
    const body =
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents ${ref} >>\nendobj\n` +
      `trailer\n<< /Root 1 0 R /Size 4 >>\n%%EOF\n`;
    return new Uint8Array(Buffer.from(body, 'latin1'));
  };

  test('is found whatever generation it names', () => {
    // A match on `0 R` alone leaves every other generation unchecked, so a file pointing
    // at an object that does not exist passes the gate as long as it writes `1 R`.
    expect(verify(file('4 0 R')).ok).toBe(false);
    expect(verify(file('4 1 R')).ok).toBe(false);
    expect(verify(file('4 65535 R')).ok).toBe(false);
  });
});
