"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const verify_ts_1 = require("../src/verify.ts");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const obj = (num, body) => ({
    num,
    bytes: Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'),
});
function wellFormed() {
    return (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', 'latin1'), [
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
        obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << >> >> /Contents 4 0 R >>'),
        {
            num: 4,
            bytes: Buffer.from('4 0 obj\n<< /Length 3 >>\nstream\nq Q\nendstream\nendobj\n', 'latin1'),
        },
    ], Buffer.from('trailer\n<< /Root 1 0 R /Size 5 >>\n', 'latin1'));
}
(0, bun_test_1.describe)('a file that lost something', () => {
    (0, bun_test_1.test)('a complete file passes', () => {
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(wellFormed())).toEqual({ ok: true, failures: [] });
    });
    (0, bun_test_1.test)('a dictionary that is opened and never closed is refused', () => {
        const damaged = (0, pdfparts_ts_1.join)(Buffer.from('%PDF-1.4\n', 'latin1'), [
            obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
            obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
            obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << >> '),
            {
                num: 4,
                bytes: Buffer.from('4 0 obj\n<< /Length 3 >>\nstream\nq Q\nendstream\nendobj\n', 'latin1'),
            },
        ], Buffer.from('trailer\n<< /Root 1 0 R /Size 5 >>\n', 'latin1'));
        const result = (0, verify_ts_1.verify)(damaged);
        (0, bun_test_1.expect)(result.ok).toBe(false);
        (0, bun_test_1.expect)(result.failures.join(' ')).toMatch(/object 3/);
    });
    (0, bun_test_1.test)('a file with no end-of-file marker is refused', () => {
        const truncated = Buffer.from(wellFormed());
        const at = truncated.length - Buffer.byteLength('%%EOF\n');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(truncated.subarray(0, at)).ok).toBe(false);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(truncated.subarray(0, at)).failures.join(' ')).toMatch(/%%EOF/);
    });
});
//# sourceMappingURL=gate.test.js.map