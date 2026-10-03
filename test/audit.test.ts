import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "html2pdf-audit-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

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

test("a character covered by the font fallback chain is not reported", async () => {
  // 度量 is absent from Noto Naskh Arabic but present in the system CJK fonts,
  // so it prints correctly and must stay silent.
  const html = `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>القياس 度量</p></body></html>`;
  const r = await render(browser, { html });
  expect(codes(r.findings)).not.toContain("missing-glyph");
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
  expect(message).toMatch(/could not load|ERR_/);
}, 40_000);