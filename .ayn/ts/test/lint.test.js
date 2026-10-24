"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
const render_ts_1 = require("../src/render.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('lint');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
const codes = (r) => r.findings.map((f) => f.code);
(0, bun_test_1.test)('the page-side script parses as javascript', () => {
    const src = (0, node_fs_1.readFileSync)((0, node_path_1.join)(import.meta.dir, '..', 'src', 'lint.ts'), 'utf8');
    const m = /const AUDIT = String\.raw`([\s\S]*?)`;\n/.exec(src);
    (0, bun_test_1.expect)(m, 'could not find the AUDIT constant').not.toBeNull();
    (0, bun_test_1.expect)(() => new Function(m[1])).not.toThrow();
});
(0, bun_test_1.test)('the css comment strip in the page script is a scan, not a pattern', () => {
    const src = (0, node_fs_1.readFileSync)((0, node_path_1.join)(import.meta.dir, '..', 'src', 'lint.ts'), 'utf8');
    const m = /const stripComments = ([\s\S]*?\n  \};)/.exec(src);
    (0, bun_test_1.expect)(m, 'could not find the stripComments helper').not.toBeNull();
    const strip = new Function(`return (${m[1].replace(/;$/, '')})`)();
    (0, bun_test_1.expect)(strip('a/* b */c')).toBe('a c');
    (0, bun_test_1.expect)(strip('a/* b')).toBe('a');
    const text = '/* '.repeat(40_000);
    const started = Date.now();
    strip(text);
    (0, bun_test_1.expect)(Date.now() - started).toBeLessThan(1000);
});
(0, bun_test_1.test)('the audit reports real findings rather than failing to run', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><meta charset="utf-8">
      <style>@page{size:A4;margin:15mm} h1::after{content:target-counter(h1, page)}</style>
      <h1>Report</h1><p>{{leftover}}</p>`,
        author: 'lint',
    });
    (0, bun_test_1.expect)(codes(r)).not.toContain('audit-failed');
    (0, bun_test_1.expect)(codes(r)).toContain('unfilled-placeholder');
}, 60_000);
(0, bun_test_1.test)('a clean document reports nothing from the audit', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>
      <p>Body text that fills a line and wraps.</p>`,
        author: 'lint',
    });
    (0, bun_test_1.expect)(codes(r)).not.toContain('audit-failed');
    (0, bun_test_1.expect)(codes(r)).not.toContain('unfilled-placeholder');
    (0, bun_test_1.expect)(codes(r)).not.toContain('audit-partial');
}, 60_000);
(0, bun_test_1.test)('a digit run is not reported as reversing into itself', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>رقم 971 50 123 4567</p></body></html>`,
        author: 'lint',
    });
    const run = r.findings.find((f) => f.code === 'rtl-digit-run');
    (0, bun_test_1.expect)(run, 'no rtl-digit-run finding').toBeDefined();
    (0, bun_test_1.expect)(run.message).toMatch(/reorder under right-to-left layout/);
    (0, bun_test_1.expect)(run.message).not.toMatch(/reversed \(971 50 123 4567\)/);
    const dashed = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>رقم 2026-10-03</p></body></html>`,
        author: 'lint',
    });
    const withDash = dashed.findings.find((f) => f.code === 'rtl-digit-run');
    (0, bun_test_1.expect)(withDash.message).toMatch(/reversed \(03-10-2026\)/);
}, 90_000);
(0, bun_test_1.test)('an RTL paragraph ending in a Latin token still reports its digit run', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>تاريخ 2026-10-03 . INV-2026-0147</p></body></html>`,
        author: 'lint',
    });
    (0, bun_test_1.expect)(r.findings.some((f) => f.code === 'rtl-digit-run')).toBe(true);
}, 90_000);
//# sourceMappingURL=lint.test.js.map