/**
 * The tokenizer that reads a content stream has capture groups numbered by hand.
 *
 * The gap report is a chain of arithmetic on what that tokenizer hands it: one operator
 * index off and every glyph lands in the wrong place, or in no place, and the result is a
 * confident number derived from a misreading. So the positions are pinned here directly,
 * with the expected value written out by hand from the arithmetic rather than taken from
 * the code that produced it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "../src/pdfparts.ts";
import { textFlow } from "../src/selection.ts";

/** Widths: CID 1 and 2 advance 100/1000 em, CID 3 (a space) advances 260/1000 em. */
function page(content: string): Uint8Array {
  const cmap = [
    "4 0 obj",
    "<< /Length 108 >>",
    "stream",
    "begincmap",
    "3 beginbfchar",
    "<0001> <0041>",
    "<0002> <0042>",
    "<0003> <0020>",
    "endbfchar",
    "endcmap",
    "endstream",
    "endobj",
  ].join("\n");
  return join(
    Buffer.from("%PDF-1.4\n", "latin1"),
    [
      { num: 1, bytes: Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1") },
      {
        num: 2,
        bytes: Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1"),
      },
      {
        num: 3,
        bytes: Buffer.from(
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] " +
            `/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n`,
          "latin1",
        ),
      },
      { num: 4, bytes: Buffer.from(`${cmap}\n`, "latin1") },
      {
        num: 5,
        bytes: Buffer.from(
          `5 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100] 2 [100] 3 [260]] /ToUnicode 4 0 R >>\nendobj\n`,
          "latin1",
        ),
      },
      {
        num: 6,
        bytes: Buffer.from(
          `6 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
          "latin1",
        ),
      },
    ],
    Buffer.from("trailer\n<< /Root 1 0 R /Size 7 >>\n", "latin1"),
  );
}

/** The widest gap on the page, in em. */
function widest(body: string): number {
  const flow = textFlow(page(body));
  if (!flow) throw new Error("the stream was refused");
  return flow.widestAll;
}

describe("reading positions out of a content stream", () => {
  test("Tf sets the size the gaps are measured against", () => {
    // Two glyphs 1 em apart at size 10: origin 10, advance 100/1000 * 10 = 1, Td 10 puts
    // the next at 20, so the gap is 20 - 11 = 9, which is 0.9 em at size 10.
    expect(widest("BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n")).toBeCloseTo(0.9, 6);
    // At size 20 the same operands do not double the gap: the advance is 2 so the pen
    // reaches 12, `Td` is relative to the line matrix which is still at 10 and so lands on
    // 20, and the gap is 8 -- which is 0.4 em at size 20, not 0.9.
    expect(widest("BT\n/F1 20 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n")).toBeCloseTo(0.4, 6);
  });

  test("Tm places the first glyph, not the second", () => {
    // The same two glyphs moved to x=200 by Tm: gap is 200 + 10 - 201 = 9 again, and a
    // misread of e against f would move it somewhere else entirely.
    expect(widest("BT\n/F1 10 Tf\n1 0 0 1 200 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n")).toBeCloseTo(0.9, 6);
  });

  test("a TJ array advances the pen by widths and by its numbers", () => {
    // `[<0001> -100 <0002>] TJ` at size 10: advance 1, then the number shifts the pen
    // right by 100/1000 * 10 = 1, so glyph two sits at 12 and the gap is 12 - 11 = 0.1 em.
    expect(widest("BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n[<0001> -100 <0002>] TJ\nET\n")).toBeCloseTo(0.1, 6);
  });

  test("an invisible glyph advances the pen without becoming a position", () => {
    // CID 3 is a space of width 260. Shown alone between two A's, the gap a reader sees
    // runs from the end of the first A to the start of the second, and the space's own
    // advance is inside it.
    expect(widest("BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n<0003> Tj\n<0002> Tj\nET\n")).toBeCloseTo(0.26, 6);
  });

  test("a scaled matrix refuses rather than inventing gaps", () => {
    expect(
      textFlow(page("BT\n/F1 10 Tf\n2 0 0 2 10 700 Tm\n<0001> Tj\n20 0 Td <0002> Tj\nET\n")),
    ).toBeNull();
  });

  test("a second Tf changes the size mid-stream", () => {
    // 10pt for the first glyph, 20pt for the second. `20 0 Td` is relative to the line
    // matrix at 10, so the second glyph lands at 30, and the gap is 30 - 11 = 19. The band
    // is 19 against the size in force where the item began, which is 10, so 1.9 em -- a
    // reader takes the font size at the start of the item, not the one at the gap.
    expect(widest("BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n20 0 Td\n/F1 20 Tf\n<0002> Tj\nET\n")).toBeCloseTo(1.9, 6);
  });
});