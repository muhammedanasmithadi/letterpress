/**
 * A font resource belongs to the stream that draws with it, and Chromium does not put a
 * page's text in the page's `/Contents`.
 *
 * It puts the text in a Form XObject that `/Contents` draws with a single `Do`, and the
 * fonts that text uses are named in *that form's* `/Resources`:
 *
 *     3 0 obj <</Type /Page /Resources <</XObject <</X9 9 0 R>> /Font <</F1 4 0 R>> /Contents 5 0 R>>
 *     5 0 obj  /X9 Do
 *     9 0 obj <</Type /XObject /Subtype /Form /Resources <</Font <</F1 4 0 R /F2 8 0 R>>>> stream ... BT /F2 10 Tf
 *
 * The page binds one font and the form binds two, so reading the table from the page alone
 * gives the stream that draws no glyphs a table and the stream that draws every glyph none
 * at all. Every consumer is keyed by content stream, so every one of them went blind: the
 * ligature-span repair found no font in force at any span and kept all of them, and the
 * selection report could not read a stream with text in it.
 *
 * Measured on a four-page report rendered by the real engine: the table reached 4 of 9
 * glyph-drawing streams, all 14 `/ActualText` spans were stranded, and the report said
 * "measured on 4 of 9 text streams; the rest were not readable".
 *
 * The fixture is built twice from one source, differing in one thing only: whether the
 * text sits in the page's `/Contents` or in a form that stream draws. Both are legal and
 * both render identically, so anything the two disagree about is where the text is -- not
 * the document.
 */
import { describe, expect, test } from 'bun:test';
import { join, trySplit } from '../src/pdfparts.ts';
import { textFlow } from '../src/selection.ts';
import { cmapStreams, fontsByContent } from '../src/textfont.ts';
import { streamText } from './fixtures.ts';

/** Two glyphs 90 units apart, in whichever font the fixture draws them with. */
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

/**
 * @param inForm draw the text from a form XObject, the way Chromium does, or inline in
 *   the page's contents, the way the code was written.
 *
 * `/F1` is on the page in both fixtures and advances 100 units. `/F2` advances 1000 and is
 * the font the text actually uses; the page binds it only in the inline fixture. A reader
 * that resolves the font sees the second advance. A reader that cannot resolve it at all
 * sees no advance and no gap, which is not a smaller number but a different question.
 */
function file(inForm: boolean): Uint8Array {
  const form = inForm;
  return join(
    Buffer.from('%PDF-1.4\n', 'latin1'),
    [
      dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      // The page binds /F1 and draws the form. It does not bind /F2 in either fixture.
      dict(
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
          `/Resources << /XObject << /X9 9 0 R >> /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
      ),
      dict(4, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>'),
      dict(8, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>'),
      // The form carries both fonts and draws with the one the page never bound.
      dict(
        9,
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] ' +
          '/Resources << /Font << /F1 4 0 R /F2 8 0 R >> >> /Length ' +
          `${TEXT.length} >>\nstream\n${TEXT}\nendstream\nendobj\n`,
      ),
      stream(5, form ? '/X9 Do' : TEXT),
      // The inline fixture's text names /F2, so its page has to bind it to be legal at all.
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
    // Both fixtures draw the same two glyphs, and the form one reaches them through a
    // single Do. A fixture that quietly differed in its text would agree for a reason that
    // has nothing to do with the thing under test.
    expect(streamText(file(true), 9)).toContain('<0001> Tj');
    expect(streamText(file(true), 5)).toBe('/X9 Do');
    expect(streamText(file(false), 5)).toContain('<0001> Tj');
  });

  test('a form XObject gets its own font table, not the page it is drawn by', () => {
    const withForm = tables(file(true));
    // The stream that draws the glyphs is the form, object 9, and it binds two fonts.
    expect(withForm.get('9')).toBe(2);
    // The page's contents bind the page's one font and keep the page's table. That one is
    // correct for itself and useless for the form, which is the whole defect: the two
    // streams are reached through the same operator and need different tables.
    expect(withForm.get('5')).toBe(1);
    expect(withForm.get('9')).not.toBe(withForm.get('5'));
  });

  test('the glyphs are measured the same whether the text is in a form or inline', () => {
    const inForm = textFlow(file(true));
    const inline = textFlow(file(false));
    expect(inForm).not.toBeNull();
    expect(inline).not.toBeNull();
    // The counters are too coarse to see the defect: an unresolvable font yields no gap at
    // all, and no gap is a gap, so a count of one is one either way. The width is the
    // quantity that changes, because it is the only one read from the font.
    expect(inForm!.widestAll).toBeCloseTo(inline!.widestAll, 6);
    expect(inline!.widestAll).toBeCloseTo(8.0, 6);
  });
});
