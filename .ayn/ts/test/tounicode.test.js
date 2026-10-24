"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_zlib_1 = require("node:zlib");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const tounicode_ts_1 = require("../src/tounicode.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const poppler_ts_1 = require("./poppler.ts");
const LATIN1 = 'latin1';
function cmaps(pdf) {
    const text = Buffer.from(pdf).toString(LATIN1);
    const objs = new Map();
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)endobj/g)) {
        objs.set(Number(m[1]), m[2]);
    }
    const out = [];
    for (const body of objs.values()) {
        const ref = body.match(/\/ToUnicode (\d+) 0 R/);
        if (!ref)
            continue;
        const cm = objs.get(Number(ref[1]));
        if (!cm)
            continue;
        const at = cm.match(/stream\r?\n/);
        if (!at || at.index === undefined)
            continue;
        const end = cm.lastIndexOf('\nendstream');
        try {
            out.push((0, node_zlib_1.inflateSync)(Buffer.from(cm, LATIN1).subarray(at.index + at[0].length, end)).toString(LATIN1));
        }
        catch { }
    }
    return out;
}
function pdfWithCMap(cmap, dictExtra = '') {
    const body = (0, fixtures_ts_1.deflated)(cmap);
    return (0, fixtures_ts_1.assemblePdf)([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
        {
            dict: `<< ${dictExtra}/Length ${body.length} /Filter /FlateDecode >>`,
            payload: body,
        },
        '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+NotoSans /Encoding /Identity-H ' +
            '/DescendantFonts [6 0 R] /ToUnicode 4 0 R >>',
        '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+NotoSans /CIDSystemInfo ' +
            '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
    ]);
}
const cmapOf = (pairs) => `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
    `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `${pairs.length} beginbfchar\n${pairs.map(([g, d]) => `<${g.toString(16).toUpperCase().padStart(4, '0')}> <${d}>`).join('\n')}\nendbfchar\n` +
    `endcmap\nend\nend\n`;
const cmapOfRange = (lo, hi, base) => `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
    `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `1 beginbfrange\n<${lo.toString(16).toUpperCase().padStart(4, '0')}> <${hi.toString(16).toUpperCase().padStart(4, '0')}> ` +
    `<${base.toString(16).toUpperCase().padStart(4, '0')}>\nendbfrange\nendcmap\nend\nend\n`;
(0, bun_test_1.describe)('ligatureExpansion', () => {
    (0, bun_test_1.test)('the seven Latin ligatures expand to their component letters', () => {
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb00)).toBe('ff');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb01)).toBe('fi');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb02)).toBe('fl');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb03)).toBe('ffi');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb04)).toBe('ffl');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb05)).toBe('st');
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xfb06)).toBe('st');
    });
    (0, bun_test_1.test)('the whole qualifying set is the 21 codepoints measured, no more', () => {
        const hits = [];
        for (let cp = 0x20; cp <= 0x10ffff; cp++) {
            if (cp >= 0xd800 && cp <= 0xdfff)
                continue;
            const e = (0, tounicode_ts_1.ligatureExpansion)(cp);
            if (e)
                hits.push([cp, e]);
        }
        (0, bun_test_1.expect)(hits).toHaveLength(21);
        const alphabetic = hits.filter(([cp]) => cp >= 0xfb00 && cp <= 0xfb4f);
        (0, bun_test_1.expect)(alphabetic.map(([cp]) => cp)).toEqual([
            0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0xfb05, 0xfb06, 0xfb13, 0xfb14, 0xfb15, 0xfb16,
            0xfb17, 0xfb4f,
        ]);
        (0, bun_test_1.expect)(hits.filter(([cp]) => cp >= 0xfe70 && cp <= 0xfeff)).toHaveLength(8);
    });
    (0, bun_test_1.test)('a single letter carrying a diacritic keeps its codepoint', () => {
        for (const cp of [0x0675, 0x0676, 0x0677, 0x0678, 0x0edc, 0x0edd]) {
            (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(cp)).toBeUndefined();
            (0, bun_test_1.expect)(String.fromCodePoint(cp).normalize('NFKC').length).toBeGreaterThan(1);
        }
    });
    (0, bun_test_1.test)('a compatibility character is not a ligature', () => {
        for (const cp of [0x00a8, 0x00af, 0x00bc, 0x02d8, 0x2160, 0x2163, 0x0132]) {
            (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(cp)).toBeUndefined();
        }
    });
    (0, bun_test_1.test)('a codepoint outside every range is refused without consulting NFKC', () => {
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0x41)).toBeUndefined();
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(-1)).toBeUndefined();
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0x110000)).toBeUndefined();
        (0, bun_test_1.expect)((0, tounicode_ts_1.ligatureExpansion)(0xd801)).toBeUndefined();
    });
});
(0, bun_test_1.describe)('fixToUnicode', () => {
    (0, bun_test_1.test)('a ligature in a bfchar destination becomes its expansion', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOf([
            [0x0654, 'FB01'],
            [0x0003, '0020'],
        ])));
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(out)).toEqual([]);
        const text = cmaps(out).join('');
        (0, bun_test_1.expect)(text).toContain('<0654> <00660069>');
        (0, bun_test_1.expect)(text).toContain('<0003> <0020>');
    });
    (0, bun_test_1.test)('a ligature hidden in a bfrange destination is found', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(out)).toEqual([]);
        const text = cmaps(out).join('');
        (0, bun_test_1.expect)(text).toContain('<0675> <00660066>');
        (0, bun_test_1.expect)(text).toContain('<0676> <00660069>');
        (0, bun_test_1.expect)(text).toContain('<0677> <0066006C>');
    });
    (0, bun_test_1.test)('a string in the stream dictionary survives the rewrite', () => {
        const src = pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00), '/Producer (Acme PDF 3.0) ');
        const out = Buffer.from((0, tounicode_ts_1.fixToUnicode)(src)).toString(LATIN1);
        (0, bun_test_1.expect)(out, 'the rewrite did not run, so this proves nothing').not.toBe(src.toString(LATIN1));
        (0, bun_test_1.expect)(out).toContain('/Producer (Acme PDF 3.0)');
        (0, bun_test_1.expect)(out).not.toMatch(/\/Producer \(\s*\)/);
        (0, bun_test_1.expect)(cmaps((0, tounicode_ts_1.fixToUnicode)(src)).join('')).toContain('<0675> <00660066>');
    });
    (0, bun_test_1.test)('the newline before stream is kept', () => {
        const out = Buffer.from((0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00), '/Producer (Acme PDF 3.0) '))).toString(LATIN1);
        (0, bun_test_1.expect)(out).toContain('>>\nstream\n');
        (0, bun_test_1.expect)(out).not.toContain('>>stream');
    });
    (0, bun_test_1.test)('every glyph a rewritten range covered is still present', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0678, 0xfb00)));
        const text = cmaps(out).join('');
        for (const gid of ['0675', '0676', '0677', '0678'])
            (0, bun_test_1.expect)(text).toContain(`<${gid}>`);
    });
    (0, bun_test_1.test)('a block header states the number of entries it actually contains', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
        const text = cmaps(out).join('');
        const blocks = [...text.matchAll(/(\d+) begin(bfchar|bfrange)\n([\s\S]*?)\nend\2/g)];
        (0, bun_test_1.expect)(blocks.length, 'no cmap blocks were matched at all').toBeGreaterThan(0);
        for (const m of blocks) {
            const entries = m[3].split('\n').filter((l) => l.trim()).length;
            (0, bun_test_1.expect)(Number(m[1])).toBe(entries);
        }
    });
    (0, bun_test_1.test)('a range with no ligature in it is left exactly as written', () => {
        const input = pdfWithCMap(cmapOfRange(0x0044, 0x004c, 0x0061));
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(input), input)).toBe(true);
    });
    (0, bun_test_1.test)('a document with no ligature is returned byte for byte', () => {
        const input = pdfWithCMap(cmapOf([
            [0x0003, '0020'],
            [0x0014, '0031'],
            [0x0079, '00B7'],
        ]));
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(input), input)).toBe(true);
    });
    (0, bun_test_1.test)('a ligature in a bfchar is fixed even when a bfrange is also rewritten', () => {
        const withBoth = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
            '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
            '3 beginbfchar\n<0654> <FB03>\n<0003> <0020>\n<0014> <0031>\nendbfchar\n' +
            '1 beginbfrange\n<0675> <0677> <FB00>\nendbfrange\n' +
            'endcmap\nend\nend\n';
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(withBoth));
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(out)).toEqual([]);
        const text = cmaps(out).join('');
        (0, bun_test_1.expect)(text).toContain('<0654> <006600660069>');
        (0, bun_test_1.expect)(text).toContain('<0675> <00660066>');
    });
    (0, bun_test_1.test)('a bfrange line is never rewritten as a bfchar entry', () => {
        const cmap = '2 beginbfrange\n<0010> <0012> <0041>\n<FB00> <FB03> <0050>\nendbfrange\n';
        (0, bun_test_1.expect)((0, tounicode_ts_1.fixCMap)(cmap)).toBeUndefined();
        (0, bun_test_1.expect)((0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmap)) &&
            (0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmap)), pdfWithCMap(cmap))).toBe(true);
    });
    (0, bun_test_1.test)('a codespacerange line is never rewritten either', () => {
        const cmap = '1 begincodespacerange\n<FB00> <FB03>\nendcodespacerange\n';
        (0, bun_test_1.expect)((0, tounicode_ts_1.fixCMap)(cmap)).toBeUndefined();
    });
    (0, bun_test_1.test)('bfchar entries are still fixed, one per line and several per line', () => {
        const onePerLine = '2 beginbfchar\n<0041> <FB01>\n<0042> <FB02>\nendbfchar\n';
        (0, bun_test_1.expect)((0, tounicode_ts_1.fixCMap)(onePerLine)).toBe('2 beginbfchar\n<0041> <00660069>\n<0042> <0066006C>\nendbfchar\n');
        const perLine = '2 beginbfchar\n<0041> <FB01> <0042> <FB02>\nendbfchar\n';
        (0, bun_test_1.expect)((0, tounicode_ts_1.fixCMap)(perLine)).toBe('2 beginbfchar\n<0041> <00660069> <0042> <0066006C>\nendbfchar\n');
    });
    (0, bun_test_1.test)('a bfchar entry that is not a ligature is left alone, and the count holds', () => {
        const cmap = '3 beginbfchar\n<0041> <FB01>\n<0042> <FB02>\n<0043> <0044>\nendbfchar\n';
        const out = (0, tounicode_ts_1.fixCMap)(cmap);
        (0, bun_test_1.expect)(out).toContain('<0043> <0044>');
        (0, bun_test_1.expect)(out).toContain('3 beginbfchar');
        (0, bun_test_1.expect)(out).not.toContain('<FB01>');
        (0, bun_test_1.expect)(out).not.toContain('<FB02>');
    });
    (0, bun_test_1.test)('an array-form bfrange is repaired and the repair is idempotent', () => {
        for (const arr of ['[<FB00> <FB01>]', '[<FB00> <FB01> <FB02> <FB03>]']) {
            const cmap = `1 beginbfrange\n<0001> ${arr}\nendbfrange\n`;
            const input = pdfWithCMap(cmap);
            (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(input).length, `before: ${arr}`).toBeGreaterThan(0);
            const once = (0, tounicode_ts_1.fixToUnicode)(input);
            (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(once), `after: ${arr}`).toEqual([]);
            (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(once), once), `twice: ${arr}`).toBe(true);
        }
    });
    (0, bun_test_1.test)('an array-form range that needs no repair is left byte-identical', () => {
        const cmap = '1 beginbfrange\n<0001> [<0041> <0042> <0043>]\nendbfrange\n';
        const input = pdfWithCMap(cmap);
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(input), input)).toBe(true);
    });
    (0, bun_test_1.test)('the codespacerange line is not mistaken for a glyph mapping', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
        (0, bun_test_1.expect)(cmaps(out).join('')).toContain('<0000> <FFFF>');
    });
    (0, bun_test_1.test)('a rewritten file is still a valid pdf', () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
        const text = Buffer.from(out).toString(LATIN1);
        (0, fixtures_ts_1.expectSoundXref)(text);
    });
    (0, bun_test_1.test)("a stream's /Length matches the payload after rewriting", () => {
        const out = (0, tounicode_ts_1.fixToUnicode)(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
        const text = Buffer.from(out).toString(LATIN1);
        (0, bun_test_1.expect)((0, fixtures_ts_1.expectSoundLengths)(text)).toBeGreaterThan(0);
    });
    (0, bun_test_1.test)('input that is not a linear pdf is returned untouched', () => {
        for (const junk of [Buffer.alloc(0), Buffer.from('not a pdf'), Buffer.from('%PDF-1.7\n')]) {
            (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(junk), junk)).toBe(true);
        }
    });
    (0, bun_test_1.test)('a Uint8Array that is not a Buffer is still read as bytes', () => {
        const input = pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00));
        const asView = new Uint8Array(input);
        (0, bun_test_1.expect)(asView).not.toBeInstanceOf(Buffer);
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)((0, tounicode_ts_1.fixToUnicode)(asView))).toEqual([]);
    });
});
(0, bun_test_1.describe)('rendered output', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-tounicode-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    (0, bun_test_1.test)('text with ligatures leaves none behind in the ToUnicode', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p>office efficient different flags finished</p>`,
        });
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
    });
    (0, bun_test_1.test)('extracted text is plain letters, so a word search finds it', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p>office efficient different flags finished</p>`,
        });
        const text = await (0, poppler_ts_1.pdfText)(r.pdf);
        for (const word of ['office', 'efficient', 'different', 'flags', 'finished']) {
            (0, bun_test_1.expect)(text.toLowerCase()).toContain(word);
        }
        for (const cp of [0xfb00, 0xfb01, 0xfb02]) {
            (0, bun_test_1.expect)(text).not.toContain(String.fromCodePoint(cp));
        }
    });
    (0, bun_test_1.test)('a document with no ligature is unaffected', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p>plain words only</p>`,
        });
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('plain words only');
    });
    (0, bun_test_1.test)('no font family keeps a ligature, and no repair changes its own output', async () => {
        for (const style of [
            '',
            'font-family:serif',
            'font-family:monospace',
            'font-weight:700',
            'font-style:italic',
        ]) {
            const r = await (0, render_ts_1.render)(browser, {
                html: `<!doctype html><meta charset="utf-8"><p style="${style}">` +
                    `office efficient different flags finished</p>`,
            });
            (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
            (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, tounicode_ts_1.fixToUnicode)(r.pdf), r.pdf)).toBe(true);
        }
    }, 120_000);
    (0, bun_test_1.test)('a word containing an ffi ligature is findable in a serif document', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8">
<style>body{font-family:"DejaVu Serif",serif}</style><p>efficient sufficient</p>`,
        });
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).toContain('efficient');
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(r.pdf)).not.toContain(String.fromCodePoint(0xfb03));
    }, 90_000);
    (0, bun_test_1.test)('arabic letters carrying hamza keep their codepoints', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p dir="rtl" lang="ar">الأ专著 والمكتبة</p>`,
        });
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
    });
    (0, bun_test_1.test)('hebrew and french text survive', async () => {
        for (const html of [`<p dir="rtl" lang="he">שלום עולם</p>`, `<p lang="fr">œuvre cœur</p>`]) {
            const r = await (0, render_ts_1.render)(browser, { html: `<!doctype html>${html}` });
            (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
            (0, bun_test_1.expect)(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
        }
    });
    (0, bun_test_1.test)('the file is still readable after both fixes have run', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p>office efficient</p>`,
        });
        const info = await (0, poppler_ts_1.pdfInfo)(r.pdf);
        (0, bun_test_1.expect)(info.pages).toBe(1);
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(text.match(/startxref/g)).toHaveLength(1);
        (0, bun_test_1.expect)(text.slice(Number(text.match(/startxref\s+(\d+)/)[1]))).toStartWith('xref');
    });
    (0, bun_test_1.test)('the fix composes with the descriptor fix in one pass', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p style="font-family:sans-serif">office efficient</p>`,
        });
        (0, bun_test_1.expect)((0, tounicode_ts_1.unresolvedLigatures)(r.pdf)).toEqual([]);
        const text = Buffer.from(r.pdf).toString(LATIN1);
        const header = text
            .slice(Number(text.match(/startxref\s+(\d+)/)[1]))
            .match(/^xref\s+0\s+(\d+)\s/);
        const table = text.slice(Number(text.match(/startxref\s+(\d+)/)[1]) + header[0].length);
        let bad = 0;
        for (let n = 1; n < Number(header[1]); n++) {
            const entry = table.slice(n * 20, n * 20 + 20);
            if (entry[17] !== 'n')
                continue;
            const off = Number(entry.slice(0, 10));
            if (!text.startsWith(`${n} 0 obj`, off))
                bad++;
        }
        (0, bun_test_1.expect)(bad).toBe(0);
    });
});
//# sourceMappingURL=tounicode.test.js.map