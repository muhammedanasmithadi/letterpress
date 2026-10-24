"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LATIN1 = void 0;
exports.sameBytes = sameBytes;
exports.assemblePdf = assemblePdf;
exports.deflated = deflated;
exports.streamText = streamText;
exports.expectSoundXref = expectSoundXref;
exports.expectSoundLengths = expectSoundLengths;
exports.encryptedFixture = encryptedFixture;
const bun_test_1 = require("bun:test");
const node_zlib_1 = require("node:zlib");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
exports.LATIN1 = 'latin1';
function sameBytes(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function assemblePdf(objs, opts = {}) {
    const endobj = opts.endobj ?? 'endobj\n';
    const trailer = opts.trailer ??
        ((size, xrefAt) => `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', exports.LATIN1)];
    let length = chunks[0].length;
    const offsets = [];
    for (let i = 0; i < objs.length; i++) {
        offsets.push(length);
        const o = objs[i];
        const bytes = typeof o === 'string'
            ? Buffer.from(`${i + 1} 0 obj\n${o}${endobj}`, exports.LATIN1)
            : Buffer.concat([
                Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, exports.LATIN1),
                o.payload,
                Buffer.from('\nendstream\nendobj\n', exports.LATIN1),
            ]);
        chunks.push(bytes);
        length += bytes.length;
    }
    const xrefAt = length;
    const n = objs.length + 1;
    const table = [`xref\n0 ${n}\n0000000000 65535 f \n`];
    for (let k = 1; k < n; k++) {
        table.push(`${String(offsets[k - 1]).padStart(10, '0')} 00000 n \n`);
    }
    chunks.push(Buffer.from(table.join(''), exports.LATIN1));
    chunks.push(Buffer.from(trailer(n, xrefAt), exports.LATIN1));
    return Buffer.concat(chunks);
}
function deflated(data) {
    return (0, node_zlib_1.deflateSync)(typeof data === 'string' ? Buffer.from(data, exports.LATIN1) : data);
}
function streamText(pdf, num) {
    const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === num);
    const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
    const raw = o.bytes.subarray(range.start, range.end);
    return (/FlateDecode/.test(o.bytes.toString(exports.LATIN1, 0, 120)) ? (0, node_zlib_1.inflateSync)(raw) : raw).toString(exports.LATIN1);
}
function expectSoundXref(text) {
    (0, bun_test_1.expect)(text.match(/startxref/g)).toHaveLength(1);
    const at = Number(text.match(/startxref\s+(\d+)/)[1]);
    (0, bun_test_1.expect)(text.slice(at, at + 4)).toBe('xref');
    const header = text.slice(at).match(/^xref\s+0\s+(\d+)\s*/);
    const size = Number(header[1]);
    const table = text.slice(at + header[0].length);
    let checked = 0;
    for (let n = 1; n < size; n++) {
        const entry = table.slice(n * 20, n * 20 + 20);
        if (entry[17] !== 'n')
            continue;
        checked++;
        (0, bun_test_1.expect)(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + 20)).toStartWith(`${n} 0 obj`);
    }
    (0, bun_test_1.expect)(checked).toBeGreaterThan(0);
    (0, bun_test_1.expect)(text).not.toContain('endobjxref');
}
function expectSoundLengths(text) {
    let streams = 0;
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj([\s\S]*?)endobj/g)) {
        const body = m[2];
        const len = body.split('stream')[0].match(/\/Length (\d+)/);
        const at = body.match(/stream\r?\n/);
        if (!len || !at || at.index === undefined)
            continue;
        streams++;
        const end = body.lastIndexOf('\nendstream');
        (0, bun_test_1.expect)(Buffer.from(body, exports.LATIN1).subarray(at.index + at[0].length, end).length).toBe(Number(len[1]));
    }
    return streams;
}
function encryptedFixture() {
    return assemblePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
        '<< /Producer (Fixture) >>',
        {
            dict: '<< /Length 58 >>',
            payload: Buffer.from('BT\n/F1 10 Tf\n/Span<</ActualText (fi)>>BDC\n[<00>]TJ\nEMC\nET\n', exports.LATIN1),
        },
        '<< /Filter /Standard /V 2 /Length 128 >>',
    ], {
        endobj: '\nendobj\n',
        trailer: (size, xrefAt) => `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R /Encrypt 6 0 R >>\n` +
            `startxref\n${xrefAt}\n%%EOF\n`,
    });
}
//# sourceMappingURL=fixtures.js.map