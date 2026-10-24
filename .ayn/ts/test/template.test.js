"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const template_ts_1 = require("../src/template.ts");
const poppler_ts_1 = require("./poppler.ts");
let browser;
let profile;
let template;
const ITEMS = [
    {
        description: 'Spectrometer calibration, reference grade',
        qty: 2,
        unit: 480,
    },
    { description: 'Fibre optic patch panel, 12 port LC', qty: 5, unit: 132.5 },
    { description: 'Vacuum pump rebuild kit', qty: 3, unit: 219 },
    { description: 'Detector housing, machined aluminium', qty: 4, unit: 356.75 },
    {
        description: 'Bench supply, 30 V / 10 A, triple output',
        qty: 6,
        unit: 148.2,
    },
    { description: 'Fume extraction hose, 3 m', qty: 8, unit: 42.9 },
    { description: 'Optical breadboard, 1 m M6 grid', qty: 2, unit: 274 },
    { description: 'Thermal camera, 640 x 480, 30 Hz', qty: 1, unit: 1240 },
    { description: 'Firmware support agreement, 12 months', qty: 1, unit: 890 },
    { description: 'On-site commissioning, per day', qty: 3, unit: 640 },
    {
        description: 'Replacement sensor window, fused silica',
        qty: 4,
        unit: 96.4,
    },
    { description: 'Vacuum gauge, 1e-9 mbar', qty: 2, unit: 512 },
];
function document(items = ITEMS, overrides = {}) {
    const totals = (0, template_ts_1.invoiceTotals)(items);
    return (0, template_ts_1.render)(template, {
        paper: 'A4',
        accent: '#1f4e79',
        font: 'sans-serif',
        company: 'Northwind Instruments',
        company_secondary: 'فاتورة اختبار',
        company_lines: (0, template_ts_1.lines)([
            'Unit 7, Fitzroy Works',
            'Manchester M1 5TF',
            'United Kingdom',
            'VAT GB 412 7788 21',
        ]),
        invoice_no: '2026-014',
        issued: '2026-10-03',
        due: '2026-11-02',
        bill_to_name: 'Halcyon Labs',
        bill_to_lines: (0, template_ts_1.lines)(['14 Rue des Lilas', '69003 Lyon', 'France']),
        rows: totals.rows,
        subtotal: totals.subtotal,
        vat: totals.vat,
        vat_rate: totals.vat_rate,
        total: totals.total,
        currency: totals.currency,
        note: 'Payment by bank transfer within 30 days.',
        company_text: (0, template_ts_1.escapeCss)('Northwind Instruments'),
        invoice_no_text: (0, template_ts_1.escapeCss)('2026-014'),
        ...overrides,
    });
}
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-tpl-'));
    browser = await browser_ts_1.Browser.launch({ profile });
    template = await Bun.file((0, node_path_1.join)(import.meta.dir, '..', 'templates', 'invoice.html')).text();
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
});
(0, bun_test_1.test)('the template contains no inlined font data', () => {
    (0, bun_test_1.expect)(template).not.toContain('base64,');
    (0, bun_test_1.expect)(template).not.toContain('data:font');
    (0, bun_test_1.expect)(template).not.toContain('@font-face');
});
(0, bun_test_1.test)('a missing value is an error, not an empty hole', () => {
    (0, bun_test_1.expect)(() => (0, template_ts_1.render)(template, { invoice_no: '1' })).toThrow(template_ts_1.TemplateError);
    try {
        (0, template_ts_1.render)(template, { invoice_no: '1' });
    }
    catch (e) {
        (0, bun_test_1.expect)(e.missing).toContain('total');
        (0, bun_test_1.expect)(e.missing).toContain('rows');
    }
});
(0, bun_test_1.test)('an optional block disappears when its value is absent', () => {
    const withValue = (0, template_ts_1.render)(template, { company_secondary: 'hello' }, { strict: false });
    const without = (0, template_ts_1.render)(template, { company_secondary: '' }, { strict: false });
    (0, bun_test_1.expect)(withValue).toContain('hello');
    (0, bun_test_1.expect)(without).not.toContain('hello');
    (0, bun_test_1.expect)(without).not.toContain('{{#');
    (0, bun_test_1.expect)(without).toContain('{{invoice_no}}');
});
(0, bun_test_1.test)('totals are computed, not hand-written', () => {
    const t = (0, template_ts_1.invoiceTotals)([{ description: 'A', qty: 3, unit: 10 }], {
        vatRate: 0.2,
    });
    (0, bun_test_1.expect)(t.subtotal).toBe('30.00');
    (0, bun_test_1.expect)(t.vat).toBe('6.00');
    (0, bun_test_1.expect)(t.total).toBe('36.00');
    (0, bun_test_1.expect)(t.vat_rate).toBe('20%');
    (0, bun_test_1.expect)((0, template_ts_1.money)(1234567.891)).toBe('1,234,567.89');
});
(0, bun_test_1.test)('a value in a bare CSS slot cannot end the declaration and open a rule', async () => {
    const html = document([{ description: 'Consulting', qty: 2, unit: 100 }], {
        accent: 'red; } body { display: none } :root { --accent: red',
    });
    const r = await (0, render_ts_1.render)(browser, { html, author: 't' });
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('Consulting');
    (0, bun_test_1.expect)(text).toContain('Northwind Instruments');
    (0, bun_test_1.expect)(text).toContain('2026-014');
}, 60_000);
(0, bun_test_1.test)('item text is escaped, so a description cannot inject markup', () => {
    const t = (0, template_ts_1.invoiceTotals)([{ description: '<b>Widget</b>', qty: 1, unit: 1 }]);
    (0, bun_test_1.expect)(t.rows).toContain('&lt;b&gt;Widget&lt;/b&gt;');
});
(0, bun_test_1.test)('markup that could break the document is refused outright', () => {
    for (const description of [
        '<script>alert(1)</script>',
        '<style>body{display:none}</style>',
        '<iframe src=x>',
        '<SCRIPT >alert(1)</SCRIPT >',
    ]) {
        (0, bun_test_1.expect)(() => (0, template_ts_1.invoiceTotals)([{ description, qty: 1, unit: 1 }])).toThrow(template_ts_1.UnsafeRowError);
    }
});
(0, bun_test_1.test)('an empty item list is refused rather than printing a total', () => {
    (0, bun_test_1.expect)(() => (0, template_ts_1.invoiceTotals)([])).toThrow(template_ts_1.TemplateError);
});
(0, bun_test_1.test)('non-numeric quantities are refused', () => {
    (0, bun_test_1.expect)(() => (0, template_ts_1.invoiceTotals)([{ description: 'x', qty: Number.NaN, unit: 1 }])).toThrow(template_ts_1.TemplateError);
    (0, bun_test_1.expect)(() => (0, template_ts_1.invoiceTotals)([{ description: 'x', qty: 1, unit: Number.POSITIVE_INFINITY }])).toThrow(template_ts_1.TemplateError);
});
(0, bun_test_1.test)('a css string is escaped for css, not for markup', () => {
    (0, bun_test_1.expect)((0, template_ts_1.escapeCss)("Ruiz & Lark's Systems")).toBe("Ruiz & Lark's Systems");
    (0, bun_test_1.expect)((0, template_ts_1.escapeCss)('say "hi"')).toBe('say \\"hi\\"');
    (0, bun_test_1.expect)((0, template_ts_1.escapeCss)('back\\slash')).toBe('back\\\\slash');
    (0, bun_test_1.expect)((0, template_ts_1.escapeCss)('two\nlines')).toBe('two lines');
});
(0, bun_test_1.test)('a single-page invoice renders with correct page numbers', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: document() });
    (0, bun_test_1.expect)(r.info.pages).toBe(1);
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfImages)(r.pdf)).toHaveLength(0);
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('page 1 of 1');
    (0, bun_test_1.expect)(text).toContain('INVOICE 2026-014');
    (0, bun_test_1.expect)(text).toContain('Northwind Instruments');
    (0, bun_test_1.expect)(text).toContain('13,135.80');
}, 30_000);
(0, bun_test_1.test)('a long invoice repeats the table header and keeps numbering', async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
        description: `Calibration visit ${i + 1}, site ${String.fromCharCode(65 + (i % 26))}`,
        qty: (i % 4) + 1,
        unit: 100 + i * 3.5,
    }));
    const r = await (0, render_ts_1.render)(browser, { html: document(many) });
    (0, bun_test_1.expect)(r.info.pages).toBeGreaterThanOrEqual(3);
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    const descriptionHeaders = text.match(/DESCRIPTION/g) ?? [];
    (0, bun_test_1.expect)(descriptionHeaders.length).toBeGreaterThanOrEqual(r.info.pages);
    for (let page = 1; page <= r.info.pages; page++) {
        (0, bun_test_1.expect)(text).toContain(`page ${page} of ${r.info.pages}`);
    }
    const totals = (0, template_ts_1.invoiceTotals)(many);
    (0, bun_test_1.expect)(text.replace(/\s+/g, '')).toContain(totals.total.replace(/\s+/g, ''));
}, 60_000);
(0, bun_test_1.test)('line items never straddle a page boundary', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
        description: `Replacement sensor window, fused silica, batch ${i + 1}`,
        qty: 1,
        unit: 96.4 + i,
    }));
    const r = await (0, render_ts_1.render)(browser, { html: document(many) });
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    const described = (text.match(/Replacement sensor window/g) ?? []).length;
    (0, bun_test_1.expect)(described).toBe(many.length);
    (0, bun_test_1.expect)(r.info.pages).toBeGreaterThan(1);
}, 60_000);
(0, bun_test_1.test)('the declared paper is honoured exactly', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: document() });
    const info = await (0, poppler_ts_1.pdfInfo)(r.pdf);
    (0, bun_test_1.expect)(info.pageSize).toContain('594.96');
    (0, bun_test_1.expect)(info.pageSize).toContain('841.92');
    (0, bun_test_1.expect)(info.encrypted).toBe(false);
}, 30_000);
//# sourceMappingURL=template.test.js.map