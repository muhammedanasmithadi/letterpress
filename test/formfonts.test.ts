import { describe, expect, test } from 'bun:test';
import { join, trySplit } from '../src/pdfparts.ts';
import { textFlow } from '../src/selection.ts';
import { cmapStreams, fontsByContent } from '../src/textfont.ts';
import { streamText } from './fixtures.ts';

const TEXT = 'BT\n/F2 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n90 0 Td <0001> Tj\nET';

const dict = (num: number, body: string) => ({
  num,
  bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
});

const stream = (num: number, body: string) => ({
  num,
  bytes: Buffer.from(
    `${num} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
    'latin1',
  ),
});

function file(inForm: boolean): Uint8Array {
  const form = inForm;
  return join(
    Buffer.from('%PDF-1.4\n', 'latin1'),
    [
      dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      dict(
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
          `/Resources << /XObject << /X9 9 0 R >> /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
      ),
      dict(4, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>'),
      dict(8, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>'),
      dict(
        9,
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] ' +
          '/Resources << /Font << /F1 4 0 R /F2 8 0 R >> >> /Length ' +
          `${TEXT.length} >>\nstream\n${TEXT}\nendstream\nendobj\n`,
      ),
      stream(5, form ? '/X9 Do' : TEXT),
      ...(form ? [] : []),
    ],
    Buffer.from('trailer\n<< /Root 1 0 R /Size 10 >>\n', 'latin1'),
  );
}

function tables(pdf: Uint8Array): Map<string, number> {
  const parts = trySplit(pdf)!;
  const cmaps = cmapStreams(pdf);
  const byContent = fontsByContent(parts, (n) => cmaps.get(n) ?? null);
  const out = new Map<string, number>();
  for (const o of parts.objs) {
    if (byContent.has(o.num)) out.set(String(o.num), byContent.get(o.num)!.size);
  }
  return out;
}

describe('font resources follow the stream that draws with them', () => {
  test('the fixture differs only in where the text sits', () => {
    expect(streamText(file(true), 9)).toContain('<0001> Tj');
    expect(streamText(file(true), 5)).toBe('/X9 Do');
    expect(streamText(file(false), 5)).toContain('<0001> Tj');
  });

  test('a form XObject gets its own font table, not the page it is drawn by', () => {
    const withForm = tables(file(true));
    expect(withForm.get('9')).toBe(2);
    expect(withForm.get('5')).toBe(1);
    expect(withForm.get('9')).not.toBe(withForm.get('5'));
  });

  test('the glyphs are measured the same whether the text is in a form or inline', () => {
    const inForm = textFlow(file(true));
    const inline = textFlow(file(false));
    expect(inForm).not.toBeNull();
    expect(inline).not.toBeNull();
    expect(inForm!.widestAll).toBeCloseTo(inline!.widestAll, 6);
    expect(inline!.widestAll).toBeCloseTo(8.0, 6);
  });
});
