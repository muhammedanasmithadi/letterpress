import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { hasRelativeAssets, parseFormat, render, stageAssets } from "../src/render.ts";
import { invoiceTotals } from "../src/template.ts";
import { pdfImages, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;
let dir: string;

// A 16x16 PNG. Chosen because chromium's broken-image placeholder is 14x16, so
// the two are distinguishable in pdfimages output: a document that lost its
// picture would otherwise still report "an image is present".
//
// The previous literal was 102 characters, so 101 data characters: not valid base64
// at all. Decoders that drop the trailing partial group produced 75 bytes whose IDAT
// failed its CRC and which had no IEND, and chromium happened to draw a 16x16 box
// anyway -- so four tests passed against an image no conforming decoder could read.
// The same class of error as the invalid base64 that made ten alt-text measurements
// describe a broken-image placeholder.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGM8oWHDQApgIkn1qIZRDUNKAwDJMQFMogTzfQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Fails loudly if the fixture stops being a decodable 16x16 image.
 *
 * Base64 validity is a precondition of every test in this file and nothing else
 * checks it, so it is checked once, here, where the failure is legible.
 */
test("the image fixture is a decodable 16x16 png", async () => {
  expect(PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(PNG.readUInt32BE(16)).toBe(16); // IHDR width
  expect(PNG.readUInt32BE(20)).toBe(16); // IHDR height
  // Walk to IEND, checking every chunk's CRC.
  let at = 8;
  const seen: string[] = [];
  while (at + 12 <= PNG.length) {
    const length = PNG.readUInt32BE(at);
    const type = PNG.subarray(at + 4, at + 8).toString("latin1");
    seen.push(type);
    const stored = PNG.readUInt32BE(at + 8 + length);
    let crc = ~0 >>> 0;
    const bytes = PNG.subarray(at + 4, at + 8 + length);
    for (const b of bytes) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    expect(((~crc) >>> 0), `crc of ${type}`).toBe(stored);
    at += 12 + length;
    if (type === "IEND") break;
  }
  expect(seen).toContain("IHDR");
  expect(seen).toContain("IDAT");
  expect(seen[seen.length - 1]).toBe("IEND");
});

/** Real pictures only: pdfimages also lists the soft mask that accompanies each. */
const pictures = async (bytes: Uint8Array) =>
  (await pdfImages(bytes)).filter((i) => i.type === "image" && i.width === 16 && i.height === 16);

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "letterpress-adv-"));
  dir = await mkdtemp(join(tmpdir(), "letterpress-adv-doc-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 20_000);

describe("format validation", () => {
  test("rejects an unknown format by name instead of crashing", async () => {
    // FORMATS keys are lowercase, so an unvalidated "A4" reached FORMATS["A4"] as
    // undefined and threw a TypeError from inside the precedence check. And the
    // `in` check that guarded it accepted "toString" and "constructor" off the
    // prototype chain, which crashed the same way.
    for (const bad of ["a9", "nope", "__proto__", "toString", "constructor"]) {
      let message = "";
      try {
        await render(browser, { html: "<!doctype html><p>x</p>", format: bad as never });
      } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message, `format: ${bad}`).toContain("unknown format");
      expect(message).toContain("a4");
    }
  }, 60_000);

  test("accepts a case-insensitive name and honours it", async () => {
    for (const name of ["a4", "A4", "A4 ", " letter "]) {
      const r = await render(browser, { html: "<!doctype html><p>x</p>", format: name as never });
      expect(r.info.pages).toBe(1);
    }
    const letter = await render(browser, { html: "<!doctype html><p>x</p>", format: "LETTER" as never });
    expect(letter.info.mediaBoxes[0]).toMatch(/612/);
  }, 90_000);

  test("parseFormat is the single validation point", () => {
    expect(parseFormat("a4")).toBe("a4");
    expect(parseFormat(undefined)).toBeUndefined();
    expect(parseFormat("")).toBeUndefined();
    expect(() => parseFormat("A9")).toThrow(/unknown format/);
    expect(() => parseFormat(7 as never)).toThrow(/must be a string/);
  });
});

describe("a missing subresource does not kill the render", () => {
  test("a 404 stylesheet renders the document and reports the failure", async () => {
    const r = await render(browser, {
      html: `<!doctype html><head><link rel="stylesheet" href="typo.css"></head>
<body><h1>HELLO</h1></body>`,
    });
    expect(await pdfText(r.pdf)).toContain("HELLO");
    expect(r.findings.map((f) => f.code)).toContain("subresource-failed");
  }, 60_000);

  test("a missing local image still renders and is reported", async () => {
    await writeFile(join(dir, "missing.html"), `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src="gone.png">`);
    const r = await render(browser, { path: join(dir, "missing.html") });
    expect(r.info.pages).toBe(1);
    // The picture is gone and chromium's 14x16 placeholder is in its place.
    expect(await pictures(r.pdf)).toHaveLength(0);
    const code = r.findings.find((f) => f.code === "subresource-failed");
    expect(code).toBeDefined();
    // A silent failure here is the worst kind: the document looks fine until you
    // compare it to the source.
    expect(code!.message).toContain("broken-image placeholder");
  }, 60_000);
});

describe("the relative-asset scan sees every reference form", () => {
  test("recognises quoted, unquoted, srcset and url() references", () => {
    expect(hasRelativeAssets('<img src="a.png">')).toBe(true);
    expect(hasRelativeAssets("<img src=a.png>")).toBe(true);
    expect(hasRelativeAssets('<img srcset="a.png 1x">')).toBe(true);
    expect(hasRelativeAssets('<link href="s.css" rel=stylesheet>')).toBe(true);
    expect(hasRelativeAssets("<style>body{background:url(a.png)}</style>")).toBe(true);
    expect(hasRelativeAssets("<style>@import url(s.css)</style>")).toBe(true);
    expect(hasRelativeAssets("<style>@font-face{src:url(f.woff2)}</style>")).toBe(true);
  });

  test("leaves absolute, inline and fragment references alone", () => {
    expect(hasRelativeAssets('<img src="https://cdn.example/a.png">')).toBe(false);
    expect(hasRelativeAssets('<img src="data:image/png;base64,AAA">')).toBe(false);
    expect(hasRelativeAssets('<a href="#top">x</a>')).toBe(false);
    expect(hasRelativeAssets("<style>body{background:url(data:image/gif;base64,AA)}</style>")).toBe(false);
    expect(hasRelativeAssets("<p>nothing here</p>")).toBe(false);
  });
});

describe("assets reach the document without rewriting it", () => {
  test("an unquoted src embeds the image", async () => {
    await writeFile(join(dir, "unquoted.png"), PNG);
    await writeFile(join(dir, "unquoted.html"), `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src=unquoted.png>`);
    const r = await render(browser, { path: join(dir, "unquoted.html") });
    expect(await pictures(r.pdf)).toHaveLength(1);
  }, 60_000);

  test("a css url() background is staged and applied", async () => {
    await writeFile(join(dir, "bg.png"), PNG);
    await writeFile(join(dir, "bg.html"),
      `<!doctype html><style>@page{size:A4;margin:8mm}body{background:url(bg.png)}</style><p>styled</p>`);
    const r = await render(browser, { path: join(dir, "bg.html") });
    expect(await pdfText(r.pdf)).toContain("styled");
    // The image is referenced from CSS, so it must be reachable by the loader.
    expect(r.findings.map((f) => f.code)).not.toContain("subresource-failed");
  }, 60_000);

  test("a nested path keeps its directories, so two files cannot collide", async () => {
    // Tested on the staged files rather than through the browser. The previous
    // version linked two stylesheets whose effects were not distinguishable from
    // one another alone, so it passed whether or not the collision was fixed.
    // Flattening turned sub/hide.css and sub_hide.css into one file; mirroring
    // keeps them apart, and that is what there is to check.
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "hide.css"), "h1{display:none}");
    await writeFile(join(dir, "sub_hide.css"), "h1{color:#0a0}");
    const doc = join(dir, "collide.html");
    await writeFile(doc,
      `<!doctype html><link rel="stylesheet" href="sub/hide.css"><link rel="stylesheet" href="sub_hide.css">`);

    const work = await mkdtemp(join(tmpdir(), "letterpress-stage-"));
    await stageAssets(
      await readFile(doc, "utf8"), doc, work,
    );

    const hidden = await readFile(join(work, "sub", "hide.css"), "utf8");
    const flat = await readFile(join(work, "sub_hide.css"), "utf8");
    expect(hidden).toContain("display:none");
    expect(flat).toContain("#0a0");
    await rm(work, { recursive: true, force: true });
  });

  test("a filename mentioned in prose is not rewritten", async () => {
    await writeFile(join(dir, "asset.png"), PNG);
    await writeFile(join(dir, "prose.html"),
      `<!doctype html><style>@page{size:A4;margin:8mm}</style>
<img src="asset.png"><p>Save as "asset.png" now</p>`);
    const r = await render(browser, { path: join(dir, "prose.html") });
    // The old whole-document string replace turned the prose into "/asset.png".
    expect(await pdfText(r.pdf)).toContain('Save as "asset.png" now');
    expect(await pdfText(r.pdf)).not.toContain('"/asset.png"');
  }, 60_000);

  test("an asset outside the document directory is refused", async () => {
    // A sibling directory, created here. The path used to be a hardcoded
    // /tmp/opencode/outside-secret.png, which only exists on the machine that wrote
    // it: the first CI run failed this with ENOENT before it tested anything.
    const outside = await mkdtemp(join(tmpdir(), "letterpress-outside-"));
    try {
      await writeFile(join(outside, "outside-secret.png"), PNG);
      await writeFile(join(dir, "escape.html"),
        `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src="${join(outside, "outside-secret.png")}">`);
      const r = await render(browser, { path: join(dir, "escape.html") });
      // It must not be staged: the file is outside the document's directory, so
      // the only thing in the pdf is chromium's placeholder, not the secret.
      expect(await pictures(r.pdf)).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});

describe("invoice totals are checked as numbers", () => {
  test("the totals expose raw values, not only formatted strings", () => {
    const t = invoiceTotals([{ description: "x", qty: 2, unit: 10 }]);
    expect(t.totalValue).toBe(24);
    expect(t.total).toBe("24.00");

    // The guard was `Math.abs(claimed - Number(computed))`. For a small figure
    // Number("24.00") is 24 and the guard happened to work. It broke the moment
    // the formatted string carried a thousands separator, which money() always
    // inserts past 999: Number("3,383,428.75") is NaN, and every NaN comparison
    // is false, so a wrong total printed without complaint.
    const big = invoiceTotals([{ description: "x", qty: 1, unit: 3_383_428.75 }], { vatRate: 0 });
    expect(big.subtotal).toBe("3,383,428.75");
    expect(Number(big.subtotal)).toBeNaN();
    expect(big.subtotalValue).toBe(3_383_428.75);
    expect(Math.abs(1 - big.subtotalValue)).toBeGreaterThan(0.005);
  });
});