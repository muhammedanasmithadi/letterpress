"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOLS = void 0;
exports.makeContext = makeContext;
exports.contextWith = contextWith;
exports.closeContext = closeContext;
exports.callTool = callTool;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("./browser.ts");
const findings_ts_1 = require("./findings.ts");
const pdf_ts_1 = require("./pdf.ts");
const pageside_ts_1 = require("./pageside.ts");
const render_ts_1 = require("./render.ts");
const subcommands_ts_1 = require("./subcommands.ts");
const validate_ts_1 = require("./validate.ts");
const FORMATS = Object.keys(render_ts_1.FORMATS);
const PDF_RESOURCE_LIMIT = 4 * 1024 * 1024;
function text(value) {
    return { type: 'text', text: value };
}
function failure(message) {
    return { content: [text(message)], isError: true };
}
const RENDER_SCHEMA = {
    type: 'object',
    properties: {
        html: {
            type: 'string',
            description: 'the document to print. required unless path or url is given.',
        },
        path: {
            type: 'string',
            description: 'a local .html file to print instead of a string of markup.',
        },
        url: {
            type: 'string',
            description: 'a http(s) url to print. needs allowNetwork, or the request is blocked.',
        },
        format: {
            type: 'string',
            enum: [...FORMATS],
            description: 'the paper. left out, the document declares its own @page size, and A4 when it declares none.',
        },
        landscape: {
            type: 'boolean',
            description: 'transpose the paper. a document that declares its own @page keeps its size and margin.',
        },
        margin: {
            type: 'string',
            description: 'a CSS length such as 15mm. needs format, and is ignored if the document declares @page margin.',
        },
        pageRanges: {
            type: 'string',
            description: 'print only these pages: 2-3, or 1,4-6. page numbers in a footer keep counting the whole document.',
        },
        allowNetwork: {
            type: 'boolean',
            description: 'permit remote http(s) requests instead of blocking them.',
        },
        maxImagePpi: {
            type: 'number',
            description: 'downsample images above this resolution. 300 is the print convention, 0 disables.',
        },
        settleMs: {
            type: 'number',
            description: 'extra wait after fonts resolve, in milliseconds.',
        },
        timeoutMs: {
            type: 'number',
            description: 'the render deadline, in milliseconds.',
        },
        noScript: {
            type: 'boolean',
            description: "do not run the document's JavaScript. the tool's own measurements still run.",
        },
        beforePrint: {
            type: 'string',
            description: 'JavaScript to run in the page after layout and before printing.',
        },
        root: {
            type: 'string',
            description: "the directory the document may read its assets from. defaults to the document's own directory.",
        },
        outputPath: {
            type: 'string',
            description: 'where to write the PDF. defaults to a temporary file, whose path comes back in the result.',
        },
        probe: {
            type: 'string',
            enum: ['gaps', 'fonts'],
            description: 'ask the loaded page a question of its own and get the answer in the result. ' +
                'gaps: where a browser will break a text selection, with the element and the cause. ' +
                'fonts: the families the document asked for.',
        },
        includePdf: {
            type: 'boolean',
            description: 'return the pdf bytes inline as well as writing them to disk. off by default, because a pdf is megabytes of base64.',
        },
    },
};
const VALIDATE_SCHEMA = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'the pdf to check, as a local file path.',
        },
        pdf: {
            type: 'string',
            description: 'the pdf to check, as base64. use this rather than a path when the file is not on the server machine.',
        },
    },
};
const FINDINGS_SCHEMA = {
    type: 'object',
    properties: {
        severity: {
            type: 'string',
            enum: ['error', 'warn', 'info'],
            description: 'return only the codes reported at this severity.',
        },
    },
};
exports.TOOLS = [
    {
        name: 'render_html',
        title: 'Render HTML to PDF',
        description: "Print HTML to PDF through Chromium's own print engine, and report what the document got wrong. " +
            'Returns the path the pdf was written to, the findings, and what the finished file turned out to be. ' +
            'A finding of severity error means the pdf is not the document you asked for.',
        inputSchema: RENDER_SCHEMA,
        execute: (args, ctx) => renderHtml(args, ctx),
    },
    {
        name: 'validate_pdf',
        title: 'Check an existing PDF',
        description: 'Check a pdf that already exists, without a browser: structure, tagged navigation, fonts, and the ' +
            'same findings a render would report. Use this on a file from anywhere, including one another tool wrote.',
        inputSchema: VALIDATE_SCHEMA,
        execute: (args, ctx) => validatePdf(args, ctx),
    },
    {
        name: 'page_rules',
        title: 'Explain the paper rules',
        description: "Say what the renderer would make of a document's own @page rules: the paper and margin it " +
            'declares, what --landscape would do to them, and what --format and --margin would change. ' +
            'Use this before rendering when the paper matters, and after when a document did not come out ' +
            'on the sheet you expected.',
        inputSchema: {
            type: 'object',
            properties: {
                html: { type: 'string', description: 'the document to read the page rules out of.' },
                format: {
                    type: 'string',
                    enum: FORMATS,
                    description: 'the paper to ask about, as if it were requested.',
                },
                margin: {
                    type: 'string',
                    description: 'the margin to ask about, as if it were requested.',
                },
            },
            required: ['html'],
        },
        execute: (args) => Promise.resolve(pageRules(args)),
    },
    {
        name: 'list_findings',
        title: 'List the finding codes',
        description: 'Every finding code the renderer can report, with its severity and what it means. Call this when a ' +
            'code appears in a result and you need to know whether it is a fault in the document or a note about it.',
        inputSchema: FINDINGS_SCHEMA,
        execute: (args) => listFindings(args),
    },
];
async function makeContext() {
    const workDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-mcp-'));
    const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-mcp-profile-'));
    let browser;
    return {
        workDir,
        outputCount: 0,
        browser: async () => {
            if (!browser)
                browser = await browser_ts_1.Browser.launch({ profile });
            return browser;
        },
        close: async () => {
            await browser?.close();
            await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
        },
    };
}
function contextWith(browser, workDir, sandbox) {
    return { browser: async () => browser, workDir, sandbox, outputCount: 0 };
}
async function closeContext(ctx) {
    await ctx.close?.();
    await (0, promises_1.rm)(ctx.workDir, { recursive: true, force: true }).catch(() => { });
}
async function callTool(name, args, ctx) {
    const tool = exports.TOOLS.find((t) => t.name === name);
    if (!tool)
        return null;
    return tool.execute(args, ctx);
}
function probeFor(name) {
    if (name === 'gaps')
        return pageside_ts_1.wideGaps;
    if (name === 'fonts')
        return pageside_ts_1.fontProbe;
    return undefined;
}
function pageRules(args) {
    const html = stringArg(args, 'html');
    if (html === undefined)
        return failure('page_rules needs the html to read.');
    const analysis = (0, subcommands_ts_1.pageAnalysis)(html, 'the document', stringArg(args, 'format'), stringArg(args, 'margin'));
    const declared = analysis.declared;
    const lines = [
        `declared size: ${declared.size ?? '(none)'}`,
        `declared margin: ${declared.margin ?? '(none)'}`,
        `declared orientation: ${declared.orientation ?? '(none)'}`,
        `@page rules: ${declared.rules.length}`,
        ...declared.rules.map((r) => `  ${r}`),
        `with --landscape: ${analysis['landscape']}`,
    ];
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: analysis,
    };
}
function findingLine(f) {
    return `${f.severity}: ${f.code} -- ${f.message}`;
}
async function renderUnderSandbox(request, ctx) {
    const refused = refuseForSandbox(request, ctx);
    if (refused !== null)
        return { refused };
    const sandbox = ctx.sandbox;
    if (sandbox !== undefined) {
        const slot = sandbox.acquire();
        if (slot === null)
            return { refused: 'the renderer is busy; try again shortly' };
        try {
            await slot;
        }
        catch {
            return { refused: 'the server is shutting down' };
        }
    }
    try {
        const browser = await ctx.browser();
        const result = await (0, render_ts_1.render)(browser, request);
        if (sandbox !== undefined && result.info.pages > sandbox.maxPages) {
            return {
                refused: `this document is ${result.info.pages} pages, over the ${sandbox.maxPages}-page limit. ` +
                    `split it, or render it with the cli, which has no page limit.`,
            };
        }
        return { result };
    }
    catch (e) {
        return { refused: `the render failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    finally {
        if (sandbox !== undefined)
            sandbox.release();
    }
}
function refuseForSandbox(request, ctx) {
    const sandbox = ctx.sandbox;
    if (sandbox === undefined)
        return null;
    if (request.path !== undefined) {
        return 'a file on the server is not read; send the html instead';
    }
    if (request.root !== undefined) {
        return 'a directory to read assets from is not accepted; send the html instead';
    }
    if (request.url !== undefined) {
        return 'a url is not fetched; send the html instead';
    }
    if (request.settleMs !== undefined && request.settleMs > sandbox.maxSettleMs) {
        request.settleMs = sandbox.maxSettleMs;
    }
    if (request.timeoutMs !== undefined && request.timeoutMs > sandbox.maxTimeoutMs) {
        request.timeoutMs = sandbox.maxTimeoutMs;
    }
    return null;
}
function nextOutputName(ctx) {
    ctx.outputCount += 1;
    return `output-${ctx.outputCount}.pdf`;
}
const OUTPUT_MAX_AGE_MS = 60 * 60 * 1000;
async function sweepOlderOutputs(ctx, keep) {
    let entries;
    try {
        entries = await (0, promises_1.readdir)(ctx.workDir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (!name.startsWith('output-'))
            continue;
        const path = (0, node_path_1.join)(ctx.workDir, name);
        if (path === keep)
            continue;
        try {
            if (ctx.sandbox === undefined) {
                await (0, promises_1.rm)(path, { force: true });
                continue;
            }
            const info = await (0, promises_1.stat)(path);
            if (Date.now() - info.mtimeMs < OUTPUT_MAX_AGE_MS)
                continue;
            await (0, promises_1.rm)(path, { force: true });
        }
        catch { }
    }
}
function confineRead(path, ctx) {
    const root = ctx.sandbox?.root;
    if (root === undefined)
        return null;
    const base = realpathOf(root);
    const target = realpathOf((0, node_path_1.resolve)(path));
    if (target !== base && !target.startsWith(base + node_path_1.sep)) {
        return `only a pdf inside ${root} can be read, not ${path}`;
    }
    return null;
}
function confineOutput(out, ctx) {
    const root = ctx.sandbox?.root;
    if (root === undefined)
        return null;
    const base = realpathOf(root);
    const target = realpathOf((0, node_path_1.resolve)(out));
    if (target !== base && !target.startsWith(base + node_path_1.sep)) {
        return `the pdf can only be written inside ${root}, not ${out}`;
    }
    return null;
}
function realpathOf(path) {
    const full = (0, node_path_1.resolve)(path);
    const parts = full.split(node_path_1.sep).filter(Boolean);
    let at = node_path_1.sep;
    for (const part of parts) {
        at = (0, node_path_1.join)(at, part);
        const link = linkTarget(at);
        if (link !== null)
            at = realpathOf(link);
    }
    return at;
}
function linkTarget(path) {
    try {
        if (!(0, node_fs_1.lstatSync)(path).isSymbolicLink())
            return null;
        return (0, node_path_1.resolve)((0, node_path_1.dirname)(path), (0, node_fs_1.readlinkSync)(path));
    }
    catch {
        return null;
    }
}
function stringArg(args, key) {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
}
function numberArg(args, key) {
    const v = args[key];
    return typeof v === 'number' ? v : undefined;
}
function boolArg(args, key) {
    return args[key] === true;
}
function numberArgs(args) {
    const timeoutMs = numberArg(args, 'timeoutMs');
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
        return { error: 'timeoutMs must be a whole number of at least 1000.' };
    }
    const settleMs = numberArg(args, 'settleMs');
    if (settleMs !== undefined && (!Number.isInteger(settleMs) || settleMs < 0)) {
        return { error: 'settleMs must be a whole number, zero or more.' };
    }
    const maxImagePpi = numberArg(args, 'maxImagePpi');
    if (maxImagePpi !== undefined && (!Number.isInteger(maxImagePpi) || maxImagePpi < 0)) {
        return { error: 'maxImagePpi must be a whole number, zero or more.' };
    }
    return { maxImagePpi, settleMs, timeoutMs };
}
function renderRequestFrom(args) {
    const html = stringArg(args, 'html');
    const path = stringArg(args, 'path');
    const url = stringArg(args, 'url');
    if (!html && !path && !url) {
        return { request: {}, error: 'render_html needs one of: html, path, url.' };
    }
    const format = stringArg(args, 'format');
    if (format !== undefined && !FORMATS.includes(format.trim().toLowerCase())) {
        return { request: {}, error: `format must be one of ${FORMATS.join(', ')}, got "${format}".` };
    }
    const margin = stringArg(args, 'margin');
    if (margin !== undefined && format === undefined) {
        return {
            request: {},
            error: "margin only applies with format, because the document's own @page wins otherwise.",
        };
    }
    const probe = stringArg(args, 'probe');
    if (probe !== undefined && probe !== 'gaps' && probe !== 'fonts') {
        return { request: {}, error: `probe must be one of gaps, fonts, got "${probe}".` };
    }
    const numbers = numberArgs(args);
    if (numbers.error !== undefined)
        return { request: {}, error: numbers.error };
    const pageRanges = stringArg(args, 'pageRanges');
    if (pageRanges !== undefined) {
        const problem = (0, render_ts_1.pageRangesProblem)(pageRanges);
        if (problem !== null) {
            return { request: {}, error: `pageRanges must be a string like "1-3": ${problem}` };
        }
    }
    return {
        request: {
            html,
            path,
            url,
            pageProbe: probeFor(probe),
            format: format?.trim().toLowerCase(),
            landscape: boolArg(args, 'landscape'),
            margin,
            pageRanges,
            allowNetwork: boolArg(args, 'allowNetwork'),
            maxImagePpi: numbers.maxImagePpi,
            settleMs: numbers.settleMs,
            timeoutMs: numbers.timeoutMs,
            noScript: boolArg(args, 'noScript'),
            beforePrint: stringArg(args, 'beforePrint'),
            root: stringArg(args, 'root'),
        },
    };
}
async function renderHtml(args, ctx) {
    const { request, error } = renderRequestFrom(args);
    if (error !== undefined)
        return failure(error);
    const requested = stringArg(args, 'outputPath');
    const out = requested !== undefined && requested.trim() !== ''
        ? requested
        : (0, node_path_1.join)(ctx.workDir, nextOutputName(ctx));
    const confined = confineOutput(out, ctx);
    if (confined !== null)
        return failure(confined);
    const rendered = await renderUnderSandbox(request, ctx);
    if ('refused' in rendered)
        return failure(rendered.refused);
    const result = rendered.result;
    try {
        await (0, promises_1.writeFile)(out, result.pdf);
        await sweepOlderOutputs(ctx, out);
    }
    catch (e) {
        return failure(`the pdf could not be written to ${out}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const errors = result.findings.filter((f) => f.severity === 'error');
    const lines = result.findings.map(findingLine);
    const summary = `wrote ${out} -- ${result.info.pages} page${result.info.pages === 1 ? '' : 's'}, ` +
        `${result.pdf.byteLength} bytes, ${result.ms}ms` +
        (errors.length ? `, ${errors.length} error-severity finding(s)` : ', no errors');
    const content = [
        text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary),
    ];
    if (result.probe !== undefined) {
        content.push(text(`probe: ${JSON.stringify(result.probe)}`));
    }
    const structured = {
        ok: errors.length === 0,
        path: out,
        pages: result.info.pages,
        bytes: result.pdf.byteLength,
        ms: result.ms,
        tagged: result.info.tagged,
        pageSizes: result.info.pageSizes,
        findings: result.findings,
        ...(result.probe === undefined ? {} : { probe: result.probe }),
    };
    if (boolArg(args, 'includePdf')) {
        if (result.pdf.byteLength <= PDF_RESOURCE_LIMIT) {
            content.push({
                type: 'resource',
                resource: {
                    uri: `file://${out}`,
                    mimeType: 'application/pdf',
                    blob: Buffer.from(result.pdf).toString('base64'),
                },
            });
        }
        else {
            content.push(text(`the pdf is ${(result.pdf.byteLength / 1048576).toFixed(1)}MB, over the ` +
                `${PDF_RESOURCE_LIMIT / 1048576}MB limit for sending it inline. it was written to ${out}.`));
        }
    }
    return { content, structuredContent: structured };
}
function decodeBase64(text) {
    const packed = text.replace(/\s+/g, '');
    if (packed.length === 0)
        return new Uint8Array();
    if (packed.length % 4 !== 0)
        return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed))
        return null;
    return new Uint8Array(Buffer.from(packed, 'base64'));
}
async function validatePdf(args, ctx) {
    const path = typeof args.path === 'string' ? args.path : undefined;
    const encoded = typeof args.pdf === 'string' ? args.pdf : undefined;
    if (!path && !encoded)
        return failure('validate_pdf needs a path to a pdf file, or the pdf itself as base64.');
    let bytes;
    if (encoded !== undefined) {
        const decoded = decodeBase64(encoded);
        if (decoded === null)
            return failure('the pdf is not base64.');
        bytes = decoded;
    }
    else {
        const confined = confineRead(path, ctx);
        if (confined !== null)
            return failure(confined);
        try {
            bytes = new Uint8Array(await (0, promises_1.readFile)(path));
        }
        catch (e) {
            return failure(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const result = (0, validate_ts_1.validate)(bytes);
    const info = (0, pdf_ts_1.inspect)(bytes);
    const lines = result.findings.map(findingLine);
    const name = path ?? 'the pdf';
    const summary = `${name} -- ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}, ` +
        `${result.ok ? 'ok' : 'not ok'}, ${info.pages} page${info.pages === 1 ? '' : 's'}` +
        (info.tagged ? ', tagged' : ', untagged');
    return {
        content: [text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary)],
        structuredContent: {
            ok: result.ok,
            path: path ?? null,
            bytes: bytes.byteLength,
            pages: info.pages,
            tagged: info.tagged,
            pageSizes: info.pageSizes,
            findings: result.findings,
        },
    };
}
const SEVERITIES = ['error', 'warn', 'info'];
async function listFindings(args) {
    const raw = typeof args.severity === 'string' ? args.severity : undefined;
    if (raw !== undefined && !SEVERITIES.includes(raw)) {
        return failure(`severity must be error, warn or info, got "${raw}".`);
    }
    const severity = raw;
    const codes = severity ? (0, findings_ts_1.codesAt)(severity) : findings_ts_1.FINDING_CODES;
    const list = codes.map((code) => ({ code, ...findings_ts_1.FINDINGS[code] }));
    const text_ = list.map((f) => `${f.severity}: ${f.code} -- ${f.summary}`);
    return {
        content: [text(text_.join('\n'))],
        structuredContent: { count: list.length, findings: list },
    };
}
//# sourceMappingURL=mcptools.js.map