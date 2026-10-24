"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const poppler_ts_1 = require("./poppler.ts");
let browser;
let profile;
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-test-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
});
const DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm }
@page { @bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif } }
body { font-family: 'Noto Kufi Arabic', sans-serif; margin: 0 }
h1 { color: #123; font-size: 20pt }
.box { width: 40mm; height: 20mm; background: #cde; border: 1pt solid #456 }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums }
td, th { border: 0.5pt solid #999; padding: 2pt }
thead { display: table-header-group }
tr { break-inside: avoid }
</style></head><body>
<h1>Acceptance document</h1>
<p>Vector text, an Arabic line, and a CSS shape.</p>
<p lang="ar" dir="rtl">فاتورة اختبارية</p>
<div class="box"></div>
<table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
${Array.from({ length: 30 }, (_, i) => `<tr><td>Line ${i + 1}</td><td>${(i % 5) + 1}</td><td>${(9.5 + i).toFixed(2)}</td></tr>`).join('')}
</tbody></table>
</body></html>`;
(0, bun_test_1.test)('renders the paper size the document declares, exactly', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: DOC });
    (0, bun_test_1.expect)(r.info.pages).toBeGreaterThan(0);
    const info = await (0, poppler_ts_1.pdfInfo)(r.pdf);
    (0, bun_test_1.expect)(info.pages).toBe(r.info.pages);
    (0, bun_test_1.expect)(info.pageSize).toContain('594.96');
    (0, bun_test_1.expect)(info.pageSize).toContain('841.92');
    const box = r.info.mediaBoxes[0].match(/\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    (0, bun_test_1.expect)(Number(box[3]) - Number(box[1])).toBeCloseTo(594.96, 1);
    (0, bun_test_1.expect)(Number(box[4]) - Number(box[2])).toBeCloseTo(841.92, 1);
}, 30_000);
(0, bun_test_1.test)('output is vector text with no raster image objects', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: DOC });
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfImages)(r.pdf)).toHaveLength(0);
    (0, bun_test_1.expect)(r.info.imageObjects).toBe(0);
    (0, bun_test_1.expect)(r.info.type0Fonts).toBeGreaterThan(0);
    (0, bun_test_1.expect)(r.info.toUnicodeMaps).toBeGreaterThan(0);
    (0, bun_test_1.expect)(r.info.producer).toContain('Skia/PDF');
    (0, bun_test_1.expect)(r.info.tagged).toBe(true);
    (0, bun_test_1.expect)(r.info.outlineTitles).toContain('Acceptance document');
    const fonts = await (0, poppler_ts_1.pdfFonts)(r.pdf);
    const rows = fonts
        .split('\n')
        .slice(2)
        .filter((l) => l.trim().length > 0);
    (0, bun_test_1.expect)(rows.length).toBeGreaterThan(1);
    for (const row of rows)
        (0, bun_test_1.expect)(row).toMatch(/\byes\s+yes\s+yes\b/);
    (0, bun_test_1.expect)(fonts).toMatch(/Arabic/i);
}, 30_000);
(0, bun_test_1.test)('text is extractable, in Latin and in Arabic', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: DOC });
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('Acceptance document');
    (0, bun_test_1.expect)(text).toContain('Vector text');
    (0, bun_test_1.expect)(text.replace(/\s+/g, '')).toContain('فاتورةاختبارية');
}, 30_000);
(0, bun_test_1.test)('CSS margin boxes place real page numbers in the footer', async () => {
    const doc = `<!doctype html><meta charset="utf-8"><style>
@page { size: A4; margin: 15mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 10pt sans-serif } }
body { font-family: sans-serif }
</style><p>one</p><p style="break-before:page">two</p><p style="break-before:page">three</p>`;
    const r = await (0, render_ts_1.render)(browser, { html: doc });
    (0, bun_test_1.expect)(r.info.pages).toBe(3);
    const text = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(text).toContain('page 1 of 3');
    (0, bun_test_1.expect)(text).toContain('page 3 of 3');
}, 30_000);
(0, bun_test_1.test)('a request that cannot be rendered as asked is refused', async () => {
    await (0, bun_test_1.expect)((0, render_ts_1.render)(browser, { html: '<p>x</p>', url: 'https://example.com/' })).rejects.toThrow(/more than one source/);
    await (0, bun_test_1.expect)((0, render_ts_1.render)(browser, { html: '<p>x</p>', timeoutMs: 0 })).rejects.toThrow(/at least 1000ms/);
    await (0, bun_test_1.expect)((0, render_ts_1.render)(browser, { html: '<p>x</p>', maxImagePpi: -1 })).rejects.toThrow(/whole number of pixels/);
}, 30_000);
(0, bun_test_1.test)('remote requests are blocked by default and reported as findings', async () => {
    const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css">
<img src="https://example.invalid/a.png" width="10" height="10">
<p>Still renders.</p>`;
    const r = await (0, render_ts_1.render)(browser, { html: doc });
    (0, bun_test_1.expect)(r.blocked.length).toBeGreaterThanOrEqual(2);
    (0, bun_test_1.expect)(r.blocked.some((u) => u.includes('example.invalid'))).toBe(true);
    (0, bun_test_1.expect)(r.findings.map((f) => f.code)).toContain('network-blocked');
    (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'network-blocked').url).toBeTruthy();
    (0, bun_test_1.expect)(r.info.pages).toBeGreaterThan(0);
}, 30_000);
(0, bun_test_1.test)('a local service is not reached when the network is not allowed', async () => {
    let hits = 0;
    const server = (0, node_http_1.createServer)((_req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('secret');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<img src="http://127.0.0.1:${port}/secret.png" width="10" height="10">
<p>Still renders.</p>`;
        const r = await (0, render_ts_1.render)(browser, { html: doc });
        (0, bun_test_1.expect)(hits).toBe(0);
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).toContain('network-blocked');
    }
    finally {
        server.close();
    }
}, 30_000);
(0, bun_test_1.test)('allowing network clears the findings', async () => {
    const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<p>No remote assets here.</p>`;
    const r = await (0, render_ts_1.render)(browser, { html: doc, allowNetwork: true });
    (0, bun_test_1.expect)(r.blocked).toHaveLength(0);
    (0, bun_test_1.expect)(r.findings.filter((f) => f.code === 'network-blocked')).toHaveLength(0);
}, 30_000);
(0, bun_test_1.test)('a request format overrides the document and says so', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: DOC, format: 'letter' });
    const finding = r.findings.find((f) => f.code === 'page-size-override');
    (0, bun_test_1.expect)(finding).toBeTruthy();
    (0, bun_test_1.expect)(finding.severity).toBe('info');
    const info = await (0, poppler_ts_1.pdfInfo)(r.pdf);
    (0, bun_test_1.expect)(info.pageSize).toMatch(/612/);
}, 30_000);
(0, bun_test_1.test)('a hanging document fails with an error instead of hanging', async () => {
    const hanging = (0, node_http_1.createServer)(() => { });
    await new Promise((r) => hanging.listen(0, '127.0.0.1', () => r()));
    const port = hanging.address().port;
    const started = Bun.nanoseconds();
    let message = '';
    try {
        await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><img src="http://127.0.0.1:${port}/stall.png"><p>never finishes</p>`,
            allowNetwork: true,
            preferFastPath: false,
            timeoutMs: 2_000,
        });
    }
    catch (e) {
        message = e instanceof Error ? e.message : String(e);
    }
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    hanging.close();
    (0, bun_test_1.expect)(message).toMatch(/navigation did not finish|printing exceeded/);
    (0, bun_test_1.expect)(message).not.toContain('cdp socket closed');
    (0, bun_test_1.expect)(elapsedMs).toBeLessThan(20_000);
}, 40_000);
(0, bun_test_1.test)('a script that never yields is cut by the deadline with honest wording', async () => {
    const started = Bun.nanoseconds();
    let message = '';
    try {
        await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><h1>spinner</h1><p>prose.</p><script>while(true){}</script>`,
            timeoutMs: 3_000,
        });
    }
    catch (e) {
        message = e instanceof Error ? e.message : String(e);
    }
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    (0, bun_test_1.expect)(message).toMatch(/took longer than 3000ms and was cut short/);
    (0, bun_test_1.expect)(message).not.toContain('cdp socket closed');
    (0, bun_test_1.expect)(elapsedMs).toBeLessThan(20_000);
}, 40_000);
(0, bun_test_1.test)('the browser still renders after a timeout', async () => {
    const r = await (0, render_ts_1.render)(browser, { html: DOC });
    (0, bun_test_1.expect)(r.info.pages).toBeGreaterThan(0);
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfImages)(r.pdf)).toHaveLength(0);
}, 30_000);
(0, bun_test_1.test)('concurrent renders all succeed and agree on page count', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => (0, render_ts_1.render)(browser, { html: DOC.replace('Acceptance document', `Doc ${i}`) })));
    for (const r of results)
        (0, bun_test_1.expect)(r.info.pages).toBeGreaterThan(0);
    (0, bun_test_1.expect)(new Set(results.map((r) => r.info.pages)).size).toBe(1);
}, 60_000);
const staged = async (dir) => {
    const out = [];
    const walk = async (d, prefix) => {
        for (const e of await (0, promises_1.readdir)(d, { withFileTypes: true })) {
            if (e.isDirectory())
                await walk((0, node_path_1.join)(d, e.name), `${prefix}${e.name}/`);
            else
                out.push(`${prefix}${e.name}`);
        }
    };
    await walk(dir, '');
    return out.sort();
};
(0, bun_test_1.describe)('stageAssets', () => {
    async function site() {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-site-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-work-'));
        await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
        await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'fonts'), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'tokens.css'), ':root { --ink: #123 }\n');
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'print.css'), '@page { size: A4 }\n');
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'fonts', 'body.woff2'), 'not really a font');
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'main.css'), [
            '@import url("tokens.css");',
            '@import url("print.css");',
            '@font-face { src: url("../fonts/body.woff2"); }',
        ].join('\n'));
        return { root, work };
    }
    (0, bun_test_1.test)("follows a stylesheet's own imports and url() targets", async () => {
        const { root, work } = await site();
        try {
            await (0, render_ts_1.stageAssets)('<link rel="stylesheet" href="assets/main.css">', (0, node_path_1.join)(root, 'index.html'), work);
            (0, bun_test_1.expect)(await staged(work)).toEqual([
                'assets/main.css',
                'assets/print.css',
                'assets/tokens.css',
                'fonts/body.woff2',
            ]);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    const stage = async (html) => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-nav-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-navwork-'));
        try {
            return await (0, render_ts_1.stageAssets)(html, (0, node_path_1.join)(root, 'index.html'), work);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    };
    (0, bun_test_1.test)('an anchor href is navigation, and nothing is staged or refused for it', async () => {
        const refused = await stage('<a href="/pricing">Pricing</a><a href="./report.html">Full report</a>' +
            '<a href="https://example.com/x">External</a><a href="#terms">Terms</a>');
        (0, bun_test_1.expect)(refused).toEqual([]);
    });
    (0, bun_test_1.test)('an image inside an anchor and a stylesheet are still assets', async () => {
        const refused = await stage('<a href="/pricing"><img src="/pricing.png"></a><link rel="stylesheet" href="/etc/passwd.css">');
        const whys = refused.map((r) => r.why);
        (0, bun_test_1.expect)(whys).toContain('outside-root');
        (0, bun_test_1.expect)(refused.some((r) => r.ref.endsWith('.png'))).toBe(true);
        (0, bun_test_1.expect)(refused.some((r) => r.ref.endsWith('.css'))).toBe(true);
        (0, bun_test_1.expect)(refused.some((r) => r.ref.includes('/pricing"'))).toBe(false);
    });
    (0, bun_test_1.test)('two stylesheets importing each other terminate', async () => {
        const { root, work } = await site();
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'a.css'), '@import url("b.css");\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'b.css'), '@import url("a.css");\n');
            await (0, render_ts_1.stageAssets)('<link rel="stylesheet" href="assets/a.css">', (0, node_path_1.join)(root, 'index.html'), work);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/a.css', 'assets/b.css']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)("follows a script's own module imports", async () => {
        const { root, work } = await site();
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'site.js'), 'export const x = 1;\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'widget.js'), "import './site.js';\n");
            await (0, render_ts_1.stageAssets)('<script type="module" src="assets/widget.js"></script>', (0, node_path_1.join)(root, 'index.html'), work);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/site.js', 'assets/widget.js']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a computed specifier is left alone rather than guessed at', async () => {
        const { root, work } = await site();
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'dyn.js'), 'const n = "site"; import(`./${n}.js`);\n');
            await (0, render_ts_1.stageAssets)('<script type="module" src="assets/dyn.js"></script>', (0, node_path_1.join)(root, 'index.html'), work);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/dyn.js']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)("a stylesheet cannot walk out of the document's own directory", async () => {
        const { root, work } = await site();
        const outside = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-outside-'));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(outside, 'secret.css'), 'body { color: red }\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'evil.css'), '@import url("../../../../../../etc/hostname");\n');
            await (0, render_ts_1.stageAssets)('<link rel="stylesheet" href="assets/evil.css">', (0, node_path_1.join)(root, 'index.html'), work);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/evil.css']);
        }
        finally {
            for (const d of [root, work, outside])
                await (0, promises_1.rm)(d, { recursive: true, force: true });
        }
    });
});
(0, bun_test_1.describe)('the asset root', () => {
    async function site() {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-root-site-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-root-work-'));
        await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
        await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'lessons'), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'styles.css'), 'body { color: #123 }\n');
        return { root, work };
    }
    const has = async (dir, rel) => {
        try {
            await (0, promises_1.readdir)((0, node_path_1.join)(dir, rel));
            return true;
        }
        catch {
            return false;
        }
    };
    (0, bun_test_1.test)('by default a ../ reference is refused and reported, not silently dropped', async () => {
        const { root, work } = await site();
        const page = (0, node_path_1.join)(root, 'lessons', 'x.html');
        try {
            await (0, promises_1.writeFile)(page, '<link rel="stylesheet" href="../assets/styles.css">');
            const html = await Bun.file(page).text();
            const refused = await (0, render_ts_1.stageAssets)(html, page, work);
            (0, bun_test_1.expect)(await has(work, 'assets')).toBe(false);
            (0, bun_test_1.expect)(refused).toEqual([
                {
                    ref: '../assets/styles.css',
                    abs: (0, node_path_1.join)(root, 'assets', 'styles.css'),
                    why: 'outside-root',
                },
            ]);
        }
        finally {
            for (const d of [root, work])
                await (0, promises_1.rm)(d, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a named root allows it, and only within that root', async () => {
        const { root, work } = await site();
        const page = (0, node_path_1.join)(root, 'lessons', 'x.html');
        const outside = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-root-out-'));
        try {
            await (0, promises_1.writeFile)(page, [
                '<link rel="stylesheet" href="../assets/styles.css">',
                '<img src="../../secret.png">',
            ].join('\n'));
            await (0, promises_1.writeFile)((0, node_path_1.join)(outside, 'secret.png'), 'not really a png');
            const html = await Bun.file(page).text();
            await (0, render_ts_1.stageAssets)(html, page, work, root);
            (0, bun_test_1.expect)(await has(work, 'assets')).toBe(true);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/styles.css']);
        }
        finally {
            for (const d of [root, work, outside])
                await (0, promises_1.rm)(d, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('the root does not change what a relative path means', async () => {
        const { root, work } = await site();
        const page = (0, node_path_1.join)(root, 'lessons', 'x.html');
        try {
            await (0, promises_1.writeFile)(page, '<link rel="stylesheet" href="assets/styles.css">');
            const html = await Bun.file(page).text();
            await (0, render_ts_1.stageAssets)(html, page, work, root);
            (0, bun_test_1.expect)(await has(work, 'assets')).toBe(false);
        }
        finally {
            for (const d of [root, work])
                await (0, promises_1.rm)(d, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a sibling of the document still loads when --root is given', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sib-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sibw-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'lessons'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'styles.css'), 'body { color: #123 }\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'lessons', 'sibling.css'), 'body { color: #456 }\n');
            const page = (0, node_path_1.join)(root, 'lessons', 'x.html');
            await (0, promises_1.writeFile)(page, [
                '<link rel="stylesheet" href="../assets/styles.css">',
                '<link rel="stylesheet" href="sibling.css">',
            ].join('\n'));
            const html = await Bun.file(page).text();
            await (0, render_ts_1.stageAssets)(html, page, work, root);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/styles.css', 'sibling.css']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)("a reference climbing above the origin clamps there, as a browser's does", async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-clamp-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-clampw-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'a', 'b', 'c'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'a.css'), 'a{}\n');
            const page = (0, node_path_1.join)(root, 'a', 'b', 'c', 'x.html');
            await (0, promises_1.writeFile)(page, '');
            await (0, render_ts_1.stageAssets)('<link rel="stylesheet" href="../../../a.css">', page, work, root);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['a.css']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a reference still outside the named root is reported, not swallowed', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-rep-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-repw-'));
        const outside = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-repo-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 's.css'), 'body{color:#123}\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(outside, 'far.css'), 'body{color:#456}\n');
            const page = (0, node_path_1.join)(root, 'x.html');
            const html = `<link rel="stylesheet" href="assets/s.css"><link rel="stylesheet" href="../${(0, node_path_1.basename)(outside)}/far.css">`;
            const refused = await (0, render_ts_1.stageAssets)(html, page, work, root);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/s.css']);
            (0, bun_test_1.expect)(refused).toHaveLength(1);
            (0, bun_test_1.expect)(refused[0].abs).toBe((0, node_path_1.join)(outside, 'far.css'));
        }
        finally {
            for (const d of [root, work, outside])
                await (0, promises_1.rm)(d, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a refusal does not depend on whether the file is there', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-oracle-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-oraclew-'));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'x.html'), '');
            const page = (0, node_path_1.join)(root, 'x.html');
            const html = [
                '<img src="../../../../../../etc/passwd">',
                '<img src="../../../../../../etc/definitely-not-here-xyz">',
            ].join('\n');
            const refused = await (0, render_ts_1.stageAssets)(html, page, work);
            (0, bun_test_1.expect)(refused).toHaveLength(2);
            (0, bun_test_1.expect)(refused.every((r) => typeof r.abs === 'string' && r.abs.startsWith('/'))).toBe(true);
            (0, bun_test_1.expect)(await staged(work)).toEqual([]);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    });
    (0, bun_test_1.test)('a symlink cannot pull a file in from outside the root', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sym-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symw-'));
        const outside = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symout-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'assets', 'ok.css'), 'body{color:#123}\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(outside, 'secret.txt'), 'SECRET-OUTSIDE-ROOT');
            await (0, promises_1.symlink)((0, node_path_1.join)(outside, 'secret.txt'), (0, node_path_1.join)(root, 'assets', 'link.txt'));
            const page = (0, node_path_1.join)(root, 'x.html');
            await (0, promises_1.writeFile)(page, '<link rel="stylesheet" href="assets/link.txt">');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work);
            (0, bun_test_1.expect)(await staged(work)).toEqual([]);
            (0, bun_test_1.expect)(refused.map((r) => r.abs)).toEqual([(0, node_path_1.join)(outside, 'secret.txt')]);
        }
        finally {
            for (const d of [root, work, outside])
                await (0, promises_1.rm)(d, { recursive: true, force: true }).catch(() => { });
        }
    }, 30_000);
    (0, bun_test_1.test)('a symlink that stays inside the root still works', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sym2-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sym2w-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'assets'), { recursive: true });
            await (0, promises_1.mkdir)((0, node_path_1.join)(root, 'shared'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'shared', 'real.css'), 'body{color:#123}\n');
            await (0, promises_1.symlink)((0, node_path_1.join)(root, 'shared', 'real.css'), (0, node_path_1.join)(root, 'assets', 'alias.css'));
            const page = (0, node_path_1.join)(root, 'x.html');
            await (0, promises_1.writeFile)(page, '<link rel="stylesheet" href="assets/alias.css">');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['assets/alias.css']);
            (0, bun_test_1.expect)(refused).toEqual([]);
            (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(work, 'assets', 'alias.css')).text()).toBe('body{color:#123}\n');
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    }, 30_000);
    (0, bun_test_1.test)('a document reached through a symlink to its site still finds its assets', async () => {
        const parent = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symlinkdoc-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symlinkdocw-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(parent, 'site', 'lessons'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(parent, 'site', 'lessons', 'sibling.css'), 'body{color:#123}\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(parent, 'site', 'lessons', 'p.html'), '<link rel="stylesheet" href="sibling.css">');
            await (0, promises_1.symlink)((0, node_path_1.join)(parent, 'site'), (0, node_path_1.join)(parent, 'aslink'));
            const page = (0, node_path_1.join)(parent, 'aslink', 'lessons', 'p.html');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work);
            (0, bun_test_1.expect)(refused).toEqual([]);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['sibling.css']);
        }
        finally {
            await (0, promises_1.rm)(parent, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    }, 30_000);
    (0, bun_test_1.test)('the same document under --root named through the link behaves identically', async () => {
        const parent = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symlinkroot-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-symlinkrootw-'));
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(parent, 'site', 'lessons'), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(parent, 'site', 'lessons', 'sibling.css'), 'body{color:#123}\n');
            await (0, promises_1.writeFile)((0, node_path_1.join)(parent, 'site', 'lessons', 'p.html'), '<link rel="stylesheet" href="sibling.css">');
            await (0, promises_1.symlink)((0, node_path_1.join)(parent, 'site'), (0, node_path_1.join)(parent, 'aslink'));
            const page = (0, node_path_1.join)(parent, 'aslink', 'lessons', 'p.html');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work, (0, node_path_1.join)(parent, 'aslink'));
            (0, bun_test_1.expect)(refused).toEqual([]);
            (0, bun_test_1.expect)(await staged(work)).toEqual(['sibling.css']);
        }
        finally {
            await (0, promises_1.rm)(parent, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    }, 30_000);
    (0, bun_test_1.test)('an asset named after the served document is not staged over it', async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-self-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-selfw-'));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'input.html'), '<p>THE DECOY</p>');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'p.html'), '<link rel="stylesheet" href="input.html"><p>THE DOCUMENT</p>');
            const page = (0, node_path_1.join)(root, 'p.html');
            await Bun.write((0, node_path_1.join)(work, 'input.html'), '<p>THE DOCUMENT</p>');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work);
            (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(work, 'input.html')).text()).toBe('<p>THE DOCUMENT</p>');
            (0, bun_test_1.expect)(refused).toEqual([
                { ref: 'input.html', abs: (0, node_path_1.join)(root, 'input.html'), why: 'document' },
            ]);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    }, 30_000);
    (0, bun_test_1.test)("the same applies to the override document's name", async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-self2-'));
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-self2w-'));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'override.html'), '<p>DECOY</p>');
            await (0, promises_1.writeFile)((0, node_path_1.join)(root, 'p.html'), '<link rel="stylesheet" href="override.html">');
            const page = (0, node_path_1.join)(root, 'p.html');
            await Bun.write((0, node_path_1.join)(work, 'override.html'), '<p>THE DOCUMENT</p>');
            const refused = await (0, render_ts_1.stageAssets)(await Bun.file(page).text(), page, work);
            (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(work, 'override.html')).text()).toBe('<p>THE DOCUMENT</p>');
            (0, bun_test_1.expect)(refused.map((r) => r.why)).toEqual(['document']);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(work, { recursive: true, force: true });
        }
    }, 30_000);
});
(0, bun_test_1.describe)('the work directory boundary', () => {
    const DIR = '/tmp/letterpress-1';
    (0, bun_test_1.test)('a name that walks out is refused', () => {
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, '../letterpress-1-0/input.html')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, '../../etc/passwd')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, '..')).toBe(false);
    });
    (0, bun_test_1.test)("a sibling whose name merely begins with the directory's is refused", () => {
        const sibling = DIR + '-0';
        (0, bun_test_1.expect)(sibling.startsWith(DIR)).toBe(true);
        (0, bun_test_1.expect)(sibling.startsWith(DIR + '/')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, `../${sibling.split('/').pop()}`)).toBe(false);
    });
    (0, bun_test_1.test)('a percent-encoded separator is a literal filename, not an escape', () => {
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, '..%2fletterpress-1-0%2finput.html')).toBe(true);
    });
    (0, bun_test_1.test)('an ordinary asset is allowed', () => {
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, 'assets/styles.css')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.confinedTo)(DIR, 'input.html')).toBe(true);
    });
});
//# sourceMappingURL=render.test.js.map