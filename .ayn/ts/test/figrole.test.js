"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const browser_ts_2 = require("./browser.ts");
const render_ts_1 = require("../src/render.ts");
const figrole_ts_1 = require("../src/figrole.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const verify_ts_1 = require("../src/verify.ts");
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const fig = (alt, caption) => `<figure><img src="${PNG}" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;
const DOC = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:20mm} img{width:20mm}</style><body><p>prose</p>${body}</body>`;
function roles(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        throw new Error('unparseable');
    const seen = new Set();
    const out = [];
    let rootNum;
    for (const o of parts.objs) {
        const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec((0, pdfparts_ts_1.dictOf)(o));
        if (m) {
            rootNum = Number(m[1]);
            break;
        }
    }
    const walk = (num, depth) => {
        if (depth > 64 || seen.has(num))
            return;
        seen.add(num);
        const text = (0, pdfparts_ts_1.dictOf)(parts.objs.find((o) => o.num === num));
        const role = /\/S\s*\/(\w+)/.exec(text)?.[1];
        if (role)
            out.push(role);
        const kids = /\/K\s*(?:\[([\s\S]*?)\]|(\d+) 0 R)/.exec(text);
        if (!kids)
            return;
        for (const ref of kids[2]
            ? [Number(kids[2])]
            : [...(kids[1] ?? '').matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]))) {
            walk(ref, depth + 1);
        }
    };
    if (rootNum !== undefined)
        walk(rootNum, 0);
    return out;
}
(0, bun_test_1.describe)('fixRedundantFigures', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-figrole-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    (0, bun_test_1.test)('the figure container becomes a grouping and the image keeps its description', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(fig('a bar chart', 'Figure 1')), author: 't' });
        (0, bun_test_1.expect)(roles(r.pdf)).toContain('Div');
        (0, bun_test_1.expect)(roles(r.pdf)).toContain('Figure');
        const parts = (0, pdfparts_ts_1.trySplit)(r.pdf);
        const described = (0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure').filter((n) => /\/Alt\s/.test((0, pdfparts_ts_1.dictOf)(parts.objs.find((o) => o.num === n))));
        (0, bun_test_1.expect)(described).toHaveLength(1);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(parts.objs.find((o) => o.num === described[0]))).toContain('a bar chart');
    }, 90_000);
    (0, bun_test_1.test)('two figures are both corrected and each keeps its own description', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(fig('first chart', 'Figure 1') + fig('second chart', 'Figure 2')),
            author: 't',
        });
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(r.pdf)).toBe(0);
        (0, bun_test_1.expect)(roles(r.pdf).filter((x) => x === 'Div')).toHaveLength(2);
        (0, bun_test_1.expect)(roles(r.pdf).filter((x) => x === 'Figure')).toHaveLength(2);
        const text = Buffer.from(r.pdf).toString('latin1');
        (0, bun_test_1.expect)(text).toContain('first chart');
        (0, bun_test_1.expect)(text).toContain('second chart');
    }, 90_000);
    (0, bun_test_1.test)('nested figures are corrected at both levels', async () => {
        const body = `<figure><img src="${PNG}" alt="outer"><figcaption>outer` +
            fig('inner', 'inner') +
            `</figcaption></figure>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(r.pdf)).toBe(0);
        (0, bun_test_1.expect)(roles(r.pdf).filter((x) => x === 'Div')).toHaveLength(2);
    }, 90_000);
    (0, bun_test_1.test)('a figure whose image has no description is left alone', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<figure><img src="${PNG}"><figcaption>cap</figcaption></figure>`),
            author: 't',
        });
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(r.pdf)).toBe(0);
        (0, bun_test_1.expect)(roles(r.pdf)).toContain('Figure');
        (0, bun_test_1.expect)(roles(r.pdf)).not.toContain('Div');
    }, 90_000);
    (0, bun_test_1.test)('a bare image is left alone', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p>prose <img src="${PNG}" alt="a bare image"> more</p>`),
            author: 't',
        });
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(r.pdf)).toBe(0);
        (0, bun_test_1.expect)(roles(r.pdf).filter((x) => x === 'Figure')).toHaveLength(1);
    }, 90_000);
    (0, bun_test_1.test)('a document with no figures is untouched', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC('<p>prose only</p>'), author: 't' });
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(r.pdf)).toBe(0);
        (0, bun_test_1.expect)(roles(r.pdf)).not.toContain('Div');
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).not.toContain('figure-role-corrected');
    }, 90_000);
    (0, bun_test_1.test)('the correction is reported as a finding', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(fig('a chart', 'Figure 1')), author: 't' });
        const f = r.findings.find((x) => x.code === 'figure-role-corrected');
        (0, bun_test_1.expect)(f).toBeDefined();
        (0, bun_test_1.expect)(f.severity).toBe('info');
        (0, bun_test_1.expect)(f.message).toContain('grouping');
    }, 90_000);
    (0, bun_test_1.test)('it is idempotent and passes the gate', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC(fig('a chart', 'Figure 1')), author: 't' });
        const once = Buffer.from(r.pdf);
        (0, bun_test_1.expect)(Buffer.from((0, figrole_ts_1.fixRedundantFigures)(r.pdf)).equals(once)).toBe(true);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('content streams are untouched', async () => {
        const html = DOC(fig('a chart', 'Figure 1'));
        const r = await (0, render_ts_1.render)(browser, { html, author: 't' });
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
        const parts = (0, pdfparts_ts_1.trySplit)(r.pdf);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure')).toHaveLength(1);
    }, 90_000);
    (0, bun_test_1.test)('an unparseable file is returned unchanged rather than rewritten', async () => {
        const junk = new Uint8Array(Buffer.from('not a pdf at all'));
        (0, bun_test_1.expect)(Buffer.from((0, figrole_ts_1.fixRedundantFigures)(junk)).equals(Buffer.from(junk))).toBe(true);
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(junk)).toBe(0);
    }, 30_000);
    (0, bun_test_1.test)('redundantFigures names the objects it would change', async () => {
        const tab = await (0, browser_ts_2.tabWithHtml)(browser, DOC(fig('x', 'y')));
        try {
            await Bun.sleep(200);
            const res = (await tab.send('Runtime.evaluate', {
                expression: `(() => { const i = document.querySelector('img'); return JSON.stringify({ w: i.naturalWidth }); })()`,
                returnByValue: true,
            }));
            (0, bun_test_1.expect)(JSON.parse(res.result?.value ?? '{}')).toEqual({ w: 1 });
        }
        finally {
            await tab.close();
        }
        const r = await (0, render_ts_1.render)(browser, { html: DOC(fig('a chart', 'Figure 1')), author: 't' });
        const parts = (0, pdfparts_ts_1.trySplit)(r.pdf);
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigures)(parts)).toEqual([]);
    }, 90_000);
});
function tree(bodies, rootK) {
    const parts = ['%PDF-1.4\n'];
    const offsets = [];
    let at = parts[0].length;
    const add = (body) => {
        offsets.push(at);
        at += body.length;
        parts.push(body);
    };
    add('1 0 obj\n<< /Type /Catalog /StructTreeRoot 2 0 R /MarkInfo << /Marked true >> >>\nendobj\n');
    add(`2 0 obj\n<< /Type /StructTreeRoot /K ${rootK} >>\nendobj\n`);
    for (const [num, body] of Object.entries(bodies))
        add(`${num} 0 obj\n${body}\nendobj\n`);
    const xrefAt = at;
    const n = offsets.length + 1;
    let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets)
        table += `${String(off).padStart(10, '0')} 00000 n \n`;
    parts.push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.from(parts.join(''), pdfparts_ts_1.LATIN1);
}
(0, bun_test_1.describe)('redundantFigures on a structure tree that is a graph', () => {
    (0, bun_test_1.test)('a self-referencing figure terminates', () => {
        const pdf = tree({ 3: '<</Type /StructElem /S /Document /K [3 0 R]>>' }, '3 0 R');
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigureCount)(pdf)).toBe(0);
    });
    (0, bun_test_1.test)('a cycle between two figures terminates', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R 5 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [5 0 R]>>',
            5: '<</Type /StructElem /S /Figure /K [4 0 R]>>',
        }, '3 0 R');
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigures)((0, pdfparts_ts_1.trySplit)(pdf))).toEqual([]);
    });
    (0, bun_test_1.test)('a cycle that reaches a described figure is found from either entry point', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R 5 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [5 0 R]>>',
            5: '<</Type /StructElem /S /Figure /K [4 0 R 6 0 R]>>',
            6: `<</Type /StructElem /S /Figure /Alt (described)>>`,
        }, '3 0 R');
        const named = (0, figrole_ts_1.redundantFigures)((0, pdfparts_ts_1.trySplit)(pdf));
        (0, bun_test_1.expect)(named.sort()).toEqual([4, 5]);
    });
    (0, bun_test_1.test)('a cycle with nothing described in it re-tags nothing', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [3 0 R 4 0 R]>>',
        }, '3 0 R');
        const before = Buffer.from(pdf);
        (0, bun_test_1.expect)(Buffer.from((0, figrole_ts_1.fixRedundantFigures)(pdf)).equals(before)).toBe(true);
    });
    (0, bun_test_1.test)('an /Alt on the element itself disqualifies it whatever is below', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: `<</Type /StructElem /S /Figure /Alt (its own) /K [5 0 R]>>`,
            5: `<</Type /StructElem /S /Figure /Alt (also its own)>>`,
        }, '3 0 R');
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigures)((0, pdfparts_ts_1.trySplit)(pdf))).toEqual([]);
    });
    (0, bun_test_1.test)('a Figure whose only child is a page object is not re-tagged', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [5 0 R <</Type /OBJR /Obj 6 0 R /Pg 7 0 R>>]>>',
            5: '<</Type /StructElem /S /Caption /K [8 0 R]>>',
            8: '<</Type /StructElem /S /Figure /Alt (deep)>>',
        }, '3 0 R');
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigures)((0, pdfparts_ts_1.trySplit)(pdf))).toEqual([4]);
    });
});
(0, bun_test_1.describe)('redundantFigures when the alt text carries the word stream', () => {
    (0, bun_test_1.test)('a figure whose /Alt contains the word stream still counts as described', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [5 0 R]>>',
            5: '<</Type /StructElem /S /Figure /Alt (a stream of monthly revenue)>>',
        }, '3 0 R');
        (0, bun_test_1.expect)((0, figrole_ts_1.redundantFigures)((0, pdfparts_ts_1.trySplit)(pdf))).toEqual([4]);
        (0, bun_test_1.expect)(Buffer.from((0, figrole_ts_1.fixRedundantFigures)(pdf)).toString(pdfparts_ts_1.LATIN1)).toContain('4 0 obj\n<</Type /StructElem /S /Div');
    });
    (0, bun_test_1.test)('a lone described figure mentioning stream has no container and re-tags nothing', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /Alt (a stream of monthly revenue)>>',
        }, '3 0 R');
        (0, bun_test_1.expect)(Buffer.from((0, figrole_ts_1.fixRedundantFigures)(pdf)).equals(pdf)).toBe(true);
    });
});
//# sourceMappingURL=figrole.test.js.map