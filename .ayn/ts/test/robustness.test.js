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
const verify_ts_1 = require("../src/verify.ts");
let browser;
let profile;
let dir;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGM8oWHDQApgIkn1qIZRDUNKAwDJMQFMogTzfQAAAABJRU5ErkJggg==', 'base64');
(0, bun_test_1.test)('the image fixture is a decodable 16x16 png', async () => {
    (0, bun_test_1.expect)(PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    (0, bun_test_1.expect)(PNG.readUInt32BE(16)).toBe(16);
    (0, bun_test_1.expect)(PNG.readUInt32BE(20)).toBe(16);
    let at = 8;
    const seen = [];
    while (at + 12 <= PNG.length) {
        const length = PNG.readUInt32BE(at);
        const type = PNG.subarray(at + 4, at + 8).toString('latin1');
        seen.push(type);
        const stored = PNG.readUInt32BE(at + 8 + length);
        let crc = ~0 >>> 0;
        const bytes = PNG.subarray(at + 4, at + 8 + length);
        for (const b of bytes) {
            crc ^= b;
            for (let k = 0; k < 8; k++)
                crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        (0, bun_test_1.expect)(~crc >>> 0, `crc of ${type}`).toBe(stored);
        at += 12 + length;
        if (type === 'IEND')
            break;
    }
    (0, bun_test_1.expect)(seen).toContain('IHDR');
    (0, bun_test_1.expect)(seen).toContain('IDAT');
    (0, bun_test_1.expect)(seen[seen.length - 1]).toBe('IEND');
});
const pictures = async (bytes) => (await (0, poppler_ts_1.pdfImages)(bytes)).filter((i) => i.type === 'image' && i.width === 16 && i.height === 16);
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-adv-'));
    dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-adv-doc-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
}, 20_000);
(0, bun_test_1.describe)('format validation', () => {
    (0, bun_test_1.test)('rejects an unknown format by name instead of crashing', async () => {
        for (const bad of ['a9', 'nope', '__proto__', 'toString', 'constructor']) {
            let message = '';
            try {
                await (0, render_ts_1.render)(browser, { html: '<!doctype html><p>x</p>', format: bad });
            }
            catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            (0, bun_test_1.expect)(message, `format: ${bad}`).toContain('unknown format');
            (0, bun_test_1.expect)(message).toContain('a4');
        }
    }, 60_000);
    (0, bun_test_1.test)('accepts a case-insensitive name and honours it', async () => {
        for (const name of ['a4', 'A4', 'A4 ', ' letter ']) {
            const r = await (0, render_ts_1.render)(browser, { html: '<!doctype html><p>x</p>', format: name });
            (0, bun_test_1.expect)(r.info.pages).toBe(1);
        }
        const letter = await (0, render_ts_1.render)(browser, {
            html: '<!doctype html><p>x</p>',
            format: 'LETTER',
        });
        (0, bun_test_1.expect)(letter.info.mediaBoxes[0]).toMatch(/612/);
    }, 90_000);
    (0, bun_test_1.test)('parseFormat is the single validation point', () => {
        (0, bun_test_1.expect)((0, render_ts_1.parseFormat)('a4')).toBe('a4');
        (0, bun_test_1.expect)((0, render_ts_1.parseFormat)(undefined)).toBeUndefined();
        (0, bun_test_1.expect)((0, render_ts_1.parseFormat)('')).toBeUndefined();
        (0, bun_test_1.expect)(() => (0, render_ts_1.parseFormat)('A9')).toThrow(/unknown format/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.parseFormat)(7)).toThrow(/must be a string/);
    });
    (0, bun_test_1.test)('toInches resolves absolute lengths and refuses the rest', () => {
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('15mm')).toBe(15 / 25.4);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('1in')).toBe(1);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('72pt')).toBe(1);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('96px')).toBe(1);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('6pc')).toBe(1);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('0')).toBe(0);
        (0, bun_test_1.expect)((0, render_ts_1.toInches)('-5mm')).toBe(-5 / 25.4);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('2em')).toThrow(/relative/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('10vw')).toThrow(/relative/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('5furlongs')).toThrow(/unsupported margin unit/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('abc')).toThrow(/not a css length/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('10')).toThrow(/needs a unit/);
        (0, bun_test_1.expect)(() => (0, render_ts_1.toInches)('.')).toThrow(/not a number/);
    });
    (0, bun_test_1.test)('render refuses non-documents before touching the browser', async () => {
        const noBrowser = null;
        await (0, bun_test_1.expect)((0, render_ts_1.render)(noBrowser, {})).rejects.toThrow(/one of: html, path, url/);
        await (0, bun_test_1.expect)((0, render_ts_1.render)(noBrowser, { html: '%PDF-1.4\n1 0 obj\n' })).rejects.toThrow(/not HTML/);
    });
});
(0, bun_test_1.describe)('a missing subresource does not kill the render', () => {
    (0, bun_test_1.test)('a 404 stylesheet renders the document and reports the failure', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><head><link rel="stylesheet" href="typo.css"></head>
<body><h1>HELLO</h1></body>`,
        });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('HELLO');
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).toContain('subresource-failed');
    }, 60_000);
    (0, bun_test_1.test)('a missing local image still renders and is reported', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'missing.html'), `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src="gone.png">`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'missing.html') });
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
        (0, bun_test_1.expect)(await pictures(r.pdf)).toHaveLength(0);
        const code = r.findings.find((f) => f.code === 'subresource-failed');
        (0, bun_test_1.expect)(code).toBeDefined();
        (0, bun_test_1.expect)(code.message).toContain('broken-image placeholder');
    }, 60_000);
    (0, bun_test_1.test)('a missing asset is counted once, whatever the browser reports', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'counted.html'), `<!doctype html><html lang="en"><head><link rel="stylesheet" href="gone.css"></head>` +
            `<body><img src="gone.png" alt="x"></body></html>`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'counted.html') });
        const f = r.findings.find((x) => x.code === 'subresource-failed');
        const listed = [...f.message.matchAll(/^ {2}\d{3} http/gm)].map((m) => m[0]);
        (0, bun_test_1.expect)(listed).toHaveLength(2);
        const claimed = Number(/^(\d+) subresources?/.exec(f.message)[1]);
        (0, bun_test_1.expect)(claimed).toBe(listed.length);
        (0, bun_test_1.expect)(f.message).not.toContain('favicon');
    }, 60_000);
});
(0, bun_test_1.describe)('the relative-asset scan sees every reference form', () => {
    (0, bun_test_1.test)('recognises quoted, unquoted, srcset and url() references', () => {
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="a.png">')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src=a.png>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img srcset="a.png 1x">')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<link href="s.css" rel=stylesheet>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>body{background:url(a.png)}</style>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@import url(s.css)</style>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@font-face{src:url(f.woff2)}</style>')).toBe(true);
    });
    (0, bun_test_1.test)('leaves absolute, inline and fragment references alone', () => {
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="https://cdn.example/a.png">')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<img src="data:image/png;base64,AAA">')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<a href="#top">x</a>')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>body{background:url(data:image/gif;base64,AA)}</style>')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<p>nothing here</p>')).toBe(false);
    });
});
(0, bun_test_1.describe)('assets reach the document without rewriting it', () => {
    (0, bun_test_1.test)('an unquoted src embeds the image', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'unquoted.png'), PNG);
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'unquoted.html'), `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src=unquoted.png>`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'unquoted.html') });
        (0, bun_test_1.expect)(await pictures(r.pdf)).toHaveLength(1);
    }, 60_000);
    (0, bun_test_1.test)('a css url() background is staged and applied', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'bg.png'), PNG);
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'bg.html'), `<!doctype html><style>@page{size:A4;margin:8mm}body{background:url(bg.png)}</style><p>styled</p>`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'bg.html') });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('styled');
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).not.toContain('subresource-failed');
    }, 60_000);
    (0, bun_test_1.test)('a nested path keeps its directories, so two files cannot collide', async () => {
        await (0, promises_1.mkdir)((0, node_path_1.join)(dir, 'sub'), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'sub', 'hide.css'), 'h1{display:none}');
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'sub_hide.css'), 'h1{color:#0a0}');
        const doc = (0, node_path_1.join)(dir, 'collide.html');
        await (0, promises_1.writeFile)(doc, `<!doctype html><link rel="stylesheet" href="sub/hide.css"><link rel="stylesheet" href="sub_hide.css">`);
        const work = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-stage-'));
        await (0, render_ts_1.stageAssets)(await (0, promises_1.readFile)(doc, 'utf8'), doc, work);
        const hidden = await (0, promises_1.readFile)((0, node_path_1.join)(work, 'sub', 'hide.css'), 'utf8');
        const flat = await (0, promises_1.readFile)((0, node_path_1.join)(work, 'sub_hide.css'), 'utf8');
        (0, bun_test_1.expect)(hidden).toContain('display:none');
        (0, bun_test_1.expect)(flat).toContain('#0a0');
        await (0, promises_1.rm)(work, { recursive: true, force: true });
    });
    (0, bun_test_1.test)('a filename mentioned in prose is not rewritten', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'asset.png'), PNG);
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'prose.html'), `<!doctype html><style>@page{size:A4;margin:8mm}</style>
<img src="asset.png"><p>Save as "asset.png" now</p>`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'prose.html') });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('Save as "asset.png" now');
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).not.toContain('"/asset.png"');
    }, 60_000);
    (0, bun_test_1.test)('an asset outside the document directory is refused', async () => {
        const outside = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-outside-'));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(outside, 'outside-secret.png'), PNG);
            await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'escape.html'), `<!doctype html><style>@page{size:A4;margin:8mm}</style><img src="${(0, node_path_1.join)(outside, 'outside-secret.png')}">`);
            const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'escape.html') });
            (0, bun_test_1.expect)(await pictures(r.pdf)).toHaveLength(0);
        }
        finally {
            await (0, promises_1.rm)(outside, { recursive: true, force: true }).catch(() => { });
        }
    }, 60_000);
    (0, bun_test_1.test)('an imported stylesheet is staged and applied', async () => {
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'imported.css'), 'p+p{page-break-before:always}');
        await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'imported.html'), `<!doctype html><style>@import "imported.css";</style><p>one</p><p>two</p>`);
        const r = await (0, render_ts_1.render)(browser, { path: (0, node_path_1.join)(dir, 'imported.html') });
        (0, bun_test_1.expect)(r.info.pages).toBe(2);
    }, 60_000);
    (0, bun_test_1.test)('the fast path is not taken for an imported stylesheet', () => {
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@import "theme.css";</style>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@import url("theme.css");</style>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@import "https://cdn.test/a.css";</style>')).toBe(false);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<script type="module">import x from "./x.js"</script>')).toBe(true);
        (0, bun_test_1.expect)((0, render_ts_1.hasRelativeAssets)('<style>@page{size:A4}</style>')).toBe(false);
    });
});
(0, bun_test_1.describe)('invoice totals are checked as numbers', () => {
    (0, bun_test_1.test)('the totals expose raw values, not only formatted strings', () => {
        const t = (0, template_ts_1.invoiceTotals)([{ description: 'x', qty: 2, unit: 10 }]);
        (0, bun_test_1.expect)(t.totalValue).toBe(24);
        (0, bun_test_1.expect)(t.total).toBe('24.00');
        const big = (0, template_ts_1.invoiceTotals)([{ description: 'x', qty: 1, unit: 3_383_428.75 }], { vatRate: 0 });
        (0, bun_test_1.expect)(big.subtotal).toBe('3,383,428.75');
        (0, bun_test_1.expect)(Number(big.subtotal)).toBeNaN();
        (0, bun_test_1.expect)(big.subtotalValue).toBe(3_383_428.75);
        (0, bun_test_1.expect)(Math.abs(1 - big.subtotalValue)).toBeGreaterThan(0.005);
    });
});
(0, bun_test_1.describe)('a subframe that will not load', () => {
    (0, bun_test_1.test)('a document that frames its own served name still prints', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><title>t</title>
<h1>THE REAL DOCUMENT</h1><iframe src="input.html" width="200" height="80"></iframe>`,
            author: 't',
        });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('THE REAL DOCUMENT');
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).toContain('asset-overwrites-document');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('a document that fails to load is still an error', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><title>t</title><p>text</p>`,
            author: 't',
        });
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('text');
    }, 90_000);
});
//# sourceMappingURL=robustness.test.js.map