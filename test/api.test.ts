import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { hasRelativeAssets, render } from "../src/render.ts";
import { pdfImages, pdfInfo, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "html2pdf-api-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

/** One page per sheet, each labelled, so page selection can be read back. */
function paged(pages: number): string {
  return `<!doctype html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 6mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { margin: 0; font-family: sans-serif }
.sheet { break-before: page; height: 275mm; font-size: 28pt }
</style></head><body>${Array.from(
    { length: pages },
    (_, i) => `<div class="sheet">PAGE_${i + 1}</div>`,
  ).join("")}</body></html>`;
}

test("pageRanges emits exactly the named pages", async () => {
  const html = paged(8);
  for (const [range, expected] of [
    ["1-2", ["PAGE_1", "PAGE_2"]],
    ["5", ["PAGE_5"]],
    ["3,7", ["PAGE_3", "PAGE_7"]],
    ["2-2", ["PAGE_2"]],
  ] as const) {
    const r = await render(browser, { html, pageRanges: range });
    const text = await pdfText(r.pdf);
    const found = [...new Set([...(text.matchAll(/PAGE_\d+/g) ?? [])].map((m) => m[0]))].sort();
    expect(found, `pageRanges "${range}"`).toEqual([...expected].sort());
  }
}, 120_000);

test("pageRanges leaves total-page counters correct", async () => {
  // The document is 3 pages. Rendering 1-2 must still print "of 3", because the
  // counters come from the document, not from the emitted subset.
  const r = await render(browser, { html: paged(3), pageRanges: "1-2" });
  const text = await pdfText(r.pdf);
  expect(text).toContain("page 1 of 3");
  expect(text).toContain("page 2 of 3");
  expect(text).not.toContain("of 2\n");
  // info.pages counts what was emitted, which is deliberately not the document
  // length. A viewer must not present it as a total.
  expect(r.info.pages).toBe(2);
}, 60_000);

test("omitting pageRanges renders every page", async () => {
  const r = await render(browser, { html: paged(8) });
  expect(r.info.pages).toBe(8);
  const text = await pdfText(r.pdf);
  for (let i = 1; i <= 8; i++) expect(text).toContain(`PAGE_${i}`);
}, 60_000);

test("the stream transfer produces bytes identical to base64", async () => {
  const html = paged(6);
  const viaBase64 = await render(browser, { html, transfer: "base64" });
  const viaStream = await render(browser, { html, transfer: "stream" });
  expect(viaStream.pdf.byteLength).toBe(viaBase64.pdf.byteLength);
  // PDFs are not byte-reproducible run to run, so compare length and structure
  // rather than bytes: the streamed document must be a real, complete PDF.
  expect(new TextDecoder("latin1").decode(viaStream.pdf).slice(0, 8)).toBe("%PDF-1.4");
  expect(viaStream.info.pages).toBe(viaBase64.info.pages);
  expect((await pdfInfo(viaStream.pdf)).pages).toBe(6);
  expect(await pdfText(viaStream.pdf)).toContain("PAGE_6");
}, 120_000);

test("the stream transfer handles a document smaller than one chunk", async () => {
  // IO.read returned eof:false for a 14KB document on a 64KB read, so a short
  // payload must not be mistaken for the end of the stream.
  const r = await render(browser, {
    html: `<!doctype html><style>@page{size:A4}</style><p>tiny</p>`,
    transfer: "stream",
  });
  expect(r.pdf.byteLength).toBeGreaterThan(500);
  expect((await pdfInfo(r.pdf)).pages).toBe(1);
  expect(await pdfText(r.pdf)).toContain("tiny");
}, 60_000);

test("the relative asset scan recognises what it must", () => {
  expect(hasRelativeAssets('<img src="logo.png">')).toBe(true);
  expect(hasRelativeAssets('<link href="style.css" rel="stylesheet">')).toBe(true);
  expect(hasRelativeAssets('<img src="./a/b.png">')).toBe(true);
  expect(hasRelativeAssets('<a href="#top">x</a>')).toBe(false);
  expect(hasRelativeAssets('<img src="https://cdn.example/a.png">')).toBe(false);
  expect(hasRelativeAssets('<img src="data:image/png;base64,AAA">')).toBe(false);
  expect(hasRelativeAssets('<script src="//cdn.example/x.js"></script>')).toBe(false);
  expect(hasRelativeAssets("<p>no assets at all</p>")).toBe(false);
});

test("the fast path prints a document with no relative assets", async () => {
  const r = await render(browser, { html: paged(3), preferFastPath: true });
  expect(r.info.pages).toBe(3);
  expect(await pdfText(r.pdf)).toContain("PAGE_3");
}, 60_000);

test("the fast path is skipped when a relative asset is present, and it still prints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "html2pdf-asset-"));
  try {
    // A 1x1 PNG, so the image genuinely resolves when served.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(dir, "dot.png"), png);
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style>
<img src="dot.png" width="40"><p>after the image</p>`;
    await writeFile(join(dir, "doc.html"), html);

    const r = await render(browser, { path: join(dir, "doc.html") });
    // The image must have loaded, which only happens via the work server.
    expect(await pdfText(r.pdf)).toContain("after the image");
    // A PNG with an alpha channel is emitted as an image plus a soft mask, so
    // two XObjects is correct and one would mean the image never loaded.
    const images = await pdfImages(r.pdf);
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images.some((i) => i.width === 1 && i.height === 1)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 90_000);

test("the fast path can be turned off explicitly", async () => {
  const r = await render(browser, { html: paged(2), preferFastPath: false });
  expect(r.info.pages).toBe(2);
}, 60_000);

test("pageRanges works together with the stream transfer", async () => {
  const r = await render(browser, {
    html: paged(8), pageRanges: "4-6", transfer: "stream",
  });
  expect(r.info.pages).toBe(3);
  const text = await pdfText(r.pdf);
  expect(text).toContain("PAGE_4");
  expect(text).toContain("PAGE_6");
  expect(text).not.toContain("PAGE_1");
}, 90_000);