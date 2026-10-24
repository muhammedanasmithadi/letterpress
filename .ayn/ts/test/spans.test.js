"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_zlib_1 = require("node:zlib");
const bun_test_1 = require("bun:test");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const render_ts_1 = require("../src/render.ts");
const spans_ts_1 = require("../src/spans.ts");
const verify_ts_1 = require("../src/verify.ts");
const browser_ts_1 = require("./browser.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const poppler_ts_1 = require("./poppler.ts");
let t;
let browser;
(0, bun_test_1.beforeAll)(async () => {
    t = await (0, browser_ts_1.launchTestBrowser)('spans');
    browser = t.browser;
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, browser_ts_1.closeTestBrowser)(t);
}, 20_000);
function streams(pdf) {
    let out = '';
    for (const o of (0, pdfparts_ts_1.trySplit)(pdf).objs) {
        const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
        if (!range)
            continue;
        const raw = o.bytes.subarray(range.start, range.end);
        try {
            out += (0, node_zlib_1.inflateSync)(raw).toString('latin1');
        }
        catch { }
    }
    return out;
}
const squashText = (s) => s.replace(/\s+/g, ' ').trim();
function marked(pdf) {
    const text = streams(pdf);
    const count = (re) => (text.match(re) ?? []).length;
    return {
        bdc: count(/\bBDC\b/g),
        emc: count(/\bEMC\b/g),
        actualText: count(/\/ActualText/g),
    };
}
const PROSE = `<!doctype html><style>@page{size:A4;margin:15mm}
  body { font: 11pt "Noto Serif" }</style>
  <p>${'Body text that fills a line and wraps with specific workflows. '.repeat(18)}</p>`;
(0, bun_test_1.test)('the repair removes the spans and changes no character', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: PROSE,
        author: 'spans',
        keepLigatureSpans: true,
        timeoutMs: 120_000,
    });
    const before = await (0, poppler_ts_1.pdfText)(r.pdf);
    (0, bun_test_1.expect)(before.toLowerCase()).toContain('fills');
    (0, bun_test_1.expect)(before.toLowerCase()).toContain('specific');
    const out = (0, spans_ts_1.stripRedundantSpans)(r.pdf);
    (0, bun_test_1.expect)(out.stats.seen).toBeGreaterThan(0);
    (0, bun_test_1.expect)(out.stats.stripped).toBeGreaterThan(0);
    (0, bun_test_1.expect)((0, verify_ts_1.verify)(out.pdf).ok).toBe(true);
    const squash = (s) => s.replace(/\s+/g, ' ').trim();
    (0, bun_test_1.expect)(squash(await (0, poppler_ts_1.pdfText)(out.pdf))).toBe(squash(before));
}, 240_000);
(0, bun_test_1.test)('marked content is left balanced', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: PROSE,
        author: 'spans',
        keepLigatureSpans: true,
        timeoutMs: 120_000,
    });
    const out = (0, spans_ts_1.stripRedundantSpans)(r.pdf);
    const counts = marked(out.pdf);
    (0, bun_test_1.expect)({ bdc: counts.bdc, emc: counts.emc }).toEqual({ bdc: counts.bdc, emc: counts.bdc });
}, 240_000);
(0, bun_test_1.test)('a span whose text the font does not also give is kept', async () => {
    const r = await (0, render_ts_1.render)(browser, {
        html: PROSE,
        author: 'spans',
        keepLigatureSpans: true,
        timeoutMs: 120_000,
    });
    const out = (0, spans_ts_1.stripRedundantSpans)(r.pdf);
    (0, bun_test_1.expect)(marked(out.pdf).actualText).toBe(out.stats.kept);
}, 240_000);
(0, bun_test_1.test)('the pipeline strips them, and keepLigatureSpans opts out', async () => {
    const stripped = await (0, render_ts_1.render)(browser, { html: PROSE, author: 'spans', timeoutMs: 120_000 });
    const kept = await (0, render_ts_1.render)(browser, {
        html: PROSE,
        author: 'spans',
        keepLigatureSpans: true,
        timeoutMs: 120_000,
    });
    const says = stripped.findings.find((f) => f.code === 'ligature-spans');
    (0, bun_test_1.expect)(says).toBeDefined();
    (0, bun_test_1.expect)(says.message).toMatch(/removed \d+ of \d+/);
    (0, bun_test_1.expect)(kept.findings.map((f) => f.code)).not.toContain('ligature-spans');
    (0, bun_test_1.expect)(squashText(await (0, poppler_ts_1.pdfText)(stripped.pdf))).toBe(squashText(await (0, poppler_ts_1.pdfText)(kept.pdf)));
}, 240_000);
(0, bun_test_1.describe)('ciphertext is not content', () => {
    (0, bun_test_1.test)('no span is cut from it, and none is even counted', () => {
        const pdf = (0, fixtures_ts_1.encryptedFixture)();
        const out = (0, spans_ts_1.stripRedundantSpans)(pdf);
        (0, bun_test_1.expect)(Buffer.from(out.pdf).equals(Buffer.from(pdf))).toBe(true);
        (0, bun_test_1.expect)(out.stats).toEqual({ seen: 0, stripped: 0, kept: 0 });
    });
});
const CID_FONT = (kidNum, cmapNum) => `<</Type /Font /Subtype /Type0 /BaseFont /FIX+t /Encoding /Identity-H ` +
    `/DescendantFonts [${kidNum} 0 R] /ToUnicode ${cmapNum} 0 R>>`;
const CID_KID = '<</Type /Font /Subtype /CIDFontType2 /BaseFont /FIX+t ' +
    '/CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /DW 1000>>';
const CMAP = (rows) => `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /F def ` +
    `1 begincodespacerange <0000> <FFFF> endcodespacerange ${rows.length} beginbfchar\n` +
    rows.map(([c, u]) => `<${c}> <${u}>`).join('\n') +
    `\nendbfchar endcmap end`;
function spanFixture(body) {
    const content = 'BT\n/F1 12 Tf\n1 0 0 1 10 700 Tm\n<0055> Tj\n' + body + '\n<0056> Tj\nET\n';
    const cmap = (0, fixtures_ts_1.deflated)(content);
    const f1Cmap = CMAP([
        ['0055', '0075'],
        ['0056', '0076'],
    ]);
    const f2Cmap = CMAP([['0676', '00660069']]);
    const pdf = (0, fixtures_ts_1.assemblePdf)([
        '<</Type /Catalog /Pages 2 0 R >>',
        '<</Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
            '/Contents 10 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> >>',
        CID_FONT(5, 8),
        CID_KID,
        CID_FONT(7, 9),
        CID_KID,
        { dict: `<</Length ${f1Cmap.length} >>`, payload: Buffer.from(f1Cmap, 'latin1') },
        { dict: `<</Length ${f2Cmap.length} >>`, payload: Buffer.from(f2Cmap, 'latin1') },
        { dict: `<</Length ${cmap.length} /Filter /FlateDecode >>`, payload: cmap },
    ]);
    return { pdf, streamNum: 10 };
}
(0, bun_test_1.test)('a span whose body restates the font resolves through the body', () => {
    const { pdf, streamNum } = spanFixture('/Span<</ActualText (fi) >> BDC\n/F2 12 Tf\n<0676> Tj\nEMC');
    const before = (0, fixtures_ts_1.streamText)(pdf, streamNum);
    (0, bun_test_1.expect)(before).toContain('/ActualText');
    const out = (0, spans_ts_1.stripRedundantSpans)(pdf);
    (0, bun_test_1.expect)(out.stats).toEqual({ seen: 1, stripped: 1, kept: 0 });
    const after = (0, fixtures_ts_1.streamText)(out.pdf, streamNum);
    (0, bun_test_1.expect)(after).not.toMatch(/ActualText|BDC|EMC/);
    (0, bun_test_1.expect)(after).toContain('<0055> Tj');
    (0, bun_test_1.expect)(after).toContain('<0056> Tj');
    (0, bun_test_1.expect)(after).toContain('<0676> Tj');
});
(0, bun_test_1.test)('a span body that switches fonts mid-span still resolves glyphs by their running font', () => {
    const { pdf, streamNum } = spanFixture('/Span<</ActualText (fiu) >> BDC\n/F2 12 Tf\n<0676> Tj\n/F1 12 Tf\n<0055> Tj\nEMC');
    const out = (0, spans_ts_1.stripRedundantSpans)(pdf);
    (0, bun_test_1.expect)(out.stats).toEqual({ seen: 1, stripped: 1, kept: 0 });
    (0, bun_test_1.expect)((0, fixtures_ts_1.streamText)(out.pdf, streamNum)).not.toMatch(/ActualText|BDC|EMC/);
});
(0, bun_test_1.test)('a span whose declared text the running font contradicts is kept', () => {
    const { pdf, streamNum } = spanFixture('/Span<</ActualText (fi) >> BDC\n/F1 12 Tf\n<0055> Tj\nEMC');
    const out = (0, spans_ts_1.stripRedundantSpans)(pdf);
    (0, bun_test_1.expect)(out.stats).toEqual({ seen: 1, stripped: 0, kept: 1 });
    (0, bun_test_1.expect)((0, fixtures_ts_1.streamText)(out.pdf, streamNum)).toContain('/ActualText');
});
(0, bun_test_1.test)('a span that restates its own font resolves through the body, not the previous run', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>` +
        `<style>@page{size:A4;margin:15mm}body{font-family:sans-serif;margin:0}</style></head><body>` +
        `<p>alpha text here</p>` +
        `<p>go see <a href="#one">first target</a> and <a href="#two">second target</a> after.</p>` +
        `<p id="one">one prose</p><p id="two">two prose</p>` +
        `<p>zeta text here</p></body></html>`;
    const kept = await (0, render_ts_1.render)(browser, {
        html,
        author: 'spans',
        keepLigatureSpans: true,
        timeoutMs: 120_000,
    });
    const before = await (0, poppler_ts_1.pdfText)(kept.pdf);
    (0, bun_test_1.expect)(squashText(before)).toContain('first target');
    const out = (0, spans_ts_1.stripRedundantSpans)(kept.pdf);
    (0, bun_test_1.expect)(out.stats.seen).toBe(1);
    (0, bun_test_1.expect)(out.stats.stripped).toBe(1);
    (0, bun_test_1.expect)(out.stats.kept).toBe(0);
    const after = await (0, poppler_ts_1.pdfText)(out.pdf);
    (0, bun_test_1.expect)(squashText(after)).toBe(squashText(before));
    (0, bun_test_1.expect)((0, verify_ts_1.verify)(out.pdf).ok).toBe(true);
}, 240_000);
(0, bun_test_1.test)('the pipeline removes such a span and stays quiet about selection', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>` +
        `<style>@page{size:A4;margin:15mm}body{font-family:sans-serif;margin:0}</style></head><body>` +
        `<p>alpha text here</p>` +
        `<p>go see <a href="#one">first target</a> and <a href="#two">second target</a> after.</p>` +
        `<p id="one">one prose</p><p id="two">two prose</p>` +
        `<p>zeta text here</p></body></html>`;
    const r = await (0, render_ts_1.render)(browser, { html, author: 'spans', timeoutMs: 120_000 });
    const says = r.findings.find((f) => f.code === 'ligature-spans');
    (0, bun_test_1.expect)(says).toBeDefined();
    (0, bun_test_1.expect)(says.message).toMatch(/removed 1 of 1/);
    (0, bun_test_1.expect)(r.findings.map((f) => f.code)).not.toContain('selection-fragmented');
    (0, bun_test_1.expect)((0, verify_ts_1.verify)(r.pdf).ok).toBe(true);
}, 240_000);
//# sourceMappingURL=spans.test.js.map