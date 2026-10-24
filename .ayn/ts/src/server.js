"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.limitFromEnv = limitFromEnv;
exports.startServer = startServer;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("./browser.ts");
const findings_ts_1 = require("./findings.ts");
const mcp_ts_1 = require("./mcp.ts");
const mcptools_ts_1 = require("./mcptools.ts");
const render_ts_1 = require("./render.ts");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SUPPORTED_VERSIONS = [mcp_ts_1.MODERN_VERSION, ...mcp_ts_1.LEGACY_VERSIONS];
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;
const warnToStderr = (message) => {
    process.stderr.write(`${message}\n`);
};
function limitFromEnv(name, fallback, min = 1, warn = warnToStderr) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
        warn(`letterpress: ${name}=${JSON.stringify(raw)} is not a number of at least ${min}; ` +
            `using ${fallback}`);
        return fallback;
    }
    return Math.floor(value);
}
const MAX_CONCURRENT_RENDERS = limitFromEnv('HTML2PDF_MAX_RENDERS', 4);
const MAX_QUEUED_RENDERS = limitFromEnv('HTML2PDF_MAX_QUEUE', 16);
const MAX_TIMEOUT_MS = 120_000;
const MAX_SETTLE_MS = 30_000;
const MAX_PAGES = limitFromEnv('HTML2PDF_MAX_PAGES', 6000);
const STOPPING_MESSAGE = 'the server is shutting down. this render was still queued and was never started; ' +
    'retry it against the new instance.';
function normalizeAuth(raw) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw === 'string') {
        const i = raw.indexOf(':');
        if (i < 0)
            return undefined;
        return { username: raw.slice(0, i), password: raw.slice(i + 1) };
    }
    if (typeof raw === 'object') {
        const r = raw;
        if (typeof r.username === 'string' && typeof r.password === 'string') {
            return { username: r.username, password: r.password };
        }
    }
    return undefined;
}
class ServerStopping extends Error {
    constructor() {
        super(STOPPING_MESSAGE);
        this.name = 'ServerStopping';
    }
}
function originAllowed(request, port) {
    const origin = request.headers.get('origin');
    if (origin !== null) {
        let parsed;
        try {
            parsed = new URL(origin);
        }
        catch {
            return false;
        }
        if (parsed.protocol !== 'http:')
            return false;
        if (!hostAllowed(parsed.host))
            return false;
        if (parsed.port !== String(port))
            return false;
    }
    const site = request.headers.get('sec-fetch-site');
    if (site === 'cross-site' || site === 'same-site')
        return false;
    return true;
}
function hostAllowed(host) {
    if (host === null)
        return true;
    if (!LOOPBACK_HOST.test(host))
        return false;
    const bracketed = /^\[[0-9a-f:]+\](?::(\d{1,5}))?$/i.exec(host);
    if (bracketed)
        return !bracketed[1] || Number(bracketed[1]) <= 65535;
    const colon = host.lastIndexOf(':');
    if (colon === -1)
        return true;
    const port = host.slice(colon + 1);
    return /^\d{1,5}$/.test(port) && Number(port) <= 65535;
}
function checkPathHtml(body) {
    if (body.path !== undefined)
        return 'path is not accepted. send the html.';
    if (typeof body.html !== 'string')
        return 'send html as a string';
    return null;
}
function checkEmpty(body) {
    if (typeof body.html === 'string' && !body.html.trim())
        return render_ts_1.EMPTY_INPUT_MESSAGE;
    return null;
}
function checkFormat(body) {
    if (body.format !== undefined && typeof body.format !== 'string') {
        return `format must be a string, got ${Array.isArray(body.format) ? 'array' : typeof body.format}`;
    }
    const format = typed(body.format);
    if (format !== undefined && !Object.hasOwn(render_ts_1.FORMATS, String(format).toLowerCase())) {
        return `unknown format "${format}". try: ${Object.keys(render_ts_1.FORMATS).join(', ')}`;
    }
    return null;
}
function checkPageRanges(body) {
    if (body.pageRanges !== undefined && typeof body.pageRanges !== 'string') {
        return 'pageRanges must be a string like "1-3"';
    }
    if (typeof body.pageRanges !== 'string')
        return null;
    const problem = (0, render_ts_1.pageRangesProblem)(body.pageRanges);
    if (problem !== null)
        return `pageRanges must be a string like "1-3": ${problem}`;
    return null;
}
function checkMargin(body) {
    if (body.margin === undefined)
        return null;
    if (typeof body.margin !== 'string')
        return 'margin must be a string like "15mm"';
    const m = body.margin.trim();
    const isLength = /^0(?:\.0+)?$/.test(m) || /^-?\d*\.?\d+(mm|cm|in|pt|px|pc|q)$/.test(m);
    if (m && !isLength) {
        return (`margin "${body.margin}" is not an absolute css length. use mm, cm, in, pt, pc, ` +
            `px or a bare 0, such as 15mm or 1in. relative units like em and vw depend on layout ` +
            `and cannot be resolved before the page is printed.`);
    }
    const format = typed(body.format);
    if (!Object.hasOwn(render_ts_1.FORMATS, String(format ?? '').toLowerCase())) {
        return ("margin only applies alongside format, because a document's own @page margin wins otherwise. " +
            'send format too, or drop the margin.');
    }
    return null;
}
function checkFlags(body) {
    for (const key of ['printBackground', 'allowNetwork', 'landscape']) {
        if (body[key] !== undefined && typeof body[key] !== 'boolean') {
            return `${key} must be true or false`;
        }
    }
    return null;
}
function checkNumbers(body) {
    for (const key of ['maxImagePpi', 'settleMs', 'timeoutMs']) {
        if (body[key] === undefined || body[key] === null)
            continue;
        if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
            return `${key} must be a number`;
        }
    }
    return null;
}
function checkResponseFormat(body) {
    if (body.responseFormat !== undefined &&
        body.responseFormat !== null &&
        body.responseFormat !== 'json' &&
        body.responseFormat !== 'pdf') {
        return `responseFormat must be "json" or "pdf", got "${String(body.responseFormat)}"`;
    }
    return null;
}
function checkMeta(body) {
    for (const key of ['author', 'subject', 'keywords']) {
        if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
            return `${key} must be a string`;
        }
    }
    return null;
}
function clamp(value, max, fallback) {
    const n = typed(value);
    if (typeof n !== 'number' || !Number.isFinite(n))
        return fallback;
    return Math.min(Math.max(n, 0), max);
}
function deadline(value) {
    const n = typed(value);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1)
        return undefined;
    return Math.min(n, MAX_TIMEOUT_MS);
}
function invalidBody(body) {
    const checks = [
        checkPathHtml,
        checkEmpty,
        checkFormat,
        checkPageRanges,
        checkMargin,
        checkFlags,
        checkNumbers,
        checkResponseFormat,
        checkMeta,
    ];
    for (const check of checks) {
        const message = check(body);
        if (message)
            return message;
    }
    return null;
}
function pdfResponse(result) {
    const errors = result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    const headers = new Headers({
        'content-type': 'application/pdf',
        'content-length': String(result.pdf.byteLength),
        'x-letterpress-pages': String(result.info.pages),
        'x-letterpress-ms': String(result.ms),
        'x-letterpress-tagged': String(result.info.tagged),
        'x-letterpress-findings': String(result.findings.length),
        'x-letterpress-errors': errors.join(','),
    });
    return new Response(result.pdf, {
        status: 200,
        headers,
    });
}
function badRequest(message) {
    return Response.json({ ok: false, error: message }, { status: 400 });
}
async function mcpResponse(request, session) {
    const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (type !== 'application/json') {
        return mcpError(null, -32600, `send content-type: application/json, not "${type || 'nothing'}"`, 415);
    }
    const read = await readCapped(request, MAX_BODY_BYTES);
    if ('tooBig' in read) {
        return mcpError(null, -32600, `the body is ${(read.tooBig / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`, 413);
    }
    if ('broken' in read) {
        return mcpError(null, -32700, 'the body stream ended early');
    }
    let msg;
    try {
        msg = JSON.parse(read.text);
    }
    catch (e) {
        return mcpError(null, -32700, `the body is not JSON: ${e.message}`);
    }
    if (msg === null || typeof msg !== 'object') {
        return mcpError(null, -32600, 'the body must be a JSON-RPC message');
    }
    const requested = requestedVersion(request, msg);
    if (requested !== null && !SUPPORTED_VERSIONS.includes(requested)) {
        return mcpError(idOf(msg), -32022, 'Unsupported protocol version', 400, {
            supported: SUPPORTED_VERSIONS,
            requested,
        });
    }
    if (!Array.isArray(msg)) {
        const mismatch = headerMismatch(request, msg);
        if (mismatch)
            return mcpError(idOf(msg), -32020, mismatch);
    }
    const reply = await (0, mcp_ts_1.handle)(session, msg, request.headers.get('mcp-protocol-version'));
    if (reply === null || (Array.isArray(reply) && reply.length === 0)) {
        return new Response(null, { status: 202 });
    }
    return Response.json(reply, { headers: { 'cache-control': 'no-store' } });
}
function idOf(msg) {
    const id = msg['id'];
    return typeof id === 'string' || typeof id === 'number' ? id : null;
}
function headerMismatch(request, msg) {
    const method = String(msg['method'] ?? '');
    const headerMethod = request.headers.get('mcp-method');
    if (headerMethod !== null && headerMethod !== method) {
        return `Mcp-Method header value '${headerMethod}' does not match body value '${method}'`;
    }
    const name = msg['params']?.['name'];
    const headerName = request.headers.get('mcp-name');
    if (headerName !== null && headerName !== String(name ?? '')) {
        return `Mcp-Name header value '${headerName}' does not match body value '${String(name ?? '')}`;
    }
    const headerVersion = request.headers.get('mcp-protocol-version');
    const bodyVersion = msg['params']?.['_meta'];
    const declared = bodyVersion?.['io.modelcontextprotocol/protocolVersion'];
    if (headerVersion !== null && typeof declared === 'string') {
        const sent = decodeHeaderValue(headerVersion);
        if (sent !== declared) {
            return `MCP-Protocol-Version header value '${headerVersion}' does not match body value '${declared}'`;
        }
    }
    const param = paramMismatch(request, msg);
    if (param !== null)
        return param;
    return null;
}
function decodeHeaderValue(value) {
    const m = /^=\?base64\?(.*)\?=$/.exec(value);
    if (!m)
        return value;
    try {
        return Buffer.from(m[1], 'base64').toString('utf8');
    }
    catch {
        return value;
    }
}
function paramMismatch(request, msg) {
    const args = msg['params']?.['arguments'];
    let problem = null;
    request.headers.forEach((value, name) => {
        if (problem !== null)
            return;
        if (!name.toLowerCase().startsWith('mcp-param-'))
            return;
        const key = name.slice('mcp-param-'.length);
        const sent = decodeHeaderValue(value);
        const inBody = args?.[key];
        if (inBody === undefined) {
            problem = `${name} header value '${value}' has no counterpart in the body`;
            return;
        }
        if (String(inBody) !== sent) {
            problem = `${name} header value '${value}' does not match body value '${String(inBody)}'`;
        }
    });
    return problem;
}
function requestedVersion(request, msg) {
    const header = request.headers.get('mcp-protocol-version');
    if (header !== null)
        return decodeHeaderValue(header);
    const body = msg['params']?.['_meta'];
    const declared = body?.['io.modelcontextprotocol/protocolVersion'];
    if (typeof declared === 'string')
        return declared;
    const legacy = msg['params']?.['protocolVersion'];
    return typeof legacy === 'string' ? legacy : null;
}
function mcpError(id, code, message, status = 400, data) {
    return Response.json({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }, { status, headers: { 'cache-control': 'no-store' } });
}
function typed(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : undefined;
}
async function readCapped(request, cap) {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > cap)
        return { tooBig: declared };
    if (!request.body)
        return { text: '' };
    const reader = request.body.getReader();
    const parts = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > cap) {
                await reader.cancel().catch(() => { });
                return { tooBig: total };
            }
            parts.push(value);
        }
    }
    catch (e) {
        return { broken: e instanceof Error ? e.message : String(e) };
    }
    return { text: Buffer.concat(parts).toString('utf8') };
}
async function startServer(opts = {}) {
    const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-server-'));
    let browser;
    try {
        browser = await browser_ts_1.Browser.launch({
            profile,
            extraArgs: opts.browserArgs,
        });
    }
    catch (e) {
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
        throw e;
    }
    opts.onReady?.(browser);
    const mcpWorkDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-mcp-'));
    const viewerDir = (0, node_path_1.join)(import.meta.dir, '..', 'viewer');
    let active = 0;
    let queued = 0;
    let stopping = false;
    const waiters = [];
    const acquire = () => {
        if (stopping)
            return Promise.reject(new ServerStopping());
        if (active < MAX_CONCURRENT_RENDERS) {
            active++;
            return Promise.resolve();
        }
        if (queued >= MAX_QUEUED_RENDERS)
            return null;
        queued++;
        return new Promise((resolve, reject) => {
            waiters.push(() => {
                queued--;
                if (stopping)
                    reject(new ServerStopping());
                else {
                    active++;
                    resolve();
                }
            });
        });
    };
    const release = () => {
        active--;
        waiters.shift()?.();
    };
    const mcpSandbox = {
        root: mcpWorkDir,
        maxPages: MAX_PAGES,
        maxSettleMs: MAX_SETTLE_MS,
        maxTimeoutMs: MAX_TIMEOUT_MS,
        acquire,
        release,
    };
    const mcpSession = { context: (0, mcptools_ts_1.contextWith)(browser, mcpWorkDir, mcpSandbox) };
    const inFlight = new Set();
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: opts.port ?? 8787,
        idleTimeout: 30,
        async fetch(request) {
            const refused = refusedBy(request);
            if (refused !== null)
                return refused;
            let url;
            try {
                url = new URL(request.url);
            }
            catch {
                return badRequest('could not parse the request url');
            }
            try {
                if (url.pathname === '/health') {
                    return healthRoute();
                }
                if (url.pathname === '/mcp') {
                    if (request.method !== 'POST') {
                        return Response.json({ ok: false, error: 'the mcp endpoint takes POST' }, { status: 405 });
                    }
                    const mcpWork = mcpResponse(request, mcpSession);
                    inFlight.add(mcpWork);
                    try {
                        return await mcpWork;
                    }
                    finally {
                        inFlight.delete(mcpWork);
                    }
                }
                if (url.pathname === '/findings') {
                    return findingsRoute();
                }
                if (url.pathname === '/' || url.pathname === '/index.html') {
                    return viewerRoute();
                }
                if (url.pathname.startsWith('/assets/')) {
                    return assetRoute(url.pathname);
                }
                if (url.pathname === '/render') {
                    if (request.method !== 'POST')
                        return new Response('not found', { status: 404 });
                    return renderRoute(request);
                }
                return new Response('not found', { status: 404 });
            }
            catch (e) {
                return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
            }
        },
    });
    function renderWithBody(body, format) {
        return (0, render_ts_1.render)(browser, {
            html: body.html,
            format: format,
            landscape: body.landscape === true,
            margin: typeof body.margin === 'string' ? body.margin.trim() || undefined : undefined,
            printBackground: body.printBackground !== false,
            allowNetwork: body.allowNetwork === true,
            author: typeof body.author === 'string' ? body.author.trim() || undefined : undefined,
            subject: typeof body.subject === 'string' ? body.subject.trim() || undefined : undefined,
            keywords: typeof body.keywords === 'string' ? body.keywords.trim() || undefined : undefined,
            auth: normalizeAuth(body.auth),
            pageRanges: body.pageRanges,
            maxImagePpi: clamp(body.maxImagePpi, 1200, undefined),
            settleMs: clamp(body.settleMs, MAX_SETTLE_MS, undefined),
            timeoutMs: deadline(body.timeoutMs),
            transfer: 'stream',
        });
    }
    async function renderBody(request) {
        const read = await readCapped(request, MAX_BODY_BYTES);
        if ('tooBig' in read) {
            return {
                refused: Response.json({
                    ok: false,
                    error: `document is ${(read.tooBig / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
                }, { status: 413 }),
            };
        }
        if ('broken' in read) {
            return { refused: badRequest(`body stream ended early: ${read.broken}`) };
        }
        let body;
        try {
            body = JSON.parse(read.text);
        }
        catch (e) {
            return { refused: badRequest(`body is not valid JSON: ${e.message}`) };
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return { refused: badRequest('body must be a JSON object') };
        }
        const invalid = invalidBody(body);
        if (invalid)
            return { refused: badRequest(invalid) };
        return { body };
    }
    function refusedBy(request) {
        if (!hostAllowed(request.headers.get('host'))) {
            return Response.json({
                ok: false,
                error: 'this server only answers requests addressed to loopback',
            }, { status: 403 });
        }
        if (!originAllowed(request, server.port ?? 0)) {
            return Response.json({
                ok: false,
                error: 'this server only answers its own viewer, not other web pages',
            }, { status: 403 });
        }
        return null;
    }
    async function healthRoute() {
        const alive = await browser.alive();
        return Response.json({ ok: alive, port: server.port, chromium: alive }, { status: alive ? 200 : 503 });
    }
    function findingsRoute() {
        return Response.json({
            findings: findings_ts_1.FINDING_CODES.map((code) => ({ code, ...findings_ts_1.FINDINGS[code] })),
            formats: Object.keys(render_ts_1.FORMATS),
        }, { headers: { 'cache-control': 'no-store' } });
    }
    async function viewerRoute() {
        const file = Bun.file((0, node_path_1.join)(viewerDir, 'index.html'));
        if (!(await file.exists())) {
            return new Response('viewer not built yet', { status: 404 });
        }
        return new Response(file, {
            headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            },
        });
    }
    async function assetRoute(pathname) {
        const name = pathname.slice('/assets/'.length);
        const target = (0, node_path_1.join)(viewerDir, name);
        if (!target.startsWith(viewerDir + '/')) {
            return new Response('forbidden', { status: 403 });
        }
        if (name.length > 512 || name.includes('\0')) {
            return new Response('not found', { status: 404 });
        }
        const file = Bun.file(target);
        if (!(await file.exists()))
            return new Response('not found', { status: 404 });
        const ext = target.slice(target.lastIndexOf('.'));
        const type = ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.js' || ext === '.mjs'
                ? 'text/javascript; charset=utf-8'
                : ext === '.css'
                    ? 'text/css; charset=utf-8'
                    : ext === '.json'
                        ? 'application/json'
                        : undefined;
        return new Response(file, type
            ? {
                headers: {
                    'content-type': type,
                    'cache-control': 'no-store',
                },
            }
            : { headers: { 'cache-control': 'no-store' } });
    }
    async function renderRoute(request) {
        try {
            const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
            if (type !== 'application/json') {
                return Response.json({
                    ok: false,
                    error: `send content-type: application/json, not "${type || 'nothing'}"`,
                }, { status: 415 });
            }
            if (active >= MAX_CONCURRENT_RENDERS && queued >= MAX_QUEUED_RENDERS) {
                return Response.json({
                    ok: false,
                    error: `${MAX_CONCURRENT_RENDERS} renders are running and ${MAX_QUEUED_RENDERS} are queued, which is the limit. retry shortly.`,
                }, { status: 429, headers: { 'retry-after': '2' } });
            }
            const read = await renderBody(request);
            if ('refused' in read)
                return read.refused;
            const body = read.body;
            const format = typed(body.format);
            const slot = acquire();
            if (!slot) {
                return Response.json({
                    ok: false,
                    error: `the render queue filled up while this request was being read. retry shortly.`,
                }, { status: 429, headers: { 'retry-after': '2' } });
            }
            try {
                await slot;
            }
            catch (e) {
                if (!(e instanceof ServerStopping))
                    throw e;
                return Response.json({ ok: false, error: STOPPING_MESSAGE }, { status: 503, headers: { 'retry-after': '5' } });
            }
            const work = (async () => {
                try {
                    const result = await renderWithBody(body, format);
                    if (result.info.pages > MAX_PAGES && !body.pageRanges) {
                        return Response.json({
                            ok: false,
                            error: `this document is ${result.info.pages} pages, over the ${MAX_PAGES}-page limit. ` +
                                `split it, or render it with the cli, which has no page limit.`,
                            pages: result.info.pages,
                            limit: MAX_PAGES,
                        }, { status: 413 });
                    }
                    if (body.responseFormat === 'pdf') {
                        return pdfResponse(result);
                    }
                    return Response.json({
                        ok: true,
                        pdf: Buffer.from(result.pdf).toString('base64'),
                        pages: result.info.pages,
                        bytes: result.pdf.byteLength,
                        ms: result.ms,
                        mediaBoxes: result.info.mediaBoxes,
                        tagged: result.info.tagged,
                        findings: result.findings,
                        partial: Boolean(body.pageRanges),
                    });
                }
                catch (e) {
                    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
                }
                finally {
                    release();
                }
            })();
            inFlight.add(work);
            try {
                return await work;
            }
            finally {
                inFlight.delete(work);
            }
        }
        catch (e) {
            return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
    }
    async function reapChromium() {
        if (!process.platform.toUpperCase().startsWith('LINUX'))
            return;
        try {
            for (const entry of await (0, promises_1.readdir)('/proc')) {
                if (!/^\d+$/.test(entry))
                    continue;
                const pid = Number(entry);
                if (pid === process.pid)
                    continue;
                try {
                    const cmdline = await (0, promises_1.readFile)(`/proc/${pid}/cmdline`, 'utf8');
                    if (!cmdline.includes(profile))
                        continue;
                    process.kill(pid, 'SIGTERM');
                }
                catch { }
            }
            await Bun.sleep(700);
            for (const entry of await (0, promises_1.readdir)('/proc')) {
                if (!/^\d+$/.test(entry))
                    continue;
                try {
                    const cmdline = await (0, promises_1.readFile)(`/proc/${entry}/cmdline`, 'utf8');
                    if (!cmdline.includes(profile))
                        continue;
                    process.kill(Number(entry), 'SIGKILL');
                }
                catch { }
            }
        }
        catch { }
    }
    const stop = async () => {
        stopping = true;
        for (const waiter of waiters.splice(0))
            waiter();
        if (inFlight.size) {
            await Promise.race([Promise.allSettled(inFlight), Bun.sleep(MAX_TIMEOUT_MS + 5_000)]);
        }
        server.stop(true);
        await browser.close();
        await reapChromium();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
        await (0, promises_1.rm)(mcpWorkDir, { recursive: true, force: true }).catch(() => { });
        const ours = `letterpress-${process.pid}-`;
        for (const entry of await (0, promises_1.readdir)((0, node_os_1.tmpdir)()).catch(() => [])) {
            if (!entry.startsWith(ours))
                continue;
            await (0, promises_1.rm)((0, node_path_1.join)((0, node_os_1.tmpdir)(), entry), { recursive: true, force: true }).catch(() => { });
        }
    };
    return { server, browser, stop, port: server.port };
}
if (import.meta.main) {
    const port = Number(process.env.PORT ?? 8787);
    const running = await startServer({
        port,
        browserArgs: process.env.HTML2PDF_WEBMCP ? ['--enable-blink-features=WebMCP'] : [],
    });
    process.stdout.write(`letterpress viewer on http://127.0.0.1:${running.port}\n`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (stopping)
                process.exit(1);
            stopping = true;
            const forced = setTimeout(() => process.exit(1), 6_000);
            running
                .stop()
                .catch(() => { })
                .finally(() => {
                clearTimeout(forced);
                process.exit(0);
            });
        });
    }
}
//# sourceMappingURL=server.js.map