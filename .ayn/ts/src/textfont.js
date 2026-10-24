"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseW = parseW;
exports.parseCMap = parseCMap;
exports.fontsByContent = fontsByContent;
exports.cmapStreams = cmapStreams;
const pdfparts_ts_1 = require("./pdfparts.ts");
function subDictOf(dict, key) {
    const at = new RegExp(`/${key}\\s*<<`).exec(dict);
    if (!at)
        return '';
    let depth = 0;
    for (let i = at.index + at[0].length - 2; i < dict.length - 1; i++) {
        const pair = dict.slice(i, i + 2);
        if (pair === '<<') {
            depth++;
            i++;
            continue;
        }
        if (pair === '>>') {
            depth--;
            i++;
            if (depth === 0)
                return dict.slice(at.index + at[0].length, i - 1);
        }
    }
    return '';
}
function fontDictOf(dict) {
    return subDictOf(dict, 'Font');
}
const MAX_CID = 0xffff;
function parseW(dict) {
    const at = /\/(?:W|w)\s*\[/.exec(dict);
    if (!at)
        return new Map();
    const end = bracketEnd(dict, at.index + at[0].length - 1);
    if (end === -1)
        return new Map();
    const out = new Map();
    const toks = dict
        .slice(at.index + at[0].length, end)
        .replace(/[[\]]/g, ' $& ')
        .split(/\s+/)
        .filter(Boolean);
    let cid = null;
    let last = null;
    for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        if (tok === '[') {
            const from = cid;
            let j = i + 1;
            for (; j < toks.length && toks[j] !== ']'; j++) {
                const w = Number(toks[j]);
                if (from !== null && Number.isFinite(w))
                    out.set(from + (j - i - 1), w);
            }
            cid = last = null;
            i = j;
            continue;
        }
        const n = Number(tok);
        if (!Number.isFinite(n))
            continue;
        if (cid === null)
            cid = n;
        else if (last === null)
            last = n;
        else {
            const from = Math.max(0, Math.min(cid, MAX_CID));
            const to = Math.max(0, Math.min(last, MAX_CID));
            for (let c = from; c <= to; c++)
                out.set(c, n);
            cid = last = null;
        }
    }
    return out;
}
function utf16be(hex) {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
        const unit = parseInt(hex.slice(i, i + 4), 16);
        if (Number.isFinite(unit))
            out += String.fromCharCode(unit);
    }
    return out;
}
function parseCMap(cmap) {
    const out = new Map();
    for (const m of cmap.matchAll(/beginbfchar\s*([\s\S]*?)\s*endbfchar/g)) {
        for (const pair of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
            out.set(parseInt(pair[1], 16), utf16be(pair[2]));
        }
    }
    for (const m of cmap.matchAll(/beginbfrange\s*([\s\S]*?)\s*endbfrange/g)) {
        for (const row of m[1].split('\n')) {
            const r = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/.exec(row);
            if (!r)
                continue;
            const lo = parseInt(r[1], 16);
            const hi = parseInt(r[2], 16);
            if (r[4]) {
                const list = [...r[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((h) => utf16be(h[1]));
                for (let i = 0; lo + i <= hi && i < list.length; i++)
                    out.set(lo + i, list[i]);
            }
            else if (r[3]) {
                const base = r[3];
                for (let c = lo; c <= hi && c - lo < MAX_CID + 1; c++) {
                    let hex = '';
                    for (let k = 0; k < base.length; k += 4) {
                        hex += ((parseInt(base.slice(k, k + 4), 16) + (c - lo)) & 0xffff)
                            .toString(16)
                            .toUpperCase()
                            .padStart(4, '0');
                    }
                    out.set(c, utf16be(hex));
                }
            }
        }
    }
    return out;
}
function fontsByContent(parts, cmapOf) {
    const byNum = (0, pdfparts_ts_1.objsByNum)(parts);
    const out = new Map();
    for (const page of parts.objs) {
        const dict = (0, pdfparts_ts_1.dictOf)(page);
        if (!/\/Type\s*\/Page\b/.test(dict))
            continue;
        let resDict = fontDictOf(dict);
        const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
        const resObj = ref ? byNum.get(Number(ref)) : undefined;
        if (resObj)
            resDict = fontDictOf((0, pdfparts_ts_1.dictOf)(resObj)) || resDict;
        const fonts = tableOf(resDict, byNum, cmapOf);
        for (const n of contentsOf(dict, byNum))
            out.set(n, fonts);
        for (const [n, f] of formsOf(dict, byNum, cmapOf)) {
            if (!out.has(n))
                out.set(n, f);
        }
    }
    return out;
}
function formsOf(pageDict, byNum, cmapOf) {
    const out = new Map();
    const root = resourcesDictOf(pageDict, byNum);
    const queue = [subDictOf(root, 'XObject'), pageDict];
    const seen = new Set();
    while (queue.length) {
        const res = queue.shift();
        if (seen.has(res))
            continue;
        seen.add(res);
        for (const n of refsIn(res)) {
            const target = byNum.get(n);
            if (!target)
                continue;
            const dict = (0, pdfparts_ts_1.dictOf)(target);
            if (!/\/Subtype\s*\/Form\b/.test(dict))
                continue;
            const own = resourcesDictOf(dict, byNum);
            out.set(n, tableOf(fontDictOf(own) || fontDictOf(dict), byNum, cmapOf));
            queue.push(own);
        }
    }
    return out;
}
function resourcesDictOf(dict, byNum) {
    const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
    const target = ref ? byNum.get(Number(ref)) : undefined;
    return target ? (0, pdfparts_ts_1.dictOf)(target) : dict;
}
function refsIn(dict) {
    return [...dict.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
}
function tableOf(resDict, byNum, cmapOf) {
    const fonts = new Map();
    for (const m of resDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
        const target = byNum.get(Number(m[2]));
        if (!target)
            continue;
        const parent = (0, pdfparts_ts_1.dictOf)(target);
        const table = simpleTable(parent, target, byNum, cmapOf) ?? cidTable(parent, byNum, cmapOf);
        if (table)
            fonts.set(m[1], table);
    }
    return fonts;
}
function simpleTable(parent, target, byNum, cmapOf) {
    const subtype = /\/Subtype\s*\/(Type3|TrueType|Type1|MMType1)/.exec(parent)?.[1];
    if (!subtype)
        return null;
    const first = Number(/\/FirstChar\s+(\d+)/.exec(parent)?.[1] ?? 0);
    const descriptorNum = Number(/\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? NaN);
    const descriptor = Number.isFinite(descriptorNum) ? byNum.get(descriptorNum) : undefined;
    const missing = Number(descriptor ? (/\/MissingWidth\s+(-?[\d.]+)/.exec((0, pdfparts_ts_1.dictOf)(descriptor))?.[1] ?? 0) : 0);
    const widths = parseWidths(parent);
    const matrix = Number(/\/FontMatrix\s*\[\s*(-?[\d.eE]+)/.exec(parent)?.[1] ?? 1);
    const scale = subtype === 'Type3' && matrix !== 0 ? matrix * 1000 : 1;
    const cmap = parseCMap(cmapOf(Number(/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? -1)) ?? '');
    void target;
    return {
        codeBytes: 1,
        widthOf: (code) => (widths.get(code - first) ?? missing) * scale,
        unicodeOf: (code) => cmap.get(code) ?? '',
    };
}
function bracketEnd(dict, from) {
    let depth = 0;
    for (let i = from; i < dict.length; i++) {
        if (dict[i] === '[')
            depth++;
        else if (dict[i] === ']') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
function parseWidths(dict) {
    const at = /\/Widths\s*\[/.exec(dict);
    if (!at)
        return new Map();
    const end = bracketEnd(dict, at.index + at[0].length - 1);
    if (end === -1)
        return new Map();
    const out = new Map();
    let n = 0;
    for (const tok of dict.slice(at.index + at[0].length, end).split(/\s+/)) {
        const w = Number(tok);
        if (Number.isFinite(w))
            out.set(n++, w);
    }
    return out;
}
function cidTable(parent, byNum, cmapOf) {
    const inline = /\/Subtype\s*\/CIDFontType2/.test(parent);
    const kidObj = inline ? undefined : descendant(byNum, parent);
    const font = inline ? parent : kidObj ? (0, pdfparts_ts_1.dictOf)(kidObj) : undefined;
    if (!font || !/\/Subtype\s*\/CIDFontType2/.test(font))
        return null;
    const dw = Number(/\/DW\s+(-?[\d.]+)/.exec(font)?.[1] ?? 1000);
    const widths = parseW(font);
    const cmap = parseCMap(cmapOf(Number(/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(parent)?.[1] ?? -1)) ?? '');
    return {
        codeBytes: 2,
        widthOf: (cid) => widths.get(cid) ?? dw,
        unicodeOf: (cid) => cmap.get(cid) ?? '',
    };
}
function descendant(byNum, parent) {
    const inline = /\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(parent)?.[1];
    if (inline !== undefined)
        return byNum.get(Number(inline));
    const arrNum = /\/DescendantFonts\s+(\d+)\s+0\s+R/.exec(parent)?.[1];
    if (arrNum !== undefined) {
        const arr = byNum.get(Number(arrNum));
        const first = arr ? /(\d+)\s+0\s+R/.exec((0, pdfparts_ts_1.dictOf)(arr))?.[1] : undefined;
        if (first !== undefined)
            return byNum.get(Number(first));
    }
    const direct = /\/DescendantFonts\s*\[\s*(<<)/.exec(parent);
    if (direct) {
        const start = direct.index + direct[0].length - 2;
        let depth = 0;
        for (let i = start; i < parent.length - 1; i++) {
            const pair = parent.slice(i, i + 2);
            if (pair === '<<') {
                depth++;
                i++;
            }
            else if (pair === '>>') {
                depth--;
                i++;
                if (depth === 0)
                    return { num: -1, bytes: Buffer.from(parent.slice(start, i - 1), 'latin1') };
            }
        }
    }
    return undefined;
}
function contentsOf(dict, byNum) {
    const out = [];
    const seen = new Set();
    const push = (n) => {
        if (seen.has(n))
            return;
        seen.add(n);
        out.push(n);
    };
    for (const m of dict.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) {
        const n = Number(m[1]);
        const target = byNum.get(n);
        const isArray = target && /^\s*(?:\d+ \d+ obj\s*)?\[/.test((0, pdfparts_ts_1.dictOf)(target));
        if (isArray)
            for (const r of (0, pdfparts_ts_1.dictOf)(target).matchAll(/(\d+)\s+0\s+R/g))
                push(Number(r[1]));
        else
            push(n);
    }
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? '';
    for (const n of array.matchAll(/(\d+)\s+0\s+R/g))
        push(Number(n[1]));
    return out;
}
function cmapStreams(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const out = new Map();
    if (!parts)
        return out;
    for (const o of parts.objs) {
        const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
        if (!range)
            continue;
        const raw = o.bytes.subarray(range.start, range.end);
        let text;
        try {
            text = (/FlateDecode/.test((0, pdfparts_ts_1.dictOf)(o)) ? (0, pdfparts_ts_1.cappedInflate)(raw) : Buffer.from(raw)).toString(pdfparts_ts_1.LATIN1);
        }
        catch {
            continue;
        }
        if (/beginbfchar|beginbfrange/.test(text))
            out.set(o.num, text);
    }
    return out;
}
//# sourceMappingURL=textfont.js.map