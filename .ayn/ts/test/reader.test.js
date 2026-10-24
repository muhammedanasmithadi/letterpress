"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const textfont_ts_1 = require("../src/textfont.ts");
const verify_ts_1 = require("../src/verify.ts");
const CMAP = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '3 beginbfchar',
    '<0001> <0020>',
    '<0002> <0041>',
    '<0003> <0061>',
    'endbfchar',
    '1 beginbfrange',
    '<0010> <0012> <0062>',
    'endbfrange',
    'endcmap',
].join('\n');
(0, bun_test_1.describe)('reading a CMap', () => {
    (0, bun_test_1.test)('the same map written with CRLF line endings parses identically', () => {
        const lf = (0, textfont_ts_1.parseCMap)(CMAP);
        const crlf = (0, textfont_ts_1.parseCMap)(CMAP.replace(/\n/g, '\r\n'));
        (0, bun_test_1.expect)(lf.size).toBe(6);
        (0, bun_test_1.expect)([...crlf.entries()]).toEqual([...lf.entries()]);
        (0, bun_test_1.expect)(crlf.get(1)).toBe(' ');
        (0, bun_test_1.expect)(crlf.get(0x10)).toBe('b');
    });
    (0, bun_test_1.test)('both forms of a range are read', () => {
        const m = (0, textfont_ts_1.parseCMap)(CMAP);
        (0, bun_test_1.expect)(m.get(0x11)).toBe('c');
        const listed = (0, textfont_ts_1.parseCMap)([
            'begincmap',
            '1 beginbfrange',
            '<0010> <0011> [<0078> <0079>]',
            'endbfrange',
            'endcmap',
        ].join('\n'));
        (0, bun_test_1.expect)(listed.get(0x10)).toBe('x');
        (0, bun_test_1.expect)(listed.get(0x11)).toBe('y');
    });
});
(0, bun_test_1.describe)('a dangling reference', () => {
    const file = (ref) => {
        const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
            `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
            `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents ${ref} >>\nendobj\n` +
            `trailer\n<< /Root 1 0 R /Size 4 >>\n%%EOF\n`;
        return new Uint8Array(Buffer.from(body, 'latin1'));
    };
    (0, bun_test_1.test)('is found whatever generation it names', () => {
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(file('4 0 R')).ok).toBe(false);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(file('4 1 R')).ok).toBe(false);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(file('4 65535 R')).ok).toBe(false);
    });
});
//# sourceMappingURL=reader.test.js.map