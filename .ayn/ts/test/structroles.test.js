"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const render_ts_1 = require("../src/render.ts");
const structroles_ts_1 = require("../src/structroles.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const verify_ts_1 = require("../src/verify.ts");
const browser_ts_1 = require("./browser.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('structroles');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
const DOC = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:20mm}body{font-family:sans-serif}</style><body>${body}</body>`;
const ROLED_DOC = '<h1>Ledger</h1><nav><a href="#a">alpha</a></nav>' +
    '<main><section><h2>One</h2><dl><dt>term one</dt><dd>def one</dd>' +
    '<dt>term two</dt><dd>def two</dd></dl></section></main>' +
    '<header>site header</header><footer>site footer</footer><p id="a">target prose</p>';
const BLOCKY_DOC = '<nav><a href="#a">alpha</a></nav><main><section><h2>One</h2>' +
    '<dl><dt>term A</dt><dd>def A <p>extra def para</p></dd><dd>def B</dd></dl>' +
    '</section></main><header>hdr one</header><footer>ft one</footer><p id="a">envoi prose</p>';
function rolesOf(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return [];
    for (const o of parts.objs) {
        if (/\/Type\s*\/StructTreeRoot/.test((0, pdfparts_ts_1.dictOf)(o))) {
            const out = [];
            for (const role of ['Document', 'NonStruct', 'Sect', 'Part', 'L', 'LI']) {
                if ((0, pdfparts_ts_1.structElementsInOrder)(parts, role).length > 0)
                    out.push(role);
            }
            return out;
        }
    }
    return [];
}
const CENSUS_FOR_ROLED = JSON.stringify([
    { tag: 'nav', text: 'alpha', owner: -1 },
    { tag: 'main', text: 'One term one def one term two def two', owner: -1 },
    { tag: 'section', text: 'One term one def one term two def two', owner: 1 },
    { tag: 'dl', text: 'term one def one term two def two', owner: 2 },
    { tag: 'dt', text: 'term one', owner: 3 },
    { tag: 'dd', text: 'def one', owner: 3 },
    { tag: 'dt', text: 'term two', owner: 3 },
    { tag: 'dd', text: 'def two', owner: 3 },
    { tag: 'header', text: 'site header', owner: -1 },
    { tag: 'footer', text: 'site footer', owner: -1 },
]);
(0, bun_test_1.describe)('the roles repair', () => {
    (0, bun_test_1.test)('the six gap elements get their semantic roles and the leaves stay anonymous', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(ROLED_DOC), author: 't' });
        const found = rolesOf(r.pdf);
        for (const role of ['Sect', 'Part', 'L', 'LI', 'NonStruct']) {
            (0, bun_test_1.expect)(found).toContain(role);
        }
        const note = r.findings.find((f) => f.code === 'role-retagged');
        (0, bun_test_1.expect)(note).toBeTruthy();
        (0, bun_test_1.expect)(note?.message).toContain('10');
    }, 90_000);
    (0, bun_test_1.test)('a definition list whose items hold blocks is skipped, landmarks still retag', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(BLOCKY_DOC), author: 't' });
        const found = rolesOf(r.pdf);
        (0, bun_test_1.expect)(found).toContain('Sect');
        (0, bun_test_1.expect)(found).toContain('Part');
        (0, bun_test_1.expect)(found).not.toContain('L');
        (0, bun_test_1.expect)(found).not.toContain('LI');
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-retagged')?.message).toContain('5');
    }, 90_000);
    (0, bun_test_1.test)('two unrelated containers with equal text are both left unnamed', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC('<nav>Menu</nav><header>Menu</header>'),
            author: 't',
        });
        const found = rolesOf(r.pdf);
        (0, bun_test_1.expect)(found).toContain('NonStruct');
        (0, bun_test_1.expect)(found).not.toContain('Sect');
        (0, bun_test_1.expect)(found).not.toContain('Part');
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-retagged')).toBeUndefined();
    }, 90_000);
    (0, bun_test_1.test)('a document without the six tags is untouched by the step', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC('<div>plain</div><h1>Head</h1><p>prose</p>'),
            author: 't',
        });
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-retagged')).toBeUndefined();
    }, 90_000);
    (0, bun_test_1.test)('running the plan again on repaired output changes no byte', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(ROLED_DOC), author: 't' });
        const elements = (0, structroles_ts_1.parseRoleCensus)(CENSUS_FOR_ROLED);
        (0, bun_test_1.expect)(elements.length).toBe(10);
        const plan = (0, structroles_ts_1.rolePlan)(r.pdf, elements);
        (0, bun_test_1.expect)(plan.entries.length).toBe(0);
        const again = (0, structroles_ts_1.applyRolePlan)(r.pdf, plan);
        (0, bun_test_1.expect)(Buffer.from(again).equals(Buffer.from(r.pdf))).toBe(true);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(again).ok).toBe(true);
    }, 90_000);
});
(0, bun_test_1.describe)('the census parser', () => {
    (0, bun_test_1.test)('it rebuilds rows from the page-side json and drops the rest', () => {
        const rows = (0, structroles_ts_1.parseRoleCensus)(JSON.stringify([
            { tag: 'nav', text: ' A B ', owner: -1 },
            { tag: 'blockquote', text: 'nope', owner: -1 },
            { tag: 'dl', text: 'x', owner: 'third' },
            { tag: 'dt', text: 7, owner: -1 },
        ]));
        (0, bun_test_1.expect)(rows).toEqual([
            { tag: 'nav', text: 'AB', owner: -1 },
            { tag: 'dl', text: 'x', owner: -1 },
        ]);
    });
    (0, bun_test_1.test)('garbage in, nothing out', () => {
        (0, bun_test_1.expect)((0, structroles_ts_1.parseRoleCensus)('this is not json')).toEqual([]);
        (0, bun_test_1.expect)((0, structroles_ts_1.parseRoleCensus)('42')).toEqual([]);
        (0, bun_test_1.expect)((0, structroles_ts_1.parseRoleCensus)(undefined)).toEqual([]);
    });
});
//# sourceMappingURL=structroles.test.js.map