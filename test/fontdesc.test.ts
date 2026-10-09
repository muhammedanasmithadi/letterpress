import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Browser } from "../src/browser.ts";
import { fixFontDescriptors, flagsFrom, parseSfnt, unresolvedFontMetrics } from "../src/fontdesc.ts";
import { pdfInfo, pdfText } from "./poppler.ts";
import { render } from "../src/render.ts";

/* ------------------------------------------------------------------ *
 * Builders
 *
 * The tests assert against fonts built to order rather than against a
 * captured PDF. Chromium's output is not available offline, and a captured
 * fixture would only prove that the numbers happen to match this engine's
 * output today, which is a weaker claim than the one that matters: the
 * value is read out of the font, so a font that declares something else
 * must come back declaring something else.
 * ------------------------------------------------------------------ */

type TableSpec = { tag: string; data: Buffer };

/** Assemble a table directory around the given tables. */
function sfnt(tables: TableSpec[], version = 0x00010000): Buffer {
  const num = tables.length;
  let power = 1;
  while (power * 2 <= num) power *= 2;
  const dir = Buffer.alloc(12 + num * 16);
  dir.writeUInt32BE(version, 0);
  dir.writeUInt16BE(num, 4);
  dir.writeUInt16BE(power * 16, 6);
  dir.writeUInt16BE(Math.log2(power), 8);
  dir.writeUInt16BE(num * 16 - power * 16, 10);

  const chunks: Buffer[] = [];
  let at = dir.length;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    dir.write(t.tag.padEnd(4, " ").slice(0, 4), rec, LATIN1);
    dir.writeUInt32BE(0, rec + 4);
    dir.writeUInt32BE(at, rec + 8);
    dir.writeUInt32BE(t.data.length, rec + 12);
    const padded = Buffer.alloc(Math.ceil(t.data.length / 4) * 4);
    t.data.copy(padded);
    chunks.push(padded);
    at += padded.length;
  });
  return Buffer.concat([dir, ...chunks]);
}

const LATIN1 = "latin1" as BufferEncoding;

/** Byte equality that does not care which Uint8Array flavour it was handed. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function head(unitsPerEm: number, macStyle: number): TableSpec {
  const b = Buffer.alloc(54);
  b.writeUInt32BE(0x00010000, 0);
  b.writeUInt16BE(unitsPerEm, 18);
  b.writeUInt16BE(macStyle, 44);
  return { tag: "head", data: b };
}

function os2(version: number, fsSelection: number, sCapHeight: number): TableSpec {
  const b = Buffer.alloc(96);
  b.writeUInt16BE(version, 0);
  b.writeUInt16BE(fsSelection, 62);
  if (version >= 2) b.writeInt16BE(sCapHeight, 86);
  return { tag: "OS/2", data: b };
}

function post(italicAngle: number, isFixedPitch: number): TableSpec {
  const b = Buffer.alloc(32);
  b.writeInt32BE(Math.round(italicAngle * 65536), 4);
  b.writeUInt32BE(isFixedPitch, 12);
  return { tag: "post", data: b };
}

/** A cmap table with one encoding record. 3/1 is Windows Unicode. */
function cmap(platform: number, encoding: number): TableSpec {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(0, 0);
  b.writeUInt16BE(1, 2);
  b.writeUInt16BE(platform, 4);
  b.writeUInt16BE(encoding, 6);
  b.writeUInt32BE(12, 8);
  return { tag: "cmap", data: b };
}

const notoSans = () => sfnt([
  head(1000, 0),
  os2(4, 0x00c0, 536),
  post(0, 0),
  cmap(3, 1),
]);

const notoSansBold = () => sfnt([
  head(1000, 0x01),
  os2(4, 0x00a0, 546),
  post(0, 0),
  cmap(3, 1),
]);

const notoSansItalic = () => sfnt([
  head(1000, 0x02),
  os2(4, 0x0181, 536),
  post(-12, 0),
  cmap(3, 1),
]);

/**
 * A one-font PDF in Chromium's shape: a CIDFontType2, a descriptor carrying the
 * negative cap height and the symbolic flag, and a compressed embedded face.
 *
 * Object numbering is fixed and load-bearing — the descriptor names the face and
 * the font names the descriptor, so every reference has to agree. An earlier
 * version of this builder had the font pointing at object 5 while the descriptor
 * was object 2, and every test in the suite failed for that reason alone.
 *
 *   1 catalog   2 pages   3 page   4 descriptor   5 font   6 embedded face
 */
function pdfWith(fileKey: string, font: Buffer, overrides: Record<string, string>): Buffer {
  const body = deflateSync(font);
  const descriptorBody =
    "<< /Type /FontDescriptor /FontName /BAAAAA+NotoSans-Regular " +
    `/Flags ${overrides.Flags ?? "4"} /FontBBox [-1000 -300 2000 900] /ItalicAngle 0 ` +
    `/Ascent 900 /Descent -300 /CapHeight ${overrides.CapHeight ?? "-714"} /StemV 80 /${fileKey} 6 0 R >>`;

  const parts: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>",
    descriptorBody,
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BAAAAA+NotoSans-Regular /FontDescriptor 4 0 R " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
    `<< /Length1 ${font.length} /Filter /FlateDecode /Length ${body.length} >>\nstream\n`,
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", LATIN1)];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    offsets.push(length);
    const head = Buffer.from(`${i + 1} 0 obj\n${parts[i]}`, LATIN1);
    chunks.push(head);
    length += head.length;
    if (parts[i]!.toString(LATIN1).includes("\nstream\n")) {
      const tail = Buffer.from(`\nendstream\nendobj\n`, LATIN1);
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

/** Read every FontDescriptor's Flags and CapHeight out of a PDF. */
function descriptors(pdf: Uint8Array): Array<{ flags: number; cap: number; hasProgram: boolean }> {
  const text = Buffer.from(pdf).toString(LATIN1);
  const out: Array<{ flags: number; cap: number; hasProgram: boolean }> = [];
  for (const m of text.matchAll(/\/Type \/FontDescriptor([\s\S]*?)>>/g)) {
    const flags = m[1]!.match(/\/Flags (\d+)/);
    const cap = m[1]!.match(/\/CapHeight (-?\d+)/);
    if (flags && cap) {
      out.push({
        flags: Number(flags[1]),
        cap: Number(cap[1]),
        hasProgram: /\/FontFile\d? \d+ 0 R/.test(m[1]!),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading the font
 * ------------------------------------------------------------------ */

describe("parseSfnt", () => {
  test("reads cap height from the font's own OS/2 table", () => {
    const s = parseSfnt(notoSans())!;
    expect(s.unitsPerEm).toBe(1000);
    expect(s.os2Version).toBe(4);
    expect(s.sCapHeight).toBe(536);
    expect(s.macStyle).toBe(0);
    expect(s.unicodeCmap).toBe(true);
  });

  test("a different font yields a different cap height, so the value is read not assumed", () => {
    // 370 units of a 700-unit em is 0.5286 em, which is 529 in PDF units.
    // A hardcoded 536 would be wrong here, which is the point of scaling.
    const scaled = parseSfnt(sfnt([head(700, 0), os2(4, 0x00c0, 370), post(0, 0), cmap(3, 1)]))!;
    expect(Math.round((scaled.sCapHeight / scaled.unitsPerEm) * 1000)).toBe(529);
  });

  test("an OS/2 older than version 2 reports no cap height rather than reading past its end", () => {
    // Version 1 has no sCapHeight field. Reading the offset anyway would return
    // whatever bytes sit there.
    const s = parseSfnt(sfnt([head(1000, 0), os2(1, 0x0040, 536), post(0, 0), cmap(3, 1)]))!;
    expect(s.os2Version).toBe(1);
    expect(s.sCapHeight).toBe(0);
  });

  test("a CFF or Type 1 face has no table directory and is refused", () => {
    expect(parseSfnt(Buffer.from("00010000", "hex"))).toBeUndefined();
    expect(parseSfnt(Buffer.from("%!PS-AdobeFont", LATIN1))).toBeUndefined();
    expect(parseSfnt(Buffer.alloc(4))).toBeUndefined();
  });

  test("a font with only a symbol cmap is not a Unicode text font", () => {
    const s = parseSfnt(sfnt([head(1000, 0), os2(4, 0x0040, 536), post(0, 0), cmap(3, 0)]))!;
    expect(s.unicodeCmap).toBe(false);
  });
});

describe("flagsFrom", () => {
  const base = parseSfnt(notoSans())!;

  test("a Unicode upright proportional face is non-symbolic", () => {
    // 4 is Symbolic. The specification says a font with a Unicode cmap used for
    // text is Nonsymbolic, which is bit 32.
    expect(flagsFrom(base, 4)).toBe(32);
  });

  test("italic is set from the font, whichever of the three tables declares it", () => {
    const byMacStyle = flagsFrom(parseSfnt(sfnt([head(1000, 0x02), os2(4, 0x00c0, 536), post(0, 0), cmap(3, 1)]))!, 4);
    const byAngle = flagsFrom(parseSfnt(sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(-11, 0), cmap(3, 1)]))!, 4);
    const byFsSelection = flagsFrom(parseSfnt(sfnt([head(1000, 0), os2(4, 0x00c1, 536), post(0, 0), cmap(3, 1)]))!, 4);
    expect(byMacStyle & 64).toBe(64);
    expect(byAngle & 64).toBe(64);
    expect(byFsSelection & 64).toBe(64);
  });

  test("a bold upright face is not italic", () => {
    expect(flagsFrom(parseSfnt(notoSansBold())!, 4) & 64).toBe(0);
  });

  test("a monospaced face is marked FixedPitch", () => {
    const mono = parseSfnt(sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(0, 1), cmap(3, 1)]))!;
    expect(flagsFrom(mono, 4) & 1).toBe(1);
    expect(flagsFrom(base, 4) & 1).toBe(0);
  });

  test("a symbol-only font keeps the symbolic bit", () => {
    const sym = parseSfnt(sfnt([head(1000, 0), os2(4, 0x0040, 536), post(0, 0), cmap(3, 0)]))!;
    const flags = flagsFrom(sym, 4);
    expect(flags & 4).toBe(4);
    expect(flags & 32).toBe(0);
  });

  test("bits that cannot be derived are left as the producer wrote them", () => {
    // Serif is bit 2 and Script is bit 8. Neither is decidable from the tables
    // this reads, so a value carrying them must survive untouched.
    const flags = flagsFrom(base, 4 | 2 | 8);
    expect(flags & 2).toBe(2);
    expect(flags & 8).toBe(8);
    expect(flags & 4).toBe(0);
    expect(flags & 32).toBe(32);
  });
});

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

describe("fixFontDescriptors", () => {
  test("rewrites the negative cap height to the font's own value", () => {
    const out = fixFontDescriptors(pdfWith("FontFile2", notoSans(), {}));
    expect(descriptors(out)).toEqual([{ flags: 32, cap: 536, hasProgram: true }]);
  });

  test("the rewritten file is still a valid pdf", () => {
    const out = Buffer.from(fixFontDescriptors(pdfWith("FontFile2", notoSans(), {})));
    const text = out.toString(LATIN1);
    // One startxref, pointing at the table. Two, and readers disagree about
    // which one to honour.
    expect(text.match(/startxref/g)).toHaveLength(1);
    const at = Number(text.match(/startxref\s+(\d+)/)![1]);
    expect(text.slice(at, at + 4)).toBe("xref");
    // Every in-use entry must point at its own object header.
    const size = Number(text.slice(at).match(/xref\s+0\s+(\d+)/)![1]);
    // Start after the whole "xref\n0 N\n" line, not after the first one. Skipping only
    // the first newline left "0 N\n" at the head of the body, so every 20-byte slice
    // was four bytes out and `entry[17] !== "n"` was true for all of them: the loop
    // below checked none of the entries and the test passed on a file with no
    // cross-reference table at all.
    const header = /xref\s+0\s+\d+\s*\n/.exec(text.slice(at))![0];
    const body = text.slice(at + header.length);
    let checked = 0;
    for (let n = 1; n < size; n++) {
      const entry = body.slice(n * 20, n * 20 + 20);
      if (entry[17] !== "n") continue;
      checked++;
      expect(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + 20)).toStartWith(`${n} 0 obj`);
    }
    expect(checked, "no in-use xref entries were examined").toBeGreaterThan(0);
    // An object glued to the keyword after it is one token to a reader.
    expect(text).not.toContain("endobjxref");
    expect(text).toMatch(/\/Size 7/);
  });

  test("a CFF font is left exactly as it was", () => {
    // FontFile3 carries no sfnt directory, so there is nothing to read and
    // inventing metrics from the descriptor would be worse than leaving them.
    const input = pdfWith("FontFile3", notoSans(), { Flags: "4", CapHeight: "-714" });
    const out = fixFontDescriptors(input);
    expect(sameBytes(out, input)).toBe(true);
  });

  test("a font with no usable sCapHeight keeps the cap height it arrived with", () => {
    const old = sfnt([head(1000, 0), os2(1, 0x0040, 0), post(0, 0), cmap(3, 1)]);
    const out = fixFontDescriptors(pdfWith("FontFile2", old, {}));
    // Flags is still corrected, because the font speaks for that. CapHeight is
    // not, because it does not.
    expect(descriptors(out)).toEqual([{ flags: 32, cap: -714, hasProgram: true }]);
  });

  test("a positive cap height already in place is left alone", () => {
    const out = fixFontDescriptors(pdfWith("FontFile2", notoSans(), { CapHeight: "700" }));
    expect(descriptors(out)).toEqual([{ flags: 32, cap: 700, hasProgram: true }]);
  });

  test("only Flags and CapHeight change; every other descriptor field survives", () => {
    const input = pdfWith("FontFile2", notoSans(), {});
    const out = fixFontDescriptors(input);
    const fields = (pdf: Uint8Array) => {
      const t = Buffer.from(pdf).toString(LATIN1);
      return {
        name: t.match(/\/FontName (\S+)/)![1],
        bbox: t.match(/\/FontBBox (\[[^\]]+\])/)![1],
        ascent: t.match(/\/Ascent (-?\d+)/)![1],
        descent: t.match(/\/Descent (-?\d+)/)![1],
        angle: t.match(/\/ItalicAngle (-?[\d.]+)/)![1],
        stem: t.match(/\/StemV (\d+)/)![1],
      };
    };
    expect(fields(out)).toEqual(fields(input));
  });

  test("input that is not a linear pdf is returned untouched", () => {
    for (const junk of [Buffer.alloc(0), Buffer.from("not a pdf at all"), Buffer.from("%PDF-1.7\n")]) {
      expect(sameBytes(fixFontDescriptors(junk), junk)).toBe(true);
    }
  });

  test("a pdf with nothing to correct comes back byte for byte", () => {
    // Already correct, and carrying a CFF face, so there is nothing to derive.
    const good = pdfWith("FontFile3", notoSans(), { Flags: "32", CapHeight: "536" });
    expect(sameBytes(fixFontDescriptors(good), good)).toBe(true);
  });

  test("a value already matching the font does not rewrite the file", () => {
    // Rebuilding is only worth its risk when something changes. Both fields are
    // already what the font says here, so there is nothing to do.
    const input = pdfWith("FontFile2", notoSans(), { Flags: "32", CapHeight: "536" });
    expect(sameBytes(fixFontDescriptors(input), input)).toBe(true);
  });

  test("a Uint8Array that is not a Buffer is still read as bytes", () => {
    // A type assertion leaves a Uint8Array in place, and its toString ignores
    // the encoding argument and returns no bytes at all. The file then looked
    // uncorrectable and was passed through with nothing said.
    const input = pdfWith("FontFile2", notoSans(), {});
    const asView = new Uint8Array(input);
    expect(asView).not.toBeInstanceOf(Buffer);
    expect(descriptors(fixFontDescriptors(asView))).toEqual([{ flags: 32, cap: 536, hasProgram: true }]);
  });

  test("a null byte cannot truncate the scan", () => {
    const input = Buffer.concat([pdfWith("FontFile2", notoSans(), {}), Buffer.from([0])]);
    expect(descriptors(fixFontDescriptors(input))).toEqual([{ flags: 32, cap: 536, hasProgram: true }]);
  });
});

/* ------------------------------------------------------------------ *
 * End to end
 *
 * The synthetic PDFs above prove the rewrite. These prove the pipeline
 * calls it, and that a reader still sees the same document afterwards.
 * ------------------------------------------------------------------ */

describe("rendered output", () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-fontdesc-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  // Noto Sans, named rather than generic, because the claim is that cap heights are
  // read per font and that needs a family whose bold genuinely differs from its regular:
  // measured 536 against 546.
  //
  // This said "DejaVu Sans", which named nothing. DejaVu is not installed on every
  // machine -- fc-match resolved it to Noto Sans here -- and where it is installed its
  // bold shares the regular's cap height, because DejaVu derives one from the other. So
  // the fixture produced two distinct cap heights on one machine and one on another, and
  // the first CI run failed on the machine where it produced one.
  const threeFaces = `<!doctype html><meta charset="utf-8">
    <style>@page{size:A4;margin:10mm}body{font-family:"Noto Sans",sans-serif}</style>
    <p style="font-weight:400">Regular face text</p>
    <p style="font-weight:700">Bold face text</p>
    <p style="font-style:italic">Italic face text</p>`;

  test("every descriptor with an embedded font gets a positive cap height", async () => {
    const r = await render(browser, { html: threeFaces });
    const withProgram = descriptors(r.pdf).filter((d) => d.hasProgram);
    expect(withProgram.length).toBeGreaterThan(0);
    for (const d of withProgram) expect(d.cap).toBeGreaterThan(0);
  });

  test("the symbolic bit is replaced by non-symbolic on every embedded face", async () => {
    const r = await render(browser, { html: threeFaces });
    const withProgram = descriptors(r.pdf).filter((d) => d.hasProgram);
    // A loop over a possibly empty list asserts nothing, and the neighbouring test has
    // exactly this guard for exactly this reason.
    expect(withProgram.length).toBeGreaterThan(0);
    for (const d of withProgram) {
      expect(d.flags & 4).toBe(0);
      expect(d.flags & 32).toBe(32);
    }
  });

  test("an italic face is marked italic and an upright one is not", async () => {
    // A synthesised italic arrives as a Type 3 font with no embedded face, so this
    // deliberately does not name a family: the default one has a real italic.
    const r = await render(browser, {
      html: `<!doctype html><p>upright</p><p><i>italic text</i></p>`,
    });
    const faces = descriptors(r.pdf).filter((d) => d.hasProgram);
    const italic = faces.filter((d) => d.flags & 64);
    const upright = faces.filter((d) => !(d.flags & 64));
    expect(italic.length).toBeGreaterThan(0);
    expect(upright.length).toBeGreaterThan(0);
  });

  test("serif-ness survives while the italic bit is added", async () => {
    // NotoSerif-Italic derives Flags 98: Nonsymbolic 32, Serif 2, Italic 64.
    // Serif is not derivable from the tables this reads, so it must be carried
    // through from what the producer wrote rather than cleared.
    const r = await render(browser, {
      html: `<!doctype html><style>body{font-family:"DejaVu Serif",serif}</style><p><i>italic</i></p>`,
    });
    const italic = descriptors(r.pdf).filter((d) => d.hasProgram && d.flags & 64);
    expect(italic.length).toBeGreaterThan(0);
    for (const d of italic) expect(d.flags & 2).toBe(2);
  });

  test("a face the font calls monospaced is marked FixedPitch", async () => {
    // Built to order, because Chromium's subsetter rewrites the post table and
    // zeroes isFixedPitch. The embedded Noto Sans Mono subset therefore declares
    // itself proportional, and Flags 32 follows the declaration rather than the
    // typeface. Measured: post table reads 0003000000000000ff9c0032... so byte 12
    // is 0 on a face whose unsubsetted original says otherwise.
    //
    // This test pins the decision rather than a hope. Reading the typeface name
    // would be a guess; the post table is the font speaking about itself.
    const embedded = descriptors(
      fixFontDescriptors(pdfWith("FontFile2", sfnt([
        head(1000, 0),
        os2(4, 0x00c0, 536),
        post(0, 1),
        cmap(3, 1),
      ]), {})),
    );
    expect(embedded[0]!.flags & 1).toBe(1);
    expect(embedded[0]!.flags & 1).not.toBe(0);
  });

  test("cap heights differ between faces, so they are read per font", async () => {
    const r = await render(browser, { html: threeFaces });
    // Bold and regular in the same family carry different cap heights. A single
    // written-in constant would flatten these to one value.
    const caps = new Set(descriptors(r.pdf).filter((d) => d.hasProgram).map((d) => d.cap));
    expect(caps.size).toBeGreaterThan(1);
  });

  test("a descriptor with no embedded font is reported, not invented", async () => {
    // Chromium emits a Type 3 font when it cannot embed a face. A Type 3 font's
    // glyphs are drawing procedures with no font program, so there is no OS/2
    // table and no derivation available. Leaving it silently would have been the
    // worse outcome.
    const r = await render(browser, { html: threeFaces });
    const gaps = unresolvedFontMetrics(r.pdf);
    const leftover = descriptors(r.pdf).filter((d) => d.cap <= 0);
    expect(leftover.length).toBe(gaps.length);
    for (const g of gaps) {
      expect(g.capHeight).toBeLessThan(0);
      expect(g.fontName).not.toBe("");
    }
    // Whatever is left over is exactly what the finding names.
    const finding = r.findings.find((f) => f.code === "font-metrics");
    if (leftover.length) {
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("warn");
      for (const g of gaps) expect(finding!.message).toContain(g.capHeight < 0 ? String(g.capHeight) : "");
    }
  });

  test("a document whose faces all embed has nothing left to report", async () => {
    const r = await render(browser, {
      html: `<!doctype html><style>body{font-family:"DejaVu Serif",serif}</style><p>Serif <b>bold</b></p>`,
    });
    expect(unresolvedFontMetrics(r.pdf)).toEqual([]);
    expect(r.findings.find((f) => f.code === "font-metrics")).toBeUndefined();
    for (const d of descriptors(r.pdf)) expect(d.cap).toBeGreaterThan(0);
  });

  test("the text still extracts, and reads the same as the source", async () => {
    const r = await render(browser, { html: threeFaces });
    const text = await pdfText(r.pdf);
    for (const word of ["Regular", "face", "text", "Bold", "Italic"]) {
      expect(text).toContain(word);
    }
    // No ligature codepoints and no replacement characters leaked into the
    // extracted text.
    expect(text).not.toContain("\ufffd");
  });

  test("the file is still a readable pdf with the expected page geometry", async () => {
    const r = await render(browser, { html: threeFaces });
    const info = await pdfInfo(r.pdf);
    expect(info.pages).toBe(1);
    // 210x297mm at 72dpi, which is what A4 is in points.
    const [, w, h] = r.info.mediaBoxes[0]!.match(/([\d.]+) ([\d.]+)\]$/)!;
    expect(Number(w)).toBeCloseTo(595.28, 0);
    expect(Number(h)).toBeCloseTo(841.89, 0);
  });

  test("the cross-reference table survives the rebuild", async () => {
    const r = await render(browser, { html: threeFaces });
    const text = Buffer.from(r.pdf).toString(LATIN1);
    // One table, one pointer. Two startxref lines is a file readers disagree
    // about, which is how this shipped broken once.
    expect(text.match(/startxref/g)).toHaveLength(1);
    const at = Number(text.match(/startxref\s+(\d+)/)![1]);
    expect(text.slice(at, at + 4)).toBe("xref");
    // Every in-use entry resolves to its own object header.
    const header = text.slice(at).match(/^xref\s+0\s+(\d+)\s/)!;
    const size = Number(header[1]);
    // Entries begin after the subsection header, which is not a fixed width.
    const table = text.slice(at + header[0].length);
    let checked = 0;
    for (let n = 1; n < size; n++) {
      const entry = table.slice(n * 20, n * 20 + 20);
      if (entry.length < 20 || entry[17] !== "n") continue;
      const off = Number(entry.slice(0, 10));
      checked++;
      expect(text.slice(off, off + 24)).toStartWith(`${n} 0 obj`);
    }
    expect(checked).toBeGreaterThan(0);
    // No object fused to the keyword after it.
    expect(text).not.toContain("endobjxref");
    expect(text).not.toContain("endobjtrailer");
  });

  test("every indirect reference in the file resolves to a defined object", async () => {
    const r = await render(browser, { html: threeFaces });
    const text = Buffer.from(r.pdf).toString(LATIN1);
    const defined = new Set(
      [...text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)].map((m) => Number(m[1])));
    const referenced = new Set(
      [...text.matchAll(/(?:^|[^0-9])(\d+) 0 R\b/g)].map((m) => Number(m[1])));
    expect(referenced.size).toBeGreaterThan(0);
    for (const n of referenced) expect(defined.has(n)).toBe(true);
  });

  test("a document with no fonts is left alone", async () => {
    const r = await render(browser, { html: "<!doctype html><p>no text</p>" });
    expect(r.info.pages).toBe(1);
  });
});