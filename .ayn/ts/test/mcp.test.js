"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const mcp_ts_1 = require("../src/mcp.ts");
const mcptools_ts_1 = require("../src/mcptools.ts");
const mcptools_ts_2 = require("../src/mcptools.ts");
const MODERN_META = {
    'io.modelcontextprotocol/protocolVersion': mcp_ts_1.MODERN_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
};
let dir;
let session;
(0, bun_test_1.beforeAll)(async () => {
    dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-mcp-test-'));
    session = await (0, mcp_ts_1.newSession)();
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await (0, mcptools_ts_2.closeContext)(session.context);
    await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
}, 20_000);
async function send(msg) {
    return (0, mcp_ts_1.handle)(session, msg);
}
function modern(id, method, params = {}) {
    const meta = (params['_meta'] ?? {});
    return send({
        jsonrpc: '2.0',
        id,
        method,
        params: { ...params, _meta: { ...MODERN_META, ...meta } },
    });
}
function resultOf(reply) {
    const r = reply;
    if (r.error !== undefined)
        throw new Error(`the server answered with an error: ${JSON.stringify(r.error)}`);
    return r.result ?? {};
}
function toolResult(reply) {
    return resultOf(reply);
}
function errorOf(reply) {
    const r = reply;
    if (r.error === undefined)
        throw new Error(`the server answered with a result: ${JSON.stringify(reply)}`);
    return r.error;
}
function legacy(id, method, params = {}) {
    return send({ jsonrpc: '2.0', id, method, params });
}
(0, bun_test_1.describe)('the handshake', () => {
    (0, bun_test_1.test)('a legacy client gets the version it asked for', async () => {
        for (const version of mcp_ts_1.LEGACY_VERSIONS) {
            const reply = await legacy(1, 'initialize', {
                protocolVersion: version,
                capabilities: {},
                clientInfo: { name: 'test', version: '1' },
            });
            const result = resultOf(reply);
            (0, bun_test_1.expect)(result.protocolVersion, version).toBe(version);
            (0, bun_test_1.expect)(result.serverInfo.name).toBe('letterpress');
        }
    });
    (0, bun_test_1.test)('a version this server does not speak is answered with one it does', async () => {
        const reply = await legacy(1, 'initialize', { protocolVersion: '1999-01-01' });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(mcp_ts_1.LEGACY_VERSIONS).toContain(result.protocolVersion);
        (0, bun_test_1.expect)(result.protocolVersion).toBe(mcp_ts_1.LEGACY_VERSIONS[0]);
    });
    (0, bun_test_1.test)('a modern client is told what the server supports', async () => {
        const reply = await modern(1, 'server/discover');
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.resultType).toBe('complete');
        (0, bun_test_1.expect)(result.supportedVersions).toEqual([mcp_ts_1.MODERN_VERSION]);
        (0, bun_test_1.expect)(result.capabilities).toHaveProperty('tools');
    });
    (0, bun_test_1.test)('a modern request for a version this server does not speak is refused', async () => {
        const reply = await modern(1, 'tools/list', {
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
        });
        const error = errorOf(reply);
        (0, bun_test_1.expect)(error.code).toBe(-32022);
        (0, bun_test_1.expect)(error.data.supported).toEqual([mcp_ts_1.MODERN_VERSION, ...mcp_ts_1.LEGACY_VERSIONS]);
    });
    (0, bun_test_1.test)('a modern request without the required client capabilities is malformed', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta: { 'io.modelcontextprotocol/protocolVersion': mcp_ts_1.MODERN_VERSION } },
        });
        (0, bun_test_1.expect)(errorOf(reply).code).toBe(-32602);
    });
    (0, bun_test_1.test)('a notification is answered with nothing', async () => {
        (0, bun_test_1.expect)(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    });
});
(0, bun_test_1.describe)('the tools', () => {
    (0, bun_test_1.test)('there are four of them, each with a name, a description and a schema', async () => {
        const reply = await legacy(1, 'tools/list');
        const tools = resultOf(reply).tools;
        (0, bun_test_1.expect)(tools.map((t) => t['name'])).toEqual([
            'render_html',
            'validate_pdf',
            'page_rules',
            'list_findings',
        ]);
        for (const tool of tools) {
            (0, bun_test_1.expect)(typeof tool['description']).toBe('string');
            (0, bun_test_1.expect)(tool['description'].length).toBeGreaterThan(40);
            (0, bun_test_1.expect)(tool['inputSchema']).toHaveProperty('type', 'object');
        }
    });
    (0, bun_test_1.test)('the words the agent reads carry their possessives', async () => {
        const reply = await legacy(1, 'tools/list');
        const tools = resultOf(reply).tools;
        const strings = [];
        for (const tool of tools) {
            strings.push(String(tool['description']));
            const schema = tool['inputSchema'];
            for (const property of Object.values(schema.properties ?? {}))
                strings.push(String(property.description ?? ''));
        }
        const initialized = resultOf(await legacy(0, 'initialize'));
        strings.push(String(initialized['instructions'] ?? ''));
        const slip = /(?<![\w'])(?!(?:its|their|his|her|our|your|my)\b)[A-Za-z]+ own\b/;
        for (const s of strings) {
            (0, bun_test_1.expect)([s.match(slip)?.[0] ?? null, s]).toEqual([null, s]);
        }
    });
    (0, bun_test_1.test)('the modern listing carries a result type and a cache lifetime', async () => {
        const reply = await modern(1, 'tools/list');
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result['resultType']).toBe('complete');
        (0, bun_test_1.expect)(result).toHaveProperty('ttlMs');
        (0, bun_test_1.expect)(result).toHaveProperty('cacheScope');
    });
    (0, bun_test_1.test)('the legacy listing carries neither, because that client never asked for them', async () => {
        const reply = await legacy(1, 'tools/list');
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result).not.toHaveProperty('resultType');
        (0, bun_test_1.expect)(result).not.toHaveProperty('ttlMs');
    });
    (0, bun_test_1.test)('every reply follows the era of the request that asked for it', async () => {
        const modernInitialize = await modern(20, 'initialize', { protocolVersion: mcp_ts_1.MODERN_VERSION });
        const modernInit = resultOf(modernInitialize);
        (0, bun_test_1.expect)(modernInit['resultType']).toBe('complete');
        (0, bun_test_1.expect)(modernInit['protocolVersion']).toBe(mcp_ts_1.MODERN_VERSION);
        const legacyDiscover = await legacy(21, 'server/discover');
        const legacyDisc = resultOf(legacyDiscover);
        (0, bun_test_1.expect)(legacyDisc).not.toHaveProperty('resultType');
        const modernDiscover = await modern(22, 'server/discover');
        (0, bun_test_1.expect)(resultOf(modernDiscover)['resultType']).toBe('complete');
    });
    (0, bun_test_1.test)('a tool result follows the era of the request that asked for it', async () => {
        const modernReply = await modern(1, 'tools/call', {
            name: 'list_findings',
            arguments: { severity: 'error' },
        });
        (0, bun_test_1.expect)(resultOf(modernReply)['resultType']).toBe('complete');
        const legacyReply = await legacy(2, 'tools/call', {
            name: 'list_findings',
            arguments: { severity: 'error' },
        });
        (0, bun_test_1.expect)(resultOf(legacyReply)).not.toHaveProperty('resultType');
        const modernContent = (resultOf(modernReply)['content'] ?? []);
        const legacyContent = (resultOf(legacyReply)['content'] ?? []);
        (0, bun_test_1.expect)(modernContent[0].text).toBe(legacyContent[0].text);
    });
    (0, bun_test_1.test)('every tool that is listed can also be called', async () => {
        for (const tool of mcptools_ts_1.TOOLS) {
            (0, bun_test_1.expect)(typeof tool.execute, tool.name).toBe('function');
        }
        const listed = resultOf(await legacy(1, 'tools/list'));
        (0, bun_test_1.expect)(listed.tools.map((t) => t.name).sort()).toEqual(mcptools_ts_1.TOOLS.map((t) => t.name).sort());
    });
    (0, bun_test_1.test)('page_rules says what the paper would be without rendering it', async () => {
        const reply = await legacy(1, 'tools/call', {
            name: 'page_rules',
            arguments: {
                html: '<!doctype html><style>@page{size:A4;margin:15mm}</style><p>x</p>',
            },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.declared.size).toBe('a4');
        (0, bun_test_1.expect)(result.structuredContent.declared.margin).toBe('15mm');
        (0, bun_test_1.expect)(result.structuredContent.declared.rules.length).toBe(1);
        (0, bun_test_1.expect)(result.content[0].text).toContain('declared size: a4');
    });
    (0, bun_test_1.test)('a render can ask the page a question of its own', async () => {
        const reply = await legacy(2, 'tools/call', {
            name: 'render_html',
            arguments: {
                html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}' +
                    'body{font:12pt serif}.row{display:flex;gap:24px}</style></head>' +
                    '<body><div class="row"><span>a</span><span>b</span></div></body></html>',
                probe: 'gaps',
                outputPath: (0, node_path_1.join)(dir, 'probed.pdf'),
            },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.probe.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(result.structuredContent.probe[0].cause).toBe('flex-gap');
    }, 120_000);
    (0, bun_test_1.test)('the stdio server reads and writes anywhere, because its caller owns the machine', async () => {
        const out = (0, node_path_1.join)(dir, 'stdio.pdf');
        const reply = await legacy(1, 'tools/call', {
            name: 'render_html',
            arguments: {
                html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><p>x</p></body></html>',
                outputPath: out,
            },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.isError).toBeFalsy();
        (0, bun_test_1.expect)(result.structuredContent.path).toBe(out);
        (0, bun_test_1.expect)((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }, 120_000);
    (0, bun_test_1.test)('a tool nobody has heard of is a protocol error', async () => {
        const reply = await legacy(1, 'tools/call', { name: 'make_coffee', arguments: {} });
        (0, bun_test_1.expect)(errorOf(reply).code).toBe(-32602);
    });
    (0, bun_test_1.test)('list_findings returns every code with its severity and its meaning', async () => {
        const reply = await legacy(1, 'tools/call', { name: 'list_findings', arguments: {} });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.count).toBeGreaterThan(30);
        for (const f of result.structuredContent.findings) {
            (0, bun_test_1.expect)(['error', 'warn', 'info']).toContain(f['severity']);
            (0, bun_test_1.expect)((f['summary'] ?? '').length).toBeGreaterThan(10);
        }
        (0, bun_test_1.expect)(result.content[0].text).toContain('js-error');
    });
    (0, bun_test_1.test)('list_findings can be narrowed to one severity', async () => {
        const reply = await legacy(1, 'tools/call', {
            name: 'list_findings',
            arguments: { severity: 'error' },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.findings.length).toBeGreaterThan(0);
        for (const f of result.structuredContent.findings) {
            (0, bun_test_1.expect)(f['severity']).toBe('error');
        }
    });
    (0, bun_test_1.test)('a severity that is not one of the three is a tool error the model can act on', async () => {
        const reply = await legacy(1, 'tools/call', {
            name: 'list_findings',
            arguments: { severity: 'critical' },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('error, warn or info');
    });
});
(0, bun_test_1.describe)('rendering through the server', () => {
    (0, bun_test_1.test)('it makes a real pdf and reports what it found', async () => {
        const out = (0, node_path_1.join)(dir, 'rendered.pdf');
        const reply = await legacy(1, 'tools/call', {
            name: 'render_html',
            arguments: {
                html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><h1>Through MCP</h1></body></html>',
                outputPath: out,
            },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.isError).toBeFalsy();
        (0, bun_test_1.expect)(result.structuredContent.ok).toBe(true);
        (0, bun_test_1.expect)(result.structuredContent.pages).toBe(1);
        (0, bun_test_1.expect)(result.structuredContent.path).toBe(out);
        const bytes = new Uint8Array(await (0, promises_1.readFile)(out));
        (0, bun_test_1.expect)(bytes.byteLength).toBeGreaterThan(1000);
        (0, bun_test_1.expect)(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    }, 120_000);
    (0, bun_test_1.test)('a document with a problem reports the finding and says the pdf is not what was asked for', async () => {
        const reply = await legacy(2, 'tools/call', {
            name: 'render_html',
            arguments: {
                html: '<!doctype html><html><head><style>@page{size:A4;margin:10mm}</style></head><body><img src="missing.png"><p>x</p></body></html>',
                outputPath: (0, node_path_1.join)(dir, 'broken.pdf'),
            },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.findings.map((f) => f.code)).toContain('subresource-failed');
    }, 120_000);
    (0, bun_test_1.test)('a render that cannot happen is a tool error with the reason in it', async () => {
        const reply = await legacy(3, 'tools/call', {
            name: 'render_html',
            arguments: { html: '<p>x</p>', format: 'a9' },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('format must be one of');
    }, 60_000);
    (0, bun_test_1.test)('validate_pdf checks a file that is there', async () => {
        const pdf = (0, node_path_1.join)(dir, 'to-check.pdf');
        await (0, promises_1.writeFile)(pdf, 'not a pdf at all', 'utf8');
        const reply = await legacy(4, 'tools/call', {
            name: 'validate_pdf',
            arguments: { path: pdf },
        });
        const result = resultOf(reply);
        (0, bun_test_1.expect)(result.structuredContent.ok).toBe(false);
        (0, bun_test_1.expect)(result.structuredContent.findings.map((f) => f.code)).toEqual(['not-a-pdf']);
    }, 60_000);
    (0, bun_test_1.test)('validate_pdf on a file that is not there says so', async () => {
        const reply = await legacy(5, 'tools/call', {
            name: 'validate_pdf',
            arguments: { path: (0, node_path_1.join)(dir, 'absent.pdf') },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('cannot read');
    }, 60_000);
});
(0, bun_test_1.describe)('the messages a server may be sent', () => {
    (0, bun_test_1.test)('a batch is answered with a reply for each request in it', async () => {
        const replies = (await (0, mcp_ts_1.handle)(session, [
            { jsonrpc: '2.0', id: 30, method: 'ping' },
            { jsonrpc: '2.0', id: 31, method: 'tools/list' },
        ]));
        (0, bun_test_1.expect)(Array.isArray(replies)).toBe(true);
        (0, bun_test_1.expect)(replies.map((r) => r.id)).toEqual([30, 31]);
    });
    (0, bun_test_1.test)('a request with the id null is answered with an error, not dropped', async () => {
        const reply = (await (0, mcp_ts_1.handle)(session, {
            jsonrpc: '2.0',
            id: null,
            method: 'ping',
        }));
        (0, bun_test_1.expect)(reply.id).toBeNull();
        (0, bun_test_1.expect)(reply.error.code).toBe(-32600);
    });
    (0, bun_test_1.test)('a tool call that cannot be written is refused, and the server survives', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 32,
            method: 'tools/call',
            params: {
                name: 'render_html',
                arguments: { html: '<p>x</p>', outputPath: '/no-such-directory-xyz/out.pdf' },
            },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('could not be written');
        const alive = await send({ jsonrpc: '2.0', id: 33, method: 'ping' });
        (0, bun_test_1.expect)(alive).not.toBeNull();
    });
});
(0, bun_test_1.describe)('the stdio line responder', () => {
    async function withPipes(out, err, body) {
        const stdoutWrite = process.stdout.write;
        const stderrWrite = process.stderr.write;
        process.stdout.write = ((s) => {
            out.push(String(s));
            return true;
        });
        process.stderr.write = ((s) => {
            err.push(String(s));
            return true;
        });
        try {
            await body();
        }
        finally {
            process.stdout.write = stdoutWrite;
            process.stderr.write = stderrWrite;
        }
    }
    const lineOf = (id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;
    (0, bun_test_1.test)('a line that parses to null is noted, not crashed on, and the session goes on', async () => {
        const out = [];
        const err = [];
        await withPipes(out, err, async () => {
            await (0, mcp_ts_1.respond)(session, 'null');
            await (0, mcp_ts_1.respond)(session, lineOf(40));
        });
        (0, bun_test_1.expect)(out).toEqual(['{"jsonrpc":"2.0","id":40,"result":{}}\n']);
        (0, bun_test_1.expect)(err.join('')).toContain('not a request object');
    });
    (0, bun_test_1.test)('a batch of only notifications is answered with nothing, not an empty array', async () => {
        const out = [];
        const err = [];
        await withPipes(out, err, async () => {
            await (0, mcp_ts_1.respond)(session, '[{"jsonrpc":"2.0","method":"idle/x"},{"jsonrpc":"2.0","method":"idle/y"}]');
            await (0, mcp_ts_1.respond)(session, lineOf(41));
        });
        (0, bun_test_1.expect)(out).toEqual(['{"jsonrpc":"2.0","id":41,"result":{}}\n']);
    });
    async function batchReplies(line) {
        const out = [];
        const err = [];
        await withPipes(out, err, async () => (0, mcp_ts_1.respond)(session, line));
        (0, bun_test_1.expect)(out.length).toBe(1);
        return JSON.parse(out[0]);
    }
    async function badMemberAnswered32600(line, goodId) {
        const replies = await batchReplies(line);
        (0, bun_test_1.expect)(replies.length).toBe(2);
        (0, bun_test_1.expect)(replies[0].id).toBeNull();
        (0, bun_test_1.expect)(replies[0].error.code).toBe(-32600);
        (0, bun_test_1.expect)(replies[1].id).toBe(goodId);
        (0, bun_test_1.expect)(replies[1].result).toEqual({});
    }
    (0, bun_test_1.test)('a batch with a null member answers the member -32600 and the rest normally', async () => {
        await badMemberAnswered32600(JSON.stringify([
            null,
            { jsonrpc: '2.0', method: 'idle/x' },
            { jsonrpc: '2.0', id: 42, method: 'ping' },
        ]), 42);
    });
    (0, bun_test_1.test)('a batch member that is itself an array is answered -32600, not descended into', async () => {
        await badMemberAnswered32600(JSON.stringify([
            [{ jsonrpc: '2.0', id: 45, method: 'ping' }],
            { jsonrpc: '2.0', id: 46, method: 'ping' },
        ]), 46);
    });
    (0, bun_test_1.test)('a handler that throws is answered with -32603 and the id echoed back', async () => {
        const out = [];
        const err = [];
        await withPipes(out, err, async () => {
            await (0, mcp_ts_1.respond)(session, lineOf(43), async () => {
                throw new Error('simulated interior failure');
            });
        });
        (0, bun_test_1.expect)(out.length).toBe(1);
        const reply = JSON.parse(out[0]);
        (0, bun_test_1.expect)(reply.id).toBe(43);
        (0, bun_test_1.expect)(reply.error.code).toBe(-32603);
        (0, bun_test_1.expect)(reply.error.message).toContain('internal error');
        (0, bun_test_1.expect)(reply.error.message).toContain('simulated interior failure');
        (0, bun_test_1.expect)(err.join('')).toContain('internal error');
    });
    (0, bun_test_1.test)('a handler failure with an unidentifiable id is noted, not answered', async () => {
        const out = [];
        const err = [];
        await withPipes(out, err, async () => {
            await (0, mcp_ts_1.respond)(session, '{"jsonrpc":"2.0","method":"ping"}\n', async () => {
                throw new Error('simulated interior failure');
            });
            await (0, mcp_ts_1.respond)(session, lineOf(44));
        });
        (0, bun_test_1.expect)(out).toEqual(['{"jsonrpc":"2.0","id":44,"result":{}}\n']);
        (0, bun_test_1.expect)(err.join('')).toContain('answered nothing');
    });
});
(0, bun_test_1.describe)('the arguments a tool refuses', () => {
    (0, bun_test_1.test)('a paper name is read the way the command line reads it', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 34,
            method: 'tools/call',
            params: { name: 'render_html', arguments: { html: '<p>x</p>', format: 'A4' } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBeFalsy();
        const sizes = result.structuredContent['pageSizes'];
        (0, bun_test_1.expect)(sizes[0]).toContain('841.91');
    }, 60_000);
    (0, bun_test_1.test)('a page range that starts after it ends is refused', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 39,
            method: 'tools/call',
            params: { name: 'render_html', arguments: { html: '<p>x</p>', pageRanges: '3-1' } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('starts after it ends');
    });
    (0, bun_test_1.test)('a page range that is not one is refused', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 41,
            method: 'tools/call',
            params: { name: 'render_html', arguments: { html: '<p>x</p>', pageRanges: 'abc' } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('not a page number or a range');
    });
    (0, bun_test_1.test)('a wait that is not a whole number is refused', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 42,
            method: 'tools/call',
            params: { name: 'render_html', arguments: { html: '<p>x</p>', settleMs: 1.5 } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('whole number');
    });
    (0, bun_test_1.test)('a paper nobody has heard of is refused', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 35,
            method: 'tools/call',
            params: { name: 'render_html', arguments: { html: '<p>x</p>', format: 'a9' } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('format must be one of');
    });
    (0, bun_test_1.test)('bytes that are not base64 are refused rather than decoded', async () => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 36,
            method: 'tools/call',
            params: { name: 'validate_pdf', arguments: { pdf: '!!!not base64!!!' } },
        });
        const result = toolResult(reply);
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('not base64');
    });
    (0, bun_test_1.test)('the work directory does not grow with the number of renders', async () => {
        const { readdir } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
        for (let i = 0; i < 3; i++) {
            const reply = await send({
                jsonrpc: '2.0',
                id: 38 + i,
                method: 'tools/call',
                params: { name: 'render_html', arguments: { html: '<p>x</p>' } },
            });
            (0, bun_test_1.expect)(toolResult(reply).isError).toBeFalsy();
        }
        const files = await readdir(session.context.workDir);
        const outputs = files.filter((f) => f.startsWith('output-'));
        (0, bun_test_1.expect)(outputs.length).toBe(1);
    }, 120_000);
    (0, bun_test_1.test)('the paper names the tool advertises are the papers the renderer has', async () => {
        const reply = await send({ jsonrpc: '2.0', id: 37, method: 'tools/list' });
        const tools = resultOf(reply)['tools'];
        const render = tools.find((t) => t.name === 'render_html');
        (0, bun_test_1.expect)(render.inputSchema.properties['format'].enum).toEqual([
            'a3',
            'a4',
            'a5',
            'legal',
            'letter',
            'tabloid',
        ]);
    });
    const refused = async (args) => {
        const reply = await send({
            jsonrpc: '2.0',
            id: 40,
            method: 'tools/call',
            params: { name: 'render_html', arguments: args },
        });
        return toolResult(reply);
    };
    (0, bun_test_1.test)('a probe nobody has heard of is refused rather than ignored', async () => {
        const result = await refused({ html: '<p>x</p>', probe: 'nonsense' });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('probe must be one of gaps, fonts');
    });
    (0, bun_test_1.test)('a timeout the timer cannot honour is refused', async () => {
        const result = await refused({ html: '<p>x</p>', timeoutMs: 0 });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('timeoutMs must be a whole number of at least 1000');
    });
    (0, bun_test_1.test)('a negative wait is refused', async () => {
        const result = await refused({ html: '<p>x</p>', settleMs: -1 });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('settleMs must be a whole number, zero or more');
    });
});
(0, bun_test_1.describe)('the server as a process', () => {
    const CLI = (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts');
    (0, bun_test_1.test)('it answers over stdin and stdout, and nothing else reaches stdout', async () => {
        const proc = Bun.spawn(['bun', CLI, 'mcp'], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const encoder = new TextEncoder();
        const send = (msg) => proc.stdin.write(encoder.encode(`${JSON.stringify(msg)}\n`));
        await send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 't', version: '1' },
            },
        });
        await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const lines = [];
        const deadline = Date.now() + 30_000;
        while (lines.length < 2 && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
                lines.push(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf('\n');
            }
        }
        const replies = lines.map((l) => JSON.parse(l));
        (0, bun_test_1.expect)(replies.length, `only got ${lines.length} lines`).toBe(2);
        (0, bun_test_1.expect)(replies[0].id).toBe(1);
        (0, bun_test_1.expect)(replies[1].id).toBe(2);
        (0, bun_test_1.expect)(replies[1].result.tools.length).toBe(mcptools_ts_1.TOOLS.length);
        await proc.stdin.end();
        const code = await proc.exited;
        (0, bun_test_1.expect)(code).toBe(0);
    }, 90_000);
});
//# sourceMappingURL=mcp.test.js.map