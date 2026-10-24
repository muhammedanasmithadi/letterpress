"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.structureTree = structureTree;
exports.markedContent = markedContent;
exports.mcidCensus = mcidCensus;
const node_fs_1 = require("node:fs");
const node_zlib_1 = require("node:zlib");
const pdfparts_ts_1 = require("../src/pdfparts.ts");
const K_FORMS = /\/K\s*(\[[\s\S]*?\]|\d+\s+0\s+R|\d+)(?![\d.])/g;
function structureTree(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return ['not a linear pdf'];
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    const lines = [];
    let rootNum;
    for (const o of parts.objs) {
        const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec((0, pdfparts_ts_1.dictOf)(o));
        if (m) {
            rootNum = Number(m[1]);
            break;
        }
    }
    if (rootNum === undefined)
        return ['no /StructTreeRoot: the document is untagged'];
    const seen = new Set();
    const show = (num, depth) => {
        const pad = '  '.repeat(depth);
        const text = (0, pdfparts_ts_1.dictOf)(byNum.get(num) ?? { num, bytes: Buffer.alloc(0) });
        const role = /\/S\s*\/(\w+)/.exec(text)?.[1] ?? '?';
        const alt = /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1] ?? '';
        const k = K_FORMS.exec(text)?.[1];
        K_FORMS.lastIndex = 0;
        let kind = '';
        if (k !== undefined) {
            if (/^\d+$/.test(k))
                kind = `MCID ${k}`;
            else if (/^\d+\s+0\s+R$/.test(k))
                kind = `child ${Number(/^(\d+)/.exec(k)[1])}`;
            else {
                const mcids = [...k.matchAll(/\/MCID\s+(\d+)/g)].map((m) => m[1]);
                const refs = [...k.matchAll(/(\d+) 0 R/g)].map((m) => m[1]);
                kind = `[ mcids=${mcids.join(',') || '-'} refs=${refs.join(',') || '-'} ]`;
            }
        }
        lines.push(`${pad}${num} ${role.padEnd(11)} ${kind.padEnd(30)} ${alt ? `Alt=${alt.slice(0, 48)}` : ''}`.trimEnd());
        if (seen.has(num))
            return;
        seen.add(num);
        if (k === undefined)
            return;
        if (/^\d+$/.test(k))
            return;
        if (/^\d+\s+0\s+R$/.test(k)) {
            show(Number(/^(\d+)/.exec(k)[1]), depth + 1);
            return;
        }
        for (const ref of k.matchAll(/(\d+) 0 R/g))
            show(Number(ref[1]), depth + 1);
    };
    show(rootNum, 1);
    return lines;
}
function markedContent(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return [];
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    const lines = [];
    for (const o of parts.objs) {
        const text = (0, pdfparts_ts_1.dictOf)(o);
        if (!/\/Type\s*\/Page\b/.test(text))
            continue;
        const ref = Number(/\/Contents\s+(\d+) 0 R/.exec(text)?.[1]);
        const body = ref
            ? (0, pdfparts_ts_1.inflatedStream)(byNum.get(ref) ?? { num: -1, bytes: Buffer.alloc(0) }, (b) => (0, node_zlib_1.inflateSync)(b))
            : undefined;
        if (!body)
            continue;
        const rows = body.toString('latin1').split(/\r?\n/);
        for (let i = 0; i < rows.length; i++) {
            const m = /\/(\w+)\s*<<\s*\/MCID\s+(\d+)/.exec(rows[i]);
            if (!m)
                continue;
            const wrapped = [];
            for (let j = i + 1; j < rows.length && !/EMC/.test(rows[j]); j++) {
                if (/\b(Tj|TJ|Do|f|S)\b/.test(rows[j]))
                    wrapped.push(rows[j].trim());
                if (wrapped.length >= 3)
                    break;
            }
            lines.push(`    MCID ${m[2]} tag=/${m[1]}  wraps: ${wrapped.join(' ; ').slice(0, 68)}`);
        }
    }
    return lines;
}
function mcidCensus(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const present = [];
    const named = new Set();
    const role = new Map();
    if (!parts)
        return { present, named, role };
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    for (const o of parts.objs) {
        const text = (0, pdfparts_ts_1.dictOf)(o);
        if (!/\/Type\s*\/Page\b/.test(text))
            continue;
        const ref = Number(/\/Contents\s+(\d+) 0 R/.exec(text)?.[1]);
        const body = ref
            ? (0, pdfparts_ts_1.inflatedStream)(byNum.get(ref) ?? { num: -1, bytes: Buffer.alloc(0) }, (b) => (0, node_zlib_1.inflateSync)(b))
            : undefined;
        if (body)
            for (const m of body.toString('latin1').matchAll(/\/MCID\s+(\d+)/g))
                present.push(m[1]);
    }
    let rootNum;
    for (const o of parts.objs) {
        const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec((0, pdfparts_ts_1.dictOf)(o));
        if (m) {
            rootNum = Number(m[1]);
            break;
        }
    }
    const seen = new Set();
    const walk = (num, depth) => {
        if (depth > 64 || seen.has(num))
            return;
        seen.add(num);
        const text = (0, pdfparts_ts_1.dictOf)(byNum.get(num) ?? { num, bytes: Buffer.alloc(0) });
        const r = /\/S\s*\/(\w+)/.exec(text)?.[1] ?? '?';
        for (const m of text.matchAll(K_FORMS)) {
            const block = m[1];
            if (/^\d+$/.test(block)) {
                named.add(block);
                if (!role.has(block))
                    role.set(block, r);
            }
            else if (/^\d+\s+0\s+R$/.test(block))
                walk(Number(/^(\d+)/.exec(block)[1]), depth + 1);
            else {
                for (const id of block.matchAll(/\/MCID\s+(\d+)/g)) {
                    named.add(id[1]);
                    if (!role.has(id[1]))
                        role.set(id[1], r);
                }
                for (const ref of block.matchAll(/(\d+) 0 R/g))
                    walk(Number(ref[1]), depth + 1);
            }
        }
    };
    if (rootNum !== undefined)
        walk(rootNum, 0);
    return { present: [...new Set(present)].sort((a, b) => Number(a) - Number(b)), named, role };
}
if (import.meta.main) {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error('usage: bun tools/structure-tree.ts <file.pdf> ...');
        process.exit(2);
    }
    let failed = false;
    for (const file of files) {
        let pdf;
        try {
            pdf = new Uint8Array((0, node_fs_1.readFileSync)(file));
        }
        catch {
            console.error(`cannot read ${file}`);
            failed = true;
            continue;
        }
        console.log(`\n${file}`);
        for (const line of structureTree(pdf))
            console.log(`  ${line}`);
        const blocks = markedContent(pdf);
        if (blocks.length) {
            console.log('\n  marked content in the page stream:');
            for (const l of blocks)
                console.log(l);
        }
        const census = mcidCensus(pdf);
        const orphans = census.present.filter((m) => !census.named.has(m));
        const ghosts = [...census.named].filter((m) => !census.present.includes(m));
        console.log(`\n  MCIDs present [${census.present.join(',')}]  named [${[...census.named].sort((a, b) => Number(a) - Number(b)).join(',')}]`);
        if (orphans.length)
            console.log(`  in the stream, named by nothing: ${orphans.join(',')}`);
        if (ghosts.length)
            console.log(`  named by the tree, absent from the stream: ${ghosts.join(',')}`);
    }
    if (failed)
        process.exit(1);
}
//# sourceMappingURL=structure-tree.js.map