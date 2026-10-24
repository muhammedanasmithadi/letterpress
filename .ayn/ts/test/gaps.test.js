"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const pageside_ts_1 = require("../src/pageside.ts");
const render_ts_1 = require("../src/render.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('gaps');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
async function probe(html) {
    const r = await (0, render_ts_1.render)(browser, { html, author: 'gaps', pageProbe: pageside_ts_1.wideGaps });
    return { gaps: r.probe ?? [], codes: r.findings.map((f) => f.code) };
}
(0, bun_test_1.test)('a flex gap is named, with the element and the value', async () => {
    const { gaps, codes } = await probe(`<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .row { display: flex; gap: 24px }
     </style><div class="row"><span>alpha</span><span>beta</span></div>`);
    (0, bun_test_1.expect)(codes).not.toContain('page-probe-failed');
    (0, bun_test_1.expect)(gaps.length).toBe(1);
    (0, bun_test_1.expect)(gaps[0].cause).toBe('flex-gap');
    (0, bun_test_1.expect)(gaps[0].selector).toContain('.row');
    (0, bun_test_1.expect)(gaps[0].selector).toContain('span');
    (0, bun_test_1.expect)(gaps[0].em).toBeGreaterThan(0.6);
}, 60_000);
(0, bun_test_1.test)('justify-content: space-between is not reported as a gap', async () => {
    const { gaps } = await probe(`<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .row { display: flex; justify-content: space-between }
     </style><div class="row"><span>alpha</span><span>beta</span></div>`);
    (0, bun_test_1.expect)(gaps.length).toBe(1);
    (0, bun_test_1.expect)(gaps[0].cause).toBe('space-between');
}, 60_000);
(0, bun_test_1.test)("an element's own margin is named as a margin", async () => {
    const { gaps } = await probe(`<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .divider { margin: 0 10px }
     </style><p><span>alpha</span><span class="divider">·</span><span>beta</span></p>`);
    (0, bun_test_1.expect)(gaps.length).toBeGreaterThan(0);
    (0, bun_test_1.expect)(gaps.every((g) => g.cause === 'margin')).toBe(true);
    (0, bun_test_1.expect)(gaps[0].selector).toContain('.divider');
}, 60_000);
(0, bun_test_1.test)('a gap a reader joins across is not reported at all', async () => {
    const { gaps } = await probe(`<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .a { margin-right: 3px }
     </style><p><span class="a">alpha</span><span>beta</span></p>`);
    (0, bun_test_1.expect)(gaps).toEqual([]);
}, 60_000);
(0, bun_test_1.test)('a probe that cannot run says so instead of returning nothing', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: '<!doctype html><p>x</p>',
        author: 'gaps',
        pageProbe: (() => (0, pageside_ts_1.wideGaps)()),
    });
    (0, bun_test_1.expect)(r.probe).toBeUndefined();
    const finding = r.findings.find((f) => f.code === 'page-probe-failed');
    (0, bun_test_1.expect)(finding).toBeDefined();
    (0, bun_test_1.expect)(finding.message).toMatch(/wideGaps is not defined/);
}, 60_000);
//# sourceMappingURL=gaps.test.js.map