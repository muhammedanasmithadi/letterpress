import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { fixToUnicode, ligatureExpansion, unresolvedLigatures } from "../src/tounicode.ts";
import { pdfInfo, pdfText } from "./poppler.ts";

const LATIN1 = "latin1" as BufferEncoding;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Every ToUnicode CMap in a file, decompressed. */
function cmaps(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString(LATIN1);
  const objs = new Map<number, string>();
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)endobj/g)) {
    objs.set(Number(m[1]), m[2]!);
  }
  const out: string[] = [];
  for (const body of objs.values()) {
    const ref = body.match(/\/ToUnicode (\d+) 0 R/);
    if (!ref) continue;
    const cm = objs.get(Number(ref[1]));
    if (!cm) continue;
    const at = cm.match(/stream\r?\n/);
    if (!at || at.index === undefined) continue;
    const end = cm.lastIndexOf("\nendstream");
    try {
      out.push(inflateSync(Buffer.from(cm, LATIN1).subarray(at.index + at[0].length, end)).toString(LATIN1));
    } catch {
      // not a flate stream; nothing to check
    }
  }
  return out;
}

/** A PDF with one Type0 font whose ToUnicode holds the given CMap body. */
function pdfWithCMap(cmap: string): Buffer {
  const body = deflateSync(Buffer.from(cmap, LATIN1));
  // Object 4 is the CMap stream, and object 5 is the Type0 font that points at it.
  // Object numbering is load-bearing: the font names the stream by number, so the
  // two have to agree.
  const parts: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+NotoSans /Encoding /Identity-H " +
      "/DescendantFonts [6 0 R] /ToUnicode 4 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+NotoSans /CIDSystemInfo " +
      "<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", LATIN1)];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    offsets.push(length);
    const head = Buffer.from(`${i + 1} 0 obj\n${parts[i]}`, LATIN1);
    chunks.push(head);
    length += head.length;
    if (typeof parts[i] === "string" && parts[i].includes("\nstream\n")) {
      const tail = Buffer.from("\nendstream\nendobj\n", LATIN1);
      chunks.push(body, tail);
      length += body.length + tail.length;
    } else {
      chunks.push(Buffer.from("endobj\n", LATIN1));
      length += 7;
    }
  }
  const xrefAt = length;
  const table = ["xref\n0 7\n0000000000 65535 f \n"];
  for (let n = 1; n <= 6; n++) {
    table.push(`${String(offsets[n - 1]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(Buffer.from(table.join(""), LATIN1));
  chunks.push(Buffer.from(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, LATIN1));
  return Buffer.concat(chunks);
}

/** A CMap with one bfchar block holding the given `glyph -> dest` pairs. */
const cmapOf = (pairs: Array<[number, string]>) =>
  `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
  `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
  `${pairs.length} beginbfchar\n${pairs.map(([g, d]) => `<${g.toString(16).toUpperCase().padStart(4, "0")}> <${d}>`).join("\n")}\nendbfchar\n` +
  `endcmap\nend\nend\n`;

/** A CMap with one bfrange block, which is where chromium puts its ligatures. */
const cmapOfRange = (lo: number, hi: number, base: number) =>
  `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
  `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
  `1 beginbfrange\n<${lo.toString(16).toUpperCase().padStart(4, "0")}> <${hi.toString(16).toUpperCase().padStart(4, "0")}> ` +
  `<${base.toString(16).toUpperCase().padStart(4, "0")}>\nendbfrange\nendcmap\nend\nend\n`;

/* ------------------------------------------------------------------ *
 * The rule
 * ------------------------------------------------------------------ */

describe("ligatureExpansion", () => {
  test("the seven Latin ligatures expand to their component letters", () => {
    expect(ligatureExpansion(0xfb00)).toBe("ff");
    expect(ligatureExpansion(0xfb01)).toBe("fi");
    expect(ligatureExpansion(0xfb02)).toBe("fl");
    expect(ligatureExpansion(0xfb03)).toBe("ffi");
    expect(ligatureExpansion(0xfb04)).toBe("ffl");
    expect(ligatureExpansion(0xfb05)).toBe("st");
    expect(ligatureExpansion(0xfb06)).toBe("st");
  });

  test("the whole qualifying set is the 21 codepoints measured, no more", () => {
    const hits: Array<[number, string]> = [];
    for (let cp = 0x20; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const e = ligatureExpansion(cp);
      if (e) hits.push([cp, e]);
    }
    // Seven Latin (FB00-FB06), five Armenian (FB13-FB17), one Hebrew (FB4F):
    // thirteen in the Alphabetic Presentation Forms block. Then eight Arabic
    // lam-alef forms (FEF5-FEFC).
    expect(hits).toHaveLength(21);
    const alphabetic = hits.filter(([cp]) => cp >= 0xfb00 && cp <= 0xfb4f);
    expect(alphabetic.map(([cp]) => cp)).toEqual([
      0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0xfb05, 0xfb06,
      0xfb13, 0xfb14, 0xfb15, 0xfb16, 0xfb17, 0xfb4f,
    ]);
    expect(hits.filter(([cp]) => cp >= 0xfe70 && cp <= 0xfeff)).toHaveLength(8);
  });

  test("a single letter carrying a diacritic keeps its codepoint", () => {
    // These are the cases NFKC alone would wrongly rewrite. Each is one letter,
    // not a ligature, and decomposing them corrupts Arabic and Lao text.
    for (const cp of [0x0675, 0x0676, 0x0677, 0x0678, 0x0edc, 0x0edd]) {
      expect(ligatureExpansion(cp)).toBeUndefined();
      // Each genuinely does expand under NFKC, so the block test is what saves it.
      expect(String.fromCodePoint(cp).normalize("NFKC").length).toBeGreaterThan(1);
    }
  });

  test("a compatibility character is not a ligature", () => {
    for (const cp of [0x00a8, 0x00af, 0x00bc, 0x02d8, 0x2160, 0x2163, 0x0132]) {
      expect(ligatureExpansion(cp)).toBeUndefined();
    }
  });

  test("a codepoint outside every range is refused without consulting NFKC", () => {
    expect(ligatureExpansion(0x41)).toBeUndefined();
    expect(ligatureExpansion(-1)).toBeUndefined();
    expect(ligatureExpansion(0x110000)).toBeUndefined();
    expect(ligatureExpansion(0xd801)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Rewriting the CMap
 * ------------------------------------------------------------------ */

describe("fixToUnicode", () => {
  test("a ligature in a bfchar destination becomes its expansion", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOf([[0x0654, "FB01"], [0x0003, "0020"]])));
    expect(unresolvedLigatures(out)).toEqual([]);
    const text = cmaps(out).join("");
    expect(text).toContain("<0654> <00660069>");
    expect(text).toContain("<0003> <0020>");
  });

  test("a ligature hidden in a bfrange destination is found", () => {
    // This is the shape chromium actually emits: three consecutive glyphs whose
    // destinations increment from U+FB00. A pass reading only bfchar entries sees
    // nothing at all here.
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    expect(unresolvedLigatures(out)).toEqual([]);
    const text = cmaps(out).join("");
    expect(text).toContain("<0675> <00660066>");
    expect(text).toContain("<0676> <00660069>");
    expect(text).toContain("<0677> <0066006C>");
  });

  test("every glyph a rewritten range covered is still present", () => {
    // A range replaced by a bfchar block must not drop the glyphs in it that had
    // nothing to do with ligatures.
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0678, 0xfb00)));
    const text = cmaps(out).join("");
    for (const gid of ["0675", "0676", "0677", "0678"]) expect(text).toContain(`<${gid}>`);
  });

  test("a block header states the number of entries it actually contains", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = cmaps(out).join("");
    for (const m of text.matchAll(/(\d+) begin(bfchar|bfrange)\n([\s\S]*?)\nend\1/g)) {
      const entries = m[3]!.split("\n").filter((l) => l.trim()).length;
      expect(Number(m[1])).toBe(entries);
    }
  });

  test("a range with no ligature in it is left exactly as written", () => {
    const input = pdfWithCMap(cmapOfRange(0x0044, 0x004c, 0x0061));
    expect(sameBytes(fixToUnicode(input), input)).toBe(true);
  });

  test("a document with no ligature is returned byte for byte", () => {
    const input = pdfWithCMap(cmapOf([[0x0003, "0020"], [0x0014, "0031"], [0x0079, "00B7"]]));
    expect(sameBytes(fixToUnicode(input), input)).toBe(true);
  });

  test("the codespacerange line is not mistaken for a glyph mapping", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    expect(cmaps(out).join("")).toContain("<0000> <FFFF>");
  });

  test("a rewritten file is still a valid pdf", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = Buffer.from(out).toString(LATIN1);
    expect(text.match(/startxref/g)).toHaveLength(1);
    const at = Number(text.match(/startxref\s+(\d+)/)![1]);
    expect(text.slice(at, at + 4)).toBe("xref");
    const header = text.slice(at).match(/^xref\s+0\s+(\d+)\s/)!;
    const table = text.slice(at + header[0].length);
    let checked = 0;
    for (let n = 1; n < Number(header[1]); n++) {
      const entry = table.slice(n * 20, n * 20 + 20);
      if (entry[17] !== "n") continue;
      checked++;
      expect(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + 20)).toStartWith(`${n} 0 obj`);
    }
    expect(checked).toBeGreaterThan(0);
    expect(text).not.toContain("endobjxref");
  });

  test("a stream's /Length matches the payload after rewriting", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = Buffer.from(out).toString(LATIN1);
    let streams = 0;
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj([\s\S]*?)endobj/g)) {
      const body = m[2]!;
      const len = body.split("stream")[0]!.match(/\/Length (\d+)/);
      const at = body.match(/stream\r?\n/);
      if (!len || !at || at.index === undefined) continue;
      streams++;
      const end = body.lastIndexOf("\nendstream");
      expect(Buffer.from(body, LATIN1).subarray(at.index + at[0].length, end).length).toBe(Number(len[1]));
    }
    expect(streams).toBeGreaterThan(0);
  });

  test("input that is not a linear pdf is returned untouched", () => {
    for (const junk of [Buffer.alloc(0), Buffer.from("not a pdf"), Buffer.from("%PDF-1.7\n")]) {
      expect(sameBytes(fixToUnicode(junk), junk)).toBe(true);
    }
  });

  test("a Uint8Array that is not a Buffer is still read as bytes", () => {
    const input = pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00));
    const asView = new Uint8Array(input);
    expect(asView).not.toBeInstanceOf(Buffer);
    expect(unresolvedLigatures(fixToUnicode(asView))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------ */

describe("rendered output", () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-tounicode-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  test("text with ligatures leaves none behind in the ToUnicode", async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient different flags finished</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
  });

  test("extracted text is plain letters, so a word search finds it", async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient different flags finished</p>`,
    });
    const text = await pdfText(r.pdf);
    for (const word of ["office", "efficient", "different", "flags", "finished"]) {
      expect(text.toLowerCase()).toContain(word);
    }
    // The presentation forms must not be in the extracted text either.
    for (const cp of [0xfb00, 0xfb01, 0xfb02]) {
      expect(text).not.toContain(String.fromCodePoint(cp));
    }
  });

  test("a document with no ligature is unaffected", async () => {
    const r = await render(browser, { html: `<!doctype html><p>plain words only</p>` });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(await pdfText(r.pdf)).toContain("plain words only");
  });

  test("arabic letters carrying hamza keep their codepoints", async () => {
    // The case a blind NFKC pass would corrupt: these are single letters, and
    // decomposing them would insert a combining mark mid-word.
    const r = await render(browser, {
      html: `<!doctype html><p dir="rtl" lang="ar">الأ专著 والمكتبة</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(r.info.pages).toBe(1);
  });

  test("hebrew and french text survive", async () => {
    for (const html of [`<p dir="rtl" lang="he">שלום עולם</p>`, `<p lang="fr">œuvre cœur</p>`]) {
      const r = await render(browser, { html: `<!doctype html>${html}` });
      expect(unresolvedLigatures(r.pdf)).toEqual([]);
      expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    }
  });

  test("the file is still readable after both fixes have run", async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient</p>`,
    });
    const info = await pdfInfo(r.pdf);
    expect(info.pages).toBe(1);
    const text = Buffer.from(r.pdf).toString(LATIN1);
    expect(text.match(/startxref/g)).toHaveLength(1);
    expect(text.slice(Number(text.match(/startxref\s+(\d+)/)![1]))).toStartWith("xref");
  });

  test("the fix composes with the descriptor fix in one pass", async () => {
    // Both rewrite the file and rebuild the xref, so running them in sequence is
    // the case most likely to corrupt the offsets.
    const r = await render(browser, {
      html: `<!doctype html><p style="font-family:sans-serif">office efficient</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    const text = Buffer.from(r.pdf).toString(LATIN1);
    const header = text.slice(Number(text.match(/startxref\s+(\d+)/)![1])).match(/^xref\s+0\s+(\d+)\s/)!;
    const table = text.slice(Number(text.match(/startxref\s+(\d+)/)![1]) + header[0].length);
    let bad = 0;
    for (let n = 1; n < Number(header[1]); n++) {
      const entry = table.slice(n * 20, n * 20 + 20);
      if (entry[17] !== "n") continue;
      const off = Number(entry.slice(0, 10));
      if (!text.startsWith(`${n} 0 obj`, off)) bad++;
    }
    expect(bad).toBe(0);
  });
});