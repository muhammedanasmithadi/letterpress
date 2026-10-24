"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const render_ts_1 = require("../src/render.ts");
const verify_ts_1 = require("../src/verify.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('final');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
(0, bun_test_1.test)('what a render returns passes the structural check', async () => {
    const shapes = [
        '<!doctype html><meta charset="utf-8"><p>Body text that fills a line and wraps.</p>',
        '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:2cm}</style><p>x</p>',
        '<!doctype html><meta charset="utf-8"><h1>T</h1><table><tr><td>a</td><td>b</td></tr></table>',
    ];
    for (const html of shapes) {
        const r = await (0, render_ts_1.render)(browser, { html, author: 'a', subject: 's' });
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).not.toContain('output-unverified');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }
}, 90_000);
(0, bun_test_1.test)('a file that will not open is an error finding, not silence', async () => {
    const good = await (0, render_ts_1.render)(browser, {
        html: '<!doctype html><meta charset="utf-8"><p>x</p>',
    });
    (0, bun_test_1.expect)((0, render_ts_1.finalCheckFinding)(good.pdf)).toBeNull();
    const whole = new TextDecoder('latin1').decode(good.pdf);
    const broken = [
        ['%%EOF removed', new TextEncoder().encode(whole.replace(/%%EOF\s*$/, ''))],
        ['header removed', new TextEncoder().encode(whole.replace(/^%PDF-[\d.]+\n/, ''))],
        ['body truncated', good.pdf.subarray(0, good.pdf.byteLength - 40)],
    ];
    for (const [name, bytes] of broken) {
        const finding = (0, render_ts_1.finalCheckFinding)(bytes);
        (0, bun_test_1.expect)({ name, found: finding !== null }).toEqual({ name, found: true });
        (0, bun_test_1.expect)(finding.severity).toBe('error');
        (0, bun_test_1.expect)(finding.message).toMatch(/structural check:/);
    }
}, 90_000);
//# sourceMappingURL=final.test.js.map