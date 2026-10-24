"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const selection_ts_1 = require("../src/selection.ts");
const textfont_ts_1 = require("../src/textfont.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const TEXT = 'BT\n/F2 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n90 0 Td <0001> Tj\nET';
const dict = (num, body) => ({
    num,
    bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
});
const stream = (num, body) => ({
    num,
    bytes: Buffer.from(`${num} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`, 'latin1'),
});
function file(inForm) {
    const form = inForm;
    return (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', 'latin1'), [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        dict(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
            `/Resources << /XObject << /X9 9 0 R >> /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`),
        dict(4, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>'),
        dict(8, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>'),
        dict(9, '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] ' +
            '/Resources << /Font << /F1 4 0 R /F2 8 0 R >> >> /Length ' +
            `${TEXT.length} >>\nstream\n${TEXT}\nendstream\nendobj\n`),
        stream(5, form ? '/X9 Do' : TEXT),
        ...(form ? [] : []),
    ], Buffer.from('trailer\n<< /Root 1 0 R /Size 10 >>\n', 'latin1'));
}
function tables(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const cmaps = (0, textfont_ts_1.cmapStreams)(pdf);
    const byContent = (0, textfont_ts_1.fontsByContent)(parts, (n) => cmaps.get(n) ?? null);
    const out = new Map();
    for (const o of parts.objs) {
        if (byContent.has(o.num))
            out.set(String(o.num), byContent.get(o.num).size);
    }
    return out;
}
(0, bun_test_1.describe)('font resources follow the stream that draws with them', () => {
    (0, bun_test_1.test)('the fixture differs only in where the text sits', () => {
        (0, bun_test_1.expect)((0, fixtures_ts_1.streamText)(file(true), 9)).toContain('<0001> Tj');
        (0, bun_test_1.expect)((0, fixtures_ts_1.streamText)(file(true), 5)).toBe('/X9 Do');
        (0, bun_test_1.expect)((0, fixtures_ts_1.streamText)(file(false), 5)).toContain('<0001> Tj');
    });
    (0, bun_test_1.test)('a form XObject gets its own font table, not the page it is drawn by', () => {
        const withForm = tables(file(true));
        (0, bun_test_1.expect)(withForm.get('9')).toBe(2);
        (0, bun_test_1.expect)(withForm.get('5')).toBe(1);
        (0, bun_test_1.expect)(withForm.get('9')).not.toBe(withForm.get('5'));
    });
    (0, bun_test_1.test)('the glyphs are measured the same whether the text is in a form or inline', () => {
        const inForm = (0, selection_ts_1.textFlow)(file(true));
        const inline = (0, selection_ts_1.textFlow)(file(false));
        (0, bun_test_1.expect)(inForm).not.toBeNull();
        (0, bun_test_1.expect)(inline).not.toBeNull();
        (0, bun_test_1.expect)(inForm.widestAll).toBeCloseTo(inline.widestAll, 6);
        (0, bun_test_1.expect)(inline.widestAll).toBeCloseTo(8.0, 6);
    });
});
//# sourceMappingURL=formfonts.test.js.map