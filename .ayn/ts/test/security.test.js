"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_net_1 = require("node:net");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const server_ts_1 = require("../src/server.ts");
const servers_ts_1 = require("./servers.ts");
const poppler_ts_1 = require("./poppler.ts");
const server = (0, servers_ts_1.useTestServer)();
const port = () => Number(new URL(server.origin).port);
const json = { 'content-type': 'application/json' };
const post = (body, headers = {}) => fetch(`${server.origin}/render`, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});
const DOC = `<!doctype html><style>@page{size:A4;margin:8mm}</style><h1>SEC</h1>`;
async function childServer(env = {}) {
    const child = Bun.spawn(['bun', (0, node_path_1.join)(import.meta.dir, '..', 'src', 'server.ts')], {
        env: { ...process.env, PORT: '0', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    let text = '';
    const bound = await (async () => {
        const deadline = Date.now() + 40_000;
        while (Date.now() < deadline) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            text += Buffer.from(chunk.value ?? new Uint8Array()).toString();
            const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (m)
                return Number(m[1]);
        }
        throw new Error(`server never announced a port: ${text}`);
    })();
    return {
        port: bound,
        pid: child.pid,
        rss: () => {
            try {
                return (Number((0, node_fs_1.readFileSync)(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024);
            }
            catch {
                return 0;
            }
        },
        kill: async () => {
            child.kill('SIGTERM');
            await child.exited;
        },
    };
}
function raw(request, waitMs = 4_000) {
    return new Promise((resolve) => {
        const socket = (0, node_net_1.connect)({ host: '127.0.0.1', port: port() });
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            const text = Buffer.concat(chunks).toString('latin1');
            socket.destroy();
            resolve({ status: Number(text.match(/HTTP\/1\.[01] (\d+)/)?.[1] ?? 0), text });
        };
        socket.on('data', (c) => chunks.push(c));
        socket.on('close', finish);
        socket.on('error', finish);
        socket.setTimeout(waitMs, finish);
        socket.write(request);
        socket.end();
    });
}
function chunkedTo(target, chunks, waitMs = 30_000) {
    return new Promise((resolve) => {
        const socket = (0, node_net_1.connect)({ host: '127.0.0.1', port: target });
        const out = [];
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            const text = Buffer.concat(out).toString('latin1');
            socket.destroy();
            resolve({ status: Number(text.match(/HTTP\/1\.[01] (\d+)/)?.[1] ?? 0), text });
        };
        socket.on('data', (c) => out.push(c));
        socket.on('close', finish);
        socket.on('error', finish);
        socket.setTimeout(waitMs, finish);
        socket.write('POST /render HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\n' +
            'transfer-encoding: chunked\r\n\r\n');
        for (const part of chunks)
            socket.write(`${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`);
        socket.write('0\r\n\r\n');
        socket.end();
    });
}
(0, bun_test_1.describe)('no local file read', () => {
    (0, bun_test_1.test)('a path is refused rather than rendered', async () => {
        const r = await post({ path: '/etc/passwd' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        (0, bun_test_1.expect)((await r.json()).error).toContain('html');
    });
    (0, bun_test_1.test)('no spelling of a path gets a file read', async () => {
        for (const body of [
            { path: '/etc/passwd' },
            { path: '../../../../etc/passwd' },
            { path: 'package.json' },
            { path: 'src/server.ts' },
            { path: '/proc/self/environ' },
            { path: 'file:///etc/passwd' },
            { html: DOC, path: '/etc/passwd' },
        ]) {
            const r = await post(body);
            (0, bun_test_1.expect)(r.status, JSON.stringify(body)).toBe(400);
        }
    });
    (0, bun_test_1.test)('a path smuggled under another key is refused by the type check', async () => {
        for (const html of [123, null, { toString: () => '/etc/passwd' }, ['/etc/passwd'], true]) {
            const r = await post({ html });
            (0, bun_test_1.expect)(r.status, String(JSON.stringify(html))).toBe(400);
        }
    });
});
(0, bun_test_1.describe)('another web origin cannot drive the renderer', () => {
    (0, bun_test_1.test)('a foreign Origin is refused', async () => {
        const r = await post({ html: DOC }, { origin: 'https://evil.example' });
        (0, bun_test_1.expect)(r.status).toBe(403);
        (0, bun_test_1.expect)((await r.json()).error).toContain('own viewer');
    });
    (0, bun_test_1.test)('a cross-site fetch-metadata header is refused', async () => {
        for (const site of ['cross-site', 'same-site']) {
            const r = await post({ html: DOC }, { 'sec-fetch-site': site });
            (0, bun_test_1.expect)(r.status, site).toBe(403);
        }
    });
    (0, bun_test_1.test)('a loopback Origin on a different port is still refused', async () => {
        const r = await post({ html: DOC }, { origin: 'http://127.0.0.1:9999' });
        (0, bun_test_1.expect)(r.status).toBe(403);
    });
    (0, bun_test_1.test)("this viewer's own Origin is accepted", async () => {
        const r = await post({ html: DOC }, { origin: server.origin });
        (0, bun_test_1.expect)(r.status).toBe(200);
    }, 60_000);
});
(0, bun_test_1.describe)('a foreign page cannot read the response either', () => {
    (0, bun_test_1.test)('no CORS headers on any response', async () => {
        for (const headers of [{}, { origin: 'https://evil.example' }]) {
            const r = await post({ html: DOC }, headers);
            (0, bun_test_1.expect)(r.headers.get('access-control-allow-origin')).toBeNull();
            (0, bun_test_1.expect)(r.headers.get('access-control-allow-headers')).toBeNull();
        }
    }, 90_000);
    (0, bun_test_1.test)('a preflight is refused, so the real request is never sent', async () => {
        const r = await fetch(`${server.origin}/render`, {
            method: 'OPTIONS',
            headers: {
                origin: 'https://evil.example',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type',
            },
        });
        (0, bun_test_1.expect)(r.headers.get('access-control-allow-origin')).toBeNull();
    });
    (0, bun_test_1.test)('a render needs application/json, so no simple request can carry one', async () => {
        for (const type of [
            'text/plain',
            'application/x-www-form-urlencoded',
            'multipart/form-data',
            '',
        ]) {
            const r = await fetch(`${server.origin}/render`, {
                method: 'POST',
                headers: type ? { 'content-type': type } : {},
                body: JSON.stringify({ html: DOC }),
            });
            (0, bun_test_1.expect)(r.status, `content-type: ${type || 'none'}`).toBe(415);
        }
    });
});
(0, bun_test_1.describe)('errors do not disclose the source', () => {
    (0, bun_test_1.test)('an out-of-range port in Host is a 403, not a crash', async () => {
        const r = await raw(`GET /health HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n`);
        (0, bun_test_1.expect)(r.status).toBe(403);
        (0, bun_test_1.expect)(r.text).not.toContain('import.meta.dir');
        (0, bun_test_1.expect)(r.text).not.toContain(process.cwd());
    });
    (0, bun_test_1.test)('an HTTP/1.0 request with no Host is answered, not crashed', async () => {
        const r = await raw('GET /health HTTP/1.0\r\n\r\n');
        (0, bun_test_1.expect)(r.status).toBeGreaterThanOrEqual(200);
        (0, bun_test_1.expect)(r.text).not.toContain('source_lines');
    });
    (0, bun_test_1.test)('an absurdly long asset path is a 404, not a crash', async () => {
        const r = await raw(`GET /assets/${'..%2f'.repeat(1000)}etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        (0, bun_test_1.expect)([403, 404]).toContain(r.status);
        (0, bun_test_1.expect)(r.text).not.toContain('ENAMETOOLONG');
        (0, bun_test_1.expect)(r.text).not.toContain('source_lines');
    }, 20_000);
    (0, bun_test_1.test)('a malformed request line produces an error json, never an html overlay', async () => {
        const r = await raw('CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: localhost\r\n\r\n');
        (0, bun_test_1.expect)(r.status).toBeGreaterThanOrEqual(400);
        (0, bun_test_1.expect)(r.text).not.toContain('source_lines');
        (0, bun_test_1.expect)(r.text).not.toContain('problems');
    });
    (0, bun_test_1.test)('no response anywhere leaks the working directory', async () => {
        const probes = [
            { path: '/health' },
            { path: '/assets/' + 'x'.repeat(600) },
            { path: '/render' },
            { path: '/../' + 'y'.repeat(600) },
        ];
        for (const probe of probes) {
            const r = await raw(`GET ${probe.path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`, 6_000);
            (0, bun_test_1.expect)(r.text, probe.path.slice(0, 40)).not.toContain(process.cwd());
        }
    }, 40_000);
});
(0, bun_test_1.describe)('a body cannot exceed the cap in memory', () => {
    (0, bun_test_1.test)('an oversized declared length is refused before reading', async () => {
        const r = await raw(`POST /render HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\n` +
            `content-length: ${100 * 1024 * 1024}\r\nConnection: close\r\n\r\n`);
        (0, bun_test_1.expect)(r.status).toBe(413);
    });
    (0, bun_test_1.test)('a chunked body with no content-length is still capped', async () => {
        const server = await childServer();
        try {
            const before = server.rss();
            const part = `{"html":"${'x'.repeat(60_000)}"}`;
            const r = await chunkedTo(server.port, Array.from({ length: 400 }, () => part));
            (0, bun_test_1.expect)(r.status).toBe(413);
            const grew = server.rss() - before;
            (0, bun_test_1.expect)(grew, `server rss grew ${grew.toFixed(0)}MB`).toBeLessThan(24);
        }
        finally {
            await server.kill();
        }
    }, 120_000);
    (0, bun_test_1.test)('a body just under the cap still renders', async () => {
        const html = `<!doctype html><style>@page{size:A4;margin:8mm}</style><p>${'x'.repeat(6 * 1024 * 1024)}</p>`;
        const r = await post({ html });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok, body.error ?? `status ${r.status}`).toBe(true);
    }, 90_000);
});
(0, bun_test_1.describe)('bounded resources', () => {
    (0, bun_test_1.test)('a long deadline is clamped, not honoured', async () => {
        const started = Date.now();
        const r = await post({ html: DOC, timeoutMs: 1_000_000_000, settleMs: 1_000_000_000 });
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)(Date.now() - started).toBeLessThan(130_000);
    }, 150_000);
    (0, bun_test_1.test)('a burst is bounded and the machine survives it', async () => {
        const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => post({ html: `${DOC}<p>burst ${i}</p>` })));
        const codes = burst.map((r) => r.status);
        (0, bun_test_1.expect)(codes.every((c) => c === 200 || c === 429)).toBe(true);
        const refused = burst.filter((r) => r.status === 429);
        const served = burst.filter((r) => r.status === 200);
        (0, bun_test_1.expect)(refused.length + served.length).toBe(burst.length);
        (0, bun_test_1.expect)(refused.length > 0 || served.length > 0).toBe(true);
        for (const r of refused) {
            (0, bun_test_1.expect)(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
        }
        const ok = burst.filter((r) => r.status === 200);
        (0, bun_test_1.expect)(ok.length).toBeGreaterThan(0);
        for (const r of ok.slice(0, 3)) {
            const body = (await r.json());
            (0, bun_test_1.expect)(body.ok).toBe(true);
            (0, bun_test_1.expect)(Buffer.from(body.pdf, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
        }
    }, 180_000);
    (0, bun_test_1.test)('the server is healthy and rendering after the burst', async () => {
        const h = await fetch(`${server.origin}/health`);
        (0, bun_test_1.expect)(h.status).toBe(200);
        const r = await post({ html: DOC });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(new Uint8Array(Buffer.from(body.pdf, 'base64')))).toContain('SEC');
    }, 90_000);
});
(0, bun_test_1.describe)('health reports the browser honestly', () => {
    (0, bun_test_1.test)('healthy reports the real bound port', async () => {
        const r = await fetch(`${server.origin}/health`);
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.port).toBe(port());
        (0, bun_test_1.expect)(body.chromium).toBe(true);
    });
    (0, bun_test_1.test)('a dead browser reports 503 rather than green', async () => {
        const dead = await (0, server_ts_1.startServer)({ port: 0 });
        await dead.browser.close();
        try {
            const r = await fetch(`http://127.0.0.1:${dead.port}/health`);
            (0, bun_test_1.expect)(r.status).toBe(503);
            const body = (await r.json());
            (0, bun_test_1.expect)(body.ok).toBe(false);
            (0, bun_test_1.expect)(body.chromium).toBe(false);
        }
        finally {
            await dead.stop();
        }
    }, 90_000);
});
(0, bun_test_1.describe)('shutdown does not strand work directories', () => {
    (0, bun_test_1.test)('a server killed mid-render leaves no work directory', async () => {
        const before = await (0, promises_1.readdir)((0, node_os_1.tmpdir)());
        const server = await childServer();
        await fetch(`http://127.0.0.1:${server.port}/render`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ html: DOC, settleMs: 4_000, timeoutMs: 60_000 }),
        }).catch(() => { });
        await server.kill();
        await Bun.sleep(1_500);
        const after = await (0, promises_1.readdir)((0, node_os_1.tmpdir)());
        const stranded = after.filter((n) => n.startsWith(`letterpress-${server.pid}-`) && !before.includes(n));
        (0, bun_test_1.expect)(stranded).toEqual([]);
    }, 150_000);
});
(0, bun_test_1.describe)('type confusion is a 400', () => {
    (0, bun_test_1.test)('each field is checked before it reaches the renderer', async () => {
        const cases = [
            [null, /JSON object/],
            [[], /JSON object/],
            ['a string', /not valid JSON/],
            [{ html: '<p>x</p>', pageRanges: ['1'] }, /pageRanges/],
            [{ html: '<p>x</p>', pageRanges: 1 }, /pageRanges/],
            [{ html: '<p>x</p>', format: { toString: () => 'a4' } }, /format must be a string/],
            [{ html: '<p>x</p>', format: ['a4'] }, /format must be a string, got array/],
            [{ html: '<p>x</p>', format: 'a9' }, /unknown format/],
            [{ html: '<p>x</p>', timeoutMs: '1' }, /timeoutMs must be a number/],
            [{ html: '<p>x</p>', settleMs: {} }, /settleMs must be a number/],
            [{ html: '<p>x</p>', maxImagePpi: '300' }, /maxImagePpi must be a number/],
        ];
        for (const [body, pattern] of cases) {
            const r = await post(body);
            (0, bun_test_1.expect)(r.status, JSON.stringify(body)).toBe(400);
            (0, bun_test_1.expect)((await r.json()).error, JSON.stringify(body)).toMatch(pattern);
        }
    });
    (0, bun_test_1.test)('a nonsense deadline is ignored rather than crashing', async () => {
        for (const timeoutMs of ['1', 0, -1, null, {}]) {
            const r = await post({ html: DOC, timeoutMs, settleMs: timeoutMs });
            (0, bun_test_1.expect)([200, 400, 500]).toContain(r.status);
            const body = (await r.json());
            (0, bun_test_1.expect)(typeof body.ok).toBe('boolean');
            if (body.ok === false)
                (0, bun_test_1.expect)(typeof body.error).toBe('string');
        }
    }, 120_000);
    (0, bun_test_1.test)('landscape is only true when it is true', async () => {
        for (const bad of ['yes', 1, 0, null, {}]) {
            const r = await post({ html: DOC, landscape: bad });
            (0, bun_test_1.expect)(r.status, JSON.stringify(bad)).toBe(400);
            (0, bun_test_1.expect)((await r.json()).error).toContain('landscape must be');
        }
        const ok = await post({ html: DOC, format: 'a4', landscape: true });
        (0, bun_test_1.expect)(ok.status).toBe(200);
        (0, bun_test_1.expect)((await ok.json()).mediaBoxes[0]).toContain('841');
    }, 120_000);
});
//# sourceMappingURL=security.test.js.map