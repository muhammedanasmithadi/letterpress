"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcidCensus = mcidCensus;
exports.validate = validate;
const pdfparts_ts_1 = require("./pdfparts.ts");
const render_ts_1 = require("./render.ts");
const K_FORMS = /\/K\s*(\[[^\]]{0,8192}\]|\d+\s+0\s+R|\d+)(?![\d.])/g;
const STRUCT_ROOT = /\/StructTreeRoot\s+(\d+) 0 R/;
function mcidCensus(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    const census = { present: [], named: new Set(), role: new Map() };
    if (!parts)
        return census;
    for (const o of parts.objs) {
        const body = pageContent(parts, o);
        if (!body)
            continue;
        for (const m of body.matchAll(/\/MCID\s+(\d+)/g))
            census.present.push(m[1]);
    }
    let rootNum;
    for (const o of parts.objs) {
        const m = STRUCT_ROOT.exec(dict(o));
        if (m) {
            rootNum = Number(m[1]);
            break;
        }
    }
    if (rootNum === undefined)
        return census;
    (0, pdfparts_ts_1.walkObjects)(parts, [rootNum], (o) => [...o.dict.matchAll(K_FORMS)].flatMap((m) => structKids(m[1])), (o) => {
        const role = /\/S\s*\/(\w+)/.exec(o.dict)?.[1] ?? '?';
        for (const m of o.dict.matchAll(K_FORMS)) {
            const block = m[1];
            if (/^\d+$/.test(block))
                note(census, block, role);
            else
                for (const id of block.matchAll(/\/MCID\s+(\d+)/g))
                    note(census, id[1], role);
        }
    });
    census.present = [...new Set(census.present)].sort((a, b) => Number(a) - Number(b));
    return census;
}
function structKids(block) {
    if (/^\d+$/.test(block))
        return [];
    if (/^\d+\s+0\s+R$/.test(block))
        return [Number(/^(\d+)/.exec(block)[1])];
    return [...block.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
}
function note(census, id, role) {
    census.named.add(id);
    if (!census.role.has(id))
        census.role.set(id, role);
}
function dict(o) {
    return o ? o.bytes.toString('latin1') : '';
}
function pageContent(parts, o) {
    const text = dict(o);
    if (!/\/Type\s*\/Page\b/.test(text))
        return undefined;
    const ref = Number(/\/Contents\s+(\d+) 0 R/.exec(text)?.[1]);
    if (!ref)
        return undefined;
    const stream = parts.objs.find((x) => x.num === ref);
    if (!stream)
        return undefined;
    const body = /\/Filter\s*\/FlateDecode/.test((0, pdfparts_ts_1.streamDict)(stream))
        ? (0, pdfparts_ts_1.inflatedStream)(stream, pdfparts_ts_1.cappedInflate)
        : plainStream(stream);
    return body?.toString('latin1');
}
function plainStream(o) {
    const range = (0, pdfparts_ts_1.streamRange)(o.bytes);
    return range ? o.bytes.subarray(range.start, range.end) : undefined;
}
function validate(pdf) {
    const findings = [];
    const text = Buffer.from(pdf).toString('latin1');
    if (!text.slice(0, 1024).includes('%PDF-')) {
        findings.push({
            code: 'not-a-pdf',
            severity: 'error',
            message: `this does not begin with %PDF-: it is not a pdf, or the header is damaged. ` +
                `the first bytes are ${JSON.stringify(text.slice(0, 16))}.`,
        });
        return { findings, ok: false };
    }
    if ((0, pdfparts_ts_1.isEncrypted)(pdf)) {
        findings.push({
            code: 'encrypted-document',
            severity: 'error',
            message: `the file is encrypted, so nothing in it can be read: not the structure, not the ` +
                `text, not the fonts. the checks below all need to decompress the page streams, and ` +
                `without the password they cannot. if this is meant to be readable, it is not.`,
        });
        return { findings, ok: false };
    }
    findings.push(...unreadablePages(pdf));
    const structural = (0, render_ts_1.finalCheckFinding)(pdf);
    if (structural)
        findings.push(structural);
    const selection = (0, render_ts_1.selectionFinding)(pdf);
    if (selection)
        findings.push(selection);
    findings.push(...structureFindings(pdf, text));
    return { findings, ok: !findings.some((f) => f.severity === 'error') };
}
function unreadablePages(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return [];
    const out = [];
    for (const o of parts.objs) {
        if (!/\/Type\s*\/Page\b/.test(dict(o)))
            continue;
        const ref = Number(/\/Contents\s+(\d+)\s+0\s+R/.exec(dict(o))?.[1]);
        if (!ref)
            continue;
        const stream = parts.objs.find((x) => x.num === ref);
        if (!stream)
            continue;
        if (!/\/Filter\s*\/FlateDecode/.test((0, pdfparts_ts_1.streamDict)(stream)))
            continue;
        if ((0, pdfparts_ts_1.inflatedStream)(stream, pdfparts_ts_1.cappedInflate) !== undefined)
            continue;
        out.push({
            code: 'content-unreadable',
            severity: 'error',
            message: `the content of page object ${o.num} cannot be decoded, so the page is blank or ` +
                `wrong in every reader. the stream says it is compressed and does not decompress.`,
        });
    }
    return out;
}
function structureFindings(pdf, text) {
    if (!STRUCT_ROOT.test(text)) {
        return [
            {
                code: 'untagged-document',
                severity: 'info',
                message: `the file has no structure tree, so a screen reader reads it as a page of text with no ` +
                    `headings, no lists and no way to skip to the next section. nothing is wrong with how ` +
                    `it looks -- this is about what can be reached, not what can be seen. chromium tags the ` +
                    `documents it prints, so a file without this came from somewhere else.`,
            },
        ];
    }
    const census = mcidCensus(pdf);
    const out = [];
    const orphans = census.present.filter((m) => !census.named.has(m));
    const present = new Set(census.present);
    const ghosts = [...census.named].filter((m) => !present.has(m));
    if (orphans.length > 0) {
        out.push({
            code: 'structure-orphan-mcid',
            severity: 'warn',
            message: `${orphans.length} marked content block${orphans.length === 1 ? '' : 's'} in the page ` +
                `stream${orphans.length === 1 ? ' is' : 's are'} named by no structure element: ` +
                `${orphans.slice(0, 8).join(', ')}. the text draws, but a reader navigating by structure ` +
                `walks past all of it, because there is nothing to walk to.`,
        });
    }
    if (ghosts.length > 0) {
        const stranded = ghosts
            .slice(0, 5)
            .map((g) => `${g}${census.role.has(g) ? ` (${census.role.get(g)})` : ''}`);
        out.push({
            code: 'structure-ghost-mcid',
            severity: 'warn',
            message: `the structure tree names ${ghosts.length} marked content block${ghosts.length === 1 ? '' : 's'} ` +
                `that ${ghosts.length === 1 ? 'is' : 'are'} not in any page stream: ${stranded.join(', ')}. ` +
                `a reader that navigates to ${ghosts.length === 1 ? 'it' : 'one'} lands on nothing, which ` +
                `is worse than an absent heading -- the document says there is something there.`,
        });
    }
    return out;
}
//# sourceMappingURL=validate.js.map