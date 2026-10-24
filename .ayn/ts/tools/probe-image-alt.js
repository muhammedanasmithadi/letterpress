"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CASES = {
    'img with alt': `<p>before <img src="${PNG}" alt="the alt text"> after</p>`,
    'img alt and title': `<p><img src="${PNG}" alt="the alt" title="the title"></p>`,
    'img alt and aria-label': `<p><img src="${PNG}" alt="the alt" aria-label="the label"></p>`,
    'img alt empty': `<p><img src="${PNG}" alt=""></p>`,
    'img no alt': `<p><img src="${PNG}"></p>`,
    'figure wrapping an img': `<figure><img src="${PNG}" alt="figure alt"><figcaption>cap</figcaption></figure>`,
    'svg role img': `<p><svg role="img" aria-label="svg label" width="20" height="20"><rect width="20" height="20" fill="#ccc"/></svg></p>`,
};
async function imageLoads(browser) {
    const tab = await browser.newTab();
    try {
        await tab.send('Page.enable');
        const { frameTree } = (await tab.send('Page.getFrameTree'));
        await tab.send('Page.setDocumentContent', {
            frameId: frameTree.frame.id,
            html: `<!doctype html><img id="probe" src="${PNG}" alt="x">`,
        });
        await Bun.sleep(400);
        const res = (await tab.send('Runtime.evaluate', {
            expression: `(() => { const i = document.getElementById('probe'); return JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight }); })()`,
            returnByValue: true,
        }));
        return JSON.parse(res.result?.value ?? '{}');
    }
    finally {
        await tab.close();
    }
}
const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-alt-probe-'));
const browser = await browser_ts_1.Browser.launch({ profile });
try {
    const probe = await imageLoads(browser);
    console.log(`fixture image: naturalWidth=${probe.w} naturalHeight=${probe.h}` +
        (probe.w > 0
            ? '  (decodes)'
            : '  (BROKEN — every result below would be about the placeholder)'));
    console.log();
    const rows = [];
    for (const [name, body] of Object.entries(CASES)) {
        const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title>` +
            `<style>@page{size:A4;margin:20mm} img{width:20mm}</style><body><p>prose</p>${body}</body>`;
        const r = await (0, render_ts_1.render)(browser, { html, author: 'probe' });
        const parts = (0, pdfparts_ts_1.trySplit)(r.pdf);
        const figures = parts ? (0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure').length : 0;
        const alts = parts
            ? (0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure')
                .map((n) => /\/Alt\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec((0, pdfparts_ts_1.dictOf)(parts.objs.find((o) => o.num === n))))
                .filter(Boolean).length
            : 0;
        const codes = r.findings.map((f) => f.code).join(',') || 'none';
        rows.push([name, figures, alts, codes]);
    }
    console.log(`  ${'case'.padEnd(24)} ${'Figure elems'.padEnd(12)} ${'with /Alt'.padEnd(10)} findings`);
    for (const [name, figures, alts, codes] of rows) {
        console.log(`  ${name.padEnd(24)} ${String(figures).padEnd(12)} ${String(alts).padEnd(10)} ${codes}`);
    }
}
finally {
    await browser.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
}
//# sourceMappingURL=probe-image-alt.js.map