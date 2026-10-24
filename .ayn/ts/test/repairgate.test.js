"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const node_zlib_1 = require("node:zlib");
const render_ts_1 = require("../src/render.ts");
const verify_ts_1 = require("../src/verify.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('repairgate');
    browser = t.browser;
}, 120_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
const HTML = '<!doctype html><meta charset="utf-8"><title>Gate</title>' +
    '<style>@page{size:A4;margin:18mm}</style><h1>Gate</h1><p>office efficient flags finished</p>';
function corruptContent(pdf) {
    const raw = Buffer.from(pdf);
    const text = raw.toString('latin1');
    for (const m of text.matchAll(/stream\r?\n/g)) {
        const start = m.index + m[0].length;
        const end = text.indexOf('\nendstream', start);
        if (end - start < 16)
            continue;
        const payload = raw.subarray(start, end);
        let drawn;
        try {
            drawn = (0, node_zlib_1.inflateSync)(payload);
        }
        catch {
            continue;
        }
        if (!drawn.includes('BT'))
            continue;
        const at = 4 + (drawn.length % Math.max(1, payload.length - 8));
        payload[at] = (payload[at] ?? 0) ^ 0xff;
        payload[at + 1] = (payload[at + 1] ?? 0) ^ 0xff;
        payload[at + 2] = (payload[at + 2] ?? 0) ^ 0xff;
        return raw;
    }
    throw new Error('no text-bearing content stream to corrupt');
}
(0, bun_test_1.describe)('the gate on a repair', () => {
    (0, bun_test_1.test)('a repair that damages the document is refused', async () => {
        const good = (await (0, render_ts_1.render)(browser, { html: HTML, author: 'A Person' })).pdf;
        const corrupted = corruptContent(good);
        const kept = (0, verify_ts_1.repairOrKeep)(good, () => corrupted);
        (0, bun_test_1.expect)(kept.applied).toBe(false);
        (0, bun_test_1.expect)(kept.failures.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(Buffer.from(kept.pdf).equals(Buffer.from(good))).toBe(true);
    }, 120_000);
    (0, bun_test_1.test)('a repair that changes nothing is not a failure', async () => {
        const good = (await (0, render_ts_1.render)(browser, { html: HTML, author: 'A Person' })).pdf;
        const kept = (0, verify_ts_1.repairOrKeep)(good, (p) => p);
        (0, bun_test_1.expect)(kept.applied).toBe(false);
        (0, bun_test_1.expect)(kept.failures).toEqual([]);
    }, 120_000);
});
//# sourceMappingURL=repairgate.test.js.map