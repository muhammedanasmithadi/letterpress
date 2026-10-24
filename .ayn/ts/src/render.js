"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_INPUT_MESSAGE = exports.FORMATS = exports.toInches = exports.declaredPageOrientation = void 0;
exports.parseFormat = parseFormat;
exports.pageRangesProblem = pageRangesProblem;
exports.confinedTo = confinedTo;
exports.normalizeDir = normalizeDir;
exports.stageAssets = stageAssets;
exports.finalCheckFinding = finalCheckFinding;
exports.hasRelativeAssets = hasRelativeAssets;
exports.render = render;
exports.selectionFinding = selectionFinding;
const node_path_1 = require("node:path");
const promises_1 = require("node:fs/promises");
const fontdesc_ts_1 = require("./fontdesc.ts");
const meta_ts_1 = require("./meta.ts");
const tounicode_ts_1 = require("./tounicode.ts");
const linkdesc_ts_1 = require("./linkdesc.ts");
const figrole_ts_1 = require("./figrole.ts");
const selection_ts_1 = require("./selection.ts");
const tjmerge_ts_1 = require("./tjmerge.ts");
const pageside_ts_1 = require("./pageside.ts");
const spans_ts_1 = require("./spans.ts");
const verify_ts_1 = require("./verify.ts");
const rolemap_ts_1 = require("./rolemap.ts");
const structroles_ts_1 = require("./structroles.ts");
const lint_ts_1 = require("./lint.ts");
const pdf_ts_1 = require("./pdf.ts");
var pdf_ts_2 = require("./pdf.ts");
Object.defineProperty(exports, "declaredPageOrientation", { enumerable: true, get: function () { return pdf_ts_2.declaredPageOrientation; } });
Object.defineProperty(exports, "toInches", { enumerable: true, get: function () { return pdf_ts_2.toInches; } });
exports.FORMATS = {
    a3: [11.6929, 16.5354],
    a4: [8.2677, 11.6929],
    a5: [5.8268, 8.2677],
    legal: [8.5, 14],
    letter: [8.5, 11],
    tabloid: [11, 17],
};
function parseFormat(value) {
    if (value == null || value === '')
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`format must be a string, got ${typeof value}`);
    const name = value.trim().toLowerCase();
    if (!Object.hasOwn(exports.FORMATS, name)) {
        throw new Error(`unknown format "${value}". try: ${Object.keys(exports.FORMATS).join(', ')}`);
    }
    return name;
}
function pageRangesProblem(value) {
    const parts = value.split(',').map((p) => p.trim());
    const bad = parts.filter((p) => !/^[1-9]\d*(-[1-9]\d*)?$/.test(p));
    if (bad.length > 0) {
        const names = bad.map((b) => '"' + b + '"').join(', ');
        const verb = bad.length === 1 ? 'is' : 'are';
        return names + ' ' + verb + ' not a page number or a range';
    }
    for (const p of parts) {
        const m = /^([1-9]\d*)-([1-9]\d*)$/.exec(p);
        if (m && Number(m[1]) > Number(m[2]))
            return 'the range "' + p + '" starts after it ends';
    }
    return null;
}
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BLOCKED_REPORTED = 20;
const close = (a, b) => Math.abs(a - b) < 0.05;
function pageOverride(html, req) {
    if (html == null)
        return null;
    const declared = (0, pdf_ts_1.declaredPageSize)(html);
    if (req.format) {
        const size = `${req.format}${req.landscape ? ' landscape' : ''}`;
        return (0, pdf_ts_1.injectPageRule)((0, pdf_ts_1.stripPageSize)(html), `size:${size};margin:${req.margin ?? '0'}`);
    }
    if (declared === null) {
        const size = req.landscape ? 'a4 landscape' : 'a4';
        return (0, pdf_ts_1.injectPageRule)(html, `size:${size};margin:${req.margin ?? '0'}`);
    }
    if (req.landscape && (0, pdf_ts_1.declaredPageOrientation)(html) === 'portrait') {
        return (0, pdf_ts_1.transposePageSize)(html);
    }
    return null;
}
function precedenceFindings(html, req) {
    const findings = [];
    const declared = (0, pdf_ts_1.declaredPageSize)(html);
    const declaredMargin = (0, pdf_ts_1.declaredPageMargin)(html);
    if (declared && req.format) {
        const [w = NaN, h = NaN] = exports.FORMATS[req.format];
        const named = declared.match(/\b(a3|a4|a5|letter|legal|tabloid)\b/)?.[1]?.toLowerCase();
        const dims = declared.match(/([\d.]+)\s*(mm|cm|in|px|pt)/gi)?.map(pdf_ts_1.toInches) ?? [];
        const [d0 = NaN, d1 = NaN] = dims;
        const target = req.landscape ? [h, w] : [w, h];
        const agrees = named
            ? named === req.format && !req.landscape
            : dims.length >= 2 &&
                ((close(d0, target[0]) && close(d1, target[1])) ||
                    (close(d0, target[1]) && close(d1, target[0])));
        if (!agrees) {
            findings.push({
                code: 'page-size-override',
                severity: 'info',
                message: `request asked for ${req.format}${req.landscape ? ' landscape' : ''}, but the document declares @page size: ${declared}. The request wins: the declaration is stripped from the document and the paper is set from the flag.`,
            });
        }
    }
    if (declared && req.landscape) {
        const orientation = (0, pdf_ts_1.declaredPageOrientation)(html);
        if (orientation === 'portrait') {
            const transposed = !req.format && (0, pdf_ts_1.transposePageSize)(html) !== null;
            if (transposed) {
                findings.push({
                    code: 'orientation-overridden',
                    severity: 'info',
                    message: `the document declares @page size: ${declared}, which is portrait, so the declaration has been transposed to landscape. The paper and margin are the document's own. Write "@page { size: ${declared} landscape }" to make that permanent.`,
                });
            }
            else if (req.format) {
                findings.push({
                    code: 'orientation-overridden',
                    severity: 'info',
                    message: `the document declares @page size: ${declared}, which is portrait. --format with --landscape takes precedence, so the paper has been transposed rather than the document's own page size used.`,
                });
            }
            else {
                findings.push({
                    code: 'orientation-ignored',
                    severity: 'error',
                    message: `--landscape had no effect: the document declares @page size: ${declared}, and that declaration cannot be transposed into a landscape spelling, so the PDF is portrait. Name a paper the engine can rotate, either with --format a4 or by writing "@page { size: ${declared} landscape }" in the stylesheet.`,
                });
            }
        }
    }
    if (declaredMargin && req.margin) {
        findings.push({
            code: 'margin-ignored',
            severity: 'warn',
            message: `--margin ${req.margin} was ignored: the document declares @page margin: ${declaredMargin}, and a document's own @page wins. Change the margin in the stylesheet, or drop the @page margin rule.`,
        });
    }
    return findings;
}
async function capImageResolution(tab, maxPpi, timeoutMs) {
    const res = await tab.send('Runtime.evaluate', {
        expression: `(${pageside_ts_1.measureImages})(${JSON.stringify(maxPpi)})`,
        returnByValue: true,
    }, timeoutMs);
    const raw = res?.result?.value;
    if (raw == null)
        return [];
    let entries;
    try {
        entries = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!entries.length)
        return [];
    await tab.send('Runtime.evaluate', {
        expression: `(${pageside_ts_1.applyImageReplacements})(${JSON.stringify(entries.map((e) => ({ at: e.at, url: e.url })))})`,
        returnByValue: true,
    }, timeoutMs);
    await tab.send('Runtime.evaluate', {
        expression: 'Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)',
        awaitPromise: true,
        returnByValue: true,
    }, timeoutMs);
    return entries.map(({ at, from, to, ppi }) => ({ at, from, to, ppi }));
}
function isTeardownAbort(errorText) {
    return /ERR_ABORTED/.test(errorText ?? '');
}
const SERVED_DOCUMENT = 'input.html';
const OVERRIDE_DOCUMENT = 'override.html';
function confinedTo(dir, name) {
    const base = normalizeDir(dir);
    return (0, node_path_1.join)(base, name).startsWith(base + '/');
}
function normalizeDir(dir) {
    return (0, node_path_1.resolve)(dir);
}
function absRoot(root) {
    return (0, node_path_1.resolve)(root.startsWith('/') ? root : `${process.cwd()}/${root}`);
}
function clampedUrlPath(rel) {
    const out = [];
    for (const part of rel.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join('/');
}
const NAV_HREF_TAGS = new Set(['a', 'area', 'base']);
const TAG_OPEN = /<\s*([\w-]+)\b[^>]*>/gi;
const SRC_ATTR = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const QUOTED_SRCSET = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
const NOT_A_LOCAL_FILE = /^(?:https?:|data:|blob:|file:|#|mailto:|\/\/)/i;
const REF_PATTERNS = [
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /@import\s+["']([^"']+)["']/gi,
    /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
function* tagRefs(text) {
    for (const tag of text.matchAll(TAG_OPEN)) {
        if (NAV_HREF_TAGS.has(tag[1].toLowerCase()))
            continue;
        const body = tag[0];
        for (const m of body.matchAll(SRC_ATTR)) {
            const value = m[1] ?? m[2] ?? m[3] ?? '';
            if (value)
                yield value;
        }
        for (const m of body.matchAll(QUOTED_SRCSET)) {
            for (const entry of m[1].split(','))
                yield entry.trim().split(/\s+/)[0];
        }
    }
}
function* refsIn(text) {
    yield* tagRefs(text);
    for (const re of REF_PATTERNS) {
        for (const m of text.matchAll(re)) {
            yield (m[1] ?? '').replace(/["']/g, '');
        }
    }
}
async function stageAssets(html, source, dir, rootArg) {
    if (!html || /^https?:/i.test(source))
        return [];
    const base = source.startsWith('/') ? (0, node_path_1.dirname)(source) : process.cwd();
    const root = rootArg ? absRoot(rootArg) : base;
    const rootReal = await (0, promises_1.realpath)(root).catch(() => root);
    const insideRoot = (p) => p === rootReal || p.startsWith(rootReal + '/');
    const state = {
        base,
        root,
        dir,
        seen: new Set(),
        written: new Set(),
        queue: [],
        refused: [],
    };
    scanAssets(state, html, base);
    while (state.queue.length) {
        const next = state.queue.shift();
        await stageOne(state, next, insideRoot);
    }
    return state.refused;
}
function lexicallyInside(p, root) {
    return p === root || p.startsWith(root + '/');
}
function considerAsset(state, ref, from) {
    const clean = ref.trim().split(/[?#]/)[0];
    if (!clean)
        return;
    if (NOT_A_LOCAL_FILE.test(clean))
        return;
    const abs = (0, node_path_1.isAbsolute)(clean) ? clean : (0, node_path_1.resolve)(from, clean);
    if (state.seen.has(abs))
        return;
    state.seen.add(abs);
    const urlPath = clampedUrlPath((0, node_path_1.relative)(state.base, abs));
    if (!urlPath)
        return;
    const target = (0, node_path_1.join)(state.dir, urlPath);
    if (!target.startsWith(state.dir + '/') || state.written.has(target))
        return;
    if (urlPath === SERVED_DOCUMENT || urlPath === OVERRIDE_DOCUMENT) {
        if (state.refused.length < 8)
            state.refused.push({ ref: clean, abs, why: 'document' });
        return;
    }
    state.written.add(target);
    state.queue.push({ ref: clean, from: abs, outside: !lexicallyInside(abs, state.root) });
}
function scanAssets(state, text, from) {
    for (const ref of refsIn(text))
        considerAsset(state, ref, from);
}
async function stageOne(state, next, insideRoot) {
    const { ref, from, outside } = next;
    const real = await (0, promises_1.realpath)(from).catch(() => null);
    if (real && !insideRoot(real)) {
        if (state.refused.length < 8 && !state.refused.some((r) => r.abs === real)) {
            state.refused.push({ ref, abs: real, why: 'outside-root' });
        }
        return;
    }
    if (!real) {
        if (outside && state.refused.length < 8 && !state.refused.some((r) => r.abs === from)) {
            state.refused.push({ ref, abs: from, why: 'outside-root' });
        }
        return;
    }
    let bytes;
    try {
        bytes = Buffer.from(await Bun.file(real).arrayBuffer());
    }
    catch {
        return;
    }
    if (!bytes.length)
        return;
    const target = (0, node_path_1.join)(state.dir, clampedUrlPath((0, node_path_1.relative)(state.base, from)));
    try {
        await Bun.write(target, bytes);
    }
    catch {
        return;
    }
    if (/\.(?:css|mjs|js)$/i.test(from)) {
        try {
            scanAssets(state, new TextDecoder('latin1').decode(bytes), (0, node_path_1.dirname)(real));
        }
        catch { }
    }
}
function finalCheckFinding(pdf) {
    const finalCheck = (0, verify_ts_1.verify)(pdf);
    if (finalCheck.ok)
        return null;
    return {
        code: 'output-unverified',
        severity: 'error',
        message: `the file returned by this call did not pass the structural check: ` +
            `${finalCheck.failures.join('; ')}. every repair upstream is gated on the same ` +
            `check, so this is the merge or the stamp producing something it should not have.`,
    };
}
function hasRelativeAssets(html) {
    for (const ref of refsIn(html)) {
        const clean = ref.trim().split(/[?#]/)[0];
        if (clean && !NOT_A_LOCAL_FILE.test(clean))
            return true;
    }
    return false;
}
async function drainStream(tab, handle, { chunkSize = 262_144, timeoutMs }) {
    const parts = [];
    for (let guard = 0; guard < 100_000; guard++) {
        const chunk = await tab.send('IO.read', { handle, size: chunkSize }, timeoutMs);
        if (!chunk.data)
            break;
        parts.push(Buffer.from(chunk.data, 'base64'));
        if (chunk.eof)
            break;
    }
    await tab.send('IO.close', { handle }).catch(() => { });
    return new Uint8Array(Buffer.concat(parts));
}
let workDirCounter = 0;
function looksBinary(html) {
    const head = html.slice(0, 1024);
    if (head.includes('\u0000'))
        return 'it contains a null byte';
    const signatures = [
        [/^\s*%PDF-/, 'it is a PDF'],
        [/^\s*[\u0080-\u00ff]{0,4}\xff[\u00d8\u00e0]/, 'it is a JPEG'],
        [/^\s*\x89PNG\r?\n/, 'it is a PNG'],
        [/^\s*GIF8[79]a/, 'it is a GIF'],
        [/^\s*\x1f\x8b/, 'it is gzip'],
        [/^\s*PK\x03\x04/, 'it is a zip'],
        [/^\s*RIFF.{4}WEBP/, 'it is a WebP'],
        [/^\s*BM/, 'it is a BMP'],
        [/^\s*\x00\x00\x01\x00/, 'it is an icon'],
    ];
    for (const [re, what] of signatures)
        if (re.test(head))
            return what;
    return undefined;
}
function refuseUnusableRequest(req, timeoutMs) {
    const named = [req.html !== undefined, req.path !== undefined, req.url !== undefined].filter(Boolean).length;
    if (named > 1) {
        throw new Error(`the request names more than one source. give one of: html, path, url, not more than one.`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
        throw new Error(`the timeout must be at least 1000ms, got ${timeoutMs}.`);
    }
    if (req.maxImagePpi !== undefined &&
        (!Number.isInteger(req.maxImagePpi) || req.maxImagePpi < 0)) {
        throw new Error(`the image size must be a whole number of pixels, got ${req.maxImagePpi}.`);
    }
}
function deadlineWording(timedOut, timeoutMs) {
    if (!timedOut.timedOut)
        return null;
    return (`the render took longer than ${timeoutMs}ms and was cut short. the document is ` +
        `larger than the deadline allows, or the browser stopped answering.`);
}
function rethrowAsDeadline(e, timedOut, timeoutMs) {
    if (e instanceof Error && e.message === 'cdp socket closed') {
        const wording = deadlineWording(timedOut, timeoutMs);
        if (wording)
            throw new Error(wording);
    }
}
function refusePastDeadline(timedOut, timeoutMs) {
    const wording = deadlineWording(timedOut, timeoutMs);
    if (wording)
        throw new Error(wording);
}
function withPaper(request) {
    return { ...request, format: parseFormat(request.format) };
}
async function resolveSource(req, dir) {
    if (req.html != null) {
        await Bun.write((0, node_path_1.join)(dir, SERVED_DOCUMENT), req.html);
        return { html: req.html, url: `${dir}/input.html`, source: 'html' };
    }
    if (req.path) {
        const abs = req.path.startsWith('/') ? req.path : `${process.cwd()}/${req.path}`;
        const raw = await Bun.file(abs).arrayBuffer();
        const asLatin1 = Buffer.from(raw).toString('latin1');
        const binary = looksBinary(asLatin1);
        if (binary) {
            throw new Error(`this input is not HTML: ${binary}. letterpress prints html, so a document with the wrong ` +
                `file extension produces a page of binary noise rather than an error. check the path.`);
        }
        const html = new TextDecoder('utf-8').decode(raw);
        await Bun.write((0, node_path_1.join)(dir, SERVED_DOCUMENT), html);
        return { html, url: abs, source: abs };
    }
    if (req.url)
        return { html: '', url: req.url, source: req.url };
    throw new Error('render needs one of: html, path, url');
}
async function serveWorkDir(dir) {
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 10,
        async fetch(request) {
            const path = new URL(request.url).pathname;
            let name;
            try {
                name = path === '/' ? SERVED_DOCUMENT : decodeURIComponent(path.slice(1));
            }
            catch {
                return new Response('bad request', { status: 400 });
            }
            if (name.includes('\0'))
                return new Response('bad request', { status: 400 });
            const resolved = (0, node_path_1.join)(dir, name);
            if (!confinedTo(dir, name))
                return new Response('forbidden', { status: 403 });
            let file;
            try {
                file = Bun.file(resolved);
            }
            catch {
                return new Response('bad request', { status: 400 });
            }
            if (!(await file.exists()))
                return new Response('not found', { status: 404 });
            return new Response(file);
        },
    });
    return {
        origin: `http://127.0.0.1:${server.port}`,
        stop: () => {
            server.stop(true);
        },
    };
}
function stampPdf(pdf) {
    const text = new TextDecoder('latin1').decode(pdf);
    const out = new Uint8Array(pdf);
    const edits = [];
    const epoch = process.env.SOURCE_DATE_EPOCH;
    if (epoch && /^\d+$/.test(epoch)) {
        const date = new Date(Number(epoch) * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const pdfDate = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
            `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
        for (const m of text.matchAll(/D:\d{14}(?:[+\-]\d{2}'?\d{2}'?|Z)/g)) {
            if (m.index !== undefined)
                edits.push([m.index, m[0].length, pdfDate]);
        }
        const iso = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
            `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
        for (const m of text.matchAll(/<(xmp:(?:CreateDate|ModifyDate))>[^<]{0,40}<\/\1>/g)) {
            if (m.index === undefined)
                continue;
            const open = m[0].indexOf('>') + 1;
            const closeAt = m[0].lastIndexOf('</');
            edits.push([m.index + open, closeAt - open, iso]);
        }
    }
    for (const [at, length, value] of edits.sort((a, b) => b[0] - a[0])) {
        const fit = value.slice(0, length);
        for (let i = 0; i < fit.length; i++)
            out[at + i] = fit.charCodeAt(i);
        for (let i = fit.length; i < length; i++)
            out[at + i] = 0x20;
    }
    return out;
}
exports.EMPTY_INPUT_MESSAGE = 'the input is empty. a 0-byte file renders as one blank page and reports success; ' +
    'check that the file has content, or that the command producing it wrote to stdout.';
async function render(browser, request) {
    const req = withPaper(request);
    const started = Bun.nanoseconds();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    refuseUnusableRequest(req, timeoutMs);
    const tmp = normalizeDir(process.env.TMPDIR ?? '/tmp');
    const dir = (0, node_path_1.join)(tmp, `letterpress-${process.pid}-${workDirCounter++}`);
    const findings = [...noScriptFindings(req)];
    const blocked = [];
    const failedSubresources = [];
    let tab;
    let server;
    const isRemote = /^https?:/i.test(req.url ?? '');
    try {
        const prepared = await prepareSource(req, dir, isRemote, findings);
        const { src, srcUrl, fastPath, override } = prepared;
        const outsideRoot = prepared.outsideRoot;
        server = prepared.server;
        tab = await browser.newTab();
        const timedOutRef = { timedOut: false };
        const deadline = setTimeout(() => {
            timedOutRef.timedOut = true;
            void browser.closeTab(tab).catch(() => { });
        }, timeoutMs);
        try {
            await tab.send('Page.enable');
            await tab.send('Runtime.enable');
            if (req.noScript) {
                await tab.send('Emulation.setScriptExecutionDisabled', { value: true });
            }
            await tab.send('Network.enable');
            void enableFontDomains(tab);
            const alive = watchTab(tab);
            const net = await watchNetwork(tab, {
                loopback: loopbackPattern(server),
                allowNetwork: req.allowNetwork === true,
                isRemote,
                srcUrl,
                blocked,
                failedSubresources,
                auth: req.auth,
            });
            await loadDocument({
                tab,
                net,
                fastPath,
                override,
                html: src.html,
                srcUrl,
                source: src.source,
                timeoutMs,
                timedOutRef,
            });
            const page = await readPage(tab, req, timeoutMs, findings);
            const { probe, docMeta, linkDescs, roles } = page;
            const declaresPaper = await probeDeclaresPaper(tab, src.html, req, timeoutMs);
            const printableWidth = printableWidthPx(req, src.html);
            const report = await tab
                .send('Runtime.evaluate', { expression: `(${pageside_ts_1.pageSideReport})(${printableWidth})`, returnByValue: true }, timeoutMs)
                .then((r) => r.result?.value);
            const checked = checkedReport(report);
            if (checked)
                findings.push(...pageSideFindings(checked, printableWidth));
            findings.push(...scriptErrorFindings(alive.errors()));
            findings.push(...(await fontFindings(tab, timeoutMs)));
            const { raw } = await printPdf(tab, req, override, declaresPaper, timeoutMs, timedOutRef);
            findings.push(...langFinding(checked, raw));
            const pdfTitle = pdfTitleFor(req);
            const { pdf, rejected } = repairDocument({
                raw,
                linkDescs,
                roles,
                pdfTitle,
                meta: pdfMeta(req, docMeta),
                keepLigatureSpans: req.keepLigatureSpans === true,
                findings,
            });
            refusePastDeadline(timedOutRef, timeoutMs);
            pushFinding(findings, finalCheckFinding(pdf));
            pushFinding(findings, selectionFinding(pdf));
            const info = (0, pdf_ts_1.inspect)(pdf);
            if (!alive.alive()) {
                throw new Error(`the browser tab crashed while printing, most likely out of memory on a very large ` +
                    `document. the deadline would have said only that ${timeoutMs}ms passed.`);
            }
            findings.push(...metadataFindings(docMeta, req, rejected), ...assetFindings(outsideRoot, req), ...networkFindings(blocked, failedSubresources, req), ...fontMetricFindings(pdf), ...dialogFindings(alive.dialogs()));
            return {
                pdf,
                info,
                findings,
                blocked,
                ms: Math.round((Bun.nanoseconds() - started) / 1e6),
                source: src.source,
                probe,
            };
        }
        catch (e) {
            rethrowAsDeadline(e, timedOutRef, timeoutMs);
            throw e;
        }
        finally {
            clearTimeout(deadline);
        }
    }
    finally {
        if (tab)
            await browser.closeTab(tab).catch(() => { });
        server?.stop();
        await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
    }
}
function repairDocument(input) {
    const { raw, linkDescs, roles, pdfTitle, meta, keepLigatureSpans, findings } = input;
    const rejected = new Set();
    let described = gated(raw, 'ToUnicode', tounicode_ts_1.fixToUnicode, rejected, findings);
    described = gated(described, 'font descriptor', fontdesc_ts_1.fixFontDescriptors, rejected, findings);
    if (linkDescs) {
        const pairing = (0, linkdesc_ts_1.linkDescPairing)(described, linkDescs);
        if (pairing.ok) {
            described = gated(described, 'link description', (p) => (0, linkdesc_ts_1.fixLinkDescs)(p, linkDescs), rejected, findings);
        }
        else if (pairing.why === 'count') {
            findings.push({
                code: 'link-descriptions-skipped',
                severity: 'warn',
                message: `the document has ${pairing.links} link${pairing.links === 1 ? '' : 's'} in its ` +
                    `structure tree and the page gave ${pairing.descs} description` +
                    `${pairing.descs === 1 ? '' : 's'} for them, so the two could not be matched one for one ` +
                    `and none of them was written. the links are all there and they work; they have no ` +
                    `description for a screen reader.`,
            });
        }
    }
    described = repairFigures(described, rejected, findings);
    described = repairStructRoles(described, roles, rejected, findings);
    described = repairRoleMap(described, rejected, findings);
    described = repairTitle(described, pdfTitle, rejected, findings);
    described = gated(described, 'metadata', (p) => (0, meta_ts_1.addMetadata)(p, meta), rejected, findings);
    const { pdf: merged, stats: runs } = (0, tjmerge_ts_1.mergeTextRuns)(described);
    if (runs.blocks > 0) {
        findings.push({
            code: 'text-runs-merged',
            severity: 'info',
            message: runs.merged > 0
                ? `folded ${runs.merged} of ${runs.blocks} text blocks into TJ arrays, ` +
                    `${sizeChange(described.byteLength, merged.byteLength)}. the text is one item per ` +
                    `block now, which is what a reader needs to select a paragraph, and a reader that ` +
                    `measures the font's own advance rather than the position the document gave a glyph ` +
                    `may draw that glyph a fraction of a point from where the document put it` +
                    `${refusedRuns(runs.refused)}.`
                : `left all ${runs.blocks} text blocks alone: none is the shape this rewrites.`,
        });
    }
    described = merged;
    if (!keepLigatureSpans) {
        const stripped = (0, spans_ts_1.stripRedundantSpans)(described);
        const spans = stripped.stats;
        const changed = spans.stripped > 0 &&
            (stripped.pdf.length !== described.length ||
                !stripped.pdf.every((v, i) => v === described[i]));
        if (changed)
            described = stripped.pdf;
        if (spans.seen > 0)
            findings.push(ligatureSpanFinding(spans, changed));
    }
    const stamped = (0, verify_ts_1.repairOrKeep)(described, stampPdf);
    if (stamped.failures.length) {
        rejected.add('stamp');
        findings.push(rejectedRepair('title stamp', stamped.failures));
    }
    return { pdf: stamped.pdf, rejected };
}
async function printPdf(tab, req, override, declaresPaper, timeoutMs, timedOutRef) {
    const { preferCss, paperWidth, paperHeight, margin } = paperParams(req, override, declaresPaper);
    let res;
    const useStream = req.transfer === 'stream';
    try {
        res = await tab.send('Page.printToPDF', {
            printBackground: req.printBackground ?? true,
            preferCSSPageSize: preferCss,
            ...(paperWidth !== undefined
                ? {
                    paperWidth,
                    paperHeight,
                    scale: 1,
                    marginTop: margin ?? 0,
                    marginBottom: margin ?? 0,
                    marginLeft: margin ?? 0,
                    marginRight: margin ?? 0,
                }
                : {}),
            displayHeaderFooter: false,
            generateDocumentOutline: true,
            generateTaggedPDF: true,
            ...(req.pageRanges ? { pageRanges: req.pageRanges } : {}),
            transferMode: useStream ? 'ReturnAsStream' : 'ReturnAsBase64',
        }, timeoutMs);
    }
    catch (e) {
        if (timedOutRef.timedOut) {
            throw new Error(`printing exceeded the ${timeoutMs}ms deadline. A very large document needs a higher --timeout; if it dies at a few thousand pages the browser ran out of memory.`);
        }
        throw e;
    }
    const raw = useStream && res.stream
        ? await drainStream(tab, res.stream, { timeoutMs })
        : new Uint8Array(Buffer.from(res.data, 'base64'));
    return { raw, useStream };
}
function pushFinding(findings, finding) {
    if (finding)
        findings.push(finding);
}
function pageSideFindings(report, printableWidthPx) {
    const out = [];
    if (report.imagesWithoutAlt > 0) {
        out.push({
            code: 'missing-alt',
            severity: 'warn',
            message: `${report.imagesWithoutAlt} image${report.imagesWithoutAlt === 1 ? ' has' : 's have'} ` +
                `no alt attribute, so nothing describes them: a screen reader reads the file name or ` +
                `nothing at all, and a search engine sees a gap. alt="" is correct for a decorative ` +
                `image and wrong here -- an image with no alt is skipped, one with an empty alt is ` +
                `read as empty.`,
        });
    }
    if (report.imagesEmptyAlt > 0) {
        out.push({
            code: 'empty-alt',
            severity: 'warn',
            message: `${report.imagesEmptyAlt} image${report.imagesEmptyAlt === 1 ? ' has' : 's have'} ` +
                `alt="" and ${report.imagesEmptyAlt === 1 ? 'is' : 'are'} not marked decorative with ` +
                `role="presentation". a screen reader announces the image as an empty label, which is ` +
                `worse than silence -- it tells the reader something is there and gives it no name.`,
        });
    }
    if (report.figuresWithoutCaption > 0) {
        out.push({
            code: 'figure-uncaptioned',
            severity: 'warn',
            message: `${report.figuresWithoutCaption} figure element${report.figuresWithoutCaption === 1 ? '' : 's'} ` +
                `the structure cannot name. measured here, across the markup shapes: an image ` +
                `with alt text is tagged a Figure and reads the alt as its name, so a figure holding one is named ` +
                `without a caption; an image with no alt, or text content, is tagged a Figure with no name, and an ` +
                `empty figure gets no element at all. give the figure a figcaption, or describe the image with alt.`,
        });
    }
    if (printableWidthPx > 0 && report.overflowing.length > 0) {
        const widest = Math.max(...report.overflowing.map((o) => o.widthPx));
        const named = report.overflowing
            .slice(0, 3)
            .map((o) => `${o.what} at ${o.widthPx}px`)
            .join(', ');
        out.push({
            code: 'content-overflows-page',
            severity: 'warn',
            message: `${report.overflowing.length === 1 ? 'an element is' : 'elements are'} wider than the ` +
                `printable area: ${named}. the sheet is ${Math.round(printableWidthPx)}px of usable width ` +
                `and the widest is ${widest}px, so that content is clipped at the paper edge. widths are ` +
                `measured in screen layout, so an element that only print css widens is not caught here.`,
        });
    }
    return out;
}
function checkedReport(report) {
    if (!report || typeof report !== 'object')
        return undefined;
    const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const overflowing = Array.isArray(report.overflowing)
        ? report.overflowing
            .filter((o) => !!o && typeof o === 'object')
            .map((o) => ({ what: String(o.what ?? ''), widthPx: count(o.widthPx) }))
        : [];
    return {
        lang: typeof report.lang === 'string' ? report.lang : '',
        imagesWithoutAlt: count(report.imagesWithoutAlt),
        imagesEmptyAlt: count(report.imagesEmptyAlt),
        imagesDecorative: count(report.imagesDecorative),
        figuresWithoutCaption: count(report.figuresWithoutCaption),
        overflowing,
    };
}
function langFinding(report, raw) {
    if (!report || typeof report.lang !== 'string' || report.lang.trim())
        return [];
    const declared = /\/Lang\s*\(([^)]*)\)/.exec(new TextDecoder('latin1').decode(raw))?.[1];
    return [
        {
            code: 'lang-undeclared',
            severity: 'warn',
            message: `the document declares no language, so chromium stamped the pdf with ` +
                (declared
                    ? `/Lang (${declared}), which is the browser's locale rather than`
                    : 'no language at all, rather than') +
                ` the document's own. a screen reader reads the text with the wrong pronunciation and ` +
                `spell-checking is wrong too. set lang on the <html> element.`,
        },
    ];
}
async function enableFontDomains(tab) {
    await Promise.all([tab.send('DOM.enable'), tab.send('CSS.enable')]).catch(() => { });
}
async function fontFindings(tab, timeoutMs) {
    let asked;
    try {
        const { root } = (await tab.send('DOM.getDocument', {}, timeoutMs));
        asked = await tab
            .send('Runtime.evaluate', { expression: `(${pageside_ts_1.fontProbe})()`, returnByValue: true }, timeoutMs)
            .then((r) => r.result?.value ?? []);
        if (!asked.length)
            return [];
        const missed = [];
        for (const [i, want] of asked.entries()) {
            const { nodeId } = (await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-lp-font="${i}"]` }, timeoutMs));
            const used = (await tab.send('CSS.getPlatformFontsForNode', { nodeId }, timeoutMs)).fonts?.map((f) => f.familyName);
            if (used?.some((u) => u.toLowerCase() === want.family.toLowerCase()))
                continue;
            missed.push({ ...want, used: used?.join(', ') || 'nothing' });
        }
        return missed.length ? [fontFinding(missed)] : [];
    }
    catch {
        return [];
    }
    finally {
        void tab
            .send('Runtime.evaluate', {
            expression: `document.querySelectorAll('[data-lp-font]').forEach((e) => e.removeAttribute('data-lp-font'))`,
            returnByValue: true,
        })
            .catch(() => { });
    }
}
function fontFinding(missed) {
    const named = missed
        .slice(0, 3)
        .map((m) => `${m.family} (${m.elements} element${m.elements === 1 ? '' : 's'}, drawn in ${m.used})`)
        .join(', ');
    const families = missed.length === 1 ? 'family' : 'families';
    const extra = missed.length > 3 ? `, and ${missed.length - 3} more` : '';
    return {
        code: 'font-fallback',
        severity: 'warn',
        message: `the document asks for ${missed.length} font ${families} this machine does not have: ` +
            `${named}${extra}. chromium printed a substitute, so the pdf is not set in the typeface asked ` +
            `for -- line breaks and spacing follow the substitute's metrics, and so does the page count. ` +
            `ship the font as a webfont, or name one that is installed.`,
    };
}
function printableWidthPx(req, html) {
    try {
        const paperInches = paperWidthInches(req.format, html);
        const margins = marginInches(req, html);
        if (paperInches === null || margins === null)
            return 0;
        const printable = paperInches - margins * 2;
        return printable > 0 ? printable * 72 * (96 / 72) : 0;
    }
    catch {
        return 0;
    }
}
function paperWidthInches(format, html) {
    if (format)
        return exports.FORMATS[format][0];
    const declared = html ? (0, pdf_ts_1.declaredPageSize)(html) : null;
    if (!declared)
        return exports.FORMATS.a4[0];
    const named = declared.match(/^(a3|a4|a5|b4|b5|letter|legal|tabloid|ledger)\b/);
    if (named) {
        const key = named[1];
        return exports.FORMATS[key]?.[0] ?? exports.FORMATS.a4[0];
    }
    const dims = declared.match(/([\d.]+)\s*(mm|cm|in|pt|pc|px|q)\b/gi);
    return dims && dims.length >= 2 ? (0, pdf_ts_1.toInches)(dims[0]) : exports.FORMATS.a4[0];
}
function marginInches(req, html) {
    if (req.margin)
        return (0, pdf_ts_1.toInches)(req.margin);
    const declared = html ? (0, pdf_ts_1.declaredPageMargin)(html) : null;
    if (!declared)
        return 0;
    const one = declared.split(/\s+/)[0];
    return one ? (0, pdf_ts_1.toInches)(one) : 0;
}
function paperParams(req, override, declaresPaper) {
    const preferCss = override !== null || (declaresPaper && !req.format);
    const margin = req.margin ? (0, pdf_ts_1.toInches)(req.margin) : undefined;
    if (margin !== undefined && margin < 0) {
        throw new Error(`margin ${req.margin} is negative, and printToPDF refuses a negative page margin on all ` +
            `four sides. a negative margin bleeds content off the sheet, which is what @page margin does ` +
            `in a stylesheet if you need it.`);
    }
    if (preferCss)
        return { preferCss, margin };
    const paper = req.format ? exports.FORMATS[req.format] : exports.FORMATS.a4;
    const transposed = !!req.landscape;
    return {
        preferCss,
        margin,
        paperWidth: transposed ? paper[1] : paper[0],
        paperHeight: transposed ? paper[0] : paper[1],
    };
}
const NEVER = /(?!)/;
function loopbackPattern(server) {
    if (!server)
        return NEVER;
    return new RegExp(`^${server.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i');
}
function canUseFastPath(req, html, isRemote, relative) {
    if (isRemote || html == null)
        return false;
    if (req.preferFastPath === false)
        return false;
    if (relative || req.maxImagePpi)
        return false;
    return true;
}
function pdfMeta(req, docMeta) {
    return {
        author: req.author?.trim() || docMeta.author || '',
        subject: req.subject?.trim() || docMeta.subject || '',
        keywords: req.keywords?.trim() || docMeta.keywords || '',
    };
}
function dialogFindings(dialogs) {
    if (!dialogs)
        return [];
    return [
        {
            code: 'dialog-dismissed',
            severity: 'warn',
            message: `the document opened ${dialogs} modal dialog${dialogs === 1 ? '' : 's'} ` +
                `(alert, confirm or prompt) and this renderer refused ${dialogs === 1 ? 'it' : 'them'}, ` +
                `because a print job has no user to answer. a script blocked on a decision ` +
                `never finished, so the pages after that point are whatever ran next.`,
        },
    ];
}
function watchTab(tab) {
    let crashed = false;
    let dialogs = 0;
    const errors = [];
    tab.on('Page.javascriptDialogOpening', () => {
        dialogs++;
        void tab.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => { });
    });
    tab.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails;
        const text = d?.exception?.description?.split('\n')[0]?.trim() || d?.text || 'unknown error';
        if (!errors.includes(text))
            errors.push(text);
    });
    void tab
        .send('Inspector.enable')
        .then(() => {
        tab.on('Inspector.targetCrashed', () => {
            crashed = true;
        });
    })
        .catch(() => { });
    return { alive: () => !crashed, dialogs: () => dialogs, errors: () => errors };
}
function scriptErrorFindings(errors) {
    if (!errors.length)
        return [];
    return [
        {
            code: 'js-error',
            severity: 'warn',
            message: `the document threw ${errors.length === 1 ? 'an uncaught error' : `${errors.length} uncaught errors`} ` +
                `while it was being printed, and the pdf was produced anyway: ${errors.slice(0, 3).join('; ')}` +
                `${errors.length > 3 ? `; and ${errors.length - 3} more` : ''}. whatever the script was about ` +
                `to set up did not happen, so the pages may not be the document you wrote.`,
        },
    ];
}
function noScriptFindings(req) {
    if (!req.noScript)
        return [];
    return [
        {
            code: 'scripts-disabled',
            severity: 'warn',
            message: 'scripts did not run: --no-script was given, so any document logic that executes on load ' +
                'never ran and the PDF reflects the page without it. Findings that depend on a running ' +
                'script (js-error, and anything the document computes at load time) are absent for that reason.',
        },
    ];
}
function isFavicon(url) {
    return url !== undefined && /\/favicon\.ico(\?|$)/.test(url);
}
async function watchNetwork(tab, opts) {
    const { loopback, allowNetwork, isRemote, srcUrl, blocked, failedSubresources, auth } = opts;
    let mainStatus;
    let netError;
    await tab.send('Fetch.enable', {
        patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
        handleAuthRequests: auth !== undefined,
    });
    tab.on('Fetch.requestPaused', (p) => {
        const url = String(p.request?.url ?? '');
        if (loopback.test(url)) {
            void tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => { });
            return;
        }
        const proceed = allowNetwork
            ? tab.send('Fetch.continueRequest', { requestId: p.requestId })
            : (blocked.length < MAX_BLOCKED_REPORTED && blocked.push(url),
                tab.send('Fetch.failRequest', {
                    requestId: p.requestId,
                    errorReason: 'BlockedByClient',
                }));
        void proceed.catch(() => { });
    });
    if (auth) {
        tab.on('Fetch.authRequired', (p) => {
            void tab
                .send('Fetch.continueWithAuth', {
                requestId: p.requestId,
                authChallengeResponse: {
                    response: 'ProvideCredentials',
                    username: auth.username,
                    password: auth.password,
                },
            })
                .catch(() => { });
        });
    }
    if (isRemote) {
        tab.on('Network.responseReceived', (p) => {
            if (p.type === 'Document' && !mainStatus)
                mainStatus = p.response?.status;
        });
    }
    tab.on('Network.responseReceived', (p) => {
        const status = p.response?.status ?? 0;
        if (status >= 400 && p.type && p.type !== 'Document' && !isFavicon(p.response?.url)) {
            failedSubresources.push({ kind: p.type, url: `${status} ${p.response?.url ?? ''}` });
        }
    });
    const requestUrls = new Map();
    tab.on('Network.requestWillBeSent', (p) => {
        if (p.requestId && p.request?.url)
            requestUrls.set(p.requestId, p.request.url);
    });
    const recordFailure = (p) => {
        if (p.blockedReason)
            return;
        const url = p.requestId ? requestUrls.get(p.requestId) : undefined;
        if (p.type === 'Document') {
            if (url === srcUrl && !netError) {
                netError = p.errorText;
                return;
            }
            failedSubresources.push({ kind: 'Subframe', url: url ?? p.errorText ?? '' });
            return;
        }
        if (isTeardownAbort(p.errorText))
            return;
        failedSubresources.push({ kind: p.type ?? 'unknown', url: p.errorText ?? '' });
    };
    tab.on('Network.loadingFailed', recordFailure);
    return {
        mainStatus: () => mainStatus,
        netError: () => netError,
        noteNavigationError: (message) => {
            netError ??= message;
        },
    };
}
async function readPage(tab, req, timeoutMs, findings) {
    await tab.send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)',
        awaitPromise: true,
        returnByValue: true,
    }, timeoutMs);
    if (req.settleMs)
        await Bun.sleep(req.settleMs);
    if (req.beforePrint) {
        await tab.send('Runtime.evaluate', { expression: req.beforePrint, awaitPromise: true, returnByValue: true }, timeoutMs);
    }
    const probe = await runPageProbe(tab, req, timeoutMs, findings);
    const docMeta = await readDocMeta(tab, timeoutMs);
    const capped = req.maxImagePpi ? await capImageResolution(tab, req.maxImagePpi, timeoutMs) : [];
    for (const c of capped) {
        findings.push({
            code: 'image-downsampled',
            severity: 'info',
            message: `image downsampled from ${c.from}px to ${c.to}px wide, ${c.ppi}ppi down to ${req.maxImagePpi}ppi, to keep the PDF a reasonable size.`,
        });
    }
    findings.push(...(await (0, lint_ts_1.audit)(tab, timeoutMs)));
    const linkDescRaw = await tab
        .send('Runtime.evaluate', { expression: linkdesc_ts_1.LINK_DESC_JS, returnByValue: true, awaitPromise: false }, timeoutMs)
        .then((r) => r.result?.value)
        .catch(() => undefined);
    const roleRaw = await tab
        .send('Runtime.evaluate', { expression: `(${pageside_ts_1.roleCensus})()`, returnByValue: true, awaitPromise: false }, timeoutMs)
        .then((r) => r.result?.value)
        .catch(() => undefined);
    return {
        probe,
        docMeta,
        linkDescs: (0, linkdesc_ts_1.parseLinkDescs)(linkDescRaw),
        roles: (0, structroles_ts_1.parseRoleCensus)(roleRaw),
    };
}
async function runPageProbe(tab, req, timeoutMs, findings) {
    if (!req.pageProbe)
        return undefined;
    const answer = await tab
        .send('Runtime.evaluate', { expression: `(${req.pageProbe})()`, returnByValue: true }, timeoutMs)
        .catch((e) => ({ exceptionDetails: { text: String(e) } }));
    const thrown = answer?.exceptionDetails;
    if (!thrown)
        return answer?.result?.value;
    const detail = thrown.exception?.description?.split('\n')[0]?.trim() || thrown.text || 'no detail';
    findings.push({
        code: 'page-probe-failed',
        severity: 'warn',
        message: `the page probe threw in the browser: ${detail}. it returned nothing, so ` +
            `nothing downstream can tell a probe that failed from a probe that found ` +
            `nothing. this is a gap in the tool, not a finding about the document.`,
    });
    return undefined;
}
async function readDocMeta(tab, timeoutMs) {
    const stated = await tab.send('Runtime.evaluate', {
        expression: `(() => {
          const pick = (names) => {
            for (const name of names) {
              const el = document.querySelector('meta[name="' + name + '"]') ||
                document.querySelector('meta[property="' + name + '"]');
              const value = el && (el.getAttribute("content") || "").trim();
              if (value) return value;
            }
            return "";
          };
          return JSON.stringify({
            author: pick(["author", "DC.creator", "dc.creator", "article:author", "biblio_author"]),
            subject: pick(["subject", "DC.subject", "dc.subject", "description", "DC.description"]),
            keywords: pick(["keywords", "DC.subject", "citation_keywords"]),
          });
        })()`,
        returnByValue: true,
    }, timeoutMs);
    try {
        return JSON.parse(stated.result?.value ?? '{}');
    }
    catch {
        return {};
    }
}
async function prepareSource(req, dir, isRemote, findings) {
    const src = await resolveSource(req, dir);
    if (src.html != null) {
        const binary = looksBinary(src.html);
        if (binary) {
            throw new Error(`this input is not HTML: ${binary}. letterpress prints html, so a document with the wrong ` +
                `file extension produces a page of binary noise rather than an error. check the path.`);
        }
        if (!req.url && !src.html.trim()) {
            throw new Error(exports.EMPTY_INPUT_MESSAGE);
        }
        findings.push(...precedenceFindings(src.html, req));
    }
    const relative = hasRelativeAssets(src.html ?? '');
    const override = isRemote ? null : pageOverride(src.html, req);
    const fastPath = canUseFastPath(req, src.html, isRemote, relative);
    let outsideRoot = [];
    let server;
    if (!isRemote && !fastPath) {
        outsideRoot = await stageAssets(src.html, src.source, dir, req.root);
        server = await serveWorkDir(dir);
    }
    let srcUrl;
    if (fastPath)
        srcUrl = 'about:blank';
    else
        srcUrl = isRemote ? src.url : `${server.origin}/input.html`;
    if (override && !fastPath) {
        try {
            await Bun.write((0, node_path_1.join)(dir, OVERRIDE_DOCUMENT), override);
        }
        catch (e) {
            server?.stop();
            throw e;
        }
        srcUrl = `${server.origin}/override.html`;
    }
    return { src, srcUrl, fastPath, override, outsideRoot, server };
}
function selectionFinding(pdf) {
    const flow = (0, selection_ts_1.textFlow)(pdf);
    if (flow &&
        ((flow.breaks > 0 &&
            (flow.tooWide > 0 || flow.jump > 0 || flow.tooThin > 0 || flow.backwards > 0)) ||
            flow.spans > 0 ||
            flow.unreadable > 0)) {
        const why = selectionReasons(flow);
        const from = flow.read < flow.streams
            ? ` Measured on ${flow.read} of ${flow.streams} text streams; the rest were not readable.`
            : '';
        return {
            code: 'selection-fragmented',
            severity: 'warn',
            message: `a browser ends a text item at any gap over 0.6 em and draws one highlight ` +
                `box per item, so selection breaks here: ${why.join('; ')}.${from}`,
        };
    }
    return null;
}
async function loadDocument(opts) {
    const { fastPath } = opts;
    if (fastPath)
        await loadIntoFrame(opts);
    else
        await loadByNavigation(opts);
    refuseUnloaded(opts);
}
async function loadIntoFrame(opts) {
    const { tab, override, html } = opts;
    const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
    await tab.send('Page.setDocumentContent', { frameId, html: override ?? html });
}
async function loadByNavigation(opts) {
    const { tab, net, srcUrl, timeoutMs, timedOutRef } = opts;
    const loaded = tab.once('Page.loadEventFired');
    await tab.send('Page.navigate', { url: srcUrl }).catch((e) => {
        if (/ERR_/.test(e.message))
            net.noteNavigationError(e.message);
    });
    await Promise.race([
        loaded.promise,
        Bun.sleep(timeoutMs).then(() => {
            throw new Error(`__deadline__`);
        }),
    ]).catch((e) => {
        throw new Error(e.message === '__deadline__' && timedOutRef.timedOut
            ? `navigation did not finish within ${timeoutMs}ms`
            : e.message);
    });
    loaded.cancel();
}
function refuseUnloaded(opts) {
    const { net, source } = opts;
    const netErr = net.netError();
    if (netErr) {
        throw new Error(`could not load ${source}: ${netErr}`);
    }
    const status = net.mainStatus();
    if (status !== undefined && (status < 200 || status >= 300)) {
        throw new Error(`${source} returned HTTP ${status}; refusing to print the error page`);
    }
}
async function probeDeclaresPaper(tab, html, req, timeoutMs) {
    if (html)
        return (0, pdf_ts_1.declaredPageSize)(html) !== null;
    if (req.format || !req.url)
        return false;
    const probe = await tab
        .send('Runtime.evaluate', { expression: PAGE_SIZE_PROBE, returnByValue: true }, timeoutMs)
        .catch(() => null);
    return probe?.result?.value === true;
}
const PAGE_SIZE_PROBE = `(() => {
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules || []) if (/@page/i.test(r.cssText || "") && /\\bsize\\s*:/i.test(r.cssText || "")) return true;
  }
  return false;
})()`;
function pdfTitleFor(req) {
    if (req.path)
        return (0, node_path_1.basename)(req.path);
    if (req.url)
        return new URL(req.url).hostname;
    return 'document';
}
function selectionReasons(flow) {
    const why = [];
    if (flow.tooWide > 0) {
        why.push(`${flow.tooWide} word spaces stretched past it, the widest to ` +
            `${flow.widest.toFixed(2)} em -- text-align:justify on a short measure, ` +
            `or letter-spacing, can cause this`);
    }
    if (flow.jump > 0) {
        why.push(`${flow.jump} gaps of more than ${3} em, which are jumps between blocks, ` +
            `columns or cells rather than between words -- table cell padding and column gaps cause these`);
    }
    if (flow.tooThin > 0) {
        why.push(`${flow.tooThin} word spaces squeezed below it, which letter-spacing causes`);
    }
    if (flow.backwards > 0) {
        why.push(`${flow.backwards} moves back inside a line, which ends a text item -- ` +
            `right-to-left text and negative letter-spacing do this by design`);
    }
    if (flow.unreadable > 0) {
        why.push(`${flow.unreadable} glyphs in fonts with no readable advance, so no gap around them was measured`);
    }
    if (flow.spans > 0) {
        why.push(`${flow.spans} marked-content spans carrying /ActualText, each a place a ` +
            `browser may end a text item regardless of spacing. chromium emits them ` +
            `around ligatures and complex-script shaping, but not every span is one`);
    }
    return why;
}
function gated(bytes, label, repair, rejected, findings) {
    const attempt = (0, verify_ts_1.repairOrKeep)(bytes, repair);
    if (attempt.failures.length) {
        rejected.add(label);
        findings.push(rejectedRepair(label, attempt.failures));
    }
    return attempt.pdf;
}
function rejectedRepair(label, failures) {
    const named = label === 'title stamp' ? 'title stamp' : `${label} fix`;
    return {
        code: 'repair-rejected',
        severity: 'warn',
        message: `the ${named} was discarded because it did not leave a valid pdf: ` +
            `${failures.join('; ')}. the file is what the previous stage produced, ` +
            `with this fix not applied.`,
    };
}
function repairFigures(described, rejected, findings) {
    const redundant = (0, figrole_ts_1.redundantFigureCount)(described);
    if (redundant === 0)
        return described;
    const attempt = (0, verify_ts_1.repairOrKeep)(described, figrole_ts_1.fixRedundantFigures);
    if (attempt.failures.length) {
        rejected.add('figure-role');
        findings.push(rejectedRepair('figure-role', attempt.failures));
        return described;
    }
    findings.push({
        code: 'figure-role-corrected',
        severity: 'info',
        message: `${redundant} figure ${redundant === 1 ? 'element' : 'elements'} ` +
            `tagged as a grouping rather than a figure, because chromium tags both the ` +
            `figure element and the image inside it as a figure and describes only the ` +
            `image. each image keeps its own description.`,
    });
    return attempt.pdf;
}
function repairStructRoles(described, roles, rejected, findings) {
    if (roles.length === 0)
        return described;
    const plan = (0, structroles_ts_1.rolePlan)(described, roles);
    if (plan.entries.length === 0)
        return described;
    const attempt = (0, verify_ts_1.repairOrKeep)(described, (p) => (0, structroles_ts_1.applyRolePlan)(p, plan));
    if (attempt.failures.length) {
        rejected.add('struct roles');
        findings.push(rejectedRepair('struct roles', attempt.failures));
        return described;
    }
    findings.push(structRolesFinding(plan.entries.length, plan));
    return attempt.pdf;
}
function repairRoleMap(described, rejected, findings) {
    const attempt = (0, verify_ts_1.repairOrKeep)(described, (p) => (0, rolemap_ts_1.applyRoleMap)(p));
    if (attempt.failures.length) {
        rejected.add('role map');
        findings.push(rejectedRepair('role map', attempt.failures));
        return described;
    }
    if (!attempt.applied)
        return described;
    findings.push({
        code: 'role-mapped',
        severity: 'info',
        message: 'non-standard structure types emitted by chromium (Aside) were mapped to their ' +
            'standard equivalents through the structure tree RoleMap, because pdf/ua requires ' +
            'every structure type to be a standard type or a mapped one.',
    });
    return attempt.pdf;
}
function structRolesFinding(entries, plan) {
    const counts = new Map();
    for (const entry of plan.entries) {
        counts.set(entry.tag, (counts.get(entry.tag) ?? 0) + 1);
    }
    const listed = [...counts.entries()].map(([tag, n]) => `${n} <${tag}>`).join(', ');
    return {
        code: 'role-retagged',
        severity: 'info',
        message: `${entries} structure ${entries === 1 ? 'container' : 'containers'} retagged to their ` +
            `semantic structure types (${listed}), because chromium writes these elements only as ` +
            `anonymous containers and the structure tree loses the role. the repair works from the ` +
            `document's own markup: each container's text in the page stream must match the element's ` +
            `text one for one, and an element whose text the structure tree does not contain exactly ` +
            `is left as printed, as is a definition list whose items hold block elements, because ` +
            `retagging either would misstate what the document says.`,
    };
}
function repairTitle(described, pdfTitle, rejected, findings) {
    const current = (0, meta_ts_1.readDocInfo)(described).title ?? '';
    if (!current || !(0, meta_ts_1.isVolatileTitle)(current) || current === pdfTitle)
        return described;
    const attempt = (0, verify_ts_1.repairOrKeep)(described, (p) => (0, meta_ts_1.setDocTitle)(p, pdfTitle));
    if (attempt.failures.length) {
        rejected.add('document title');
        findings.push(rejectedRepair('document title', attempt.failures));
        return described;
    }
    return attempt.pdf;
}
function ligatureSpanFinding(spans, changed) {
    return {
        code: 'ligature-spans',
        severity: 'info',
        message: changed
            ? `removed ${spans.stripped} of ${spans.seen} marked-content spans carrying ` +
                `/ActualText, each of which ended a text item at every ligature. each was ` +
                `removed only because /ToUnicode already gave the same characters, so the ` +
                `extracted text is unchanged.${keptSpans(spans.kept)}`
            : spans.stripped > 0
                ? `found ${spans.stripped} removable /ActualText spans and the file came back ` +
                    `unchanged, so nothing was removed. this is a bug in letterpress, not a ` +
                    `finding about the document.`
                : `left all ${spans.seen} /ActualText spans in place: /ToUnicode does not ` +
                    `resolve them to the same text, so each is the only copy of it.`,
    };
}
function sizeChange(before, after) {
    const delta = before - after;
    if (delta === 0)
        return 'the same size';
    return delta > 0 ? `${delta} bytes smaller` : `${-delta} bytes larger`;
}
function refusedRuns(refused) {
    return refused ? `; ${refused} left alone as not simple enough to rewrite` : '';
}
function keptSpans(kept) {
    return kept ? ` ${kept} kept, being the only place their text appears.` : '';
}
function namedRoot(root) {
    return root ? `the root you named (${absRoot(root)})` : "the document's own directory";
}
function metadataFindings(docMeta, req, rejected) {
    const out = [];
    if (docMeta.author && !req.author?.trim() && !rejected.has('metadata')) {
        out.push({
            code: 'metadata-authored',
            severity: 'info',
            message: `wrote "${docMeta.author}" as the pdf author, from the document's own meta tag. pass --author to override it.`,
        });
    }
    if (docMeta.subject?.trim() && !req.subject?.trim() && !rejected.has('metadata')) {
        out.push({
            code: 'metadata-subject',
            severity: 'info',
            message: `wrote "${docMeta.subject}" as the pdf subject, from the document's own meta tag.`,
        });
    }
    return out;
}
function assetFindings(outsideRoot, req) {
    const out = [];
    const outside = outsideRoot.filter((o) => o.why === 'outside-root');
    const overDocument = outsideRoot.filter((o) => o.why === 'document');
    if (overDocument.length) {
        out.push({
            code: 'asset-overwrites-document',
            severity: 'warn',
            url: overDocument[0].abs,
            message: `${overDocument.length} referenced ${overDocument.length === 1 ? 'path is' : 'paths are'} ` +
                `named after the document itself and ${overDocument.length === 1 ? 'was' : 'were'} not staged: ` +
                `${overDocument.map((o) => o.ref).join(', ')}.\n` +
                `staging one would replace the page being printed with a different one, so the ` +
                `render would show a document nobody asked for. rename the file it points at.`,
        });
    }
    if (outside.length) {
        const listed = outside.map((o) => `  ${o.ref} -> ${o.abs}`).join('\n');
        out.push({
            code: 'asset-outside-root',
            severity: 'warn',
            url: outside[0].abs,
            message: `${outside.length} referenced ${outside.length === 1 ? 'path is' : 'paths are'} outside ` +
                `${namedRoot(req.root)}, ` +
                `so ${outside.length === 1 ? 'it was' : 'they were'} not read:\n${listed}\n` +
                `pass --root naming a directory that contains ` +
                `${outside.length === 1 ? 'it' : 'them'} to allow it.`,
        });
    }
    return out;
}
function networkFindings(blocked, failedSubresources, req) {
    const out = [];
    for (const url of blocked) {
        out.push({
            code: 'network-blocked',
            severity: 'warn',
            url,
            message: `blocked a remote request to ${url}. Pass --allow-network to permit it, or inline the asset.`,
        });
    }
    if (failedSubresources.length) {
        const seen = new Set();
        const unique = failedSubresources.filter((f) => {
            if (isFavicon(f.url))
                return false;
            if (!f.url)
                return true;
            if (seen.has(f.url))
                return false;
            seen.add(f.url);
            return true;
        });
        const kinds = [...new Set(unique.map((f) => f.kind))];
        const images = unique.filter((f) => f.kind === 'Image').length;
        const listed = [...new Set(unique.map((f) => f.url))]
            .slice(0, 5)
            .map((u) => `  ${u}`)
            .join('\n');
        out.push({
            code: 'subresource-failed',
            severity: 'warn',
            url: unique[0]?.url,
            message: `${unique.length} ${unique.length === 1 ? 'subresource' : 'subresources'} (${kinds.join(', ')}) failed to load, so the document is missing ${unique.length === 1 ? 'it' : 'them'}.\n${listed}` +
                (images
                    ? `\n${images} ${images === 1 ? 'is an image' : 'are images'}: where a picture should be, the pdf carries chromium's broken-image placeholder.`
                    : '') +
                `\nthe pdf was still produced, but it will not look like the source. url(), @import and @font-face src are staged from disk only when the document is a file.`,
        });
    }
    if (req.url && !req.allowNetwork) {
        out.push({
            code: 'url-render-blocked',
            severity: 'error',
            message: `rendering a remote URL blocks its own subresources and usually the document itself. Set allowNetwork to render ${req.url}.`,
        });
    }
    return out;
}
function fontMetricFindings(pdf) {
    const unresolved = (0, fontdesc_ts_1.unresolvedFontMetrics)(pdf);
    if (!unresolved.length)
        return [];
    const named = unresolved.map((u) => u.subtype === 'Type3'
        ? `${u.fontName} ${u.capHeight} (Type 3, whose glyphs are drawing procedures with no embedded font to read the metric from)`
        : `${u.fontName} ${u.capHeight} (${u.subtype}, emitted without an embedded font program)`);
    return [
        {
            code: 'font-metrics',
            severity: 'warn',
            message: `${unresolved.length} font descriptor${unresolved.length === 1 ? ' still carries' : 's still carry'} a negative cap height ` +
                `(${named.slice(0, 3).join(', ')}). ` +
                `The PDF specification calls a negative CapHeight an error a viewer may refuse to render text over. ` +
                `There is nothing to derive the metric from, so the value was left as produced. ` +
                `Embedding the font as a file rather than relying on a system face usually removes it.`,
        },
    ];
}
//# sourceMappingURL=render.js.map