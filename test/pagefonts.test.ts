import { describe, expect, test } from 'bun:test';
import { join } from '../src/pdfparts.ts';
import { textFlow } from '../src/selection.ts';
import { streamText as sharedStreamText } from './fixtures.ts';

const BODY = (font: string): string =>
  `BT\n/${font} 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n90 0 Td <0001> Tj\nET`;

function file(sharedName: boolean): Uint8Array {
  const dict = (num: number, body: string) => ({
    num,
    bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
  });
  const stream = (num: number, font: string) => {
    const text = BODY(font);
    return {
      num,
      bytes: Buffer.from(
        `${num} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`,
        'latin1',
      ),
    };
  };
  const page2Font = sharedName ? '/F1 6 0 R' : '/F2 6 0 R';
  return join(
    Buffer.from('%PDF-1.4\n', 'latin1'),
    [
      dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      dict(2, '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>'),
      dict(
        3,
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      ),
      dict(4, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>'),
      stream(5, 'F1'),
      dict(6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>'),
      dict(
        7,
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${page2Font} >> >> /Contents 8 0 R >>`,
      ),
      stream(8, sharedName ? 'F1' : 'F2'),
    ],
    Buffer.from('trailer\n<< /Root 1 0 R /Size 9 >>\n', 'latin1'),
  );
}

function streamText(pdf: Uint8Array, num: number): string {
  return sharedStreamText(pdf, num);
}

describe('font resources are page-local', () => {
  test('the fixture differs only in whether the name collides', () => {
    const shared = file(true);
    const distinct = file(false);
    expect(streamText(shared, 5)).toContain('/F1 10 Tf');
    expect(streamText(shared, 8)).toContain('/F1 10 Tf');
    expect(streamText(distinct, 5)).toContain('/F1 10 Tf');
    expect(streamText(distinct, 8)).toContain('/F2 10 Tf');
  });

  test('the two pages are measured the same however the font is named', () => {
    const shared = textFlow(file(true));
    const distinct = textFlow(file(false));
    expect(shared).not.toBeNull();
    expect(distinct).not.toBeNull();
    expect(distinct!.glyphs).toBe(4);
    expect(shared!.glyphs).toBe(distinct!.glyphs);
    expect(shared!.gaps).toBe(distinct!.gaps);
    expect(shared!.breaks).toBe(distinct!.breaks);
    expect(shared!.jump).toBe(distinct!.jump);
    expect(shared!.tooWide).toBe(distinct!.tooWide);
    expect(shared!.widestAll).toBeCloseTo(distinct!.widestAll, 6);
    expect(distinct!.widestAll).toBeCloseTo(8.9, 6);
  });
});
