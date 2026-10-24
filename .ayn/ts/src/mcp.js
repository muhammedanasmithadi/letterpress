"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_VERSIONS = exports.MODERN_VERSION = void 0;
exports.handle = handle;
exports.newSession = newSession;
exports.serve = serve;
exports.respond = respond;
exports.runMcp = runMcp;
const mcptools_ts_1 = require("./mcptools.ts");
exports.MODERN_VERSION = '2026-07-28';
exports.LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'letterpress', version: '0.1.0' };
const INSTRUCTIONS = "Render HTML to PDF through Chromium's own print engine, and check PDFs that already exist. " +
    'A render reports findings: severity error means the PDF is not the document you asked for, ' +
    'warn means something is degraded, and info is a note. Call list_findings to find out what a code means.';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
function ok(id, result) {
    return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id,
        error: data === undefined ? { code, message } : { code, message, data },
    };
}
function internalReply(label, id, e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (id === null) {
        process.stderr.write(`letterpress-mcp: ignoring ${label} that answered nothing: ${reason}\n`);
        return null;
    }
    process.stderr.write(`letterpress-mcp: answered ${label} with an internal error: ${reason}\n`);
    return fail(id, -32603, `internal error: ${reason}`);
}
function metaOf(msg) {
    const meta = msg.params?.['_meta'];
    return meta && typeof meta === 'object' ? meta : {};
}
function declaredVersion(msg) {
    const version = metaOf(msg)[META_VERSION];
    return typeof version === 'string' ? version : null;
}
function toolList() {
    return mcptools_ts_1.TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
    }));
}
function modernResult(body) {
    return {
        resultType: 'complete',
        ...body,
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
    };
}
async function handle(session, msg, headerVersion) {
    if (Array.isArray(msg))
        return handleBatch(session, msg, headerVersion);
    if (msg.method === undefined)
        return null;
    if (msg.id === undefined) {
        return null;
    }
    const id = msg.id;
    const version = declaredVersion(msg);
    if (version !== null && !isSupportedModern(version)) {
        return fail(id, -32022, 'Unsupported protocol version', {
            supported: [exports.MODERN_VERSION, ...exports.LEGACY_VERSIONS],
            requested: version,
        });
    }
    const modern = version !== null || headerVersion === exports.MODERN_VERSION;
    if (modern && metaOf(msg)[META_CLIENT_CAPS] === undefined) {
        return fail(id, -32602, `a modern request must carry ${META_CLIENT_CAPS} in _meta`);
    }
    if (msg.id === null) {
        return fail(null, -32600, 'a request must have an id, and null is not one');
    }
    return dispatch(session, id, msg, modern);
}
function dispatch(session, id, msg, modern) {
    if (msg.method === 'server/discover')
        return discover(id, modern);
    if (msg.method === 'initialize')
        return initialize(id, msg, modern);
    if (msg.method === 'ping')
        return ok(id, modern ? modernResult({}) : {});
    if (msg.method === 'tools/list')
        return listTools(id, modern);
    if (msg.method === 'tools/call')
        return callToolRequest(session, id, msg, modern);
    return fail(id, -32601, `Method not found: ${msg.method}`);
}
async function handleBatch(session, msgs, headerVersion) {
    const replies = [];
    for (const one of msgs) {
        const reply = await handleOneInBatch(session, one, headerVersion);
        if (reply !== null && !Array.isArray(reply))
            replies.push(reply);
    }
    return replies;
}
async function handleOneInBatch(session, one, headerVersion) {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) {
        return fail(null, -32600, 'a batch member must be a request object, not this');
    }
    try {
        return await handle(session, one, headerVersion);
    }
    catch (e) {
        const id = typeof one.id === 'string' || typeof one.id === 'number' ? one.id : null;
        return internalReply('a batch member', id, e);
    }
}
function discover(id, modern) {
    const body = {
        supportedVersions: [exports.MODERN_VERSION],
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
    };
    return ok(id, modern ? modernResult(body) : body);
}
function initialize(id, msg, modern) {
    const requested = msg.params?.['protocolVersion'];
    const body = {
        protocolVersion: modern ? exports.MODERN_VERSION : agreedVersion(requested),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
    };
    return ok(id, modern ? modernResult(body) : body);
}
function agreedVersion(requested) {
    if (typeof requested !== 'string')
        return exports.LEGACY_VERSIONS[0];
    if (!exports.LEGACY_VERSIONS.includes(requested))
        return exports.LEGACY_VERSIONS[0];
    return requested;
}
function listTools(id, modern) {
    const tools = toolList();
    if (modern) {
        return ok(id, modernResult({ tools, ttlMs: 3_600_000, cacheScope: 'public' }));
    }
    return ok(id, { tools });
}
function isSupportedModern(version) {
    return version === exports.MODERN_VERSION;
}
async function callToolRequest(session, id, msg, modern) {
    const params = (msg.params ?? {});
    const name = params['name'];
    if (typeof name !== 'string') {
        return fail(id, -32602, 'tools/call needs a tool name');
    }
    const args = (params['arguments'] ?? {});
    if (typeof args !== 'object' || Array.isArray(args)) {
        return fail(id, -32602, `the arguments to ${name} must be an object`);
    }
    const result = await (0, mcptools_ts_1.callTool)(name, args, session.context);
    if (result === null) {
        return fail(id, -32602, `Unknown tool: ${name}`);
    }
    const body = { content: result.content };
    if (result.structuredContent !== undefined)
        body['structuredContent'] = result.structuredContent;
    if (result.isError)
        body['isError'] = true;
    return ok(id, modern ? modernResult(body) : body);
}
async function newSession() {
    return { context: await (0, mcptools_ts_1.makeContext)() };
}
async function serve(session) {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = Bun.stdin.stream().getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line)
                continue;
            void respond(session, line);
        }
    }
}
async function respond(session, line, call = handle) {
    let msg;
    try {
        msg = JSON.parse(line);
    }
    catch {
        process.stderr.write('letterpress-mcp: ignoring a line that is not JSON\n');
        return;
    }
    if (msg === null || typeof msg !== 'object') {
        process.stderr.write('letterpress-mcp: ignoring a line that is not a request object\n');
        return;
    }
    let reply;
    try {
        reply = await call(session, msg);
    }
    catch (e) {
        const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
        reply = internalReply('a line', id, e);
    }
    if (reply === null || (Array.isArray(reply) && reply.length === 0))
        return;
    try {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
    catch { }
}
async function runMcp() {
    const session = await newSession();
    let stopping = false;
    const stop = () => {
        if (stopping)
            process.exit(0);
        stopping = true;
        void (0, mcptools_ts_1.closeContext)(session.context).finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await serve(session);
    await (0, mcptools_ts_1.closeContext)(session.context);
    return 0;
}
if (import.meta.main) {
    process.exit(await runMcp());
}
//# sourceMappingURL=mcp.js.map