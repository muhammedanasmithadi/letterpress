"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const node_zlib_1 = require("node:zlib");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const pdf_ts_1 = require("../src/pdf.ts");
const verify_ts_1 = require("../src/verify.ts");
const fixtures_ts_1 = require("./fixtures.ts");
(0, bun_test_1.describe)('objects past the trailer', () => {
    (0, bun_test_1.test)('trailing garbage matching the object pattern is not parsed as an object', () => {
        const pdf = build('BT /F1 12 Tf 10 100 Td (hi) Tj ET');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
        const junk = Buffer.from('42 0 obj\n<< /Type /Junk >>\nendobj\n', pdfparts_ts_1.LATIN1);
        const mutant = Buffer.concat([pdf, junk]);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(mutant).ok).toBe(true);
        const parts = (0, pdfparts_ts_1.trySplit)(mutant);
        (0, bun_test_1.expect)(parts.objs.map((o) => o.num)).not.toContain(42);
        const out = (0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(out).ok).toBe(true);
        (0, bun_test_1.expect)(Buffer.from(out).toString(pdfparts_ts_1.LATIN1)).not.toContain('/Type /Junk');
    });
    (0, bun_test_1.test)('a concatenated second file behind the first does not corrupt the first', () => {
        const a = build('BT /F1 12 Tf 10 100 Td (aaa) Tj ET', false);
        const b = build('BT /F1 12 Tf 10 100 Td (bbb) Tj ET');
        const both = Buffer.concat([a, b]);
        const parts = (0, pdfparts_ts_1.trySplit)(both);
        const out = (0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(out).ok).toBe(true);
        (0, bun_test_1.expect)(Buffer.from(out).toString(pdfparts_ts_1.LATIN1)).toContain('(aaa)');
    });
});
function build(contents, compress = true) {
    const chunks = [];
    const offsets = [];
    const len = () => chunks.reduce((a, b) => a + b.length, 0);
    const add = (body) => {
        offsets.push(len());
        chunks.push(Buffer.from(body, pdfparts_ts_1.LATIN1));
    };
    chunks.push(Buffer.from('%PDF-1.4\n', pdfparts_ts_1.LATIN1));
    add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n');
    const raw = Buffer.from(contents, pdfparts_ts_1.LATIN1);
    const payload = compress ? (0, node_zlib_1.deflateSync)(raw) : raw;
    offsets.push(len());
    chunks.push(Buffer.from(`4 0 obj\n<< /Length ${payload.length} >>\nstream\n`, pdfparts_ts_1.LATIN1));
    chunks.push(payload);
    chunks.push(Buffer.from('\nendstream\nendobj\n', pdfparts_ts_1.LATIN1));
    add('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
    const xrefAt = len();
    const n = offsets.length + 1;
    let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets)
        table += `${String(off).padStart(10, '0')} 00000 n \n`;
    chunks.push(Buffer.from(table, pdfparts_ts_1.LATIN1));
    chunks.push(Buffer.from(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, pdfparts_ts_1.LATIN1));
    return Buffer.concat(chunks);
}
function measuredLength(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const streamObj = parts?.objs.find((o) => o.bytes.includes('stream'));
    const range = streamObj ? (0, pdfparts_ts_1.streamRange)(streamObj.bytes) : undefined;
    return {
        declared: Number(/\/Length\s+(\d+)/.exec(streamObj?.bytes.toString(pdfparts_ts_1.LATIN1) ?? '')?.[1] ?? -1),
        measured: range ? range.end - range.start : -1,
    };
}
const PLAIN = 'BT /F1 12 Tf 10 100 Td (plain) Tj ET';
(0, bun_test_1.describe)('streamRange', () => {
    (0, bun_test_1.test)('agrees with the declared length on an ordinary stream', () => {
        const { declared, measured } = measuredLength(build(PLAIN));
        (0, bun_test_1.expect)(measured).toBe(declared);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(build(PLAIN)).ok).toBe(true);
    });
    bun_test_1.test.each([
        ['names it once', `${PLAIN}\nendstream\nmore text`],
        ['names it twice', `${PLAIN}\n% endstream\nmore\nendstream\nstill going`],
        ['ends with the bytes', `${PLAIN}\nendstream`],
    ])('agrees with the declared length when the payload %s', (_label, contents) => {
        for (const compress of [false, true]) {
            const pdf = build(contents, compress);
            const { declared, measured } = measuredLength(pdf);
            (0, bun_test_1.expect)(measured, `compress=${compress}`).toBe(declared);
            (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok, `compress=${compress}`).toBe(true);
        }
    });
    (0, bun_test_1.test)('reports no range for an object with no stream', () => {
        const parts = (0, pdfparts_ts_1.trySplit)(build(PLAIN));
        const catalog = parts.objs.find((o) => /\/Type \/Catalog/.test((0, pdfparts_ts_1.dictOf)(o)));
        (0, bun_test_1.expect)((0, pdfparts_ts_1.streamRange)(catalog.bytes)).toBeUndefined();
    });
    (0, bun_test_1.test)('a zero-length payload is a range, not a missing one', () => {
        const empty = Buffer.from('7 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n', pdfparts_ts_1.LATIN1);
        const range = (0, pdfparts_ts_1.streamRange)(empty);
        (0, bun_test_1.expect)(range).toBeDefined();
        (0, bun_test_1.expect)(range.end - range.start).toBe(0);
    });
});
(0, bun_test_1.describe)('kidsOf', () => {
    (0, bun_test_1.test)('a bare reference', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</Type /StructElem /K 15 0 R>>')).toEqual([15]);
    });
    (0, bun_test_1.test)('an array of references and MCIDs, with an object reference dictionary', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</Type /StructElem /K [13 0 R <</Type /OBJR /Obj 5 0 R /Pg 2 0 R>> 19 0 R]>>')).toEqual([13, 19]);
    });
    (0, bun_test_1.test)('a nested dictionary is skipped to its matching close, not the first one', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [4 0 R <</A <</B 1 0 R>> /Obj 9 0 R>> 5 0 R]>>')).toEqual([4, 5]);
    });
    (0, bun_test_1.test)('a bare integer is an MCID, not a child', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</Type /StructElem /Pg 2 0 R /K 19>>')).toEqual([]);
    });
    (0, bun_test_1.test)('no /K at all', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</Type /StructElem>>')).toEqual([]);
    });
    (0, bun_test_1.test)('a nested array is descended into, not cut at its first bracket', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [[1 0 R] [2 0 R]]>>')).toEqual([1, 2]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [1 0 R [2 0 R] 3 0 R]>>')).toEqual([1, 2, 3]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [[[3 0 R]]]>>')).toEqual([3]);
    });
    (0, bun_test_1.test)('an inline dictionary inside a nested array is still skipped', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [[1 0 R <</Type /OBJR /Obj 7 0 R /Pg 2 0 R>>] [3 0 R]]>>')).toEqual([1, 3]);
    });
    (0, bun_test_1.test)('unbalanced brackets yield nothing rather than a partial answer', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [1 0 R [2 0 R>>')).toEqual([]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [[[[1 0 R]>>')).toEqual([]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K [1 0 R')).toEqual([]);
    });
    (0, bun_test_1.test)('nesting deeper than the bound terminates and returns nothing', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K ' + '['.repeat(200) + '1 0 R' + ']'.repeat(200) + '>>')).toEqual([]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</K ' + '['.repeat(16) + '1 0 R' + ']'.repeat(16) + '>>')).toEqual([1]);
    });
});
(0, bun_test_1.describe)('structElementsInOrder', () => {
    function tree(bodies) {
        const parts = ['%PDF-1.4\n'];
        const offsets = [];
        let at = parts[0].length;
        const add = (body) => {
            offsets.push(at);
            at += body.length;
            parts.push(body);
        };
        add('1 0 obj\n<< /Type /Catalog /StructTreeRoot 2 0 R >>\nendobj\n');
        add('2 0 obj\n<< /Type /StructTreeRoot /K 3 0 R >>\nendobj\n');
        for (const [num, body] of Object.entries(bodies))
            add(`${num} 0 obj\n${body}\nendobj\n`);
        const xrefAt = at;
        const n = offsets.length + 1;
        let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
        for (const off of offsets)
            table += `${String(off).padStart(10, '0')} 00000 n \n`;
        parts.push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
        return Buffer.from(parts.join(''), pdfparts_ts_1.LATIN1);
    }
    (0, bun_test_1.test)('document order, not the order objects are written in', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K 5 0 R>>',
            5: '<</Type /StructElem /S /Figure /K 6 0 R>>',
            6: '<</Type /StructElem /S /Figure>>',
        });
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure')).toEqual([4, 5, 6]);
    });
    (0, bun_test_1.test)('matches only the role asked for, with the slash', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R 5 0 R]>>',
            4: '<</Type /StructElem /S /Figure>>',
            5: '<</Type /StructElem /S /Caption>>',
        });
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure')).toEqual([4]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Caption')).toEqual([5]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Sect')).toEqual([]);
    });
    (0, bun_test_1.test)('a cycle does not hang the walk', () => {
        const pdf = tree({
            3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
            4: '<</Type /StructElem /S /Figure /K [3 0 R 4 0 R]>>',
        });
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure')).toEqual([4]);
    });
    (0, bun_test_1.test)('an untagged file yields nothing rather than throwing', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.structElementsInOrder)((0, pdfparts_ts_1.trySplit)(build(PLAIN)), 'Figure')).toEqual([]);
    });
    void pdfparts_ts_1.join;
});
(0, bun_test_1.describe)('insertIntoDict', () => {
    (0, bun_test_1.test)('inserts before the outer close, not a nested one', async () => {
        const { insertIntoDict } = await Promise.resolve().then(() => __importStar(require('../src/pdfparts.ts')));
        const obj = '5 0 obj\n<</Type /Annot\n/A <</S /URI\n/URI (https://x.example/)>>\n/StructParent 1>>\nendobj';
        const out = insertIntoDict(obj, '/Contents (hello)');
        const nestedClose = out.indexOf('/URI (https://x.example/)>>') + '/URI (https://x.example/)>>'.length;
        const at = out.indexOf('/Contents (hello)');
        (0, bun_test_1.expect)(at).toBeGreaterThan(nestedClose);
        (0, bun_test_1.expect)(at).toBeLessThan(out.lastIndexOf('>>'));
    });
});
(0, bun_test_1.describe)('findStream', () => {
    (0, bun_test_1.test)('it finds the keyword outside a string and outside a comment', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('<< /A 1 >>\nstream\n', 'word')).toBe(11);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('<< /A (stream) >>\nstream\n', 'word')).toBe(18);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('% a stream comment\n<< /A 1 >>', 'word')).toBe(-1);
    });
    (0, bun_test_1.test)('a word wants the keyword as a word, and a newline wants a line ending', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('xstream', 'word')).toBe(-1);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('xstream', 'newline')).toBe(-1);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('xstream\n', 'newline')).toBe(1);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('stream\n', 'word')).toBe(0);
    });
    (0, bun_test_1.test)('an escaped parenthesis does not end the string', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.findStream)('(a \\) b) stream', 'word')).toBe(9);
    });
});
(0, bun_test_1.describe)('the cost of splitting a document', () => {
    const withStream = (size) => {
        const stream = 'q '.repeat(size);
        const body = `1 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
        return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n0\n%%EOF\n`, pdfparts_ts_1.LATIN1));
    };
    (0, bun_test_1.test)('splitting a document with a huge stream stays fast', () => {
        const pdf = withStream(32_000_000);
        const started = Date.now();
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        const took = Date.now() - started;
        (0, bun_test_1.expect)(parts).toBeDefined();
        (0, bun_test_1.expect)(parts.objs.length).toBe(1);
        (0, bun_test_1.expect)(took).toBeLessThan(2_000);
    });
    (0, bun_test_1.test)('the cost does not grow with the size of the stream', () => {
        const small = withStream(4_000);
        const large = withStream(32_000_000);
        const time = (pdf) => {
            const started = Date.now();
            (0, pdfparts_ts_1.trySplit)(pdf);
            return Date.now() - started;
        };
        time(small);
        time(large);
        (0, bun_test_1.expect)(time(large) - time(small)).toBeLessThan(600);
    });
});
(0, bun_test_1.describe)('the dictionary of an object', () => {
    (0, bun_test_1.test)('a long dictionary is still read whole', () => {
        const filler = ' '.repeat(9000);
        const obj = {
            num: 1,
            bytes: Buffer.from(`1 0 obj\n<< /Note (${filler}) /Type /Page >>\nendobj\n`, pdfparts_ts_1.LATIN1),
        };
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(obj)).toContain('/Type /Page');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(obj)).toContain('/Note');
    });
    (0, bun_test_1.test)('a stream after the dictionary is not part of it', () => {
        const obj = {
            num: 1,
            bytes: Buffer.from('1 0 obj\n<< /Length 5 >>\nstream\nq q q\nendstream\nendobj\n', pdfparts_ts_1.LATIN1),
        };
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(obj)).toBe('1 0 obj\n<< /Length 5 >>');
    });
});
(0, bun_test_1.describe)('maskStrings', () => {
    const O = (bytes) => ({ num: 1, bytes: Buffer.from(bytes, pdfparts_ts_1.LATIN1) });
    (0, bun_test_1.test)('blanks the contents and preserves every offset and length', () => {
        const src = '<< /Alt (hello) /K [1 0 R] >>';
        const masked = (0, pdfparts_ts_1.maskStrings)(src);
        (0, bun_test_1.expect)(masked).not.toContain('hello');
        (0, bun_test_1.expect)(masked.length).toBe(src.length);
        const at = masked.indexOf('/K');
        (0, bun_test_1.expect)(src.slice(at)).toBe(masked.slice(at));
    });
    (0, bun_test_1.test)("keeps the delimiters, so a caller's own match on a parenthesis still works", () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.maskStrings)('(abc)')).toBe('(   )');
    });
    (0, bun_test_1.test)('an escaped close parenthesis does not end the string', () => {
        const masked = (0, pdfparts_ts_1.maskStrings)(String.raw `<</A (a \) b) /K [9 0 R]>>`);
        (0, bun_test_1.expect)(masked).toContain(String.raw `\)`);
        (0, bun_test_1.expect)(masked).not.toContain(' b)');
        (0, bun_test_1.expect)(masked).toContain('/K [9 0 R]');
    });
    (0, bun_test_1.test)('an escaped open parenthesis is not an open', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.maskStrings)(String.raw `<< /A (a \( b) /K [9 0 R]>>`)).not.toContain('( b');
    });
    (0, bun_test_1.test)('an unterminated string does not throw', () => {
        (0, bun_test_1.expect)(() => (0, pdfparts_ts_1.maskStrings)('<< /A (unterminated')).not.toThrow();
        (0, bun_test_1.expect)((0, pdfparts_ts_1.maskStrings)('<< /A (unterminated')).not.toContain('unterminated');
    });
    (0, bun_test_1.test)('a hex string is left alone, because a caller may need to read it', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.maskStrings)('<</Alt <00480065006C006C006F> /K [1 0 R]>>')).toContain('<00480065006C006C006F>');
    });
    (0, bun_test_1.test)('dictOf reads values; dictCode hides them', () => {
        const o = O('<< /URI (https://x.example/stream/) /Contents (a) >>');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictOf)(o)).toContain('https://x.example/stream/');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictCode)(o)).not.toContain('https://x.example/stream/');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictCode)(o)).toContain('/Contents');
    });
    (0, bun_test_1.test)('dictCode does not stop at the word stream inside a string', () => {
        const o = O('<< /Alt (a stream of revenue) /K [15 0 R] >>');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.dictCode)(o)).toContain('/K [15 0 R]');
    });
    (0, bun_test_1.test)('streamDict does not stop at a string carrying the keyword and a newline', () => {
        const o = O('<< /Alt (foo stream\nbar) /Length 99 >> stream\nxxxx\nendstream');
        (0, bun_test_1.expect)(/\/Length\s+(\d+)/.exec((0, pdfparts_ts_1.streamDict)(o))?.[1]).toBe('99');
    });
    (0, bun_test_1.test)('kidsOf does not read a reference out of an /Alt', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.kidsOf)('<</S /Figure /Alt (/K 99 0 R) /K [15 0 R]>>')).toEqual([15]);
    });
    (0, bun_test_1.test)('insertIntoDict is not derailed by an unbalanced << inside a string', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.insertIntoDict)('<< /URI (a << b) >>', '/Contents (x)')).toContain('/Contents (x)');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.insertIntoDict)('<< /URI (a << b) >>', '/Contents (x)')).toBe('<< /URI (a << b) /Contents (x)\n>>');
    });
});
(0, bun_test_1.describe)('streamDict', () => {
    (0, bun_test_1.test)('cuts at the keyword, leaving the payload out', () => {
        const o = {
            num: 1,
            bytes: Buffer.from('<< /Length 5 >> stream\nhello\nendstream', pdfparts_ts_1.LATIN1),
        };
        (0, bun_test_1.expect)((0, pdfparts_ts_1.streamDict)(o).trim()).toBe('<< /Length 5 >>');
    });
});
function fileWithObject4(body) {
    const bodies = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
        `4 0 obj\n${body}\nendobj\n`,
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ];
    const head = Buffer.from('%PDF-1.4\n', pdfparts_ts_1.LATIN1);
    const chunks = [head];
    const offsets = [];
    let at = head.length;
    for (const b of bodies) {
        offsets.push(at);
        at += b.length;
        chunks.push(Buffer.from(b, pdfparts_ts_1.LATIN1));
    }
    let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets)
        table += `${String(off).padStart(10, '0')} 00000 n \n`;
    chunks.push(Buffer.from(table, pdfparts_ts_1.LATIN1));
    chunks.push(Buffer.from(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, pdfparts_ts_1.LATIN1));
    return Buffer.concat(chunks);
}
(0, bun_test_1.describe)('split keeps a stream object whole', () => {
    const CONTENT = 'BT /F1 12 Tf (page one) Tj ET';
    const cases = [
        ['plain', `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`, CONTENT],
        [
            'endobj in the dictionary',
            `<< /Producer (endobj) /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
            CONTENT,
        ],
        [
            'endobj in the payload',
            `<< /Length ${7 + CONTENT.length} >>\nstream\nendobj ${CONTENT}\nendstream`,
            `endobj ${CONTENT}`,
        ],
    ];
    for (const [name, body, payload] of cases) {
        (0, bun_test_1.test)(name, () => {
            const pdf = fileWithObject4(body);
            const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === 4);
            const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
            (0, bun_test_1.expect)(range).toBeDefined();
            (0, bun_test_1.expect)(o.bytes.subarray(range.start, range.end).toString(pdfparts_ts_1.LATIN1)).toBe(payload);
            (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1).endsWith('\nendstream\nendobj')).toBe(true);
            (0, bun_test_1.expect)((0, verify_ts_1.contentPayloads)(pdf)).toEqual([payload]);
            const parts = (0, pdfparts_ts_1.trySplit)(pdf);
            (0, bun_test_1.expect)((0, verify_ts_1.contentPayloads)(pdf, parts)).toEqual([payload]);
            (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
        });
    }
    (0, bun_test_1.test)('a string carrying the keyword does not make a plain object a stream', () => {
        const pdf = fileWithObject4('<< /Alt (a stream\nof text) >>');
        const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === 4);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.streamRange)(o.bytes)).toBeUndefined();
        (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1)).toBe('4 0 obj\n<< /Alt (a stream\nof text) >>\nendobj');
    });
});
(0, bun_test_1.describe)('split when a non-stream object carries the keyword', () => {
    const body = (extra) => `<< ${extra} /Type /Free >>`;
    const cases = [
        ['inside a literal string', '/A (endobj)'],
        ['as the prefix of a longer word', '/A (endobject)'],
        ['inside an array', '/A [endobj]'],
        ['with no parens at all', '/A endobj'],
        ['and then a real reference after it', '/A (endobj) /Ref 99 0 R'],
    ];
    for (const [name, extra] of cases) {
        (0, bun_test_1.test)(name, () => {
            const pdf = fileWithObject4(body(extra));
            const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === 4);
            (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1)).toBe(`4 0 obj\n${body(extra)}\nendobj`);
            const dangling = fileWithObject4(body('/A (endobj) /Ref 99 0 R'));
            (0, bun_test_1.expect)((0, verify_ts_1.verify)(dangling).ok).toBe(false);
        });
    }
    (0, bun_test_1.test)('the keyword still ends the object when it is the real one', () => {
        const pdf = fileWithObject4('<< /A (nothing here) >>');
        const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === 4);
        (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1)).toBe('4 0 obj\n<< /A (nothing here) >>\nendobj');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
    });
});
(0, bun_test_1.describe)('maskStrings and comments', () => {
    (0, bun_test_1.test)('an unbalanced parenthesis inside a comment does not swallow the rest', () => {
        const body = '<< /A % a comment ( unbalanced\n/Length 140 >> carrying';
        const masked = (0, pdfparts_ts_1.maskStrings)(body);
        (0, bun_test_1.expect)(masked.length).toBe(body.length);
        (0, bun_test_1.expect)(masked).not.toContain('comment');
        (0, bun_test_1.expect)(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe('140');
    });
    (0, bun_test_1.test)('a comment holding a closing parenthesis does not close a real string early', () => {
        const body = '<< /Alt (real) % ) \n/Next 1 0 R >>';
        (0, bun_test_1.expect)((0, pdfparts_ts_1.maskStrings)(body)).toContain('/Next 1 0 R');
    });
    (0, bun_test_1.test)('a percent sign inside a literal string is not a comment', () => {
        const masked = (0, pdfparts_ts_1.maskStrings)('<< /Alt (100% (secret)) /Next 1 0 R >>');
        (0, bun_test_1.expect)(masked).not.toContain('secret');
        (0, bun_test_1.expect)(masked).toContain('/Next 1 0 R');
    });
    (0, bun_test_1.test)('a carriage return ends a comment too', () => {
        const masked = (0, pdfparts_ts_1.maskStrings)('<< /A % ( unbalanced\r/Length 140 >>');
        (0, bun_test_1.expect)(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe('140');
    });
    (0, bun_test_1.test)('insertIntoDict still finds the dictionary past a comment', () => {
        const out = (0, pdfparts_ts_1.insertIntoDict)('<< /A % ( unbalanced\n/B 1 >>', '/Contents (x)');
        (0, bun_test_1.expect)(out).toContain('/Contents (x)');
    });
});
(0, bun_test_1.describe)('split when a dictionary spells an object header', () => {
    (0, bun_test_1.test)('a string naming a header does not invent an object', () => {
        const pdf = fileWithObject4('<< /Alt (2 0 obj) /P 9 0 R >>');
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        (0, bun_test_1.expect)(parts.objs.map((o) => o.num)).toEqual([1, 2, 3, 4, 5]);
        const o = parts.objs.find((x) => x.num === 4);
        (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1)).toBe('4 0 obj\n<< /Alt (2 0 obj) /P 9 0 R >>\nendobj');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(false);
    });
    (0, bun_test_1.test)('a real header still found at the start of a line', () => {
        const pdf = fileWithObject4('<< /A 1 >>');
        (0, bun_test_1.expect)((0, pdfparts_ts_1.trySplit)(pdf)
            .objs.find((x) => x.num === 4)
            .bytes.toString(pdfparts_ts_1.LATIN1)).toBe('4 0 obj\n<< /A 1 >>\nendobj');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
    });
    (0, bun_test_1.test)('a header after a stream payload is found, which a masked scan would miss', () => {
        const payload = 'x'.repeat(400) + '(not a paren';
        const pdf = fileWithObject4(`<< /Length ${payload.length} >>\nstream\n${payload}\nendstream`);
        const parts = (0, pdfparts_ts_1.trySplit)(pdf);
        (0, bun_test_1.expect)(parts.objs.map((o) => o.num)).toEqual([1, 2, 3, 4, 5]);
        const o = parts.objs.find((x) => x.num === 4);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.streamRange)(o.bytes).end - (0, pdfparts_ts_1.streamRange)(o.bytes).start).toBe(payload.length);
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
    });
});
(0, bun_test_1.describe)("split when a dictionary ends a line with the keyword's spelling", () => {
    const cases = [
        ['a bare name at end of line', '<< /A endobj\n/Foo 1 >>'],
        ['a name used as a title', '<< /Title /endobj\n/Foo 1 >>'],
        ['a name inside an array', '<< /A [endobj]\n/Foo 1 >>'],
        ['nested dictionaries closing', '<< /A << /B 1 >>\n/C 2 >>'],
        ['and the plain case still works', '<< /A 1 >>'],
    ];
    for (const [name, body] of cases) {
        (0, bun_test_1.test)(name, () => {
            const pdf = fileWithObject4(body);
            const o = (0, pdfparts_ts_1.trySplit)(pdf).objs.find((x) => x.num === 4);
            (0, bun_test_1.expect)(o.bytes.toString(pdfparts_ts_1.LATIN1)).toBe(`4 0 obj\n${body}\nendobj`);
            (0, bun_test_1.expect)((0, pdfparts_ts_1.trySplit)(pdf).objs.map((x) => x.num)).toEqual([1, 2, 3, 4, 5]);
        });
    }
    (0, bun_test_1.test)('an object with no dictionary is still delimited', () => {
        const pdf = fileWithObject4('<< /A 1 >>');
        const rejoined = (0, pdfparts_ts_1.trySplit)(fileWithObject4('<< /A 1 >>'));
        (0, bun_test_1.expect)(rejoined.objs.find((x) => x.num === 4).bytes.toString(pdfparts_ts_1.LATIN1)).toBe('4 0 obj\n<< /A 1 >>\nendobj');
        (0, bun_test_1.expect)((0, verify_ts_1.verify)(pdf).ok).toBe(true);
    });
});
(0, bun_test_1.describe)('encryption declared in the trailer', () => {
    (0, bun_test_1.test)('is detected, and only from the trailer', () => {
        (0, bun_test_1.expect)((0, pdfparts_ts_1.isEncrypted)((0, fixtures_ts_1.encryptedFixture)())).toBe(true);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.isEncrypted)((0, fixtures_ts_1.assemblePdf)(['<< /Type /Catalog /Pages 2 0 R >>']))).toBe(false);
        const decoy = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R >>',
            { dict: '<< /Length 8 >>', payload: Buffer.from('/Encrypt', pdfparts_ts_1.LATIN1) },
        ]);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.isEncrypted)(decoy)).toBe(false);
        (0, bun_test_1.expect)((0, pdfparts_ts_1.isEncrypted)(new Uint8Array([1, 2, 3]))).toBe(false);
    });
});
(0, bun_test_1.describe)('inspect says whether a file is encrypted', () => {
    (0, bun_test_1.test)('a declared /Encrypt is reported', () => {
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array((0, fixtures_ts_1.encryptedFixture)())).encrypted).toBe(true);
    });
    (0, bun_test_1.test)('an ordinary file is reported as not encrypted', () => {
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array((0, fixtures_ts_1.assemblePdf)(['<< /Type /Catalog /Pages 2 0 R >>']))).encrypted).toBe(false);
    });
    (0, bun_test_1.test)('the word inside a content stream is not a declaration', () => {
        const decoy = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R >>',
            { dict: '<< /Length 8 >>', payload: Buffer.from('/Encrypt', pdfparts_ts_1.LATIN1) },
        ]);
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array(decoy)).encrypted).toBe(false);
    });
});
(0, bun_test_1.describe)('pageSizes follows the page tree, not the order objects appear in', () => {
    const shuffled = (0, fixtures_ts_1.assemblePdf)([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [5 0 R 3 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 111 222] >>',
        '<< /Type /Info /Producer (nothing) >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 333 444] >>',
    ]);
    (0, bun_test_1.test)('the first entry is the first page in the tree', () => {
        const info = (0, pdf_ts_1.inspect)(new Uint8Array(shuffled));
        (0, bun_test_1.expect)(info.pageSizes).toEqual(['/MediaBox [0 0 333 444]', '/MediaBox [0 0 111 222]']);
    });
    (0, bun_test_1.test)('there is one entry per page either way', () => {
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array(shuffled)).pageSizes).toHaveLength(2);
    });
    (0, bun_test_1.test)('a file with no page tree falls back to file order rather than to nothing', () => {
        const tree = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 111 222] >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 333 444] >>',
        ]);
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array(tree)).pageSizes).toEqual([
            '/MediaBox [0 0 111 222]',
            '/MediaBox [0 0 333 444]',
        ]);
    });
    (0, bun_test_1.test)('every page reports a box, including one that declares none', () => {
        const inherited = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>',
            '<< /Type /Page /Parent 2 0 R >>',
        ]);
        (0, bun_test_1.expect)((0, pdf_ts_1.inspect)(new Uint8Array(inherited)).pageSizes).toEqual(['']);
    });
});
//# sourceMappingURL=pdfparts.test.js.map