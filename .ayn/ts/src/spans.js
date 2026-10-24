"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unescapePdfString = unescapePdfString;
exports.stripRedundantSpans = stripRedundantSpans;
const node_zlib_1 = require("node:zlib");
const pdfparts_ts_1 = require("./pdfparts.ts");
const textfont_ts_1 = require("./textfont.ts");
const EMPTY = { seen: 0, stripped: 0, kept: 0 };
const SPAN_OPEN = /\/Span\s*<<([^<>]*)>>\s*BDC/g;
function unescapePdfString(s) {
    const inner = s[0] === '<'
        ? Buffer.from(s.slice(1, -1).replace(/\s/g, ''), 'hex').toString(pdfparts_ts_1.LATIN1)
        : s.slice(1, -1);
    return inner.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
        if (c >= '0' && c <= '7')
            return String.fromCharCode(parseInt(c, 8));
        return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c;
    });
}
function bodyText(body, start, fonts) {
    let table = start;
    let out = '';
    for (const m of body.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>/g)) {
        if (m[1] !== undefined) {
            table = fonts.get(m[1]) ?? table;
            continue;
        }
        const hex = (m[2] ?? '').replace(/\s/g, '');
        const width = hex.length > 0 && hex.length % 4 === 0 ? 4 : 2;
        for (let i = 0; i + width <= hex.length; i += width) {
            out += table ? table.unicodeOf(parseInt(hex.slice(i, i + width), 16)) : '';
        }
    }
    return out;
}
function fontBefore(text, at, fonts) {
    let name;
    for (const m of text.slice(0, at).matchAll(/\/(\w+)\s+[\d.]+\s+Tf/g))
        name = m[1];
    return name ? (fonts.get(name) ?? null) : null;
}
function stripRedundantSpans(pdf) {
    const stats = { ...EMPTY };
    if ((0, pdfparts_ts_1.hasPostTrailerObjects)(pdf))
        return { pdf, stats };
    if ((0, pdfparts_ts_1.isEncrypted)(pdf))
        return { pdf, stats };
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return { pdf, stats };
    const cmaps = (0, textfont_ts_1.cmapStreams)(pdf);
    const byContent = (0, textfont_ts_1.fontsByContent)(parts, (num) => cmaps.get(num) ?? null);
    const objs = parts.objs.map((o) => stripInStream(o, byContent.get(o.num), stats));
    return { pdf: (0, pdfparts_ts_1.join)(parts.head, objs, parts.trailer), stats };
}
function stripInStream(o, fonts, stats) {
    const dict = (0, pdfparts_ts_1.dictOf)(o);
    const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
    if (!range)
        return o;
    const compressed = /FlateDecode/.test(dict);
    let text;
    try {
        const raw = o.bytes.subarray(range.start, range.end);
        text = (compressed ? (0, pdfparts_ts_1.cappedInflate)(raw) : Buffer.from(raw)).toString(pdfparts_ts_1.LATIN1);
    }
    catch {
        return o;
    }
    stats.seen += (text.match(/\/ActualText/g) ?? []).length;
    if (!/\/ActualText/.test(text))
        return o;
    if (!fonts?.size)
        return o;
    const cuts = [];
    SPAN_OPEN.lastIndex = 0;
    for (let m = SPAN_OPEN.exec(text); m; m = SPAN_OPEN.exec(text)) {
        const actual = /\/ActualText\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(m[1] ?? '');
        if (!actual)
            continue;
        const declared = unescapePdfString(actual[1] ?? '');
        if (!declared)
            continue;
        const emc = text.indexOf('EMC', SPAN_OPEN.lastIndex);
        if (emc < 0)
            continue;
        const bodyStart = SPAN_OPEN.lastIndex;
        const body = text.slice(bodyStart, emc);
        const table = fontBefore(text, m.index, fonts);
        const resolved = bodyText(body, table, fonts);
        if (resolved && resolved === declared) {
            stats.stripped++;
            cuts.push({ start: m.index, end: bodyStart });
            cuts.push({ start: emc, end: emc + 3 });
        }
        else {
            stats.kept++;
        }
    }
    if (!cuts.length)
        return o;
    cuts.sort((a, b) => b.start - a.start);
    let out = text;
    for (const c of cuts)
        out = out.slice(0, c.start) + ' ' + out.slice(c.end);
    if (out === text)
        return o;
    const payload = Buffer.from(out, pdfparts_ts_1.LATIN1);
    const bodyBytes = compressed ? (0, node_zlib_1.deflateSync)(payload) : payload;
    const head = (0, pdfparts_ts_1.dictOf)(o)
        .replace(/\/Length\s+(?:\d+\s+0\s+R|\d+)/, `/Length ${bodyBytes.length}`)
        .trim();
    return {
        num: o.num,
        bytes: Buffer.concat([
            Buffer.from(`${head}\nstream\n`, pdfparts_ts_1.LATIN1),
            bodyBytes,
            Buffer.from('\nendstream\nendobj\n', pdfparts_ts_1.LATIN1),
        ]),
    };
}
//# sourceMappingURL=spans.js.map