import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";

/**
 * A PNG of the given size, filled with a deterministic gradient.
 *
 * A gradient rather than a flat colour because a flat one compresses to almost nothing
 * and the downsampling test needs a file that actually shrinks. Deterministic so two
 * runs produce the same bytes and a size comparison means what it says.
 */
function widePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 255 / width) | 0;
      raw[row + 2 + x * 3] = (y * 255 / height) | 0;
      raw[row + 3 + x * 3] = ((x ^ y) * 7) & 0xff;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "letterpress-audit-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

/** Width and height in points, parsed from a MediaBox string. */
const boxSize = (box: string) => {
  const m = box.match(/\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/);
  return { w: Number(m![1]), h: Number(m![2]) };
};

test("a page count above eight is reported correctly", async () => {
  for (const n of [9, 12, 40]) {
    const html = `<!doctype html><style>@page{size:A4;margin:8mm}</style>` +
      Array.from({ length: n }, (_, i) => `<div style="break-before:page">p${i + 1}</div>`).join("");
    const r = await render(browser, { html });
    expect(r.info.pages).toBe(n);
  }
}, 90_000);

test("a document that declares no paper defaults to a4, not us letter", async () => {
  const r = await render(browser, { html: "<!doctype html><p>no @page here</p>" });
  expect(r.info.mediaBoxes[0]).toMatch(/595\.\d+ 841\.\d+/);
}, 30_000);

test("--format a4 and @page size a4 agree to within a point", async () => {
  const viaFlag = await render(browser, { html: "<!doctype html><p>x</p>", format: "a4" });
  const viaCss = await render(browser, {
    html: "<!doctype html><style>@page{size:a4;margin:0}</style><p>x</p>",
  });
  const size = (box: string) => box.match(/([\d.]+)\s+([\d.]+)\s*\]/)!.slice(1).map(Number);
  const a = size(viaFlag.info.mediaBoxes[0]);
  const b = size(viaCss.info.mediaBoxes[0]);
  // Chromium resolves its named A4 constant and its CDP paperWidth path
  // separately and they differ by about 0.96pt, a third of a millimetre.
  expect(Math.abs(a[0] - b[0])).toBeLessThan(1.5);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(1.5);
}, 30_000);

test("--landscape under a portrait @page is an error, not silence", async () => {
  const r = await render(browser, {
    html: "<!doctype html><style>@page{size:A4;margin:10mm}</style><p>x</p>",
    landscape: true,
  });
  expect(codes(r.findings)).toContain("orientation-ignored");
  expect(r.findings.find((f) => f.code === "orientation-ignored")!.severity).toBe("error");
  // and the PDF really is portrait, which is what the error is about
  expect(r.info.mediaBoxes[0]).toMatch(/594\.\d+ 841\.\d+/);
}, 30_000);

test("--margin under a declared @page margin is reported", async () => {
  const r = await render(browser, {
    html: "<!doctype html><style>@page{size:A4;margin:0}</style><p>x</p>",
    format: "a4",
    margin: "20mm",
  });
  expect(codes(r.findings)).toContain("margin-ignored");
}, 30_000);

test("an unfilled template placeholder is an error", async () => {
  const r = await render(browser, {
    html: "<!doctype html><style>@page{size:A4}</style><p>{{company}} owes {{total}}</p>",
  });
  const f = r.findings.find((x) => x.code === "unfilled-placeholder")!;
  expect(f).toBeTruthy();
  expect(f.severity).toBe("error");
  expect(f.message).toContain("{{company}}");
}, 30_000);

test("a data file rendered as a document is refused with a finding", async () => {
  const r = await render(browser, { html: JSON.stringify({ a: 1, b: ["x", "y"] }, null, 2) });
  expect(codes(r.findings)).toContain("json-rendered");
}, 30_000);

test("target-counter in a stylesheet is reported, because it prints nothing", async () => {
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
.toc a::after{content: leader('.') target-counter(attr(href url), page)}
</style><h1>T</h1><p><a href="#s">Section</a></p><h2 id="s">Section</h2>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === "unsupported-paged-media")!;
  expect(f).toBeTruthy();
  expect(f.severity).toBe("error");
  expect(f.message).toContain("target-counter");
}, 30_000);

test("digits at risk of bidi reversal in arabic text are reported", async () => {
  const html = `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === "rtl-digit-run")!;
  expect(f).toBeTruthy();
  expect(f.message).toContain("2026-10-03");
  expect(f.message).toContain("bdi");
}, 30_000);

test("a character no installed font covers is reported", async () => {
  // A private-use codepoint: absent from every font, so the fallback chain ends
  // at the last-resort box. CJK would not do, since the Noto fallback covers it.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>marker  here</p></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === "missing-glyph")!;
  expect(f).toBeTruthy();
  expect(f.message).toContain("U+E000");
}, 30_000);

test("every missing glyph is listed, not capped", async () => {
  // 20 distinct private-use codepoints. A cap reports a few and implies the
  // document is otherwise clean, which is how problems go unnoticed.
  const chars = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0xe000 + i)).join("");
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>${chars}</p></body></html>`;
  const r = await render(browser, { html });
  expect(r.findings.filter((x) => x.code === "missing-glyph").length).toBe(20);
}, 30_000);

test("a no-break space is reported as a real space, not as an invisible format character", async () => {
  // U+00A0 has no glyph of its own in most fonts, but it occupies exactly a
  // space's width and prints as one. Grouping it with the formatting characters
  // made ordinary documents emit a phantom finding, and described it as
  // invisible, which it is not: pdftotext -bbox puts it at the same x as "a b".
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>a&nbsp;b</p></body></html>`;
  const r = await render(browser, { html });
  const joined = r.findings.map((x) => x.message).join(" ");
  expect(joined).not.toContain("invisible formatting characters");
  expect(joined).toContain("U+00A0");
}, 30_000);

test("a character covered by the font fallback chain is not reported", async () => {
  // 度量 is absent from Noto Naskh Arabic but present in the system CJK fonts,
  // so it prints correctly and must stay silent.
  const html = `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>القياس 度量</p></body></html>`;
  const r = await render(browser, { html });
  expect(codes(r.findings)).not.toContain("missing-glyph");
}, 30_000);

test("a date with a strong ltr character before it is not reported", async () => {
  // "ISO 8601: 2026-10-03" and "INV-2026-014" both keep their digits in order,
  // because the last strong character before the number is left-to-right.
  const one = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>ISO 8601: 2026-10-03</p></body></html>`,
  });
  expect(codes(one.findings)).not.toContain("rtl-digit-run");

  const two = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>رقم INV-2026-0147</p></body></html>`,
  });
  expect(codes(two.findings)).not.toContain("rtl-digit-run");
}, 40_000);

test("a date with no dir attribute at all is still reported", async () => {
  // lang="ar" with no dir is how most people write an Arabic document, and the
  // paragraph direction is inferred from the first strong character.
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p></body></html>`,
  });
  expect(codes(r.findings)).toContain("rtl-digit-run");
}, 30_000);

test("the prescribed fix does not re-trigger the warning", async () => {
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: <bdi dir="ltr">2026-10-03</bdi></p></body></html>`,
  });
  expect(codes(r.findings)).not.toContain("rtl-digit-run");
}, 30_000);

test("repeated occurrences are counted, not collapsed to one", async () => {
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p><p>التاريخ: 2026-10-03</p></body></html>`,
  });
  const f = r.findings.find((x) => x.code === "rtl-digit-run")!;
  expect(f).toBeTruthy();
  expect(f.message).toContain("2 times");
}, 30_000);

test("--format with --landscape actually produces landscape", async () => {
  const doc = `<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>x</h1>`;
  const r = await render(browser, { html: doc, format: "a4", landscape: true });
  const { w, h } = boxSize(r.info.mediaBoxes[0]);
  expect(w).toBeGreaterThan(h);
  expect(codes(r.findings)).toContain("page-size-override");
}, 30_000);

test("a commented-out @page is not treated as a declaration", async () => {
  // Reading the comment made the tool call a landscape PDF portrait.
  const r = await render(browser, {
    html: `<!doctype html><style>/* @page{size:A5} */ @page{margin:10mm}</style><h1>x</h1>`,
    landscape: true,
  });
  expect(codes(r.findings)).not.toContain("orientation-ignored");
  const { w, h } = boxSize(r.info.mediaBoxes[0]);
  expect(w).toBeGreaterThan(h);
}, 30_000);

test("plain latin text raises no text findings", async () => {
  const r = await render(browser, {
    html: `<!doctype html><style>@page{size:A4;margin:15mm}</style>
<body style="font-family:sans-serif"><p>Invoice 2026-014 dated 2026-10-03, total 1,234.56</p></body>`,
  });
  expect(codes(r.findings).filter((c) => c === "rtl-digit-run" || c === "missing-glyph")).toHaveLength(0);
}, 30_000);

test("an http failure is reported instead of printing the error page", async () => {
  let message = "";
  try {
    await render(browser, {
      url: "https://this-host-does-not-exist-zzq7.invalid/",
      allowNetwork: true,
      timeoutMs: 20_000,
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  // Either a name resolution failure or a proxy answering with a status.
  expect(message).toMatch(/could not load|ERR_|HTTP \d\d\d/);
}, 40_000);

test("a document declaring no paper defaults to a4 through the work server", async () => {
  // The document is served over loopback rather than opened as a file, so a
  // regression here means the served copy is empty or missing.
  const r = await render(browser, { html: "<!doctype html><p>served</p>" });
  expect(r.info.pages).toBe(1);
  expect(r.info.mediaBoxes[0]).toMatch(/59[45]\.\d+ 84[12]\.\d+/);
}, 30_000);

test("SOURCE_DATE_EPOCH makes output byte-reproducible", async () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "1700000000";
  try {
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>reproducible</p>`;
    const a = await render(browser, { html, author: "Someone" });
    // Straddle a second boundary on purpose. Rendering twice back to back lands in
    // the same second, where the timestamps are equal however they are handled, so
    // this test could not see a timestamp that was never pinned at all -- which is
    // how the XMP packet kept the wall clock while the dictionary was pinned.
    await Bun.sleep(1_100);
    const b = await render(browser, { html, author: "Someone" });
    // Chromium varies both /CreationDate and the document title, which it takes
    // from the page URL. Fixing only the date still leaves the bytes different.
    expect(new TextDecoder("latin1").decode(a.pdf)).toBe(new TextDecoder("latin1").decode(b.pdf));
    const text = new TextDecoder("latin1").decode(a.pdf);
    expect(text).toMatch(/D:20231114\d{6}Z/);
    expect(text).toContain("document");
    // The packet carries the same two timestamps in ISO 8601, and both are pinned.
    expect(text).toContain("<xmp:CreateDate>2023-11-14T");
    expect(text).toContain("<xmp:ModifyDate>2023-11-14T");
    expect(text).not.toMatch(/<xmp:(?:Create|Modify)Date>(?!2023-11-14)/);
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 60_000);

test("without a pinned clock two renders differ only in their timestamps", async () => {
  // The counterpart to the above, and the reason the epoch exists: an unpinned
  // render is not reproducible, and pretending otherwise is what a test that
  // renders twice in the same second would do.
  const previous = process.env.SOURCE_DATE_EPOCH;
  delete process.env.SOURCE_DATE_EPOCH;
  try {
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>unpinned</p>`;
    const a = await render(browser, { html });
    await Bun.sleep(1_100);
    const b = await render(browser, { html });
    const first = new TextDecoder("latin1").decode(a.pdf);
    const second = new TextDecoder("latin1").decode(b.pdf);
    expect(first).not.toBe(second);
    // Same length: only the digits of the timestamp differ.
    expect(first.length).toBe(second.length);
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 60_000);

test("without SOURCE_DATE_EPOCH the timestamp is left alone", async () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  delete process.env.SOURCE_DATE_EPOCH;
  try {
    const r = await render(browser, { html: "<!doctype html><p>unstamped</p>" });
    const text = new TextDecoder("latin1").decode(r.pdf);
    // The timestamp is Chromium's own, and the title is normalised either way.
    // What must not reappear is the loopback address the document was served
    // from: a random port in the metadata made two runs of one input differ.
    expect(text).toMatch(/D:\d{14}/);
    expect(text).not.toMatch(/127\.0\.0\.1:\d+/);
    // Trailing spaces are the fixed-width padding. A pdf reader trims them, and
    // pdfinfo reports the title as exactly "document".
    expect(text).toMatch(/\/Title \(document *\)/);
  } finally {
    if (previous !== undefined) process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 30_000);

test("images are downsampled to the cap, and reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letterpress-img-"));
  try {
    // 1200px wide at 180mm is 169ppi, so 120ppi must reduce it.
    //
    // Built here rather than read from /tmp. An earlier version read
    // /tmp/small.jpg, which is outside the repository: the test passed on the machine
    // that wrote it and failed on every other one, and here it failed the moment that
    // file was cleaned up. A test that depends on state it does not create is not a
    // test.
    const photo = join(dir, "photo.png");
    await Bun.write(photo, widePng(1200, 900));
    const doc = `<!doctype html><style>@page{size:A4;margin:10mm} img{width:180mm}</style><img src="photo.png">`;
    await Bun.write(join(dir, "doc.html"), doc);

    const capped = await render(browser, { path: join(dir, "doc.html"), maxImagePpi: 120 });
    expect(capped.findings.map((f) => f.code)).toContain("image-downsampled");
    expect(capped.info.imageObjects).toBe(1);

    const off = await render(browser, { path: join(dir, "doc.html"), maxImagePpi: 0 });
    expect(off.findings.map((f) => f.code)).not.toContain("image-downsampled");
    // Downsampling must actually shrink the file, not merely claim to.
    expect(capped.pdf.byteLength).toBeLessThan(off.pdf.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 90_000);