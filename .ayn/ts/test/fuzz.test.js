"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const fuzz_ts_1 = require("../tools/fuzz.ts");
const fuzzpdf_ts_1 = require("../tools/fuzzpdf.ts");
const render_ts_1 = require("../src/render.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const browser_ts_1 = require("./browser.ts");
const hasGhostscript = await (0, fuzzpdf_ts_1.ghostscriptOk)();
let t;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('fuzz');
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
(0, bun_test_1.test)('fifteen fixed documents hold the render contract', async () => {
    for (let i = 0; i < 15; i++) {
        const { html } = (0, fuzz_ts_1.document)(20261013, i);
        const res = await (0, fuzz_ts_1.fuzzOne)(t.browser, 20261013, i, html);
        (0, bun_test_1.expect)(res.ok, `seed 20261013 doc ${i}: ${res.reason}\n${html.slice(0, 600)}`).toBe(true);
        (0, bun_test_1.expect)(res.pages).toBeGreaterThan(0);
    }
}, 240_000);
(0, bun_test_1.test)('every repair holds its contract on mutated files', async () => {
    const r1 = await (0, render_ts_1.render)(t.browser, {
        html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>The official fish fills five.</p>`,
        author: 'fuzz',
    });
    const r2 = await (0, render_ts_1.render)(t.browser, {
        html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}table,td{border:1pt solid #999}</style><table><tr><td>a</td><td>b</td></tr></table>`,
        author: 'fuzz',
    });
    const r = (0, fuzz_ts_1.rng)(4242);
    let checked = 0;
    for (const src of [r1.pdf, r2.pdf]) {
        for (let i = 0; i < 40; i++) {
            const { bytes, name } = (0, fuzzpdf_ts_1.mutate)(r, src, Math.floor(r() * 6));
            for (const repair of fuzzpdf_ts_1.REPAIRS) {
                const res = (0, fuzzpdf_ts_1.fuzzRepair)(repair, bytes);
                (0, bun_test_1.expect)(res.ok, `${repair.name} on ${name} mutant of ${bytes.length} bytes: ${res.reason}`).toBe(true);
                checked++;
            }
        }
    }
    (0, bun_test_1.expect)(checked).toBe(2 * 40 * fuzzpdf_ts_1.REPAIRS.length);
}, 120_000);
(0, bun_test_1.test)('exotic files pass through every repair byte-identical', async () => {
    const dir = (0, node_path_1.join)(import.meta.dir, 'data');
    const cases = [
        { file: 'linearized.pdf', kind: 'linearized', marker: /\/Linearized\b/ },
        { file: 'encrypted-r3.pdf', kind: 'encrypted', marker: /\/Encrypt\b/ },
    ];
    for (const { file, kind, marker } of cases) {
        const bytes = new Uint8Array(await Bun.file((0, node_path_1.join)(dir, file)).arrayBuffer());
        (0, bun_test_1.expect)(bytes.length, `${file} is empty`).toBeGreaterThan(100);
        const text = Buffer.from(bytes).toString('latin1');
        (0, bun_test_1.expect)(marker.test(text), `${file} lost its shape`).toBe(true);
        const res = (0, fuzzpdf_ts_1.fuzzExoticFile)({ kind, detail: file, bytes });
        (0, bun_test_1.expect)(res.failures, `${file}: ${res.failures.join('; ')}`).toEqual([]);
    }
});
(0, bun_test_1.describe)('harness units (no browser)', () => {
    (0, bun_test_1.test)('rng is deterministic per seed and varies across seeds', () => {
        const a = (0, fuzz_ts_1.rng)(7);
        const seq = [a(), a(), a()];
        const b = (0, fuzz_ts_1.rng)(7);
        (0, bun_test_1.expect)([b(), b(), b()]).toEqual(seq);
        const c = (0, fuzz_ts_1.rng)(8);
        (0, bun_test_1.expect)(c()).not.toBe(seq[0]);
    });
    (0, bun_test_1.test)('documents are complete HTML with a head, blocks and tail', () => {
        const { html, head, tail, blocks } = (0, fuzz_ts_1.document)(99, 3);
        (0, bun_test_1.expect)(html.startsWith('<!doctype html>')).toBe(true);
        (0, bun_test_1.expect)(html.endsWith('</body></html>')).toBe(true);
        (0, bun_test_1.expect)(html).toBe(head + blocks.join('\n') + tail);
    });
    (0, bun_test_1.test)('every mutation kind returns named bytes without throwing', () => {
        const src = Buffer.from('%PDF-1.4\n1 0 obj\n<< /A 1 >>\nendobj\ntrailer\n<< /Size 2 >>\n');
        const r = (0, fuzz_ts_1.rng)(11);
        const names = new Set();
        for (let kind = 0; kind < 6; kind++) {
            const { bytes, name } = (0, fuzzpdf_ts_1.mutate)(r, src, kind);
            (0, bun_test_1.expect)(name.length).toBeGreaterThan(0);
            (0, bun_test_1.expect)(bytes.length).toBeGreaterThan(0);
            names.add(name);
        }
        (0, bun_test_1.expect)(names.size).toBe(6);
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.mutate)(r, new Uint8Array(0), 0).bytes.length).toBe(0);
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.mutate)(r, new Uint8Array(0), 3).bytes.length).toBe(0);
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.mutate)(r, Buffer.from('x'), 1).bytes.length).toBe(1);
    });
    (0, bun_test_1.test)('fuzzRepair names a throw, an emptying and a corruption', () => {
        const pdf = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
        ]);
        const throwing = {
            name: 'boom',
            run: (_p) => {
                throw new Error('nope');
            },
        };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(throwing, pdf).ok).toBe(false);
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(throwing, pdf).reason).toContain('threw');
        const emptying = { name: 'void', run: (_p) => new Uint8Array(0) };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(emptying, pdf).ok).toBe(false);
        const corrupting = {
            name: 'rot',
            run: (p) => {
                const b = Buffer.from(p);
                b[20] = 0x58;
                return b;
            },
        };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(corrupting, pdf).ok).toBe(false);
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(corrupting, pdf).reason).toContain('corrupted a valid file');
        const keeping = { name: 'same', run: (p) => p };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzRepair)(keeping, pdf).ok).toBe(true);
    });
    (0, bun_test_1.test)('fuzzExoticFile names a throw, an emptying and a rewrite', () => {
        const pdf = (0, fixtures_ts_1.assemblePdf)(['<< /Type /Catalog /Pages 2 0 R >>']);
        const file = { kind: 'encrypted', detail: 'unit', bytes: pdf };
        const throwing = {
            name: 'boom',
            run: (_p) => {
                throw new Error('nope');
            },
        };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzExoticFile)(file, [throwing]).failures.join(';')).toContain('threw');
        const emptying = { name: 'void', run: (_p) => new Uint8Array(0) };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzExoticFile)(file, [emptying]).failures.join(';')).toContain('emptied');
        const keeping = { name: 'same', run: (p) => p };
        (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzExoticFile)(file, [keeping]).failures).toEqual([]);
    });
    (0, bun_test_1.test)('checkFindings rejects malformed findings and unknown severities', () => {
        (0, bun_test_1.expect)((0, fuzz_ts_1.checkFindings)([{ code: 'x', severity: 'warn', message: 'm' }])).toBeUndefined();
        (0, bun_test_1.expect)((0, fuzz_ts_1.checkFindings)([{ code: '', severity: 'warn', message: 'm' }])).toContain('malformed');
        (0, bun_test_1.expect)((0, fuzz_ts_1.checkFindings)([{ code: 'x', severity: 'warn', message: '' }])).toContain('malformed');
        const bogus = { code: 'x', severity: 'bogus', message: 'm' };
        (0, bun_test_1.expect)((0, fuzz_ts_1.checkFindings)([bogus])).toContain('unknown severity');
    });
    bun_test_1.test.skipIf(!hasGhostscript)('ghostscript producer yields both shapes', async () => {
        const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-fuzzexotic-'));
        try {
            const base = (0, fixtures_ts_1.assemblePdf)([
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
            ]);
            const files = await (0, fuzzpdf_ts_1.exoticCorpus)([base], dir);
            (0, bun_test_1.expect)(files.length).toBeGreaterThan(0);
            (0, bun_test_1.expect)(files.some((f) => f.kind === 'linearized')).toBe(true);
            (0, bun_test_1.expect)(files.some((f) => f.kind === 'encrypted')).toBe(true);
            for (const f of files) {
                (0, bun_test_1.expect)((0, fuzzpdf_ts_1.fuzzExoticFile)(f).failures).toEqual([]);
            }
        }
        finally {
            await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
        }
    }, 120_000);
});
//# sourceMappingURL=fuzz.test.js.map