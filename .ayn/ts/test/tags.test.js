"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
let browser;
(0, bun_test_1.beforeAll)(async () => {
    browser = await browser_ts_1.Browser.launch({ profile: await mkdtempProfile() });
}, 60_000);
async function mkdtempProfile() {
    const { mkdtemp } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
    const { tmpdir } = await Promise.resolve().then(() => __importStar(require('node:os')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    return mkdtemp(join(tmpdir(), 'letterpress-tags-'));
}
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
});
async function roles(html) {
    const r = await (0, render_ts_1.render)(browser, {
        html: `<!doctype html><html lang="en"><meta charset="utf-8">${html}`,
    });
    const text = Buffer.from(r.pdf).toString('latin1');
    const out = [];
    for (const m of text.matchAll(/(?:^|[^0-9])\d+ \d+ obj\b([\s\S]*?)endobj/g)) {
        if (!/\/Type\s*\/StructElem/.test(m[1]))
            continue;
        const s = /\/S\s*\/(\w+)/.exec(m[1]);
        if (s && s[1] !== 'Document')
            out.push(s[1]);
    }
    return out;
}
(0, bun_test_1.describe)('semantic elements are tagged with their own roles', () => {
    const cases = [
        ['h1', '<h1>One</h1>', 'H1'],
        ['h2', '<h2>Two</h2>', 'H2'],
        ['h3', '<h3>Three</h3>', 'H3'],
        ['h4', '<h4>Four</h4>', 'H4'],
        ['h5', '<h5>Five</h5>', 'H5'],
        ['h6', '<h6>Six</h6>', 'H6'],
        ['p', '<p>A paragraph.</p>', 'P'],
        ['ul and li', '<ul><li>one</li></ul>', 'LI'],
        ['ol', '<ol><li>first</li></ol>', 'L'],
        ['blockquote', '<blockquote>quoted</blockquote>', 'BlockQuote'],
        ['strong', '<p><strong>bold</strong></p>', 'Strong'],
        ['em', '<p><em>italic</em></p>', 'Em'],
        ['code', '<pre><code>x = 1</code></pre>', 'Code'],
        ['a href', `<p><a href="https://example.test">link</a></p>`, 'Link'],
        ['article', '<article>body</article>', 'Art'],
        ['aside', '<aside>note</aside>', 'Aside'],
    ];
    for (const [name, html, role] of cases) {
        (0, bun_test_1.test)(`<${name}> is tagged ${role}`, async () => {
            (0, bun_test_1.expect)(await roles(html)).toContain(role);
        });
    }
    (0, bun_test_1.test)('a heading nested inside a list item keeps its heading role', async () => {
        (0, bun_test_1.expect)(await roles('<ul><li><h1>Item</h1></li></ul>')).toContain('H1');
    });
    (0, bun_test_1.test)('a heading split across spans is still one heading', async () => {
        const r = await roles('<h1><span>Split</span> <span>Heading</span></h1><p>body</p>');
        (0, bun_test_1.expect)(r).toContain('H1');
        (0, bun_test_1.expect)(r).toContain('P');
    });
    (0, bun_test_1.test)('a table is tagged with its structure', async () => {
        const r = await roles('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>');
        for (const role of ['Table', 'TR', 'TH', 'TD'])
            (0, bun_test_1.expect)(r).toContain(role);
    });
    (0, bun_test_1.test)('a figure with a caption is tagged', async () => {
        const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const r = await roles(`<figure><img src="${px}" alt="x" width="10" height="10"><figcaption>cap</figcaption></figure>`);
        (0, bun_test_1.expect)(r).toContain('Figure');
        (0, bun_test_1.expect)(r).toContain('Caption');
    });
});
(0, bun_test_1.describe)('elements with no semantics are tagged NonStruct, which is correct', () => {
    (0, bun_test_1.test)('a div is NonStruct', async () => {
        (0, bun_test_1.expect)(await roles('<div>text</div>')).toContain('NonStruct');
    });
    (0, bun_test_1.test)('a span is NonStruct', async () => {
        (0, bun_test_1.expect)(await roles('<p><span>inner</span></p>')).toContain('NonStruct');
    });
    (0, bun_test_1.test)('a document of only divs and spans yields no heading or paragraph role', async () => {
        const r = await roles('<section><div><span>Name</span></div><div><span>Role</span></div></section>' +
            '<div><ul><li>a</li><li>b</li></ul></div>');
        (0, bun_test_1.expect)(r.filter((x) => /^H\d/.test(x))).toEqual([]);
        (0, bun_test_1.expect)(r).not.toContain('P');
        (0, bun_test_1.expect)(r).toContain('LI');
    });
});
(0, bun_test_1.describe)('chromium tagging gaps are closed by the roles repair', () => {
    (0, bun_test_1.test)('a description list is retagged as a list with items', async () => {
        const r = await roles('<dl><dt>term</dt><dd>definition</dd></dl>');
        (0, bun_test_1.expect)(r.length, 'the document produced structure elements').toBeGreaterThan(0);
        (0, bun_test_1.expect)(r).toContain('L');
        (0, bun_test_1.expect)(r).toContain('LI');
    });
    (0, bun_test_1.test)('sectioning elements become region containers', async () => {
        for (const [html, role] of [
            ['<section><p>x</p></section>', 'Sect'],
            ['<nav>link</nav>', 'Sect'],
            ['<main>body</main>', 'Part'],
            ['<header>head</header>', 'Part'],
            ['<footer>foot</footer>', 'Part'],
        ]) {
            const r = await roles(html);
            (0, bun_test_1.expect)(r.length, `${html} produced structure elements`).toBeGreaterThan(0);
            (0, bun_test_1.expect)(r).toContain(role);
        }
    });
    (0, bun_test_1.test)('elements chromium types itself are left alone by the roles repair', async () => {
        for (const html of ['<article>wrote in prose</article>', '<aside>wrote in prose</aside>']) {
            const r = await (0, render_ts_1.render)(browser, {
                html: `<!doctype html><html lang="en"><meta charset="utf-8">${html}`,
            });
            (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'role-retagged')).toBeUndefined();
        }
    });
});
(0, bun_test_1.describe)('the tree is structurally sound', () => {
    (0, bun_test_1.test)('the catalog marks the document and names a tree root', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: '<!doctype html><h1>T</h1><p>x</p>' });
        (0, bun_test_1.expect)(r.info.tagged).toBe(true);
        const text = Buffer.from(r.pdf).toString('latin1');
        (0, bun_test_1.expect)(text).toContain('/Type /StructTreeRoot');
        (0, bun_test_1.expect)(text).toContain('/Type /MarkInfo');
        (0, bun_test_1.expect)(text).toContain('/Marked true');
    });
    (0, bun_test_1.test)('the language reaches both the catalog and the document element', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: `<!doctype html><html lang="fr"><h1>T</h1>` });
        const text = Buffer.from(r.pdf).toString('latin1');
        const objs = new Map();
        for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
            objs.set(Number(m[1]), m[2]);
        }
        const catalog = objs.get(Number(/\/Root (\d+) 0 R/.exec(text)[1]));
        (0, bun_test_1.expect)(/\/Lang \((fr[^)]*)\)/.exec(catalog)).not.toBeNull();
        const doc = objs.get(Number(/\/K\s+(\d+) 0 R/.exec(objs.get(Number(/\/StructTreeRoot (\d+) 0 R/.exec(catalog)[1])))[1]));
        (0, bun_test_1.expect)(/\/S \/Document/.test(doc)).toBe(true);
        (0, bun_test_1.expect)(/\/Lang \(fr\)/.test(doc)).toBe(true);
    });
    (0, bun_test_1.test)('every structure element resolves and every parent points back', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: '<!doctype html><h1>T</h1><p>one</p><ul><li>a</li></ul><h2>S</h2><p>two</p>',
        });
        const text = Buffer.from(r.pdf).toString('latin1');
        const objs = new Map();
        for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
            objs.set(Number(m[1]), m[2]);
        }
        const rootNum = Number(/\/Root (\d+) 0 R/.exec(text)[1]);
        const root = objs.get(rootNum);
        (0, bun_test_1.expect)(root).toContain('/StructTreeRoot');
        const treeRootNum = Number(/\/StructTreeRoot (\d+) 0 R/.exec(root)[1]);
        const treeRoot = objs.get(treeRootNum);
        (0, bun_test_1.expect)(treeRoot).toContain('/Type /StructTreeRoot');
        (0, bun_test_1.expect)(treeRoot).toContain('/ParentTree');
        const childrenOf = (body) => {
            const arr = /\/K\s*\[([^\]]*)\]/.exec(body);
            if (arr)
                return [...arr[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
            const one = /\/K\s+(\d+)\s+0\s+R/.exec(body);
            return one ? [Number(one[1])] : [];
        };
        const seen = new Set();
        const walk = (n, parent) => {
            (0, bun_test_1.expect)(seen.has(n)).toBe(false);
            seen.add(n);
            const body = objs.get(n);
            (0, bun_test_1.expect)(body).toBeDefined();
            if (parent !== null) {
                const p = /\/P\s+(\d+)\s+0\s+R/.exec(body);
                (0, bun_test_1.expect)(p).not.toBeNull();
                (0, bun_test_1.expect)(Number(p[1])).toBe(parent);
            }
            for (const k of childrenOf(body))
                walk(k, n);
        };
        const docChild = Number(/\/K\s+(\d+) 0 R/.exec(treeRoot)[1]);
        walk(docChild, null);
        (0, bun_test_1.expect)(seen.size).toBeGreaterThan(5);
    });
    (0, bun_test_1.test)('every parent tree key names an element that exists', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: '<!doctype html><h1>T</h1><p>one</p><ul><li>a</li></ul><p>two</p>',
        });
        const text = Buffer.from(r.pdf).toString('latin1');
        const objs = new Map();
        for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
            objs.set(Number(m[1]), m[2]);
        }
        const catalog = objs.get(Number(/\/Root (\d+) 0 R/.exec(text)[1]));
        const treeRoot = objs.get(Number(/\/StructTreeRoot (\d+) 0 R/.exec(catalog)[1]));
        (0, bun_test_1.expect)(treeRoot).toContain('/ParentTreeNextKey');
        const ptNum = Number(/\/ParentTree (\d+) 0 R/.exec(treeRoot)[1]);
        const pt = objs.get(ptNum);
        const refs = [...pt.matchAll(/(\d+) 0 R/g)];
        (0, bun_test_1.expect)(refs.length, 'the parent tree named no objects').toBeGreaterThan(0);
        for (const m of refs) {
            (0, bun_test_1.expect)(objs.get(Number(m[1]))).toBeDefined();
        }
    });
});
//# sourceMappingURL=tags.test.js.map