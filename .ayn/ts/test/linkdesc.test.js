"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const linkdesc_ts_1 = require("../src/linkdesc.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const verify_ts_1 = require("../src/verify.ts");
const GIF = 'data:image/gif;base64,R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==';
const DOC = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:20mm}</style><body><p>prose</p>${body}</body>`;
function decode(token) {
    if (token.startsWith('(')) {
        return token
            .slice(1, -1)
            .replace(/\\([()\\])/g, '$1')
            .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    }
    if (!token.startsWith('<'))
        return token;
    const bytes = Buffer.from(token.slice(1, -1).replace(/\s+/g, ''), 'hex');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    }
    return bytes.toString('latin1');
}
function readAnnots(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        throw new Error('unparseable');
    const out = [];
    for (const o of parts.objs) {
        const text = (0, pdfparts_ts_1.dictOf)(o);
        if (!/\/Subtype \/Link\b/.test(text))
            continue;
        const uri = /\/URI\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1] ?? '?';
        const contents = /\/Contents\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1];
        out.push([decode(uri), contents ? decode(contents) : '']);
    }
    return out;
}
function readLinkAlts(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        throw new Error('unparseable');
    const out = [];
    for (const num of (0, linkdesc_ts_1.linkOrder)(parts)) {
        const o = parts.objs.find((x) => x.num === num);
        if (!o)
            continue;
        const alt = /\/Alt\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec((0, pdfparts_ts_1.dictOf)(o))?.[1];
        out.push(alt ? decode(alt) : '');
    }
    return out;
}
(0, bun_test_1.describe)('insertIntoDict', () => {
    (0, bun_test_1.test)('inserts inside the outer dictionary, not a nested one', () => {
        const obj = '5 0 obj\n<</Type /Annot\n/Subtype /Link\n/A <</S /URI\n/URI (https://x.example/)>>\n/StructParent 1>>\nendobj';
        const out = (0, pdfparts_ts_1.insertIntoDict)(obj, '/Contents (hello)');
        const nestedClose = out.indexOf('/URI (https://x.example/)>>') + '/URI (https://x.example/)>>'.length;
        const at = out.indexOf('/Contents (hello)');
        const outerClose = out.lastIndexOf('>>');
        (0, bun_test_1.expect)(at).toBeGreaterThan(nestedClose);
        (0, bun_test_1.expect)(at).toBeLessThan(outerClose);
        (0, bun_test_1.expect)(out.endsWith('>>\nendobj')).toBe(true);
    });
    (0, bun_test_1.test)('inserts into a dictionary with no nesting', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.insertIntoDict)('1 0 obj\n<</A 1>>\nendobj', '/B 2')).toBe('1 0 obj\n<</A 1/B 2\n>>\nendobj');
    });
    (0, bun_test_1.test)('leaves a body with no dictionary alone', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.insertIntoDict)('1 0 obj\n42\nendobj', '/B 2')).toBe('1 0 obj\n42\nendobj');
    });
});
(0, bun_test_1.describe)('parseLinkDescs', () => {
    (0, bun_test_1.test)('reads a list of strings', () => {
        (0, bun_test_1.expect)((0, linkdesc_ts_1.parseLinkDescs)('["alpha","beta"]')).toEqual(['alpha', 'beta']);
    });
    (0, bun_test_1.test)('reads an empty list', () => {
        (0, bun_test_1.expect)((0, linkdesc_ts_1.parseLinkDescs)('[]')).toEqual([]);
    });
    bun_test_1.test.each([
        ['not json', 'nope'],
        ['an object', '{"a":1}'],
        ['a non-string element', '["a",1]'],
        ['a number', 7],
        ['null', null],
        ['undefined', undefined],
    ])('refuses %s', (_label, input) => {
        (0, bun_test_1.expect)((0, linkdesc_ts_1.parseLinkDescs)(input)).toBeNull();
    });
});
(0, bun_test_1.describe)('link descriptions', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-linkdesc-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    const CASES = {
        'one link': {
            body: `<p><a href="https://a.example/">link-1</a></p>`,
            wanted: [['https://a.example/', 'link-1']],
        },
        'three links': {
            body: `<p><a href="https://a.example/">link-1</a> <a href="https://b.example/">link-2</a> ` +
                `<a href="https://c.example/">link-3</a></p>`,
            wanted: [
                ['https://a.example/', 'link-1'],
                ['https://b.example/', 'link-2'],
                ['https://c.example/', 'link-3'],
            ],
        },
        'the same address twice': {
            body: `<p><a href="https://a.example/">first</a> <a href="https://a.example/">second</a></p>`,
            wanted: [
                ['https://a.example/', 'first'],
                ['https://a.example/', 'second'],
            ],
        },
        'a link inside a heading, and one in a paragraph': {
            body: `<h2><a href="https://h.example/">heading link</a></h2><p><a href="https://p.example/">para link</a></p>`,
            wanted: [
                ['https://h.example/', 'heading link'],
                ['https://p.example/', 'para link'],
            ],
        },
        'an internal link that has no annotation': {
            body: `<p><a href="https://a.example/">ext</a></p><p><a href="#nowhere">int</a></p>`,
            wanted: [['https://a.example/', 'ext']],
        },
        'non-ascii text': {
            body: `<p><a href="https://a.example/">café — 日本語</a></p>`,
            wanted: [['https://a.example/', 'café — 日本語']],
        },
        'an anchor that paints nothing between two that do': {
            body: `<p><a href="https://a.example/">link-1</a> <a href="https://empty.example/"></a> ` +
                `<a href="https://b.example/">link-2</a></p>`,
            wanted: [
                ['https://a.example/', 'link-1'],
                ['https://b.example/', 'link-2'],
            ],
        },
    };
    for (const [name, { body, wanted }] of Object.entries(CASES)) {
        (0, bun_test_1.test)(`${name}: described on the right annotation`, async () => {
            const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
            (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual(wanted);
            (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
        }, 90_000);
    }
    (0, bun_test_1.test)('a link the print cannot navigate is described on its structure element', async () => {
        const body = `<p><a href="#nowhere">Data policy</a></p>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(readLinkAlts(r.pdf)).toEqual(['Data policy']);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('documents of such links keep the descriptions in document order', async () => {
        const body = `<p><a href="#terms">Terms of service</a></p>` +
            `<p><a href="#privacy">Data policy</a></p>` +
            `<p><a href="#api">API policy</a></p>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(readLinkAlts(r.pdf)).toEqual(['Terms of service', 'Data policy', 'API policy']);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('an annotatable link keeps its description on the annotation, not also as alt', async () => {
        const body = `<p><a href="https://a.example/">ext</a></p><p><a href="#nowhere">int</a></p>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([['https://a.example/', 'ext']]);
        (0, bun_test_1.expect)(readLinkAlts(r.pdf)).toEqual(['', 'int']);
    }, 90_000);
    (0, bun_test_1.test)('the alt on a structure element is idempotent', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p><a href="#nowhere">int</a></p>`),
            author: 't',
        });
        const once = Buffer.from(r.pdf);
        (0, bun_test_1.expect)(Buffer.from((0, linkdesc_ts_1.fixLinkDescs)(r.pdf, ['int'])).equals(once)).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('a link wrapping an image is described on both of its annotations', async () => {
        const body = `<p><a href="https://x.example/"><img src="${GIF}" alt="a logo"></a></p>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([
            ['https://x.example/', 'a logo'],
            ['https://x.example/', 'a logo'],
        ]);
    }, 90_000);
    (0, bun_test_1.test)('a link that the print hides is reported rather than losing the descriptions in silence', async () => {
        const body = `<p><a href="https://a.example/">visible</a></p>` +
            `<style>@media print{.gone{display:none}}</style>` +
            `<p class="gone"><a href="https://b.example/">hidden in print</a></p>` +
            `<p><a href="https://c.example/">another visible</a></p>`;
        const r = await (0, render_ts_1.render)(browser, { html: DOC(body), author: 't' });
        const f = r.findings.find((x) => x.code === 'link-descriptions-skipped');
        (0, bun_test_1.expect)(f).toBeDefined();
        (0, bun_test_1.expect)(f.severity).toBe('warn');
        (0, bun_test_1.expect)(f.message).toMatch(/2 links/);
        (0, bun_test_1.expect)(f.message).toMatch(/3 descriptions/);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('a document with no links is untouched', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: DOC('<p>plain</p>'), author: 't' });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([]);
    }, 90_000);
    (0, bun_test_1.test)('the repair is idempotent', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p><a href="https://a.example/">alpha</a></p>`),
            author: 't',
        });
        const once = Buffer.from(r.pdf);
        (0, bun_test_1.expect)(Buffer.from((0, linkdesc_ts_1.fixLinkDescs)(r.pdf, ['alpha'])).equals(once)).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('a description list of the wrong length changes nothing', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p><a href="https://a.example/">alpha</a></p>`),
            author: 't',
        });
        (0, bun_test_1.expect)(Buffer.from((0, linkdesc_ts_1.fixLinkDescs)(r.pdf, ['alpha', 'beta'])).equals(Buffer.from(r.pdf))).toBe(true);
        (0, bun_test_1.expect)(Buffer.from((0, linkdesc_ts_1.fixLinkDescs)(r.pdf, [])).equals(Buffer.from(r.pdf))).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('only an object reference dictionary names the annotation', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p><a href="https://a.example/">alpha</a></p>`),
            author: 't',
        });
        const parts = (0, pdfparts_ts_1.trySplit)(r.pdf);
        if (!parts)
            throw new Error('unparseable');
        const link = (0, linkdesc_ts_1.linkOrder)(parts)[0];
        const annots = (0, linkdesc_ts_1.linkAnnotations)(parts, link);
        (0, bun_test_1.expect)(annots).toHaveLength(1);
        const annot = parts.objs.find((o) => o.num === annots[0]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(annot)).toMatch(/\/Subtype \/Link\b/);
    }, 90_000);
    (0, bun_test_1.test)('the page script prefers the visible text, then the image alt, then the address', async () => {
        const tab = await browser.newTab();
        try {
            await tab.send('Page.enable');
            const { frameTree } = (await tab.send('Page.getFrameTree'));
            await tab.send('Page.setDocumentContent', {
                frameId: frameTree.frame.id,
                html: DOC(`<p><a href="https://a.example/">visible</a></p>` +
                    `<p><a href="https://b.example/"><img src="${GIF}" alt="from alt"></a></p>` +
                    `<p><a href="https://c.example/page"><img src="${GIF}"></a></p>` +
                    `<p><a href="https://d.example/empty"></a></p>`),
            });
            await Bun.sleep(200);
            const res = (await tab.send('Runtime.evaluate', {
                expression: linkdesc_ts_1.LINK_DESC_JS,
                returnByValue: true,
                awaitPromise: false,
            }));
            (0, bun_test_1.expect)((0, linkdesc_ts_1.parseLinkDescs)(res.result?.value)).toEqual([
                'visible',
                'from alt',
                'https://c.example/page',
            ]);
        }
        finally {
            await tab.close();
        }
    }, 60_000);
    (0, bun_test_1.test)('a URL containing the word stream is described once, not twice', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: DOC(`<p><a href="https://example.com/stream/latest">x</a></p>`),
            author: 't',
        });
        (0, bun_test_1.expect)(readAnnots(r.pdf)).toEqual([['https://example.com/stream/latest', 'x']]);
        const again = (0, linkdesc_ts_1.fixLinkDescs)(r.pdf, ['x']);
        (0, bun_test_1.expect)(readAnnots(again)).toEqual(readAnnots(r.pdf));
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(again).ok).toBe(true);
    }, 90_000);
});
//# sourceMappingURL=linkdesc.test.js.map