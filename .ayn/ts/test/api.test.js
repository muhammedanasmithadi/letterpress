"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const poppler_ts_1 = require("./poppler.ts");
let browser;
let profile;
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-api-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
});
function paged(pages) {
    return `<!doctype html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 6mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { margin: 0; font-family: sans-serif }
.sheet { break-before: page; height: 275mm; font-size: 28pt }
</style></head><body>${Array.from({ length: pages }, (_, i) => `<div class="sheet">PAGE_${i + 1}</div>`).join('')}</body></html>`;
}
(0, bun_test_1.test)('pageRanges emits exactly the named pages', async () => {
    const html = paged(8);
    for (const [range, expected] of [
        ['1-2', ['PAGE_1', 'PAGE_2']],
        ['5', ['PAGE_5']],
        ['3,7', ['PAGE_3', 'PAGE_7']],
        ['2-2', ['PAGE_2']],
    ]) {
        const r = await (0, render_ts_1.render)(browser, { html, pageRanges: range });
        const text = await (0, poppler_ts_1.pdfText)(r.pdf);
        const found = [...new Set([...(text.matchAll(/PAGE_\d+/g) ?? [])].map((m) => m[0]))].sort();
        (0, bun_test_1.expect)(found, `pageRanges "${range}"`).toEqual([...expected].sort());
    }
}, 120_000);
(0, bun_test_1.test)('pageRanges leaves total-page counters correct', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: paged(3), pageRanges: '1-2' });
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('page 1 of 3');
    (0, bun_test_1.expect)(text).toContain('page 2 of 3');
    (0, bun_test_1.expect)(text).not.toContain('of 2\n');
    (0, bun_test_1.expect)(r.info.pages).toBe(2);
}, 60_000);
(0, bun_test_1.test)('omitting pageRanges renders every page', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: paged(8) });
    (0, bun_test_1.expect)(r.info.pages).toBe(8);
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    for (let i = 1; i <= 8; i++)
        (0, bun_test_1.expect)(text).toContain(`PAGE_${i}`);
}, 60_000);
(0, bun_test_1.test)('the stream transfer produces bytes identical to base64', async () => {
    const previous = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    try {
        const html = paged(6);
        const viaBase64 = await (0, render_ts_1.render)(browser, { html, transfer: 'base64' });
        const viaStream = await (0, render_ts_1.render)(browser, { html, transfer: 'stream' });
        (0, bun_test_1.expect)(viaStream.pdf.byteLength).toBe(viaBase64.pdf.byteLength);
        (0, bun_test_1.expect)(new TextDecoder('latin1').decode(viaStream.pdf).slice(0, 8)).toBe('%PDF-1.4');
        (0, bun_test_1.expect)(viaStream.info.pages).toBe(viaBase64.info.pages);
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(viaStream.pdf)).pages).toBe(6);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(viaStream.pdf)).toContain('PAGE_6');
    }
    finally {
        if (previous === undefined)
            delete process.env.SOURCE_DATE_EPOCH;
        else
            process.env.SOURCE_DATE_EPOCH = previous;
    }
}, 120_000);
(0, bun_test_1.test)('the stream transfer handles a document smaller than one chunk', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><style>@page{size:A4}</style><p>tiny</p>`,
        transfer: 'stream',
    });
    (0, bun_test_1.expect)(r.pdf.byteLength).toBeGreaterThan(500);
    (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(r.pdf)).pages).toBe(1);
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('tiny');
}, 60_000);
(0, bun_test_1.test)('the relative asset scan recognises what it must', () => {
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="logo.png">')).toBe(true);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<link href="style.css" rel="stylesheet">')).toBe(true);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="./a/b.png">')).toBe(true);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<a href="#top">x</a>')).toBe(false);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="https://cdn.example/a.png">')).toBe(false);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="data:image/png;base64,AAA">')).toBe(false);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<script src="//cdn.example/x.js"></script>')).toBe(false);
    (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<p>no assets at all</p>')).toBe(false);
});
(0, bun_test_1.test)('the fast path prints a document with no relative assets', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: paged(3), preferFastPath: true });
    (0, bun_test_1.expect)(r.info.pages).toBe(3);
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('PAGE_3');
}, 60_000);
(0, bun_test_1.test)('the fast path is skipped when a relative asset is present, and it still prints', async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-asset-'));
    try {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'dot.png'), png);
        const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style>
<img src="dot.png" width="40"><p>after the image</p>`;
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'doc.html'), html);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'doc.html') });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('after the image');
        const images = await (0, poppler_ts_1.pdfImages)(r.pdf);
        (0, bun_test_1.expect)(images.length).toBeGreaterThanOrEqual(1);
        (0, bun_test_1.expect)(images.some((i) => i.width === 1 && i.height === 1)).toBe(true);
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
    }
}, 90_000);
(0, bun_test_1.test)('the fast path can be turned off explicitly', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: paged(2), preferFastPath: false });
    (0, bun_test_1.expect)(r.info.pages).toBe(2);
}, 60_000);
(0, bun_test_1.test)('pageRanges works together with the stream transfer', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: paged(8),
        pageRanges: '4-6',
        transfer: 'stream',
    });
    (0, bun_test_1.expect)(r.info.pages).toBe(3);
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('PAGE_4');
    (0, bun_test_1.expect)(text).toContain('PAGE_6');
    (0, bun_test_1.expect)(text).not.toContain('PAGE_1');
}, 90_000);
//# sourceMappingURL=api.test.js.map