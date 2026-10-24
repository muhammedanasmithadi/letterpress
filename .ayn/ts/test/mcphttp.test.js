"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const bun_test_1 = require("bun:test");
const servers_ts_1 = require("./servers.ts");
const server = (0, servers_ts_1.useTestServer)();
const MODERN_META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
};
function post(body, headers = {}) {
    return fetch(`${server.origin}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
        },
        body: JSON.stringify(body),
    });
}
async function headerMismatch(r) {
    (0, bun_test_1.expect)(r.status).toBe(400);
    const body = (await r.json());
    return body.error.code;
}
function modern(body, headers = {}) {
    const method = String(body['method'] ?? '');
    const name = body['params']?.['name'];
    return post({ ...body, params: { ...body['params'], _meta: MODERN_META } }, {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name ? { 'mcp-name': String(name) } : {}),
        ...headers,
    });
}
(0, bun_test_1.describe)('the mcp endpoint', () => {
    (0, bun_test_1.test)('it answers a batch the way the stdio transport does', async () => {
        const r = await post([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]);
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(Array.isArray(body)).toBe(true);
        (0, bun_test_1.expect)(body.map((x) => x.id)).toEqual([1, 2]);
    });
    (0, bun_test_1.test)('a version in the header makes it a modern request', async () => {
        const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-protocol-version': '2026-07-28' });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.error?.code).toBe(-32602);
        (0, bun_test_1.expect)(body.error?.message).toContain('clientCapabilities');
    });
    (0, bun_test_1.test)('a request with no version anywhere is a legacy request', async () => {
        const r = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.result.resultType).toBeUndefined();
    });
    (0, bun_test_1.test)('a custom parameter header with no counterpart is refused', async () => {
        const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-param-severity': 'warn' });
        (0, bun_test_1.expect)(await headerMismatch(r)).toBe(-32020);
    });
    (0, bun_test_1.test)('it answers a discovery request', async () => {
        const r = await modern({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.result.supportedVersions).toEqual(['2026-07-28']);
    });
    (0, bun_test_1.test)('it lists the tools', async () => {
        const r = await modern({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.result.tools.map((t) => t.name).sort()).toEqual([
            'list_findings',
            'page_rules',
            'render_html',
            'validate_pdf',
        ]);
    });
    (0, bun_test_1.test)('it calls a tool', async () => {
        const r = await modern({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'list_findings', arguments: { severity: 'error' } },
        });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.result.content[0].text).toContain('not-a-pdf');
    });
    (0, bun_test_1.test)('a legacy client gets the handshake it asked for', async () => {
        const r = await post({
            jsonrpc: '2.0',
            id: 4,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'test', version: '1' },
            },
        });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.result.protocolVersion).toBe('2025-06-18');
    });
    (0, bun_test_1.test)('a notification is accepted with no body', async () => {
        const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        (0, bun_test_1.expect)(r.status).toBe(202);
        (0, bun_test_1.expect)(await r.text()).toBe('');
    });
    (0, bun_test_1.test)('the headers and the body have to agree', async () => {
        const cases = [
            ['Mcp-Method header value', { 'mcp-method': 'tools/call' }],
            ['Mcp-Name header value', { 'mcp-name': 'render_html' }],
            ['MCP-Protocol-Version header value', { 'mcp-protocol-version': '2025-06-18' }],
        ];
        for (const [what, headers] of cases) {
            const r = await modern({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, headers);
            (0, bun_test_1.expect)(r.status, what).toBe(400);
            const body = (await r.json());
            (0, bun_test_1.expect)(body.error.code, what).toBe(-32020);
        }
    });
    (0, bun_test_1.test)('a body that is not JSON is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not json at all',
        });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.error.code).toBe(-32700);
    });
    (0, bun_test_1.test)('the wrong content type is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: '{}',
        });
        (0, bun_test_1.expect)(r.status).toBe(415);
    });
    (0, bun_test_1.test)('a GET is not allowed', async () => {
        (0, bun_test_1.expect)((await fetch(`${server.origin}/mcp`)).status).toBe(405);
    });
    (0, bun_test_1.test)('the pdf cannot be written outside the server own directory', async () => {
        for (const outputPath of [
            '/tmp/letterpress-escape.pdf',
            '/etc/passwd',
            '../escape.pdf',
            '../../escape.pdf',
        ]) {
            const r = await modern({
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: {
                    name: 'render_html',
                    arguments: { html: '<p>x</p>', outputPath },
                },
            });
            const body = (await r.json());
            (0, bun_test_1.expect)(body.result.isError, outputPath).toBe(true);
            (0, bun_test_1.expect)(body.result.content[0].text, outputPath).toContain('can only be written inside');
        }
    }, 120_000);
    (0, bun_test_1.test)('a symbolic link out of the directory is refused too', async () => {
        const first = await modern({
            jsonrpc: '2.0',
            id: 8,
            method: 'tools/call',
            params: {
                name: 'render_html',
                arguments: { html: '<p>x</p>', outputPath: '/etc/passwd' },
            },
        });
        const body = (await first.json());
        const root = /inside (.+), not/.exec(body.result.content[0].text)?.[1];
        (0, bun_test_1.expect)(root, 'the refusal names the directory').toBeTruthy();
        const link = (0, node_path_1.join)(root, 'escape.pdf');
        await (0, promises_1.symlink)('/tmp/letterpress-symlink-target.pdf', link);
        try {
            const r = await modern({
                jsonrpc: '2.0',
                id: 9,
                method: 'tools/call',
                params: {
                    name: 'render_html',
                    arguments: { html: '<p>x</p>', outputPath: link },
                },
            });
            const out = (await r.json());
            (0, bun_test_1.expect)(out.result.isError).toBe(true);
            (0, bun_test_1.expect)(out.result.content[0].text).toContain('can only be written inside');
        }
        finally {
            await (0, promises_1.rm)(link, { force: true }).catch(() => { });
        }
    }, 120_000);
    (0, bun_test_1.test)('a pdf is checked by its bytes, and not by a path outside the directory', async () => {
        const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n').toString('base64');
        const byPath = await modern({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'validate_pdf', arguments: { path: '/etc/passwd' } },
        });
        const refused = (await byPath.json());
        (0, bun_test_1.expect)(refused.result.isError).toBe(true);
        (0, bun_test_1.expect)(refused.result.content[0].text).toContain('can be read');
        const byBytes = await modern({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: { name: 'validate_pdf', arguments: { pdf } },
        });
        const checked = (await byBytes.json());
        (0, bun_test_1.expect)(checked.result.isError).toBeFalsy();
        (0, bun_test_1.expect)(checked.result.content[0].text).toContain('finding');
    }, 60_000);
    (0, bun_test_1.test)('a request from another web page is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
        });
        (0, bun_test_1.expect)(r.status).toBe(403);
    });
});
(0, bun_test_1.describe)('what a shared server will not do', () => {
    const HTML = '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><p>x</p></body></html>';
    async function call(args) {
        const r = await modern({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'render_html', arguments: args },
        });
        const body = (await r.json());
        return body.result;
    }
    (0, bun_test_1.test)('a directory to read assets from is not accepted', async () => {
        const result = await call({ html: '<p>x</p>', root: '/tmp' });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('send the html');
    });
    (0, bun_test_1.test)("one caller does not delete another caller's document", async () => {
        const first = await call({ html: '<p>one</p>' });
        const second = await call({ html: '<p>two</p>' });
        const a = (first.content[0].text.match(/wrote (\S+)/) ?? [])[1];
        const b = (second.content[0].text.match(/wrote (\S+)/) ?? [])[1];
        (0, bun_test_1.expect)(a).not.toBe(b);
        (0, bun_test_1.expect)(await Bun.file(a).exists()).toBe(true);
        (0, bun_test_1.expect)(await Bun.file(b).exists()).toBe(true);
    }, 120_000);
    (0, bun_test_1.test)('a file on the server is not read', async () => {
        const result = await call({ path: '/etc/hostname' });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('send the html');
    });
    (0, bun_test_1.test)('a url is not fetched', async () => {
        const result = await call({ html: HTML, url: 'http://127.0.0.1:9/secret' });
        (0, bun_test_1.expect)(result.isError).toBe(true);
        (0, bun_test_1.expect)(result.content[0].text).toContain('send the html');
    });
    (0, bun_test_1.test)('two callers do not get the same file', async () => {
        const first = await call({ html: HTML });
        const second = await call({ html: HTML });
        const a = (first.content[0].text.match(/wrote (\S+)/) ?? [])[1];
        const b = (second.content[0].text.match(/wrote (\S+)/) ?? [])[1];
        (0, bun_test_1.expect)(a).toBeTruthy();
        (0, bun_test_1.expect)(a).not.toBe(b);
    });
    (0, bun_test_1.test)('a body over the limit is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                pad: 'x'.repeat(9 * 1024 * 1024),
            }),
        });
        (0, bun_test_1.expect)(r.status).toBe(413);
    });
});
(0, bun_test_1.describe)('the version header', () => {
    (0, bun_test_1.test)('a version this server does not speak is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'mcp-protocol-version': '1999-01-01' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.error.code).toBe(-32022);
        (0, bun_test_1.expect)(body.error.data.supported).toContain('2026-07-28');
    });
    (0, bun_test_1.test)('a base64 encoded version is understood', async () => {
        const encoded = `=?base64?${Buffer.from('2026-07-28').toString('base64')}?=`;
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'mcp-protocol-version': encoded },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: { _meta: MODERN_META },
            }),
        });
        (0, bun_test_1.expect)(r.status).toBe(200);
    });
    (0, bun_test_1.test)('a custom parameter header that disagrees with the body is refused', async () => {
        const r = await fetch(`${server.origin}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'mcp-method': 'tools/call',
                'mcp-name': 'render_html',
                'mcp-param-html': 'something else',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'render_html', arguments: { html: '<p>x</p>' } },
            }),
        });
        (0, bun_test_1.expect)(await headerMismatch(r)).toBe(-32020);
    });
});
//# sourceMappingURL=mcphttp.test.js.map