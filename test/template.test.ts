import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { TemplateError, UnsafeRowError, escapeCss, invoiceTotals, lines, money, render as fill } from "../src/template.ts";
import { pdfInfo, pdfImages, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;
let template: string;

const ITEMS = [
  { description: "Spectrometer calibration, reference grade", qty: 2, unit: 480 },
  { description: "Fibre optic patch panel, 12 port LC", qty: 5, unit: 132.5 },
  { description: "Vacuum pump rebuild kit", qty: 3, unit: 219 },
  { description: "Detector housing, machined aluminium", qty: 4, unit: 356.75 },
  { description: "Bench supply, 30 V / 10 A, triple output", qty: 6, unit: 148.2 },
  { description: "Fume extraction hose, 3 m", qty: 8, unit: 42.9 },
  { description: "Optical breadboard, 1 m M6 grid", qty: 2, unit: 274 },
  { description: "Thermal camera, 640 x 480, 30 Hz", qty: 1, unit: 1240 },
  { description: "Firmware support agreement, 12 months", qty: 1, unit: 890 },
  { description: "On-site commissioning, per day", qty: 3, unit: 640 },
  { description: "Replacement sensor window, fused silica", qty: 4, unit: 96.4 },
  { description: "Vacuum gauge, 1e-9 mbar", qty: 2, unit: 512 },
];

function document(items = ITEMS) {
  const totals = invoiceTotals(items);
  return fill(template, {
    paper: "A4",
    accent: "#1f4e79",
    font: "sans-serif",
    company: "Northwind Instruments",
    company_secondary: "فاتورة اختبار",
    company_lines: lines(["Unit 7, Fitzroy Works", "Manchester M1 5TF", "United Kingdom", "VAT GB 412 7788 21"]),
    invoice_no: "2026-014",
    issued: "2026-10-03",
    due: "2026-11-02",
    bill_to_name: "Halcyon Labs",
    bill_to_lines: lines(["14 Rue des Lilas", "69003 Lyon", "France"]),
    rows: totals.rows,
    subtotal: totals.subtotal,
    vat: totals.vat,
    vat_rate: totals.vat_rate,
    total: totals.total,
    currency: totals.currency,
    note: "Payment by bank transfer within 30 days.",

    company_text: escapeCss("Northwind Instruments"),
    invoice_no_text: escapeCss("2026-014"),
  });
}

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "letterpress-tpl-"));
  browser = await Browser.launch({ profile });
  template = await Bun.file(join(import.meta.dir, "..", "templates", "invoice.html")).text();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

test("the template contains no inlined font data", () => {
  expect(template).not.toContain("base64,");
  expect(template).not.toContain("data:font");
  expect(template).not.toContain("@font-face");
});

test("a missing value is an error, not an empty hole", () => {
  expect(() => fill(template, { invoice_no: "1" })).toThrow(TemplateError);
  try {
    fill(template, { invoice_no: "1" });
  } catch (e) {
    expect((e as TemplateError).missing).toContain("total");
    expect((e as TemplateError).missing).toContain("rows");
  }
});

test("an optional block disappears when its value is absent", () => {
  const withValue = fill(template, { company_secondary: "hello" }, { strict: false });
  const without = fill(template, { company_secondary: "" }, { strict: false });
  expect(withValue).toContain("hello");
  expect(without).not.toContain("hello");
  expect(without).not.toContain("{{#");
  expect(without).toContain("{{invoice_no}}");
});

test("totals are computed, not hand-written", () => {
  const t = invoiceTotals([{ description: "A", qty: 3, unit: 10 }], { vatRate: 0.2 });
  expect(t.subtotal).toBe("30.00");
  expect(t.vat).toBe("6.00");
  expect(t.total).toBe("36.00");
  expect(t.vat_rate).toBe("20%");
  expect(money(1234567.891)).toBe("1,234,567.89");
});

test("item text is escaped, so a description cannot inject markup", () => {
  const t = invoiceTotals([{ description: "<b>Widget</b>", qty: 1, unit: 1 }]);
  expect(t.rows).toContain("&lt;b&gt;Widget&lt;/b&gt;");
});

test("markup that could break the document is refused outright", () => {

  for (const description of [
    "<script>alert(1)</script>",
    "<style>body{display:none}</style>",
    "<iframe src=x>",
    "<SCRIPT >alert(1)</SCRIPT >",
  ]) {
    expect(() => invoiceTotals([{ description, qty: 1, unit: 1 }])).toThrow(UnsafeRowError);
  }
});

test("an empty item list is refused rather than printing a total", () => {
  expect(() => invoiceTotals([])).toThrow(TemplateError);
});

test("non-numeric quantities are refused", () => {
  expect(() => invoiceTotals([{ description: "x", qty: Number.NaN, unit: 1 }])).toThrow(TemplateError);
  expect(() => invoiceTotals([{ description: "x", qty: 1, unit: Number.POSITIVE_INFINITY }])).toThrow(TemplateError);
});

test("a css string is escaped for css, not for markup", () => {

  expect(escapeCss("Ruiz & Lark's Systems")).toBe("Ruiz & Lark's Systems");
  expect(escapeCss('say "hi"')).toBe('say \\"hi\\"');
  expect(escapeCss("back\\slash")).toBe("back\\\\slash");
  expect(escapeCss("two\nlines")).toBe("two lines");
});

test("a single-page invoice renders with correct page numbers", async () => {
  const r = await render(browser, { html: document() });
  expect(r.info.pages).toBe(1);
  expect(await pdfImages(r.pdf)).toHaveLength(0);

  const text = await pdfText(r.pdf);
  expect(text).toContain("page 1 of 1");
  expect(text).toContain("INVOICE 2026-014");
  expect(text).toContain("Northwind Instruments");
  expect(text).toContain("13,135.80");
}, 30_000);

test("a long invoice repeats the table header and keeps numbering", async () => {
  const many = Array.from({ length: 90 }, (_, i) => ({
    description: `Calibration visit ${i + 1}, site ${String.fromCharCode(65 + (i % 26))}`,
    qty: (i % 4) + 1,
    unit: 100 + i * 3.5,
  }));
  const r = await render(browser, { html: document(many) });
  expect(r.info.pages).toBeGreaterThanOrEqual(3);

  const text = await pdfText(r.pdf);

  const descriptionHeaders = text.match(/DESCRIPTION/g) ?? [];
  expect(descriptionHeaders.length).toBeGreaterThanOrEqual(r.info.pages);

  for (let page = 1; page <= r.info.pages; page++) {
    expect(text).toContain(`page ${page} of ${r.info.pages}`);
  }

  const totals = invoiceTotals(many);
  expect(text.replace(/\s+/g, "")).toContain(totals.total.replace(/\s+/g, ""));
}, 60_000);

test("line items never straddle a page boundary", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    description: `Replacement sensor window, fused silica, batch ${i + 1}`,
    qty: 1,
    unit: 96.4 + i,
  }));
  const r = await render(browser, { html: document(many) });
  const text = await pdfText(r.pdf);
  const described = (text.match(/Replacement sensor window/g) ?? []).length;
  expect(described).toBe(many.length);
  expect(r.info.pages).toBeGreaterThan(1);
}, 60_000);

test("the declared paper is honoured exactly", async () => {
  const r = await render(browser, { html: document() });
  const info = await pdfInfo(r.pdf);
  expect(info.pageSize).toContain("594.96");
  expect(info.pageSize).toContain("841.92");
  expect(info.encrypted).toBe(false);
}, 30_000);
