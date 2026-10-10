/**
 * A measurement that cannot see part of the document has to say so.
 *
 * Every one of these produced a confident number from a file it had not actually read: a
 * font whose descendant could not be resolved gave every glyph a width of exactly one em, a
 * page naming a `/Contents` array was measured as though it had no text at all, and a
 * dangling `/Resources` reference threw on the assumption that `!` does something at
 * runtime. None of them made the page look wrong, because none of them touched the page.
 */
import { describe, expect, test } from "bun:test";
import { join, type Obj } from "../src/pdfparts.ts";
import { parseCMap, parseW } from "../src/textfont.ts";
import { textFlow } from "../src/selection.ts";

const dict = (num: number, body: string) => ({
  num,
  bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, "latin1"),
});

function build(fonts: string, contents: string, extra: Obj[] = []): Uint8Array {
  return join(
    Buffer.from("%PDF-1.4\n", "latin1"),
    [
      dict(1, "<< /Type /Catalog /Pages 2 0 R >>"),
      dict(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      dict(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${fonts} ${contents} >>`),
      ...extra,
      {
        num: 10,
        bytes: Buffer.from(
          '10 0 obj\n<< /Length 60 >>\nstream\nBT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\nendstream\nendobj\n',
          "latin1",
        ),
      },
    ],
    Buffer.from("trailer\n<< /Root 1 0 R /Size 11 >>\n", "latin1"),
  );
}

const CID = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100]] >>";

describe("a font whose widths cannot be read", () => {
  test("is left out rather than measured at one em per glyph", () => {
    // `/Type0` with no descendant anywhere in the file. Reading the parent finds no `/W`,
    // and the fallback made every glyph exactly one em wide, which turns a letter fit into
    // a gap. Leaving the name out means the stream is refused instead.
    const pdf = build(
      "/Resources << /Font << /F1 4 0 R >> >>",
      "/Contents 10 0 R",
      [dict(4, "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [9 0 R] >>")],
    );
    // No font under that name, so the stream cannot be read, so there is no measurement to
    // report: `textFlow` returning null is the honest answer and a fabricated one is not.
    expect(textFlow(pdf)).toBeNull();
  });

  test("a descendant written as a dictionary in the array is found", () => {
    // `/DescendantFonts [<< ... >>]` rather than a reference to one.
    const pdf = build(
      "/Resources << /Font << /F1 4 0 R >> >>",
      "/Contents 10 0 R",
      [
        dict(
          4,
          "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [<< /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100]] >>] >>",
        ),
      ],
    );
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.read).toBe(1);
  });
});

describe("a page whose content is named indirectly", () => {
  test("a `/Contents` that names an array of streams is followed", () => {
    // `/Contents 5 0 R` where object 5 is `[10 0 R]`. Treating 5 as a stream finds nothing,
    // and the page then reports no text at all rather than no *readable* text.
    const pdf = join(
      Buffer.from("%PDF-1.4\n", "latin1"),
      [
        dict(1, "<< /Type /Catalog /Pages 2 0 R >>"),
        dict(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        dict(
          3,
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        ),
        dict(4, CID),
        dict(5, "[10 0 R]"),
        {
          num: 10,
          bytes: Buffer.from(
            "10 0 obj\n<< /Length 58 >>\nstream\nBT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\nendstream\nendobj\n",
            "latin1",
          ),
        },
      ],
      Buffer.from("trailer\n<< /Root 1 0 R /Size 11 >>\n", "latin1"),
    );
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.streams).toBe(1);
    expect(flow!.read).toBe(1);
  });
});

describe("a page that names something the file does not contain", () => {
  test("is measured as unread rather than throwing", () => {
    // `!` on a map lookup is a compile-time assertion with no runtime effect, so a page
    // whose `/Resources` object is absent took the whole render down with it.
    const pdf = build("/Resources 99 0 R", "/Contents 10 0 R", [dict(4, CID)]);
    expect(() => textFlow(pdf)).not.toThrow();
    // Nothing was readable, so there is no measurement -- a row of zeroes would read as
    // "this document has no wide gaps", which is the opposite of the truth.
    expect(textFlow(pdf)).toBeNull();
  });
});

describe("a document only partly read", () => {
  test("the finding can say the numbers came from part of it", () => {
    // Two content streams, one of them naming a font the page does not bind. Both are
    // counted, one is measured, and the report carries the difference.
    const text = (font: string): string =>
      `BT\n/${font} 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\n`;
    const good = text("F1");
    // The second stream names a font the page does not bind, so it cannot be read.
    const bad = text("F9");
    const pdf = join(
      Buffer.from("%PDF-1.4\n", "latin1"),
      [
        dict(1, "<< /Type /Catalog /Pages 2 0 R >>"),
        dict(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        dict(
          3,
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents [10 0 R 11 0 R] >>",
        ),
        dict(4, CID),
        { num: 10, bytes: Buffer.from(`10 0 obj\n<< /Length ${good.length} >>\nstream\n${good}endstream\nendobj\n`, "latin1") },
        { num: 11, bytes: Buffer.from(`11 0 obj\n<< /Length ${bad.length} >>\nstream\n${bad}endstream\nendobj\n`, "latin1") },
      ],
      Buffer.from("trailer\n<< /Root 1 0 R /Size 12 >>\n", "latin1"),
    );
    const flow = textFlow(pdf);
    expect(flow).not.toBeNull();
    expect(flow!.streams).toBe(2);
    expect(flow!.read).toBe(1);
  });
});

describe("a stream using something the report cannot read", () => {
  const withContent = (content: string, fonts = CID): Uint8Array =>
    join(
      Buffer.from("%PDF-1.4\n", "latin1"),
      [
        dict(1, "<< /Type /Catalog /Pages 2 0 R >>"),
        dict(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        dict(
          3,
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 10 0 R >>`,
        ),
        dict(4, fonts),
        {
          num: 10,
          bytes: Buffer.from(
            `10 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
            "latin1",
          ),
        },
      ],
      Buffer.from("trailer\n<< /Root 1 0 R /Size 11 >>\n", "latin1"),
    );

  const plain = "BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n50 0 Td <0001> Tj\nET\n";

  test("is read", () => {
    expect(textFlow(withContent(plain))).not.toBeNull();
  });

  test("char spacing refuses the stream rather than measuring around it", () => {
    // `2 Tc` moves every glyph by two units. Passing over it measures gaps the reader does
    // not see, and the number looks like a measurement.
    expect(textFlow(withContent(plain.replace("1 0 0 1 10 700 Tm", "2 Tc\n1 0 0 1 10 700 Tm")))).toBeNull();
  });

  test("word spacing refuses the stream", () => {
    expect(textFlow(withContent(plain.replace("1 0 0 1 10 700 Tm", "5 Tw\n1 0 0 1 10 700 Tm")))).toBeNull();
  });

  test("a literal string inside TJ refuses the stream", () => {
    // `(abc) 12 (def) TJ` shows glyphs through an encoding this does not read. Treating the
    // strings as nothing leaves the pen where it was and shifts every gap after them.
    const body = "BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n(abc) 12 (def) TJ\nET\n";
    expect(textFlow(withContent(body))).toBeNull();
  });
});

describe("a CMap written on one line", () => {
  test("is read like a multi-line one", () => {
    // Legal, and the newline-anchored pattern found nothing, so every CID read as unmapped
    // and every space looked like a drawn glyph.
    const one = parseCMap("begincmap 2 beginbfchar <0001> <0020> <0002> <0041> endbfchar endcmap");
    const many = parseCMap("begincmap\n2 beginbfchar\n<0001> <0020>\n<0002> <0041>\nendbfchar\nendcmap");
    expect([...one.entries()]).toEqual([...many.entries()]);
    expect(one.get(1)).toBe(" ");
  });

  test("a two-character destination steps by character, not by code point", () => {
    // This engine writes `<00660069>` for an "fi" ligature. Stepping one code point turns
    // that into a single character in the wrong plane and every later one with it.
    const m = parseCMap("begincmap\n1 beginbfrange\n<0010> <0011> <00660069>\nendbfrange\nendcmap");
    expect(m.get(0x10)).toBe("fi");
    expect(m.get(0x11)).toBe("gj");
  });
});

describe("the /W array", () => {
  test("both grammar forms land on the right CIDs", () => {
    // `0 [600 0 0 260]` and `15 17 250` are different forms in the same array; reading
    // only the first leaves CIDs 15 to 17 with no width at all.
    const w = parseW("/W [0 [600 0 0 260] 15 17 250 38 [614]]");
    expect(w.get(0)).toBe(600);
    expect(w.get(3)).toBe(260);
    expect(w.get(15)).toBe(250);
    expect(w.get(16)).toBe(250);
    expect(w.get(17)).toBe(250);
    expect(w.get(38)).toBe(614);
    expect(w.size).toBe(8);
  });
});