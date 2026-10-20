import { describe, expect, test } from 'bun:test';
import { join, type Obj } from '../src/pdfparts.ts';
import { parseCMap, parseW } from '../src/textfont.ts';
import { textFlow } from '../src/selection.ts';
import { mergeTextRuns } from '../src/tjmerge.ts';

const dict = (num: number, body: string) => ({
  num,
  bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
});

function build(fonts: string, contents: string, extra: Obj[] = []): Uint8Array {
  return join(
    Buffer.from('%PDF-1.4\n', 'latin1'),
    [
      dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      dict(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${fonts} ${contents} >>`),
      ...extra,
      {
        num: 10,
        bytes: Buffer.from(
          '10 0 obj\n<< /Length 60 >>\nstream\nBT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\nendstream\nendobj\n',
          'latin1',
        ),
      },
    ],
    Buffer.from('trailer\n<< /Root 1 0 R /Size 11 >>\n', 'latin1'),
  );
}

const CID = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100]] >>';

describe('a font whose widths cannot be read', () => {
  test('is left out rather than measured at one em per glyph', () => {
    const pdf = build('/Resources << /Font << /F1 4 0 R >> >>', '/Contents 10 0 R', [
      dict(
        4,
        '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [9 0 R] >>',
      ),
    ]);
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.unreadable).toBe(2);
  });

  test('a descendant written as a dictionary in the array is found', () => {
    const pdf = build('/Resources << /Font << /F1 4 0 R >> >>', '/Contents 10 0 R', [
      dict(
        4,
        '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [<< /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100]] >>] >>',
      ),
    ]);
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.read).toBe(1);
  });
});

describe('a page whose content is named indirectly', () => {
  test('a `/Contents` that names an array of streams is followed', () => {
    const pdf = join(
      Buffer.from('%PDF-1.4\n', 'latin1'),
      [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        dict(
          3,
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        ),
        dict(4, CID),
        dict(5, '[10 0 R]'),
        {
          num: 10,
          bytes: Buffer.from(
            '10 0 obj\n<< /Length 58 >>\nstream\nBT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\nendstream\nendobj\n',
            'latin1',
          ),
        },
      ],
      Buffer.from('trailer\n<< /Root 1 0 R /Size 11 >>\n', 'latin1'),
    );
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.streams).toBe(1);
    expect(flow!.read).toBe(1);
  });
});

describe('a page that names something the file does not contain', () => {
  test('is measured as unread rather than throwing', () => {
    const pdf = build('/Resources 99 0 R', '/Contents 10 0 R', [dict(4, CID)]);
    expect(() => textFlow(pdf)).not.toThrow();
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.unreadable).toBeGreaterThan(0);
  });
});

describe('a document only partly read', () => {
  test('the finding can say the numbers came from part of it', () => {
    const text = (font: string): string =>
      `BT\n/${font} 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\n`;
    const good = text('F1');
    const bad = text('F1').replace('1 0 0 1 10 700 Tm', '2 0 0 2 10 700 Tm');
    const pdf = join(
      Buffer.from('%PDF-1.4\n', 'latin1'),
      [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        dict(
          3,
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents [10 0 R 11 0 R] >>',
        ),
        dict(4, CID),
        {
          num: 10,
          bytes: Buffer.from(
            `10 0 obj\n<< /Length ${good.length} >>\nstream\n${good}endstream\nendobj\n`,
            'latin1',
          ),
        },
        {
          num: 11,
          bytes: Buffer.from(
            `11 0 obj\n<< /Length ${bad.length} >>\nstream\n${bad}endstream\nendobj\n`,
            'latin1',
          ),
        },
      ],
      Buffer.from('trailer\n<< /Root 1 0 R /Size 12 >>\n', 'latin1'),
    );
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.streams).toBe(2);
    expect(flow!.read).toBe(1);
  });
});

describe('a stream using something the report cannot read', () => {
  const withContent = (content: string, fonts = CID): Uint8Array =>
    join(
      Buffer.from('%PDF-1.4\n', 'latin1'),
      [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        dict(
          3,
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 10 0 R >>`,
        ),
        dict(4, fonts),
        {
          num: 10,
          bytes: Buffer.from(
            `10 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
            'latin1',
          ),
        },
      ],
      Buffer.from('trailer\n<< /Root 1 0 R /Size 11 >>\n', 'latin1'),
    );

  const plain = 'BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\n';

  test('is read', () => {
    expect(textFlow(withContent(plain))).not.toBeNull();
  });

  test('char spacing refuses the stream rather than measuring around it', () => {
    expect(
      textFlow(withContent(plain.replace('1 0 0 1 10 700 Tm', '2 Tc\n1 0 0 1 10 700 Tm'))),
    ).toBeNull();
  });

  test('word spacing refuses the stream', () => {
    expect(
      textFlow(withContent(plain.replace('1 0 0 1 10 700 Tm', '5 Tw\n1 0 0 1 10 700 Tm'))),
    ).toBeNull();
  });

  test('a literal string inside TJ refuses the stream', () => {
    const body = 'BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n(abc) 12 (def) TJ\nET\n';
    expect(textFlow(withContent(body))).toBeNull();
  });
});

describe('a CMap written on one line', () => {
  test('is read like a multi-line one', () => {
    const one = parseCMap('begincmap 2 beginbfchar <0001> <0020> <0002> <0041> endbfchar endcmap');
    const many = parseCMap(
      'begincmap\n2 beginbfchar\n<0001> <0020>\n<0002> <0041>\nendbfchar\nendcmap',
    );
    expect([...one.entries()]).toEqual([...many.entries()]);
    expect(one.get(1)).toBe(' ');
  });

  test('a two-character destination steps by character, not by code point', () => {
    const m = parseCMap('begincmap\n1 beginbfrange\n<0010> <0011> <00660069>\nendbfrange\nendcmap');
    expect(m.get(0x10)).toBe('fi');
    expect(m.get(0x11)).toBe('gj');
  });
});

describe('a one-byte font', () => {
  const body = 'BT\n/F3 10 Tf\n1 0 0 1 10 700 Tm\n<41> Tj\n8 0 Td <42> Tj\nET\n';
  const oneByteDoc = () =>
    join(
      Buffer.from('%PDF-1.4\n', 'latin1'),
      [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        dict(
          3,
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F3 7 0 R >> >> /Contents 10 0 R >>',
        ),
        dict(
          7,
          '<< /Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 -.001 0 0] /FirstChar 65 /LastChar 66 /Widths [500 600] /FontBBox [0 0 1000 1000] >>',
        ),
        {
          num: 10,
          bytes: Buffer.from(
            `10 0 obj\n<< /Length ${body.length} >>\nstream\n${body}endstream\nendobj\n`,
            'latin1',
          ),
        },
      ],
      Buffer.from('trailer\n<< /Root 1 0 R /Size 11 >>\n', 'latin1'),
    );

  test('is measured with the widths it declares', () => {
    const pdf = oneByteDoc();
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.unreadable).toBe(0);
    expect(flow!.widestAll).toBeCloseTo(0.3, 6);
  });

  test('is left out of the text-run merge', () => {
    const pdf = oneByteDoc();
    const merged = mergeTextRuns(pdf);
    expect(merged.stats.merged).toBe(0);
    expect(Buffer.from(merged.pdf).equals(Buffer.from(pdf))).toBe(true);
  });
});

describe('the /W array', () => {
  test('both grammar forms land on the right CIDs', () => {
    const w = parseW('/W [0 [600 0 0 260] 15 17 250 38 [614]]');
    expect(w.get(0)).toBe(600);
    expect(w.get(3)).toBe(260);
    expect(w.get(15)).toBe(250);
    expect(w.get(16)).toBe(250);
    expect(w.get(17)).toBe(250);
    expect(w.get(38)).toBe(614);
    expect(w.size).toBe(8);
  });
});
