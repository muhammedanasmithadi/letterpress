"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeTextRuns = mergeTextRuns;
exports.textRunProfile = textRunProfile;
const textfont_ts_1 = require("./textfont.ts");
const node_zlib_1 = require("node:zlib");
const pdfparts_ts_1 = require("./pdfparts.ts");
const EPSILON = 1e-4;
const PLACES = 6;
function widthsByResource(parts) {
    const out = new Map();
    for (const [num, fonts] of (0, textfont_ts_1.fontsByContent)(parts, () => null)) {
        const widths = new Map();
        for (const [name, table] of fonts) {
            if (table.codeBytes === 2)
                widths.set(name, table.widthOf);
        }
        out.set(num, widths);
    }
    return out;
}
function cidsOf(hex) {
    if (hex.length % 4 !== 0)
        return null;
    const out = [];
    for (let i = 0; i < hex.length; i += 4)
        out.push(parseInt(hex.slice(i, i + 4), 16));
    return out;
}
function replay(block, widths) {
    const placed = [];
    let x = 0;
    let y = 0;
    let lx = 0;
    let ly = 0;
    let simple = true;
    let size = 0;
    let widthOf = () => 1000;
    const show = (hex) => {
        const cids = cidsOf(hex);
        if (!cids) {
            simple = false;
            return false;
        }
        for (const cid of cids) {
            placed.push({ x, y, cid });
            x += (widthOf(cid) / 1000) * size;
        }
        return true;
    };
    const showArray = (spec) => {
        for (const piece of spec.split(/\s+/)) {
            if (!piece)
                continue;
            const hex = /^<([0-9A-Fa-f]*)>$/.exec(piece);
            if (hex) {
                if (!show(hex[1]))
                    break;
                continue;
            }
            const num = Number(piece);
            if (Number.isFinite(num))
                x -= (num / 1000) * size;
        }
    };
    const tok = /\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|\[([^\]]*)\]\s*TJ|\b(Tz|Tc|Tw|TL|T\*|Ts)\b/g;
    for (let m = tok.exec(block); m; m = tok.exec(block)) {
        if (m[1] !== undefined) {
            size = Number(m[2]);
            const found = widths.get(m[1]);
            if (!found)
                simple = false;
            else
                widthOf = found;
            continue;
        }
        if (m[3] !== undefined) {
            if (Number(m[3]) !== 1 || Number(m[4]) !== 0 || Number(m[5]) !== 0)
                simple = false;
            if (Number(m[6]) !== 1 && Number(m[6]) !== -1)
                simple = false;
            x = lx = Number(m[7]);
            y = ly = Number(m[8]);
            continue;
        }
        if (m[9] !== undefined) {
            lx += Number(m[9]);
            ly += Number(m[10]);
            x = lx;
            y = ly;
            continue;
        }
        if (m[11] !== undefined) {
            show(m[11]);
            continue;
        }
        if (m[12] !== undefined) {
            showArray(m[12]);
            continue;
        }
        if (m[13] !== undefined)
            simple = false;
    }
    return { placed, simple };
}
function blocksOf(stream) {
    return [...stream.matchAll(/BT[\s\S]*?ET/g)].map((m) => m[0]);
}
function blocksAt(stream) {
    return [...stream.matchAll(/BT[\s\S]*?ET/g)].map((m) => ({
        text: m[0],
        from: m.index,
        to: m.index + m[0].length,
    }));
}
function mergeBlock(block, widths) {
    const text = block.trim();
    if (!text.startsWith('BT') || !text.endsWith('ET'))
        return null;
    const scan = scanBlock(text);
    return scan ? buildBlock(scan, widths) : null;
}
function onlySpace(text, from, to) {
    const space = /\S/g;
    space.lastIndex = from;
    const found = space.exec(text);
    return found === null || found.index >= to;
}
function scanBlock(text) {
    const tok = /\bBT\b|\bET\b|\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|([^\n]*\bBDC\b[^\n]*)|\bEMC\b/g;
    const st = {
        tf: '',
        size: 0,
        tm: '',
        open: false,
        closed: false,
        dx: 0,
        dy: 0,
        moved: false,
        items: [],
    };
    let at = 0;
    for (let m = tok.exec(text); m; m = tok.exec(text)) {
        if (!onlySpace(text, at, m.index))
            return null;
        at = m.index + m[0].length;
        if (!step(st, m))
            return null;
    }
    if (!onlySpace(text, at, text.length))
        return null;
    if (!st.open || !st.closed)
        return null;
    if (!st.items.some((i) => 'cids' in i))
        return null;
    return { items: st.items, tf: st.tf, size: st.size, tm: st.tm };
}
function step(st, m) {
    if (m[0] === 'BT') {
        if (st.open || st.items.length)
            return false;
        st.open = true;
        return true;
    }
    if (m[0] === 'ET') {
        if (!st.open || st.closed)
            return false;
        st.closed = true;
        return true;
    }
    if (m[12] !== undefined) {
        st.items.push({ raw: m[12] });
        return true;
    }
    if (m[0] === 'EMC') {
        st.items.push({ raw: m[0] });
        return true;
    }
    if (st.closed)
        return false;
    if (m[1] !== undefined)
        return applyFont(st, m);
    if (m[3] !== undefined)
        return applyMatrix(st, m);
    if (m[9] !== undefined)
        return applyMove(st, m);
    if (m[11] === undefined)
        return false;
    return applyShow(st, m);
}
function applyFont(st, m) {
    if (st.items.some((i) => 'cids' in i))
        return false;
    st.tf = `/${m[1]} ${Number(m[2])} Tf`;
    st.size = Number(m[2]);
    return true;
}
function applyMatrix(st, m) {
    if (st.items.some((i) => 'cids' in i))
        return false;
    if (Number(m[3]) !== 1 || Number(m[4]) !== 0 || Number(m[5]) !== 0)
        return false;
    if (Number(m[6]) !== 1 && Number(m[6]) !== -1)
        return false;
    st.tm = `${m[3]} ${m[4]} ${m[5]} ${m[6]} ${m[7]} ${m[8]} Tm`;
    return true;
}
function applyMove(st, m) {
    st.dx = Number(m[9]);
    st.dy = Number(m[10]);
    st.moved = true;
    return true;
}
function applyShow(st, m) {
    if (st.dy !== 0)
        return false;
    const cids = cidsOf(m[11]);
    if (!cids)
        return false;
    st.items.push({ cids, dx: st.dx, moved: st.moved });
    st.moved = false;
    st.dx = st.dy = 0;
    return true;
}
function buildBlock(scan, widths) {
    const widthOf = widths.get(scan.tf.slice(1, scan.tf.indexOf(' ')));
    if (!widthOf || scan.size <= 0)
        return null;
    const advanceOf = (cids) => cids.reduce((sum, cid) => sum + (widthOf(cid) / 1000) * scan.size, 0);
    const out = [];
    let entries = [];
    let residue = 0;
    let pending = 0;
    let first = true;
    let tm = scan.tm;
    const flush = () => {
        if (!entries.length)
            return;
        out.push(`[${entries.join(' ')}] TJ`);
        entries = [];
    };
    for (const item of scan.items) {
        if ('raw' in item) {
            flush();
            out.push(item.raw);
            continue;
        }
        const sum = advanceOf(item.cids);
        if (item.moved) {
            if (first)
                tm = foldFirstTd(tm, item.dx);
            else {
                const exact = -((item.dx - pending) * 1000) / scan.size + residue;
                const rounded = Math.round(exact * 10 ** PLACES) / 10 ** PLACES;
                residue = exact - rounded;
                if (rounded !== 0)
                    entries.push(String(rounded));
            }
            pending = sum;
        }
        else {
            pending += sum;
        }
        first = false;
        for (const cid of item.cids)
            entries.push(`<${cid.toString(16).toUpperCase().padStart(4, '0')}>`);
    }
    flush();
    return `BT ${scan.tf} ${tm} ${out.join(' ')} ET`;
}
function foldFirstTd(tm, dx) {
    if (dx === 0)
        return tm;
    if (!tm)
        return `1 0 0 -1 ${dx} 0 Tm`;
    const m = tm.split(' ');
    return `${m[0]} ${m[1]} ${m[2]} ${m[3]} ${Number(m[4]) + dx} ${m[5]} Tm`;
}
function streamPlaced(stream, widths) {
    const out = [];
    for (const block of blocksOf(stream)) {
        const { placed, simple } = replay(block, widths);
        if (!simple)
            return null;
        out.push(...placed);
    }
    return out;
}
function sameGlyphs(before, after) {
    if (!after || after.length !== before.length)
        return false;
    for (let i = 0; i < before.length; i++) {
        if (after[i].cid !== before[i].cid)
            return false;
        if (Math.abs(after[i].x - before[i].x) > EPSILON)
            return false;
        if (Math.abs(after[i].y - before[i].y) > EPSILON)
            return false;
    }
    return true;
}
function decodeStream(o) {
    const dict = (0, pdfparts_ts_1.dictOf)(o);
    const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
    if (!range)
        return null;
    const compressed = /FlateDecode/.test(dict);
    const raw = o.bytes.subarray(range.start, range.end);
    try {
        return { bytes: compressed ? (0, pdfparts_ts_1.cappedInflate)(raw) : Buffer.from(raw), compressed };
    }
    catch {
        return null;
    }
}
const WORD = /[A-Za-z0-9_]/;
function wordByte(b) {
    return b !== undefined && WORD.test(String.fromCharCode(b));
}
function hasTextBlock(bytes) {
    let at = bytes.indexOf('BT');
    while (at !== -1) {
        if (!wordByte(bytes[at - 1]) && !wordByte(bytes[at + 2]))
            return true;
        at = bytes.indexOf('BT', at + 1);
    }
    return false;
}
function mergeTextRuns(pdf) {
    const stats = { blocks: 0, merged: 0, refused: 0 };
    if ((0, pdfparts_ts_1.hasPostTrailerObjects)(pdf))
        return { pdf, stats };
    if ((0, pdfparts_ts_1.isEncrypted)(pdf))
        return { pdf, stats };
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return { pdf, stats };
    const byStream = widthsByResource(parts);
    if (!byStream.size)
        return { pdf, stats };
    let changed = 0;
    const objs = parts.objs.map((o) => {
        const decoded = decodeStream(o);
        if (!decoded || !hasTextBlock(decoded.bytes))
            return o;
        const text = decoded.bytes.toString(pdfparts_ts_1.LATIN1);
        const blocks = blocksAt(text);
        stats.blocks += blocks.length;
        const widths = byStream.get(o.num);
        if (!widths)
            return o;
        const before = streamPlaced(text, widths);
        const runs = [];
        for (const block of blocks) {
            const run = before ? mergeBlock(block.text, widths) : null;
            if (run)
                runs.push({ from: block.from, to: block.to, run });
        }
        let rewritten = text;
        for (const r of runs.reverse()) {
            rewritten = rewritten.slice(0, r.from) + r.run + rewritten.slice(r.to);
        }
        const merged = runs.length;
        if (rewritten === text) {
            stats.refused += before ? blocks.length - merged : blocks.length;
            return o;
        }
        if (!sameGlyphs(before, streamPlaced(rewritten, widths))) {
            stats.refused += blocks.length;
            return o;
        }
        stats.merged += merged;
        changed++;
        const payload = Buffer.from(rewritten, pdfparts_ts_1.LATIN1);
        const body = decoded.compressed ? (0, node_zlib_1.deflateSync)(payload) : payload;
        const head = (0, pdfparts_ts_1.dictOf)(o)
            .replace(/\/Length\s+(?:\d+\s+0\s+R|\d+)/, `/Length ${body.length}`)
            .trim();
        return {
            num: o.num,
            bytes: Buffer.concat([
                Buffer.from(`${head}\nstream\n`, pdfparts_ts_1.LATIN1),
                body,
                Buffer.from('\nendstream\nendobj\n', pdfparts_ts_1.LATIN1),
            ]),
        };
    });
    if (!changed)
        return { pdf, stats };
    return { pdf: new Uint8Array((0, pdfparts_ts_1.join)(parts.head, objs, parts.trailer)), stats };
}
function textRunProfile(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const profile = { glyphs: 0, tj: 0, showOps: 0 };
    if (!parts)
        return profile;
    for (const o of parts.objs) {
        const decoded = decodeStream(o);
        if (!decoded || !hasTextBlock(decoded.bytes))
            continue;
        const text = decoded.bytes.toString(pdfparts_ts_1.LATIN1);
        profile.glyphs += (text.match(/<[0-9A-Fa-f]+>/g) ?? []).length;
        profile.tj += (text.match(/\bTJ\b/g) ?? []).length;
        profile.showOps += (text.match(/\bTj\b/g) ?? []).length + (text.match(/\bTJ\b/g) ?? []).length;
    }
    return profile;
}
//# sourceMappingURL=tjmerge.js.map