"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const selection_ts_1 = require("../src/selection.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const BODY = (font) => `BT\n/${font} 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n90 0 Td <0001> Tj\nET`;
function file(sharedName) {
    const dict = (num, body) => ({
        num,
        bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
    });
    const stream = (num, font) => {
        const text = BODY(font);
        return {
            num,
            bytes: Buffer.from(`${num} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`, 'latin1'),
        };
    };
    const page2Font = sharedName ? '/F1 6 0 R' : '/F2 6 0 R';
    return (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', 'latin1'), [
        dict(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        dict(2, '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>'),
        dict(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
        dict(4, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /A /DW 500 /W [1 [100]] >>'),
        stream(5, 'F1'),
        dict(6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /B /DW 500 /W [1 [1000]] >>'),
        dict(7, `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${page2Font} >> >> /Contents 8 0 R >>`),
        stream(8, sharedName ? 'F1' : 'F2'),
    ], Buffer.from('trailer\n<< /Root 1 0 R /Size 9 >>\n', 'latin1'));
}
function streamText(pdf, num) {
    return (0, fixtures_ts_1.streamText)(pdf, num);
}
(0, bun_test_1.describe)('font resources are page-local', () => {
    (0, bun_test_1.test)('the fixture differs only in whether the name collides', () => {
        const shared = file(true);
        const distinct = file(false);
        (0, bun_test_1.expect)(streamText(shared, 5)).toContain('/F1 10 Tf');
        (0, bun_test_1.expect)(streamText(shared, 8)).toContain('/F1 10 Tf');
        (0, bun_test_1.expect)(streamText(distinct, 5)).toContain('/F1 10 Tf');
        (0, bun_test_1.expect)(streamText(distinct, 8)).toContain('/F2 10 Tf');
    });
    (0, bun_test_1.test)('the two pages are measured the same however the font is named', () => {
        const shared = (0, selection_ts_1.textFlow)(file(true));
        const distinct = (0, selection_ts_1.textFlow)(file(false));
        (0, bun_test_1.expect)(shared).not.toBeNull();
        (0, bun_test_1.expect)(distinct).not.toBeNull();
        (0, bun_test_1.expect)(distinct.glyphs).toBe(4);
        (0, bun_test_1.expect)(shared.glyphs).toBe(distinct.glyphs);
        (0, bun_test_1.expect)(shared.gaps).toBe(distinct.gaps);
        (0, bun_test_1.expect)(shared.breaks).toBe(distinct.breaks);
        (0, bun_test_1.expect)(shared.jump).toBe(distinct.jump);
        (0, bun_test_1.expect)(shared.tooWide).toBe(distinct.tooWide);
        (0, bun_test_1.expect)(shared.widestAll).toBeCloseTo(distinct.widestAll, 6);
        (0, bun_test_1.expect)(distinct.widestAll).toBeCloseTo(8.9, 6);
    });
});
//# sourceMappingURL=pagefonts.test.js.map