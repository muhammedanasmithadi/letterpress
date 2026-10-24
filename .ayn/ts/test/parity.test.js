"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const poppler_ts_1 = require("./poppler.ts");
const display = process.env.DISPLAY;
const canRunHeadful = Boolean(display);
const DOC = `<!doctype html><meta charset="utf-8"><title>Parity</title>
<style>
@page { size: A4; margin: 12mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { font-family: "DejaVu Serif", serif }
h2 { break-before: page }
</style>
<h1>Parity document</h1><p>office efficient flags finished. Section one.</p>
<h2>Two</h2><p>Second section, some body text to fill the page a little.</p>
<h2>Three</h2><ul><li>Alpha</li><li>Beta</li></ul>
<table><tr><th>Head</th></tr><tr><td>Cell</td></tr></table>`;
function roles(pdf) {
    const counts = new Map();
    for (const m of Buffer.from(pdf)
        .toString('latin1')
        .matchAll(/\/Type \/StructElem\s*\/S\s*\/(\w+)/g)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    return [...counts]
        .sort()
        .map(([role, n]) => `${role}=${n}`)
        .join(' ');
}
async function run(headless) {
    const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-parity-'));
    const browser = await browser_ts_1.Browser.launch({
        profile,
        headless,
        extraArgs: headless ? [] : ['--ozone-platform=x11', '--window-size=1280,1700'],
    });
    try {
        return await (0, render_ts_1.render)(browser, { html: DOC, author: 'Parity' });
    }
    finally {
        await browser.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    }
}
bun_test_1.describe.skipIf(!canRunHeadful)('headful parity', () => {
    let headless;
    let headful;
    (0, bun_test_1.beforeAll)(async () => {
        headless = await run(true);
        headful = await run(false);
    }, 180_000);
    (0, bun_test_1.test)('a headful browser is really launched, not a headless one with a flag after it', async () => {
        const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-parity-probe-'));
        const browser = await browser_ts_1.Browser.launch({
            profile,
            headless: false,
            extraArgs: ['--ozone-platform=x11'],
        });
        const r = await (0, render_ts_1.render)(browser, { html: '<p>probe</p>' });
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
        await browser.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    }, 120_000);
    (0, bun_test_1.test)('the same number of pages', () => {
        (0, bun_test_1.expect)(headful.info.pages).toBe(headless.info.pages);
        (0, bun_test_1.expect)(headless.info.pages).toBe(3);
    });
    (0, bun_test_1.test)('the same page geometry', () => {
        (0, bun_test_1.expect)(headful.info.mediaBoxes).toEqual(headless.info.mediaBoxes);
    });
    (0, bun_test_1.test)('the same tagging', () => {
        (0, bun_test_1.expect)(headful.info.tagged).toBe(headless.info.tagged);
        (0, bun_test_1.expect)(headful.info.tagged).toBe(true);
    });
    (0, bun_test_1.test)('the same structure tree, role for role', () => {
        (0, bun_test_1.expect)(roles(headful.pdf)).toBe(roles(headless.pdf));
        (0, bun_test_1.expect)(roles(headless.pdf)).toContain('H1=1');
        (0, bun_test_1.expect)(roles(headless.pdf)).toContain('Table=1');
    });
    (0, bun_test_1.test)('the same text, including the margin-box footer', async () => {
        const a = await (0, poppler_ts_1.pdfText)(headless.pdf);
        const b = await (0, poppler_ts_1.pdfText)(headful.pdf);
        (0, bun_test_1.expect)(b).toBe(a);
        (0, bun_test_1.expect)(a).toContain('page 3 of 3');
    });
    (0, bun_test_1.test)('a comparable file size', () => {
        const delta = Math.abs(headful.pdf.byteLength - headless.pdf.byteLength);
        (0, bun_test_1.expect)(delta).toBeLessThanOrEqual(64);
    });
    (0, bun_test_1.test)('identical pixels on every page', async () => {
        const a = await (0, poppler_ts_1.pdfToPng)(headless.pdf, { dpi: 110, prefix: (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-parity-hl') });
        const b = await (0, poppler_ts_1.pdfToPng)(headful.pdf, { dpi: 110, prefix: (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-parity-hf') });
        try {
            (0, bun_test_1.expect)(b.length).toBe(a.length);
            (0, bun_test_1.expect)(a.length).toBe(3);
            for (let i = 0; i < a.length; i++) {
                const left = await Bun.file(a[i]).arrayBuffer();
                const right = await Bun.file(b[i]).arrayBuffer();
                (0, bun_test_1.expect)(new Uint8Array(right).length).toBe(new Uint8Array(left).length);
                (0, bun_test_1.expect)(Buffer.from(right).equals(Buffer.from(left))).toBe(true);
            }
        }
        finally {
            for (const f of [...a, ...b])
                await (0, promises_1.rm)(f, { force: true }).catch(() => { });
        }
    }, 180_000);
});
bun_test_1.describe.skipIf(canRunHeadful)('headful parity', () => {
    (0, bun_test_1.test)('is skipped without a display', () => {
        (0, bun_test_1.expect)(process.env.DISPLAY).toBeFalsy();
    });
});
(0, bun_test_1.describe)('headless is the default', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-parity-default-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    (0, bun_test_1.test)('launching without headless still works and needs no display', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: `<!doctype html><p>plain</p>` });
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
    });
});
(0, bun_test_1.describe)("the rewritten document is the browser's document", () => {
    const MERGE_DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Merge</title>
<style>@page{size:A4;margin:15mm} body{font-family:"Noto Serif",serif;font-size:11pt}</style></head>
<body><h1>Heading</h1>
<p>Paragraph text with enough words in it to fill a line or two of the page, so that the text runs are
long enough for the difference to show.</p>
<p>A second paragraph, because the first one is short.</p></body></html>`;
    (0, bun_test_1.test)('the folding of the text runs keeps the text, the words and the page', async () => {
        const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-merge-'));
        const browser = await browser_ts_1.Browser.launch({ profile });
        let ours;
        let theirs;
        try {
            ours = (await (0, render_ts_1.render)(browser, { html: MERGE_DOC, author: 'Merge' })).pdf;
            const tab = await browser.newTab('about:blank');
            await tab.send('Page.enable');
            const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
            await tab.send('Page.setDocumentContent', { frameId, html: MERGE_DOC });
            const printed = await tab.send('Page.printToPDF', {
                printBackground: true,
                preferCSSPageSize: true,
            });
            theirs = new Uint8Array(Buffer.from(printed.data, 'base64'));
        }
        finally {
            await browser.close();
            await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
        }
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(ours)).toBe(await (0, poppler_ts_1.pdfText)(theirs));
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfWords)(ours)).map((w) => [w.text, w.xMin, w.xMax])).toEqual((await (0, poppler_ts_1.pdfWords)(theirs)).map((w) => [w.text, w.xMin, w.xMax]));
        const a = await gray(ours, 72, (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-merge-ours'));
        const b = await gray(theirs, 72, (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-merge-theirs'));
        try {
            (0, bun_test_1.expect)(a.length).toBe(1);
            (0, bun_test_1.expect)(b.length).toBe(1);
            const left = pgmPixels(a[0]);
            const right = pgmPixels(b[0]);
            const differing = countDifferent(left, right);
            const total = left.length;
            (0, bun_test_1.expect)(differing / total).toBeLessThan(0.001);
        }
        finally {
            for (const f of [...a, ...b])
                await (0, promises_1.rm)(f, { force: true }).catch(() => { });
        }
    }, 180_000);
});
async function gray(bytes, dpi, prefix) {
    const path = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `lp-merge-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
    await Bun.write(path, bytes);
    try {
        await Bun.$ `gs -q -dNOPAUSE -dBATCH -sDEVICE=pgmraw -r${dpi} -sOutputFile=${prefix} ${path}`.quiet();
        const dir = (0, node_path_1.dirname)(prefix);
        const stem = (0, node_path_1.basename)(prefix);
        const entries = await (0, promises_1.readdir)(dir).catch(() => []);
        return entries
            .filter((n) => n === stem || n.startsWith(`${stem}-`))
            .filter((n) => !n.endsWith('.pdf'))
            .sort()
            .map((n) => (0, node_path_1.join)(dir, n));
    }
    finally {
        await (0, promises_1.rm)(path, { force: true }).catch(() => { });
    }
}
function pgmPixels(file) {
    const raw = (0, node_fs_1.readFileSync)(file);
    let at = 0;
    const line = () => {
        let out = '';
        while (at < raw.length && raw[at] !== 10)
            out += String.fromCharCode(raw[at++]);
        at++;
        return out;
    };
    if (line().trim() !== 'P5')
        throw new Error('not a graymap');
    for (;;) {
        const text = line().trim();
        if (text.startsWith('#'))
            continue;
        if (text.split(/\s+/).length === 2)
            break;
    }
    line();
    return raw.subarray(at);
}
function countDifferent(left, right) {
    if (left.length !== right.length)
        return left.length;
    let n = 0;
    for (let i = 0; i < left.length; i++)
        if (left[i] !== right[i])
            n++;
    return n;
}
//# sourceMappingURL=parity.test.js.map