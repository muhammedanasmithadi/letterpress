"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const render_ts_1 = require("../src/render.ts");
const rolemap_ts_1 = require("../src/rolemap.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const verify_ts_1 = require("../src/verify.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('rolemap');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
const DOC = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:20mm}body{font-family:sans-serif}</style><body>${body}</body>`;
function roleMapOf(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return undefined;
    for (const o of parts.objs) {
        if (/\/Type\s*\/StructTreeRoot/.test((0, pdfparts_ts_1.dictOf)(o))) {
            const m = /\/RoleMap\s*<<([^<>]*)>>/.exec((0, pdfparts_ts_1.dictOf)(o));
            return m ? m[1].trim() : undefined;
        }
    }
    return undefined;
}
(0, bun_test_1.describe)('the role map repair', () => {
    (0, bun_test_1.test)('an Aside element gets a RoleMap entry mapping it to Sect', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC('<aside>wrote in prose</aside>'), author: 't' });
        (0, bun_test_1.expect)(roleMapOf(r.pdf)).toBe('/Aside /Sect');
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-mapped')).toBeTruthy();
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('a document without non-standard types is untouched', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC('<p>plain prose</p>'), author: 't' });
        (0, bun_test_1.expect)(roleMapOf(r.pdf)).toBeUndefined();
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-mapped')).toBeUndefined();
    }, 90_000);
    (0, bun_test_1.test)('running the repair again on a mapped file changes no byte', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC('<aside>wrote in prose</aside>'), author: 't' });
        const again = (0, rolemap_ts_1.applyRoleMap)(r.pdf);
        (0, bun_test_1.expect)(Buffer.from(again).equals(Buffer.from(r.pdf))).toBe(true);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(again).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('applyRoleMap is a no-op when there is nothing to map', () => {
        const r = new Uint8Array([1, 2, 3]);
        (0, bun_test_1.expect)((0, rolemap_ts_1.applyRoleMap)(r)).toBe(r);
    });
});
//# sourceMappingURL=rolemap.test.js.map