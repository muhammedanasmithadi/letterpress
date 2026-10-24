"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const tjmerge_ts_1 = require("../src/tjmerge.ts");
const verify_ts_1 = require("../src/verify.ts");
const poppler_ts_1 = require("./poppler.ts");
let browser;
let profile;
const DOCS = [
    [
        'prose',
        `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif;font-size:11pt;line-height:1.4}
     p.even{text-align:justify}`,
        `<p>The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. WAVE To.</p>
     <p class="even">A justified paragraph, so the inter-word adjustments are not all the same
     and the merge has to carry every one of them: the quick brown fox again and again.</p>`,
    ],
    [
        'headings and a list',
        `@page{size:A4;margin:20mm} body{font-family:'Noto Sans',sans-serif} h1{font-size:20pt} h2{font-size:14pt} li{margin:2pt}`,
        `<h1>Heading one</h1><p>Some text under it.</p><h2>Heading two</h2>
     <ul><li>first item</li><li>second item</li><li>third item</li></ul>`,
    ],
    [
        'a table',
        `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif} table{border-collapse:collapse;width:100%}
     td,th{border:0.5pt solid #999;padding:3pt}`,
        `<table><tr><th>Item</th><th>Value</th></tr>${Array.from({ length: 25 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>${i * 7}</td></tr>`).join('')}</table>`,
    ],
    [
        'three fonts',
        `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif}
     .s{font-family:'Noto Sans',sans-serif} .m{font-family:'Noto Sans Mono',monospace}`,
        `<p>Serif text. <span class="s">Sans text.</span> <span class="m">monospace()</span> Back to serif.</p>`,
    ],
    [
        'glyphs outside the Latin block',
        `@page{size:A4;margin:20mm} body{font-family:'Noto Sans',sans-serif;font-size:12pt}`,
        `<p>Crème brûlée, naïve piñata. 日本語のテキスト Selecting across a fallback font.</p>`,
    ],
];
function page(name, css, body) {
    return `<!doctype html><meta charset="utf-8"><title>${name}</title><style>${css}</style>${body}`;
}
async function chromiumPrint(html) {
    const tab = await browser.newTab('about:blank');
    try {
        await tab.send('Page.enable');
        const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
        await tab.send('Page.setDocumentContent', { frameId, html });
        const res = await tab.send('Page.printToPDF', {
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            generateTaggedPDF: true,
            transferMode: 'ReturnAsBase64',
        });
        return new Uint8Array(Buffer.from(res.data, 'base64'));
    }
    finally {
        await browser.closeTab(tab);
    }
}
async function rasterise(pdf, dir, tag) {
    const path = (0, node_path_1.join)(dir, `${tag}.pdf`);
    await Bun.write(path, pdf);
    await Bun.$ `pdftoppm -png -r 100 ${path} ${(0, node_path_1.join)(dir, tag)}`.quiet();
    return Buffer.from(await Bun.file((0, node_path_1.join)(dir, `${tag}-1.png`)).arrayBuffer());
}
function said(text, code) {
    return text.findings.find((f) => f.code === code)?.message;
}
(0, bun_test_1.describe)('merging text runs', () => {
    (0, bun_test_1.test)('the page survives the merge unchanged', async () => {
        const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-tj-'));
        try {
            for (const [name, css, body] of DOCS) {
                const before = await chromiumPrint(page(name, css, body));
                const { pdf: after, stats } = (0, tjmerge_ts_1.mergeTextRuns)(before);
                (0, bun_test_1.expect)([name, stats.merged]).not.toEqual([name, 0]);
                (0, bun_test_1.expect)([name, Buffer.from(after).equals(Buffer.from(before))]).toEqual([name, false]);
                (0, bun_test_1.expect)([name, await (0, poppler_ts_1.pdfText)(after)]).toEqual([name, await (0, poppler_ts_1.pdfText)(before)]);
                const before0 = await (0, poppler_ts_1.pdfWords)(before);
                const words = await (0, poppler_ts_1.pdfWords)(after);
                (0, bun_test_1.expect)([name, words.map((w) => w.text)]).toEqual([name, before0.map((w) => w.text)]);
                (0, bun_test_1.expect)([name, words.length > 0]).toEqual([name, true]);
                for (const [i, word] of words.entries()) {
                    const was = before0[i];
                    (0, bun_test_1.expect)([name, i, Math.abs(word.xMin - was.xMin) < 0.01]).toEqual([name, i, true]);
                    (0, bun_test_1.expect)([name, i, Math.abs(word.xMax - was.xMax) < 0.01]).toEqual([name, i, true]);
                }
                (0, bun_test_1.expect)([
                    name,
                    (await rasterise(after, dir, 'b')).equals(await rasterise(before, dir, 'a')),
                ]).toEqual([name, true]);
                (0, bun_test_1.expect)([name, (0, verify_ts_1.verify)(after).ok]).toEqual([name, true]);
                const gs = await Bun.$ `gs -o /dev/null -sDEVICE=nullpage ${(0, node_path_1.join)(dir, 'b.pdf')} 2>&1`.text();
                (0, bun_test_1.expect)([name, /error/i.test(gs)]).toEqual([name, false]);
                const profile = (0, tjmerge_ts_1.textRunProfile)(after);
                (0, bun_test_1.expect)([name, profile.tj]).toEqual([name, profile.showOps]);
            }
        }
        finally {
            await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
        }
    }, 300_000);
    (0, bun_test_1.test)('the pipeline reports what it folded and what it left alone', async () => {
        for (const [name, css, body] of DOCS) {
            const r = await (0, render_ts_1.render)(browser, { html: page(name, css, body), author: 'tj' });
            const message = said(r, 'text-runs-merged');
            (0, bun_test_1.expect)([name, message !== undefined]).toEqual([name, true]);
            (0, bun_test_1.expect)([name, /the text is one item per block now/.test(message)]).toEqual([name, true]);
            (0, bun_test_1.expect)([name, /left all \d+ text blocks alone/.test(message)]).toEqual([name, false]);
            (0, bun_test_1.expect)([name, /bytes (smaller|larger)|the same size/.test(message)]).toEqual([name, true]);
            (0, bun_test_1.expect)([name, /-\d+ bytes/.test(message)]).toEqual([name, false]);
        }
    }, 300_000);
    (0, bun_test_1.test)('a document that the fold makes larger says so', async () => {
        const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
            '<style>@page{size:A4;margin:18mm;@bottom-center{content:counter(page);font:9pt serif}}' +
            'body{font-family:"Noto Naskh Arabic",serif;font-size:13pt;line-height:1.8}</style></head>' +
            '<body><h1>الفصل الأول</h1>' +
            '<p>السابق ثلاثة يمر بأسفل، ومن ثم نزل. The official fish fills five dozen liquor jugs.</p>' +
            '<p>الأرقام ٢٠٢٦-١٠-٠٣ والتاريخ يظهر معكوسا في السياق من اليسار إلى اليمين.</p>' +
            '<p>الفصل الثاني من الكتاب، ونص آخر ليملأ السطر.</p></body></html>';
        const r = await (0, render_ts_1.render)(browser, { html, author: 'tj' });
        const message = said(r, 'text-runs-merged');
        (0, bun_test_1.expect)(message).toBeDefined();
        (0, bun_test_1.expect)(message).not.toMatch(/-\d+ bytes/);
        (0, bun_test_1.expect)(message).toMatch(/bytes (smaller|larger)|the same size/);
    }, 120_000);
    (0, bun_test_1.test)('merging an already merged file changes nothing', async () => {
        const before = await chromiumPrint(page('prose', DOCS[0][1], DOCS[0][2]));
        const once = (0, tjmerge_ts_1.mergeTextRuns)(before).pdf;
        const twice = (0, tjmerge_ts_1.mergeTextRuns)(once);
        (0, bun_test_1.expect)(Buffer.from(twice.pdf).equals(Buffer.from(once))).toBe(true);
        (0, bun_test_1.expect)(twice.stats.merged).toBe(0);
    }, 120_000);
    (0, bun_test_1.test)('a file it cannot handle is returned untouched', () => {
        const junk = (0, tjmerge_ts_1.mergeTextRuns)(Buffer.from('not a pdf'));
        (0, bun_test_1.expect)(Buffer.from(junk.pdf).toString()).toBe('not a pdf');
        (0, bun_test_1.expect)(junk.stats.merged).toBe(0);
        const bare = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n');
        const empty = (0, tjmerge_ts_1.mergeTextRuns)(new Uint8Array(bare));
        (0, bun_test_1.expect)(empty.pdf.byteLength).toBe(bare.byteLength);
        (0, bun_test_1.expect)(empty.stats.blocks).toBe(0);
    });
});
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-tj-profile-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
});
//# sourceMappingURL=tjmerge.test.js.map