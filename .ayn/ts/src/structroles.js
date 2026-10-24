"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRoleCensus = parseRoleCensus;
exports.rolePlan = rolePlan;
exports.applyRolePlan = applyRolePlan;
const pdfparts_ts_1 = require("./pdfparts.ts");
const textfont_ts_1 = require("./textfont.ts");
const spans_ts_1 = require("./spans.ts");
const ROLE_OF = {
    nav: 'Sect',
    section: 'Sect',
    main: 'Part',
    header: 'Part',
    footer: 'Part',
    dl: 'L',
    dt: 'LI',
    dd: 'LI',
};
function normalizedText(text) {
    return text.replace(/\s+/g, '');
}
function parseRoleCensus(returned) {
    if (typeof returned !== 'string')
        return [];
    let value;
    try {
        value = JSON.parse(returned);
    }
    catch {
        return [];
    }
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const row of value) {
        if (row === null || typeof row !== 'object')
            continue;
        const tag = row.tag;
        const text = row.text;
        const owner = row.owner;
        if (typeof tag !== 'string' || typeof text !== 'string')
            continue;
        if (!(tag in ROLE_OF))
            continue;
        out.push({
            tag,
            text: normalizedText(text),
            owner: typeof owner === 'number' ? owner : -1,
        });
    }
    return out;
}
const STREAM_TOKEN = /\/(\w+)\s*<<([^<>]*)>>\s*BDC|\/(\w+)\s+[\d.]+\s+Tf|EMC|<([0-9A-Fa-f\s]*)>/g;
const ACTUAL_TEXT = /\/ActualText\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/;
function openToken(stack, dict) {
    const mcid = /\/MCID\s+(\d+)/.exec(dict)?.[1];
    if (mcid !== undefined) {
        stack.push(Number(mcid));
        return;
    }
    const actual = ACTUAL_TEXT.exec(dict)?.[1];
    stack.push(actual === undefined ? null : (0, spans_ts_1.unescapePdfString)(actual));
}
function closeToken(byMcid, stack) {
    const closed = stack.pop();
    const target = stack[stack.length - 1];
    if (typeof closed !== 'string' || typeof target !== 'number')
        return;
    byMcid.set(target, (byMcid.get(target) ?? '') + closed);
}
function glyphToken(byMcid, stack, table, hex) {
    const target = stack[stack.length - 1];
    if (typeof target !== 'number' || !table)
        return;
    const body = hex.replace(/\s/g, '');
    if (!body)
        return;
    const width = body.length % 4 === 0 ? 4 : 2;
    let text = byMcid.get(target) ?? '';
    for (let i = 0; i + width <= body.length; i += width) {
        text += table.unicodeOf(parseInt(body.slice(i, i + width), 16));
    }
    byMcid.set(target, text);
}
function markedText(stream, fonts) {
    const byMcid = new Map();
    const stack = [];
    let table = null;
    stream.replace(STREAM_TOKEN, (whole, openTag, openDict, fontName, hex) => {
        if (openTag !== undefined) {
            openToken(stack, openDict ?? '');
            return whole;
        }
        if (fontName !== undefined) {
            table = fonts.get(fontName) ?? table;
            return whole;
        }
        if (whole === 'EMC') {
            closeToken(byMcid, stack);
            return whole;
        }
        if (hex !== undefined)
            glyphToken(byMcid, stack, table, hex);
        return whole;
    });
    return byMcid;
}
const K_ENTRY = /<<[^<>]*?>>|\d+\s+0\s+R|(?<![\d.])\d+(?![\d.])/g;
function kidsOfElem(rawText) {
    const rest = (0, pdfparts_ts_1.slashK)(rawText)?.value;
    if (rest === undefined)
        return [];
    let i = 0;
    while (i < rest.length && /\s/.test(rest[i]))
        i++;
    const kids = [];
    const fromBody = (body) => {
        for (const m of body.matchAll(K_ENTRY)) {
            const token = m[0];
            if (token.startsWith('<<')) {
                const mcid = /\/MCID\s+(\d+)/.exec(token);
                if (!mcid)
                    continue;
                const pg = /\/Pg\s+(\d+)\s+0\s+R/.exec(token);
                kids.push({ kind: 'mcid', mcid: Number(mcid[1]), page: pg ? Number(pg[1]) : undefined });
                continue;
            }
            if (/0\s+R$/.test(token)) {
                kids.push({ kind: 'ref', num: Number(token.split(/\s+/)[0]) });
                continue;
            }
            kids.push({ kind: 'mcid', mcid: Number(token) });
        }
    };
    if (rest[i] === '[') {
        const end = rest.indexOf(']', i);
        if (end === -1)
            return [];
        fromBody(rest.slice(i + 1, end));
        return kids;
    }
    const scalar = /^(<<[^<>]*?>>|\d+\s+0\s+R|\d+)/.exec(rest.slice(i));
    if (scalar)
        fromBody(scalar[0]);
    return kids;
}
const EMPTY_WALK = { text: '', pure: false };
function mcidTextAt(w, page, mcid) {
    if (page === undefined)
        return '';
    return w.mcids.get(page)?.get(mcid) ?? '';
}
function mcrText(w, text, page) {
    const mcid = Number(/\/MCID\s+(\d+)/.exec(text)?.[1] ?? -1);
    const own = Number(/\/Pg\s+(\d+)\s+0\s+R/.exec(text)?.[1] ?? 0) || undefined;
    return mcidTextAt(w, own ?? page, mcid);
}
function roleOf(text) {
    return /\/S\s*\/(\w+)/.exec(text)?.[1];
}
function pageAt(text) {
    const at = /\/Pg\s+(\d+)\s+0\s+R/.exec(text);
    return at ? Number(at[1]) : undefined;
}
function startPure(isElem, role) {
    return !isElem || role === 'NonStruct' || role === 'Document';
}
function walkKids(w, text, depth, ownPage, here, pure) {
    let out = '';
    let ok = pure;
    let holds = false;
    for (const kid of kidsOfElem(text)) {
        if (kid.kind === 'ref') {
            holds = true;
            const res = walk(w, kid.num, depth + 1, ownPage, here);
            out += res.text;
            ok &&= res.pure;
            continue;
        }
        out += mcidTextAt(w, kid.page ?? ownPage, kid.mcid);
    }
    return { text: out, pure: ok, holds };
}
function registerWrapper(w, num, depth, chain, kids) {
    w.ancestors.set(num, chain);
    w.wrappers.push({
        num,
        depth,
        holds: kids.holds,
        text: kids.text,
        pure: kids.pure && kids.text.length > 0,
    });
}
function walk(w, num, depth, page, chain) {
    if (depth > 64 || w.visited.has(num))
        return EMPTY_WALK;
    w.visited.add(num);
    const obj = w.byNum.get(num);
    if (!obj)
        return EMPTY_WALK;
    const text = obj.bytes.toString(pdfparts_ts_1.LATIN1);
    if (/\/Type\s*\/MCR\b/.test(text))
        return { text: mcrText(w, text, page), pure: true };
    const isElem = /\/Type\s*\/StructElem\b/.test(text);
    if (!isElem && !/\/Type\s*\/StructTreeRoot\b/.test(text))
        return EMPTY_WALK;
    const role = roleOf(text);
    const ownPage = pageAt(text) ?? page;
    const wrapping = role === 'NonStruct';
    const here = wrapping ? [...chain, num] : chain;
    const kids = walkKids(w, text, depth, ownPage, here, startPure(isElem, role));
    if (wrapping)
        registerWrapper(w, num, depth, chain, kids);
    return { text: kids.text, pure: kids.pure };
}
function rootNumber(byNum) {
    for (const o of byNum.values()) {
        const m = /\/StructTreeRoot\s+(\d+)\s+0\s+R/.exec((0, pdfparts_ts_1.dictOf)(o));
        if (m)
            return Number(m[1]);
    }
    return undefined;
}
function pageContents(byNum) {
    const contents = new Map();
    for (const o of byNum.values()) {
        const dict = (0, pdfparts_ts_1.dictOf)(o);
        if (!/\/Type\s*\/Page\b/.test(dict))
            continue;
        const ref = Number(/\/Contents\s+(\d+)\s+0\s+R/.exec(dict)?.[1] ?? 0);
        if (ref)
            contents.set(o.num, ref);
    }
    return contents;
}
function streamText(target) {
    const range = (0, pdfparts_ts_1.streamRange)(target.bytes);
    if (!range)
        return undefined;
    const raw = target.bytes.subarray(range.start, range.end);
    try {
        return (/FlateDecode/.test((0, pdfparts_ts_1.dictOf)(target)) ? (0, pdfparts_ts_1.cappedInflate)(raw) : Buffer.from(raw)).toString(pdfparts_ts_1.LATIN1);
    }
    catch {
        return undefined;
    }
}
function markedByPage(pdf, parts, byNum, contents) {
    const cmaps = (0, textfont_ts_1.cmapStreams)(pdf);
    const byContent = (0, textfont_ts_1.fontsByContent)(parts, (num) => cmaps.get(num) ?? null);
    const out = new Map();
    for (const [pageObj, streamObj] of contents) {
        const target = byNum.get(streamObj);
        if (!target)
            continue;
        const text = streamText(target);
        if (text === undefined)
            continue;
        out.set(pageObj, markedText(text, byContent.get(streamObj) ?? new Map()));
    }
    return out;
}
function gather(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return undefined;
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    const root = rootNumber(byNum);
    if (root === undefined)
        return undefined;
    const w = {
        byNum,
        mcids: markedByPage(pdf, parts, byNum, pageContents(byNum)),
        visited: new Set(),
        wrappers: [],
        ancestors: new Map(),
    };
    walk(w, root, 0, undefined, []);
    return { wrappers: w.wrappers, ancestors: w.ancestors };
}
function shadows(gathered, outer, inner) {
    const chain = gathered.ancestors.get(inner);
    return chain !== undefined && chain.includes(outer);
}
function candidatesFor(gathered, el, consumed) {
    return gathered.wrappers
        .filter((w) => w.holds && normalizedText(w.text) === el.text && !consumed.has(w.num))
        .map((w) => w.num);
}
function itemTag(tag) {
    return tag === 'dt' || tag === 'dd';
}
function censusMatch(gathered, elements, plan) {
    const wrapperOf = new Map(gathered.wrappers.map((w) => [w.num, w]));
    const outermostOf = (candidates) => candidates.find((a) => candidates.every((b) => a === b || shadows(gathered, a, b)));
    const consumed = new Set();
    const match = Array.from({ length: elements.length });
    for (const [i, el] of elements.entries()) {
        if (!el.text)
            continue;
        const candidates = candidatesFor(gathered, el, consumed);
        if (candidates.length === 0)
            continue;
        const chosen = candidates.length === 1 ? candidates[0] : outermostOf(candidates);
        if (chosen === undefined || !wrapperOf.has(chosen)) {
            plan.ambiguous++;
            continue;
        }
        const wrapper = wrapperOf.get(chosen);
        if (itemTag(el.tag) && !wrapper.pure)
            continue;
        consumed.add(chosen);
        match[i] = { num: chosen, pure: wrapper.pure };
    }
    return match;
}
function kidsByOwner(elements, owner) {
    const out = [];
    for (const [k, e] of elements.entries())
        if (e.owner === owner)
            out.push(k);
    return out;
}
function listComplete(state, gathered, dl, dlNum) {
    for (const k of kidsByOwner(state.elements, dl)) {
        const kid = state.match[k];
        if (!kid || !shadows(gathered, dlNum, kid.num))
            return false;
        if (state.elements[k].tag === 'dl') {
            if (!state.planned.has(k))
                return false;
            continue;
        }
        if (!kid.pure)
            return false;
    }
    return true;
}
function planListKids(state, dl) {
    for (const k of kidsByOwner(state.elements, dl)) {
        const kid = state.match[k];
        if (kid !== undefined && !state.planned.has(k))
            state.planned.set(k, kid.num);
    }
}
function planItems(state, gathered) {
    for (let i = state.elements.length - 1; i >= 0; i--) {
        const m = state.match[i];
        if (!m)
            continue;
        const tag = state.elements[i].tag;
        if (itemTag(tag))
            continue;
        if (tag !== 'dl') {
            state.planned.set(i, m.num);
            continue;
        }
        if (!listComplete(state, gathered, i, m.num))
            continue;
        state.planned.set(i, m.num);
        planListKids(state, i);
    }
}
function rolePlan(pdf, elements) {
    const plan = { entries: [], ambiguous: 0, unmatched: 0 };
    if (elements.length === 0)
        return plan;
    const gathered = gather(pdf);
    if (!gathered)
        return { ...plan, unmatched: elements.length };
    const state = {
        elements,
        match: censusMatch(gathered, elements, plan),
        planned: new Map(),
    };
    planItems(state, gathered);
    for (const [i, el] of elements.entries()) {
        if (!el.text)
            continue;
        const n = state.planned.get(i);
        if (n === undefined) {
            plan.unmatched++;
            continue;
        }
        plan.entries.push({ tag: el.tag, role: ROLE_OF[el.tag], num: n });
    }
    return plan;
}
function applyRolePlan(pdf, plan) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts || plan.entries.length === 0)
        return pdf;
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    for (const entry of plan.entries) {
        const obj = byNum.get(entry.num);
        if (!obj)
            continue;
        const text = obj.bytes.toString(pdfparts_ts_1.LATIN1);
        if (!/\/S\s*\/NonStruct\b/.test(text))
            continue;
        obj.bytes = Buffer.from(text.replace(/\/S(\s*)\/NonStruct\b/, `/S$1/${entry.role}`), pdfparts_ts_1.LATIN1);
    }
    return new Uint8Array((0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer));
}
//# sourceMappingURL=structroles.js.map