import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { pdfFonts, pdfImages, pdfInfo, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "html2pdf-test-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm }
@page { @bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif } }
body { font-family: 'Noto Kufi Arabic', sans-serif; margin: 0 }
h1 { color: #123; font-size: 20pt }
.box { width: 40mm; height: 20mm; background: #cde; border: 1pt solid #456 }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums }
td, th { border: 0.5pt solid #999; padding: 2pt }
thead { display: table-header-group }
tr { break-inside: avoid }
</style></head><body>
<h1>Acceptance document</h1>
<p>Vector text, an Arabic line, and a CSS shape.</p>
<p lang="ar" dir="rtl">فاتورة اختبارية</p>
<div class="box"></div>
<table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
${Array.from({ length: 30 }, (_, i) => `<tr><td>Line ${i + 1}</td><td>${(i % 5) + 1}</td><td>${(9.5 + i).toFixed(2)}</td></tr>`).join("")}
</tbody></table>
</body></html>`;

test("renders the paper size the document declares, exactly", async () => {
  const r = await render(browser, { html: DOC });
  expect(r.info.pages).toBeGreaterThan(0);

  // poppler's own reading of the page geometry
  const info = await pdfInfo(r.pdf);
  expect(info.pages).toBe(r.info.pages);
  expect(info.pageSize).toContain("594.96");
  expect(info.pageSize).toContain("841.92");

  const box = r.info.mediaBoxes[0].match(/\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)!;
  expect(Number(box[3]) - Number(box[1])).toBeCloseTo(594.96, 1);
  expect(Number(box[4]) - Number(box[2])).toBeCloseTo(841.92, 1);
}, 30_000);

test("output is vector text with no raster image objects", async () => {
  const r = await render(browser, { html: DOC });

  expect(await pdfImages(r.pdf)).toHaveLength(0);
  expect(r.info.imageObjects).toBe(0);
  expect(r.info.type0Fonts).toBeGreaterThan(0);
  expect(r.info.toUnicodeMaps).toBeGreaterThan(0);
  expect(r.info.producer).toContain("Skia/PDF");
  expect(r.info.tagged).toBe(true);
  expect(r.info.outlineTitles).toContain("Acceptance document");

  const fonts = await pdfFonts(r.pdf);
  const rows = fonts.split("\n").slice(2).filter((l) => l.trim().length > 0);
  expect(rows.length).toBeGreaterThan(1);
  // every font must be embedded, subset, and carry a Unicode map, or the text
  // is neither portable nor selectable
  for (const row of rows) expect(row).toMatch(/\byes\s+yes\s+yes\b/);
  expect(fonts).toMatch(/Arabic/i);
}, 30_000);

test("text is extractable, in Latin and in Arabic", async () => {
  const r = await render(browser, { html: DOC });
  const text = await pdfText(r.pdf);
  expect(text).toContain("Acceptance document");
  expect(text).toContain("Vector text");
  // Arabic survived shaping and is recoverable through the ToUnicode map
  expect(text.replace(/\s+/g, "")).toContain("فاتورةاختبارية");
}, 30_000);

test("CSS margin boxes place real page numbers in the footer", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>
@page { size: A4; margin: 15mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 10pt sans-serif } }
body { font-family: sans-serif }
</style><p>one</p><p style="break-before:page">two</p><p style="break-before:page">three</p>`;
  const r = await render(browser, { html: doc });
  expect(r.info.pages).toBe(3);
  const text = await pdfText(r.pdf);
  expect(text).toContain("page 1 of 3");
  expect(text).toContain("page 3 of 3");
}, 30_000);

test("remote requests are blocked by default and reported as findings", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css">
<img src="https://example.invalid/a.png" width="10" height="10">
<p>Still renders.</p>`;
  const r = await render(browser, { html: doc });
  expect(r.blocked.length).toBeGreaterThanOrEqual(2);
  expect(r.blocked.some((u) => u.includes("example.invalid"))).toBe(true);
  expect(r.findings.map((f) => f.code)).toContain("network-blocked");
  expect(r.findings.find((f) => f.code === "network-blocked")!.url).toBeTruthy();
  expect(r.info.pages).toBeGreaterThan(0);
}, 30_000);

test("allowing network clears the findings", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<p>No remote assets here.</p>`;
  const r = await render(browser, { html: doc, allowNetwork: true });
  expect(r.blocked).toHaveLength(0);
  expect(r.findings.filter((f) => f.code === "network-blocked")).toHaveLength(0);
}, 30_000);

test("a request format overrides the document and says so", async () => {
  const r = await render(browser, { html: DOC, format: "letter" });
  const finding = r.findings.find((f) => f.code === "page-size-override");
  expect(finding).toBeTruthy();
  // Informational: the request is applied, so this records what happened rather
  // than warning about a problem. Letter is the paper that was asked for.
  expect(finding!.severity).toBe("info");
  const info = await pdfInfo(r.pdf);
  expect(info.pageSize).toMatch(/612/);
}, 30_000);

test("a hanging document fails with an error instead of hanging", async () => {
  const hanging = createServer(() => { /* accept, never answer */ });
  await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", () => r()));
  const port = (hanging.address() as { port: number }).port;

  const started = Bun.nanoseconds();
  let message = "";
  try {
    // preferFastPath off so the document really navigates: the fast path
    // installs HTML with no load event, so there is nothing left to stall.
    await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><img src="http://127.0.0.1:${port}/stall.png"><p>never finishes</p>`,
      allowNetwork: true,
      preferFastPath: false,
      timeoutMs: 2_000,
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
  hanging.close();

  // Whichever phase stalls, the message must name the deadline rather than
  // surfacing the raw socket error the closed tab produces.
  expect(message).toMatch(/navigation did not finish|printing exceeded/);
  expect(message).not.toContain("cdp socket closed");
  expect(elapsedMs).toBeLessThan(20_000);
}, 40_000);

test("the browser still renders after a timeout", async () => {
  const r = await render(browser, { html: DOC });
  expect(r.info.pages).toBeGreaterThan(0);
  expect(await pdfImages(r.pdf)).toHaveLength(0);
}, 30_000);

test("concurrent renders all succeed and agree on page count", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => render(browser, { html: DOC.replace("Acceptance document", `Doc ${i}`) })),
  );
  for (const r of results) expect(r.info.pages).toBeGreaterThan(0);
  expect(new Set(results.map((r) => r.info.pages)).size).toBe(1);
}, 60_000);