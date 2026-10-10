/**
 * A font resource name is page-local. `/F1` on one page and `/F1` on the next are two
 * different fonts, and reading them as one table lets the last page that binds `/F1`
 * decide the advance widths for every other page.
 *
 * Nothing downstream notices. The glyphs are still drawn where the content stream puts
 * them, the page still renders identically, and the characters still extract correctly.
 * Only the numbers computed from the widths move, which is the dangerous shape: a
 * measurement that is confidently incorrect rather than one that fails.
 *
 * The fixture is built twice from the same source, differing in one thing only: whether the
 * second page reuses the name `/F1` or binds its own `/F2`. Anything the two disagree about
 * is the name collision, not the document.
 */
import { describe, expect, test } from "bun:test";
import { join, trySplit, streamRange } from "../src/pdfparts.ts";
import { inflateSync } from "node:zlib";
import { textFlow } from "../src/selection.ts";

const BODY = (font: string): string =>
  `BT\n/${font} 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n90 0 Td <0001> Tj\nET`;

function file(sharedName: boolean): Uint8Array {
  const dict = (num: number, body: string) => ({
    num,
    bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, "latin1"),
  });
  const stream = (num: number, font: string) => {
    const text = BODY(font);
    return {
      num,
      bytes: Buffer.from(
        `${num} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`,
        "latin1",
      ),
    };
  };
  // Page one binds /F1, page two binds /F1 again or /F2. Same font object either way.
  const page2Font = sharedName ? "/F1 6 0 R" : "/F2 6 0 R";
  return join(
    Buffer.from("%PDF-1.4\n", "latin1"),
    [
      dict(1, "<< /Type /Catalog /Pages 2 0 R >>"),
      dict(2, "<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>"),
      dict(
        3,
        "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      ),
      dict(4, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>"),
      stream(5, "F1"),
      dict(6, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>"),
      dict(
        7,
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${page2Font} >> >> /Contents 8 0 R >>`,
      ),
      stream(8, sharedName ? "F1" : "F2"),
    ],
    Buffer.from("trailer\n<< /Root 1 0 R /Size 9 >>\n", "latin1"),
  );
}

/** The text of a content stream, so the fixture can be checked rather than assumed. */
function streamText(pdf: Uint8Array, num: number): string {
  const o = trySplit(pdf)!.objs.find((x) => x.num === num)!;
  const range = streamRange(o.bytes)!;
  const raw = o.bytes.subarray(range.start, range.end);
  return (/FlateDecode/.test(o.bytes.toString("latin1", 0, 120))
    ? inflateSync(raw)
    : raw
  ).toString("latin1");
}

describe("font resources are page-local", () => {
  test("the fixture differs only in whether the name collides", () => {
    const shared = file(true);
    const distinct = file(false);
    // Each page names the resource it binds. A stream that names a font its page does not
    // bind cannot be read at all, which looks identical to a name collision and is not one.
    expect(streamText(shared, 5)).toContain("/F1 10 Tf");
    expect(streamText(shared, 8)).toContain("/F1 10 Tf");
    expect(streamText(distinct, 5)).toContain("/F1 10 Tf");
    expect(streamText(distinct, 8)).toContain("/F2 10 Tf");
  });

  test("the two pages are measured the same however the font is named", () => {
    const shared = textFlow(file(true));
    const distinct = textFlow(file(false));
    expect(shared).not.toBeNull();
    expect(distinct).not.toBeNull();
    // Two pages, two glyphs each, one gap between the glyphs of each page.
    expect(distinct!.glyphs).toBe(4);
    expect(shared!.glyphs).toBe(distinct!.glyphs);
    expect(shared!.gaps).toBe(distinct!.gaps);
    expect(shared!.breaks).toBe(distinct!.breaks);
    expect(shared!.jump).toBe(distinct!.jump);
    expect(shared!.tooWide).toBe(distinct!.tooWide);
  });
});