"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LATIN1 = void 0;
exports.objsByNum = objsByNum;
exports.cappedInflate = cappedInflate;
exports.isEncrypted = isEncrypted;
exports.findTrailer = findTrailer;
exports.hasPostTrailerObjects = hasPostTrailerObjects;
exports.split = split;
exports.join = join;
exports.trySplit = trySplit;
exports.insertIntoDict = insertIntoDict;
exports.findStream = findStream;
exports.maskStrings = maskStrings;
exports.dictOf = dictOf;
exports.dictCode = dictCode;
exports.kidsOf = kidsOf;
exports.slashK = slashK;
exports.structElementsInOrder = structElementsInOrder;
exports.streamRange = streamRange;
exports.inflatedStream = inflatedStream;
exports.streamDict = streamDict;
exports.walkObjects = walkObjects;
const node_zlib_1 = require("node:zlib");
function objsByNum(parts) {
    return new Map(parts.objs.map((o) => [o.num, o]));
}
exports.LATIN1 = 'latin1';
const MAX_OBJECT_NUMBER = 1_000_000;
const MAX_INFLATE = 64 * 1024 * 1024;
function cappedInflate(raw) {
    return (0, node_zlib_1.inflateSync)(raw, { maxOutputLength: MAX_INFLATE });
}
const NEWLINE = Buffer.from('\n', exports.LATIN1);
function asBuffer(pdf) {
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}
function dictClose(window) {
    let depth = 0;
    for (let i = 0; i + 1 < window.length; i++) {
        const a = window.charCodeAt(i);
        const b = window.charCodeAt(i + 1);
        if (a === 60 && b === 60) {
            depth++;
            i++;
            continue;
        }
        if (a === 62 && b === 62) {
            depth--;
            i++;
            if (depth === 0)
                return i + 1;
        }
    }
    return -1;
}
function isEncrypted(pdf) {
    const buf = asBuffer(pdf);
    const at = findTrailer(buf);
    if (at === -1)
        return false;
    const end = buf.indexOf('startxref', at);
    const trailer = buf.subarray(at, end === -1 ? buf.length : end).toString(exports.LATIN1);
    return /\/Encrypt\b/.test(maskStrings(trailer));
}
function findTrailer(text) {
    const source = typeof text === 'string' ? text : text.toString(exports.LATIN1);
    const m = /(?:^|\n)[ \t]*trailer[ \t]*(?:\r?\n|$)/.exec(source);
    return m ? m.index : -1;
}
function hasPostTrailerObjects(pdf) {
    const text = asBuffer(pdf).toString(exports.LATIN1);
    const at = findTrailer(text);
    if (at === -1)
        return false;
    return /(?:^|\n)\d+ \d+ obj\b/.test(text.slice(at));
}
function sliceObject(text, raw, num, from, next) {
    const window = text.slice(from, next);
    const marker = findStream(window, 'newline');
    let to;
    if (marker !== -1) {
        const endKw = endstreamOf(text, from + marker);
        if (endKw !== -1) {
            let end = endKw + '\nendstream'.length;
            const tail = /^\s*endobj/.exec(text.slice(end));
            if (tail)
                end += tail[0].length;
            to = end;
        }
        else {
            to = next;
        }
    }
    else {
        const maskedWindow = maskStrings(window);
        const dictEnd = dictClose(maskedWindow);
        const after = dictEnd === -1 ? 0 : dictEnd;
        const m = /\bendobj[ \t]*[\r\n]/.exec(maskedWindow.slice(after));
        to = m ? from + after + m.index + 6 : next;
    }
    return { num, bytes: raw.subarray(from, to) };
}
function endstreamOf(text, from) {
    let at = from;
    for (;;) {
        const found = text.indexOf('\nendstream', at);
        if (found === -1)
            return -1;
        if (/^\s*endobj/.test(text.slice(found + '\nendstream'.length)))
            return found;
        at = found + 1;
    }
}
function split(raw) {
    const text = raw.toString(exports.LATIN1);
    const starts = [];
    for (const m of text.matchAll(/(?:^|\n)(\d+)\s+\d+\s+obj\b/g)) {
        starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== '0' ? 1 : 0) });
    }
    const trailerAt = findTrailer(text);
    const first = starts[0];
    if (first === undefined || trailerAt === -1)
        throw new Error('not a linear pdf');
    const bodyStarts = starts.filter((s) => s.at < trailerAt);
    if (bodyStarts.length === 0)
        throw new Error('no objects before the trailer');
    const objs = [];
    let at = 0;
    while (at < bodyStarts.length) {
        const s = bodyStarts[at];
        const next = bodyStarts[at + 1];
        const obj = sliceObject(text, raw, s.num, s.at, next === undefined ? trailerAt : next.at);
        objs.push(obj);
        const end = s.at + obj.bytes.length;
        while (at + 1 < bodyStarts.length && bodyStarts[at + 1].at < end)
            at++;
        at++;
    }
    const oldStartxref = text.indexOf('\nstartxref', trailerAt);
    if (oldStartxref === -1)
        throw new Error('no startxref');
    return {
        head: raw.subarray(0, first.at),
        objs,
        trailer: raw.subarray(trailerAt + 1, oldStartxref),
    };
}
function join(head, objs, trailer) {
    const parts = [head];
    const at = new Map();
    let length = head.length;
    for (const o of objs) {
        at.set(o.num, length);
        parts.push(o.bytes);
        length += o.bytes.length;
        parts.push(NEWLINE);
        length += 1;
    }
    const highest = Math.max(...objs.map((o) => o.num));
    const size = (Number.isSafeInteger(highest) && highest < MAX_OBJECT_NUMBER ? highest : 0) + 1;
    const xrefAt = length;
    parts.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, exports.LATIN1));
    for (let n = 1; n < size; n++) {
        const off = at.get(n);
        parts.push(Buffer.from(off === undefined ? '0000000000 65535 f \n' : `${String(off).padStart(10, '0')} 00000 n \n`, exports.LATIN1));
    }
    const fixed = Buffer.from(trailer.toString(exports.LATIN1).replace(/\/Size\s+\d+/, `/Size ${size}`), exports.LATIN1);
    parts.push(fixed, NEWLINE, Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, exports.LATIN1));
    return Buffer.concat(parts);
}
function trySplit(pdf) {
    try {
        return split(asBuffer(pdf));
    }
    catch {
        return undefined;
    }
}
function insertIntoDict(body, entry) {
    const code = maskStrings(body);
    let depth = 0;
    let close = -1;
    for (let i = 0; i < code.length - 1; i++) {
        const pair = code.slice(i, i + 2);
        if (pair === '<<') {
            depth++;
            i++;
        }
        else if (pair === '>>') {
            depth--;
            if (depth === 0)
                close = i;
            i++;
        }
    }
    if (close === -1)
        return body;
    return body.slice(0, close) + entry + '\n' + body.slice(close);
}
function findStream(text, mode) {
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '%') {
            while (i < n && text[i] !== '\n' && text[i] !== '\r')
                i++;
            continue;
        }
        if (ch === '(') {
            i = skipString(text, i);
            continue;
        }
        if (ch === 's' && isStreamKeyword(text, i, mode))
            return i;
        i++;
    }
    return -1;
}
function skipString(text, at) {
    let i = at + 1;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === ')')
            return i + 1;
        i++;
    }
    return n;
}
function isStreamKeyword(text, at, mode) {
    if (!text.startsWith('stream', at))
        return false;
    const after = text[at + 6] ?? ' ';
    if (mode === 'newline')
        return after === '\n' || after === '\r';
    const before = at === 0 ? ' ' : text[at - 1];
    return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}
const DICT_LIMIT = 8192;
function maskStrings(text) {
    const out = [];
    let last = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '%') {
            let end = i + 1;
            while (end < n && text[end] !== '\n' && text[end] !== '\r')
                end++;
            out.push(text.slice(last, i + 1), ' '.repeat(end - i - 1));
            last = end;
            i = end;
            continue;
        }
        if (ch !== '(') {
            i++;
            continue;
        }
        const masked = maskStringBody(text, i + 1);
        out.push(text.slice(last, i + 1));
        if (masked.escapes !== '')
            out.push(masked.escapes);
        if (masked.body !== '')
            out.push(masked.body);
        last = masked.end;
        i = masked.end + 1;
    }
    out.push(text.slice(last));
    return out.join('');
}
function maskStringBody(text, start) {
    let j = start;
    const n = text.length;
    const escapes = [];
    const body = [];
    let run = 0;
    while (j < n) {
        const c = text[j];
        if (c === '\\') {
            if (run > 0) {
                body.push(' '.repeat(run));
                run = 0;
            }
            escapes.push(text.slice(j, j + 2));
            j += 2;
            continue;
        }
        if (c === ')')
            break;
        if (c === '\n') {
            if (run > 0) {
                body.push(' '.repeat(run));
                run = 0;
            }
            body.push('\n');
            j++;
            continue;
        }
        run++;
        j++;
    }
    if (run > 0)
        body.push(' '.repeat(run));
    return { end: Math.min(j, n), escapes: escapes.join(''), body: body.join('') };
}
function dictOf(o) {
    const bytes = o.bytes;
    const limit = Math.min(bytes.length, DICT_LIMIT);
    const head = bytes.subarray(0, limit).toString(exports.LATIN1);
    const at = findStream(head, 'word');
    if (at !== -1)
        return head.slice(0, at).trim();
    if (limit === bytes.length)
        return head.trim();
    const text = bytes.toString(exports.LATIN1);
    const full = findStream(text, 'word');
    return (full === -1 ? text : text.slice(0, full)).trim();
}
function dictCode(o) {
    return maskStrings(dictOf(o));
}
function bracketed(text, at, open, close) {
    const width = open.length;
    let depth = 0;
    for (let i = at; i + width <= text.length; i += width) {
        if (text.startsWith(open, i)) {
            depth++;
            continue;
        }
        if (text.startsWith(close, i)) {
            depth--;
            if (depth === 0)
                return text.slice(at + width, i);
        }
    }
    return undefined;
}
function refsIn(body, depth) {
    if (depth > 32)
        return [];
    const out = [];
    let i = 0;
    while (i < body.length) {
        if (body.startsWith('<<', i)) {
            const inner = bracketed(body, i, '<<', '>>');
            if (inner === undefined)
                break;
            i += inner.length + 4;
            continue;
        }
        if (body[i] === '[') {
            const inner = bracketed(body, i, '[', ']');
            if (inner === undefined)
                break;
            out.push(...refsIn(inner, depth + 1));
            i += inner.length + 2;
            continue;
        }
        const m = /^\s*(\d+) 0 R/.exec(body.slice(i));
        if (m) {
            out.push(Number(m[1]));
            i += m[0].length;
            continue;
        }
        i++;
    }
    return out;
}
function kidsOf(rawText) {
    const at = slashK(rawText);
    if (at === undefined)
        return [];
    if (at.value.startsWith('[')) {
        const body = bracketed(at.value, 0, '[', ']');
        return body === undefined ? [] : refsIn(body, 0);
    }
    const m = /^(\d+) 0 R/.exec(at.value);
    return m ? [Number(m[1])] : [];
}
function slashK(rawText) {
    const text = maskStrings(rawText);
    const at = /\/K\s*/.exec(text);
    if (!at)
        return undefined;
    let i = at.index + at[0].length;
    while (i < text.length && /\s/.test(text[i]))
        i++;
    return { value: text.slice(i) };
}
function structElementsInOrder(parts, role) {
    const byNum = new Map();
    for (const o of parts.objs)
        byNum.set(o.num, dictCode(o));
    let start;
    for (const text of byNum.values()) {
        const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(text);
        if (m) {
            start = Number(m[1]);
            break;
        }
    }
    if (start === undefined)
        return [];
    const want = new RegExp(`/S\\s*/${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const order = [];
    const seen = new Set();
    const walk = (num, depth) => {
        if (seen.has(num) || depth > 64)
            return;
        seen.add(num);
        const text = byNum.get(num);
        if (text === undefined)
            return;
        if (/\/Type\s*\/StructElem/.test(text) && want.test(text))
            order.push(num);
        for (const ref of kidsOf(text))
            walk(ref, depth + 1);
    };
    walk(start, 0);
    return order;
}
function streamRange(bytes) {
    const text = Buffer.isBuffer(bytes)
        ? bytes.toString(exports.LATIN1)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(exports.LATIN1);
    const marker = text.match(/stream\r?\n/);
    if (!marker || marker.index === undefined)
        return undefined;
    const start = marker.index + marker[0].length;
    const end = text.lastIndexOf('endstream');
    if (end < start)
        return undefined;
    let stop = end;
    if (stop > start && text[stop - 1] === '\n')
        stop--;
    return { start, end: stop };
}
function inflatedStream(o, inflate) {
    const range = streamRange(o.bytes);
    if (!range)
        return undefined;
    try {
        return inflate(o.bytes.subarray(range.start, range.end));
    }
    catch {
        return undefined;
    }
}
function streamDict(o) {
    const text = o.bytes.toString(exports.LATIN1);
    const at = findStream(text, 'newline');
    return maskStrings(at === -1 ? text : text.slice(0, at));
}
function walkObjects(parts, roots, children, visit) {
    const byNum = new Map(parts.objs.map((o) => [o.num, o.bytes.toString(exports.LATIN1)]));
    const seen = new Set();
    const walk = (num, depth) => {
        if (depth > 64 || seen.has(num))
            return;
        seen.add(num);
        const obj = { num, dict: byNum.get(num) ?? '' };
        visit(obj, depth);
        for (const kid of children(obj))
            walk(kid, depth + 1);
    };
    for (const root of roots)
        walk(root, 0);
}
//# sourceMappingURL=pdfparts.js.map