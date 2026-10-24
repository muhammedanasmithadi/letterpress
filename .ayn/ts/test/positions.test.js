"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const selection_ts_1 = require("../src/selection.ts");
function page(content) {
    const cmap = [
        '4 0 obj',
        '<< /Length 108 >>',
        'stream',
        'begincmap',
        '3 beginbfchar',
        '<0001> <0041>',
        '<0002> <0042>',
        '<0003> <0020>',
        'endbfchar',
        'endcmap',
        'endstream',
        'endobj',
    ].join('\n');
    return (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', 'latin1'), [
        {
            num: 1,
            bytes: Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
        },
        {
            num: 2,
            bytes: Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
        },
        {
            num: 3,
            bytes: Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] ' +
                `/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n`, 'latin1'),
        },
        { num: 4, bytes: Buffer.from(`${cmap}\n`, 'latin1') },
        {
            num: 5,
            bytes: Buffer.from(`5 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [100] 2 [100] 3 [260]] /ToUnicode 4 0 R >>\nendobj\n`, 'latin1'),
        },
        {
            num: 6,
            bytes: Buffer.from(`6 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`, 'latin1'),
        },
    ], Buffer.from('trailer\n<< /Root 1 0 R /Size 7 >>\n', 'latin1'));
}
function widest(body) {
    const flow = (0, selection_ts_1.textFlow)(page(body));
    if (!flow)
        throw new Error('the stream was refused');
    return flow.widestAll;
}
(0, bun_test_1.describe)('reading positions out of a content stream', () => {
    (0, bun_test_1.test)('Tf sets the size the gaps are measured against', () => {
        (0, bun_test_1.expect)(widest('BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n')).toBeCloseTo(0.9, 6);
        (0, bun_test_1.expect)(widest('BT\n/F1 20 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n')).toBeCloseTo(0.4, 6);
    });
    (0, bun_test_1.test)('Tm places the first glyph, not the second', () => {
        (0, bun_test_1.expect)(widest('BT\n/F1 10 Tf\n1 0 0 1 200 700 Tm\n<0001> Tj\n10 0 Td <0002> Tj\nET\n')).toBeCloseTo(0.9, 6);
    });
    (0, bun_test_1.test)('a TJ array advances the pen by widths and by its numbers', () => {
        (0, bun_test_1.expect)(widest('BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n[<0001> -100 <0002>] TJ\nET\n')).toBeCloseTo(0.1, 6);
    });
    (0, bun_test_1.test)('an invisible glyph advances the pen without becoming a position', () => {
        (0, bun_test_1.expect)(widest('BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n<0003> Tj\n<0002> Tj\nET\n')).toBeCloseTo(0.26, 6);
    });
    (0, bun_test_1.test)('a scaled matrix refuses rather than inventing gaps', () => {
        (0, bun_test_1.expect)((0, selection_ts_1.textFlow)(page('BT\n/F1 10 Tf\n2 0 0 2 10 700 Tm\n<0001> Tj\n20 0 Td <0002> Tj\nET\n'))).toBeNull();
    });
    (0, bun_test_1.test)('a second Tf changes the size mid-stream', () => {
        (0, bun_test_1.expect)(widest('BT\n/F1 10 Tf\n1 0 0 1 10 700 Tm\n<0001> Tj\n20 0 Td\n/F1 20 Tf\n<0002> Tj\nET\n')).toBeCloseTo(1.9, 6);
    });
});
//# sourceMappingURL=positions.test.js.map