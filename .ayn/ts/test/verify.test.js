"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const meta_ts_1 = require("../src/meta.ts");
const fontdesc_ts_1 = require("../src/fontdesc.ts");
const tounicode_ts_1 = require("../src/tounicode.ts");
const verify_ts_1 = require("../src/verify.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const poppler_ts_1 = require("./poppler.ts");
const LATIN1 = 'latin1';
function same(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
function fixture() {
    const streams = [
        'BT /F1 12 Tf 10 100 Td (page one) Tj ET',
        'BT /F1 12 Tf 10 100 Td (page two) Tj ET',
    ];
    return (0, fixtures_ts_1.assemblePdf)([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R >>',
        '<< /Title (Fixture) /Producer (Skia/PDF m154) >>',
        ...streams.map((s) => ({
            dict: `<< /Length ${s.length} >>`,
            payload: Buffer.from(s, LATIN1),
        })),
    ], {
        endobj: '\nendobj\n',
        trailer: (size, xrefAt) => `trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    });
}
function movesGlyphs(pdf) {
    const text = Buffer.from(pdf).toString(LATIN1);
    return Buffer.from(text.replace('(page one)', '(page ONE)'), LATIN1);
}
function breaksXref(pdf) {
    const text = Buffer.from(pdf).toString(LATIN1);
    const bad = text.replace(/startxref\n(\d+)/, (_m, at) => `startxref\n${Number(at) + 7}`);
    return Buffer.from(bad.replace(/\n(\d{10}) 00000 n \n/, (_m, off) => `\n${String(Number(off) + 3).padStart(10, '0')} 00000 n \n`), LATIN1);
}
(0, bun_test_1.describe)('verify', () => {
    (0, bun_test_1.test)('a whole file passes', () => {
        const r = (0, verify_ts_1.verify)(fixture());
        (0, bun_test_1.expect)(r.failures).toEqual([]);
        (0, bun_test_1.expect)(r.ok).toBe(true);
    });
    (0, bun_test_1.test)('two startxref lines are refused', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const two = Buffer.from(text.replace(/startxref/, '\nstartxref\n0'), LATIN1);
        const r = (0, verify_ts_1.verify)(two);
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/startxref/);
    });
    (0, bun_test_1.test)('a startxref pointing at the wrong place is refused', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const at = text.search(/startxref\n(\d+)/);
        const broken = Buffer.from(text.slice(0, at) + text.slice(at).replace(/startxref\n\d+/, 'startxref\n999999'), LATIN1);
        const r = (0, verify_ts_1.verify)(broken);
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/does not point/);
    });
    (0, bun_test_1.test)('a reference to an object that does not exist is refused', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const broken = Buffer.from(text.replace('/Contents 6 0 R', '/Contents 99 0 R'), LATIN1);
        const r = (0, verify_ts_1.verify)(broken);
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/does not exist/);
    });
    (0, bun_test_1.test)('a stream whose /Length disagrees with its payload is refused', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const broken = Buffer.from(text.replace('/Length 39', '/Length 99'), LATIN1);
        const r = (0, verify_ts_1.verify)(broken);
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/Length/);
    });
    (0, bun_test_1.test)('a file that is not a linear pdf fails rather than passing silently', () => {
        const r = (0, verify_ts_1.verify)(Buffer.from('not a pdf at all'));
        (0, bun_test_1.expect)(r.ok).toBe(false);
    });
    (0, bun_test_1.test)('a reference inside a literal string is not a reference', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const withAlt = Buffer.from(text.replace('/Contents 6 0 R', '/Alt (see object 999 0 R) /Contents 6 0 R'), LATIN1);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(withAlt).failures.join(' ')).not.toMatch(/does not exist/);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(Buffer.from(fixture())).failures).toEqual([]);
    });
    (0, bun_test_1.test)('a reference inside a stream payload is not a reference', () => {
        const payload = Buffer.from('<x>see object 999 0 R</x>', LATIN1);
        const text = Buffer.from(fixture()).toString(LATIN1);
        const added = `9 0 obj
<< /Length ${payload.length} >>
stream
${payload.toString(LATIN1)}
endstream
endobj
`;
        const r = (0, verify_ts_1.verify)(Buffer.from(text.replace('trailer', added + 'trailer'), LATIN1));
        (0, bun_test_1.expect)(r.failures.join(' ')).not.toMatch(/does not exist/);
    });
    (0, bun_test_1.test)('a genuine dangling reference is still refused with the scan narrowed', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const broken = Buffer.from(text.replace('/Contents 6 0 R', '/Contents 99 0 R'), LATIN1);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(broken).ok).toBe(false);
    });
    (0, bun_test_1.test)('/Length is read past a string carrying the word stream', () => {
        const text = Buffer.from(fixture()).toString(LATIN1);
        const hidden = Buffer.from(text.replace('/Length 39', '/Producer (upstream) /Length 39'), LATIN1);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(hidden).ok).toBe(false);
    });
});
(0, bun_test_1.describe)('content survived', () => {
    (0, bun_test_1.test)("contentPayloads finds every page's stream", () => {
        (0, bun_test_1.expect)((0, verify_ts_1.contentPayloads)(fixture())).toHaveLength(2);
    });
    (0, bun_test_1.test)('a repair that moves a glyph is caught, and structure cannot', () => {
        const original = fixture();
        const moved = movesGlyphs(original);
        const structureOnly = (0, verify_ts_1.verify)(moved);
        (0, bun_test_1.expect)(structureOnly.ok).toBe(true);
        const withOriginal = (0, verify_ts_1.verify)(moved, original);
        (0, bun_test_1.expect)(withOriginal.ok).toBe(false);
        (0, bun_test_1.expect)(withOriginal.failures.join(' ')).toMatch(/content stream 1 was rewritten/);
    });
    (0, bun_test_1.test)('a repair that changes nothing outside the content stream passes', () => {
        const original = fixture();
        const described = (0, fontdesc_ts_1.fixFontDescriptors)((0, meta_ts_1.addMetadata)(original, { author: 'A Person' }));
        const r = (0, verify_ts_1.verify)(described, original);
        (0, bun_test_1.expect)(r.failures).toEqual([]);
        (0, bun_test_1.expect)(r.ok).toBe(true);
    });
    (0, bun_test_1.test)('a page pointing at a different stream is caught', () => {
        const original = fixture();
        const text = Buffer.from(original).toString(LATIN1);
        const swapped = Buffer.from(text
            .replace('/Contents 6 0 R', '/Contents \x00 R')
            .replace('/Contents 7 0 R', '/Contents 6 0 R')
            .replace('/Contents \x00 R', '/Contents 7 0 R'), LATIN1);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(swapped).ok).toBe(true);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(swapped, original).ok).toBe(false);
    });
});
(0, bun_test_1.describe)('repairOrKeep', () => {
    (0, bun_test_1.test)('a repair that is already a no-op is not treated as applied', () => {
        const original = fixture();
        const r = (0, verify_ts_1.repairOrKeep)(original, (p) => p);
        (0, bun_test_1.expect)(r.applied).toBe(false);
        (0, bun_test_1.expect)(r.failures).toEqual([]);
        (0, bun_test_1.expect)(r.pdf).toBe(original);
    });
    (0, bun_test_1.test)('a good repair is kept', () => {
        const original = fixture();
        const r = (0, verify_ts_1.repairOrKeep)(original, (p) => (0, meta_ts_1.addMetadata)(p, { author: 'A Person' }));
        (0, bun_test_1.expect)(r.applied).toBe(true);
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBe('A Person');
    });
    (0, bun_test_1.test)('a repair that moves a glyph is discarded and the original kept', () => {
        const original = fixture();
        const r = (0, verify_ts_1.repairOrKeep)(original, movesGlyphs);
        (0, bun_test_1.expect)(r.applied).toBe(false);
        (0, bun_test_1.expect)(r.failures.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(same(r.pdf, original)).toBe(true);
    });
    (0, bun_test_1.test)('a repair that throws is discarded rather than propagated', () => {
        const original = fixture();
        const r = (0, verify_ts_1.repairOrKeep)(original, () => {
            throw new Error('boom');
        });
        (0, bun_test_1.expect)(r.applied).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/threw/);
        (0, bun_test_1.expect)(same(r.pdf, original)).toBe(true);
    });
    (0, bun_test_1.test)('a repair that breaks the file is discarded', () => {
        const original = fixture();
        const broken = breaksXref(original);
        (0, bun_test_1.expect)(same(broken, original), 'the corruption helper changed nothing').toBe(false);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(broken).ok, 'the corrupted file should not verify').toBe(false);
        const r = (0, verify_ts_1.repairOrKeep)(original, (p) => breaksXref(p));
        (0, bun_test_1.expect)(r.applied).toBe(false);
        (0, bun_test_1.expect)(same(r.pdf, original)).toBe(true);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/xref|startxref/i);
    });
    (0, bun_test_1.test)('truncating the file is caught', () => {
        const original = fixture();
        const r = (0, verify_ts_1.repairOrKeep)(original, (p) => p.subarray(0, Math.floor(p.length / 2)));
        (0, bun_test_1.expect)(r.applied).toBe(false);
        (0, bun_test_1.expect)(r.failures.length).toBeGreaterThan(0);
    });
});
(0, bun_test_1.describe)('a document a reader would open', () => {
    (0, bun_test_1.test)('a cross-reference stream is a cross-reference table', () => {
        const head = '%PDF-1.5\n';
        const body = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
        const xref = '2 0 obj\n<< /Type /XRef /Size 3 /Root 1 0 R >>\nendobj\n';
        const text = `${head}${body}${xref}startxref\n${head.length + body.length}\n%%EOF\n`;
        const result = (0, verify_ts_1.verify)(new Uint8Array(Buffer.from(text, 'latin1')));
        (0, bun_test_1.expect)(result.failures.filter((f) => f.includes('startxref'))).toEqual([]);
    });
    (0, bun_test_1.test)('a file that has been updated is read at its last pointer', () => {
        const once = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
            'trailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n9\n%%EOF\n';
        const result = (0, verify_ts_1.verify)(new Uint8Array(Buffer.from(once + once, 'latin1')));
        (0, bun_test_1.expect)(result.ok).toBe(true);
    });
});
(0, bun_test_1.describe)('the gate in the render path', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-gate-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    (0, bun_test_1.test)('dropping any single object from a rendered document is caught', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>
        <h1>Report</h1><p>Body text that wraps onto more than one line.</p>`,
            author: 'Someone',
        });
        const parts = (0, pdfparts_ts_1.split)(Buffer.from(r.pdf));
        (0, bun_test_1.expect)(parts.objs.length, 'the fixture has too few objects to mean anything').toBeGreaterThan(10);
        const missed = [];
        for (const o of parts.objs) {
            const dropped = (0, pdfparts_ts_1.join)(parts.head, parts.objs.filter((x) => x.num !== o.num), parts.trailer);
            const v = (0, verify_ts_1.verify)(dropped);
            if (v.ok)
                missed.push(String(o.num));
            else if (!v.failures.some((f) => f.startsWith('a reference to object'))) {
                missed.push(`${o.num} (${v.failures[0]})`);
            }
        }
        (0, bun_test_1.expect)(missed, `verify accepted a document missing objects: ${missed.join(', ')}`).toEqual([]);
    }, 60_000);
    (0, bun_test_1.test)('an ordinary render is verified and reported intact', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><h1>H</h1><p>office efficient flags finished</p>`,
            author: 'A Person',
        });
        (0, bun_test_1.expect)(r.findings.filter((f) => f.code === 'repair-rejected')).toEqual([]);
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBe('A Person');
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
    });
    (0, bun_test_1.test)('the shipped file always passes its own checks', async () => {
        for (const html of [
            `<p>plain</p>`,
            `<p style="font-family:serif">office efficient finished</p>`,
            `<p style="font-family:monospace">office</p>`,
            `<p>你好世界</p>`,
            `<p></p>`,
        ]) {
            const r = await (0, render_ts_1.render)(browser, {
                html: `<!doctype html><meta charset="utf-8">${html}`,
            });
            const v = (0, verify_ts_1.verify)(r.pdf);
            (0, bun_test_1.expect)(v.failures).toEqual([]);
        }
    });
    (0, bun_test_1.test)('every repair is a function of its input, on a real render', async () => {
        for (const style of ['', 'font-family:serif', 'font-weight:700', 'font-style:italic']) {
            const r = await (0, render_ts_1.render)(browser, {
                html: `<!doctype html><meta charset="utf-8"><p style="${style}">office efficient different flags finished</p>`,
            });
            (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
            (0, bun_test_1.expect)(same((0, tounicode_ts_1.fixToUnicode)(r.pdf), r.pdf)).toBe(true);
            (0, bun_test_1.expect)(same((0, fontdesc_ts_1.fixFontDescriptors)(r.pdf), r.pdf)).toBe(true);
        }
    }, 120_000);
    (0, bun_test_1.test)('the repairs still do their work', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><p>office efficient</p>`,
            author: 'Someone',
        });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBe('Someone');
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(text).not.toMatch(/\/CapHeight -/);
    });
    (0, bun_test_1.describe)('split and join round-trip a real render', () => {
        const DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Round trip</title>
<style>@page { size: A4; margin: 15mm }
body { font-family: 'Noto Serif', serif }
code { font-family: 'Noto Sans Mono', monospace }
td { border: 0.5pt solid #999 }</style></head><body>
<h1>Heading</h1><p>Some prose with a <a href="https://example.com/">link</a> in it.</p>
<table>${Array.from({ length: 30 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>value ${i}</td></tr>`).join('')}</table>
</body></html>`;
        (0, bun_test_1.test)('every object and the trailer survive unchanged, and the result still reads', async () => {
            const r = await (0, render_ts_1.render)(browser, { html: DOC, author: 'round trip' });
            const parts = (0, pdfparts_ts_1.split)(Buffer.from(r.pdf));
            const rejoined = (0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer);
            const before = new Map(parts.objs.map((o) => [o.num, o.bytes]));
            const after = (0, pdfparts_ts_1.split)(rejoined);
            (0, bun_test_1.expect)(after?.objs.length).toBe(parts.objs.length);
            for (const o of after?.objs ?? []) {
                (0, bun_test_1.expect)(before.get(o.num)?.equals(o.bytes)).toBe(true);
            }
            (0, bun_test_1.expect)(parts.trailer.equals(after?.trailer ?? Buffer.alloc(0))).toBe(true);
            (0, bun_test_1.expect)((0, verify_ts_1.verify)(rejoined).ok).toBe(true);
            (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(rejoined)).pages).toBe((await (0, poppler_ts_1.pdfInfo)(Buffer.from(r.pdf))).pages);
        }, 120_000);
    });
});
(0, bun_test_1.describe)('an indirect /Length', () => {
    const PAYLOAD = 'BT /F1 12 Tf (hi) Tj ET';
    const mk = (extra, len) => (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', LATIN1), [
        {
            num: 1,
            bytes: Buffer.from('1 0 obj\n<</Type /Catalog /Pages 2 0 R >>\nendobj\n', LATIN1),
        },
        {
            num: 2,
            bytes: Buffer.from('2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', LATIN1),
        },
        {
            num: 3,
            bytes: Buffer.from('3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n', LATIN1),
        },
        {
            num: 4,
            bytes: Buffer.from(`4 0 obj\n<</Length ${len}>>\nstream\n${PAYLOAD}\nendstream\nendobj\n`, LATIN1),
        },
        ...extra,
    ], Buffer.from('trailer\n<</Root 1 0 R /Size 9 >>\n', LATIN1));
    (0, bun_test_1.test)('an indirect /Length that is correct passes', () => {
        const pdf = mk([
            {
                num: 9,
                bytes: Buffer.from(`9 0 obj\n${PAYLOAD.length}\nendobj\n`, LATIN1),
            },
        ], '9 0 R');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
    });
    (0, bun_test_1.test)('an indirect /Length that lies is caught', () => {
        const pdf = mk([{ num: 9, bytes: Buffer.from('9 0 obj\n999\nendobj\n', LATIN1) }], '9 0 R');
        const r = (0, verify_ts_1.verify)(pdf);
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/via object 9 but carries 23 bytes/);
    });
    (0, bun_test_1.test)('an indirect /Length pointing at nothing is caught', () => {
        const r = (0, verify_ts_1.verify)(mk([], '9 0 R'));
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/does not exist|which is not in the file/);
    });
    (0, bun_test_1.test)('a direct /Length that lies is still caught', () => {
        const r = (0, verify_ts_1.verify)(mk([], '21'));
        (0, bun_test_1.expect)(r.ok).toBe(false);
        (0, bun_test_1.expect)(r.failures.join(' ')).toMatch(/declares \/Length 21 but carries 23 bytes/);
    });
});
//# sourceMappingURL=verify.test.js.map