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
const servers_ts_1 = require("./servers.ts");
const server_ts_1 = require("../src/server.ts");
const poppler_ts_1 = require("./poppler.ts");
let s;
let origin;
(0, bun_test_1.beforeAll)(async () => {
    s = await (0, servers_ts_1.launchTestServer)();
    origin = (0, servers_ts_1.serverOrigin)(s);
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await s?.stop();
}, 20_000);
const DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 10mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { font-family: sans-serif }
</style></head><body><h1>Server fixture</h1><p>Rendered over HTTP.</p></body></html>`;
const post = (body, headers = {}) => fetch(`${origin}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});
(0, bun_test_1.describe)('health', () => {
    (0, bun_test_1.test)('reports readiness without rendering', async () => {
        const r = await fetch(`${origin}/health`);
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(body.port).toBe(s.server.port);
    });
});
(0, bun_test_1.describe)('a server that cannot start', () => {
    (0, bun_test_1.test)('it leaves no profile directory behind', async () => {
        const { readdirSync } = await Promise.resolve().then(() => __importStar(require('node:fs')));
        const { tmpdir } = await Promise.resolve().then(() => __importStar(require('node:os')));
        const before = readdirSync(tmpdir()).filter((n) => n.startsWith('letterpress-server-'));
        const was = process.env.HTML2PDF_CHROMIUM;
        process.env.HTML2PDF_CHROMIUM = '/nonexistent/chromium-binary';
        try {
            await (0, bun_test_1.expect)((0, server_ts_1.startServer)({ port: 0 })).rejects.toThrow();
        }
        finally {
            if (was === undefined)
                delete process.env.HTML2PDF_CHROMIUM;
            else
                process.env.HTML2PDF_CHROMIUM = was;
        }
        const after = readdirSync(tmpdir()).filter((n) => n.startsWith('letterpress-server-'));
        (0, bun_test_1.expect)(after.length).toBe(before.length);
    }, 30_000);
});
(0, bun_test_1.describe)('render', () => {
    (0, bun_test_1.test)('returns a real pdf that poppler can read', async () => {
        const r = await post({ html: DOC });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(body.pages).toBe(1);
        (0, bun_test_1.expect)(body.tagged).toBe(true);
        (0, bun_test_1.expect)(body.mediaBoxes[0]).toContain('594.95996');
        const findings = body.findings;
        (0, bun_test_1.expect)(findings.filter((f) => f.severity === 'error')).toEqual([]);
        for (const f of findings)
            (0, bun_test_1.expect)(f.severity).not.toBe('error');
        const pdf = Buffer.from(body.pdf, 'base64');
        (0, bun_test_1.expect)(pdf.byteLength).toBe(body.bytes);
        (0, bun_test_1.expect)(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(new Uint8Array(pdf))).pages).toBe(1);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(new Uint8Array(pdf))).toContain('Rendered over HTTP');
    }, 60_000);
    (0, bun_test_1.test)('honours a format and reports the conflict with @page', async () => {
        const r = await post({ html: DOC, format: 'letter' });
        const body = (await r.json());
        (0, bun_test_1.expect)(body.mediaBoxes[0]).toMatch(/612/);
        (0, bun_test_1.expect)(body.findings.map((f) => f.code)).toContain('page-size-override');
    }, 60_000);
    (0, bun_test_1.test)('pageRanges is marked partial so the count is not read as a total', async () => {
        const many = `<!doctype html><style>@page{size:A4;margin:6mm}
body{margin:0}.s{break-before:page;height:275mm;font-size:30pt}</style>
${Array.from({ length: 6 }, (_, i) => `<div class="s">PAGE_${i + 1}</div>`).join('')}`;
        const full = (await (await post({ html: many })).json());
        (0, bun_test_1.expect)(full.pages).toBe(6);
        (0, bun_test_1.expect)(full.partial).toBe(false);
        const part = (await (await post({ html: many, pageRanges: '2-3' })).json());
        (0, bun_test_1.expect)(part.pages).toBe(2);
        (0, bun_test_1.expect)(part.partial).toBe(true);
        const text = await (0, poppler_ts_1.pdfText)(new Uint8Array(Buffer.from(part.pdf, 'base64')));
        (0, bun_test_1.expect)(text).toContain('PAGE_2');
        (0, bun_test_1.expect)(text).toContain('PAGE_3');
        (0, bun_test_1.expect)(text).not.toContain('PAGE_1');
    }, 90_000);
    (0, bun_test_1.test)('rejects a body with no html', async () => {
        const r = await post({ format: 'a4' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        (0, bun_test_1.expect)((await r.json()).error).toContain('html');
    });
    (0, bun_test_1.test)('rejects blank html as a client error, not a 500', async () => {
        for (const html of ['', '   ']) {
            const r = await post({ html });
            (0, bun_test_1.expect)(r.status, JSON.stringify(html)).toBe(400);
            (0, bun_test_1.expect)((await r.json()).error).toContain('the input is empty');
        }
    });
    (0, bun_test_1.test)('rejects an unknown format rather than guessing', async () => {
        const r = await post({ html: DOC, format: 'a9' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const { error } = (await r.json());
        (0, bun_test_1.expect)(error).toContain('unknown format');
        (0, bun_test_1.expect)(error).toContain('a4');
    });
    (0, bun_test_1.test)('rejects a page range that starts after it ends, as a client error', async () => {
        for (const pageRanges of ['3-1', 'abc', '0']) {
            const r = await post({ html: DOC, pageRanges });
            (0, bun_test_1.expect)(r.status, pageRanges).toBe(400);
            const { error } = (await r.json());
            (0, bun_test_1.expect)(error, pageRanges).toContain('pageRanges');
        }
    });
    (0, bun_test_1.test)('rejects malformed json', async () => {
        const r = await post('{not json');
        (0, bun_test_1.expect)(r.status).toBe(400);
        (0, bun_test_1.expect)((await r.json()).error).toContain('not valid JSON');
    });
    (0, bun_test_1.test)('refuses an oversized document with 413', async () => {
        const huge = `<!doctype html><p>${'x'.repeat(9 * 1024 * 1024)}</p>`;
        const r = await post(huge);
        (0, bun_test_1.expect)(r.status).toBe(413);
        const { error } = (await r.json());
        (0, bun_test_1.expect)(error).toMatch(/over the 8MB limit/);
    }, 60_000);
    (0, bun_test_1.test)('a path is refused by name rather than read from disk', async () => {
        const r = await post({ path: '/tmp/definitely-not-here.html' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const { error } = (await r.json());
        (0, bun_test_1.expect)(error).toContain('path is not accepted');
    });
    (0, bun_test_1.test)('the server is still healthy after a failure', async () => {
        const r = await fetch(`${origin}/health`);
        (0, bun_test_1.expect)((await r.json()).ok).toBe(true);
        const again = await post({ html: DOC });
        (0, bun_test_1.expect)((await again.json()).ok).toBe(true);
    }, 60_000);
    (0, bun_test_1.test)('a burst waits rather than being refused', async () => {
        const burst = 8;
        const results = await Promise.all(Array.from({ length: burst }, () => post({ html: DOC })));
        const ok = results.filter((r) => r.status === 200);
        (0, bun_test_1.expect)(ok).toHaveLength(burst);
        for (const r of ok)
            (0, bun_test_1.expect)((await r.json()).ok).toBe(true);
    }, 120_000);
    (0, bun_test_1.test)('a burst beyond the queue is refused, and says so', async () => {
        const results = await Promise.all(Array.from({ length: 40 }, () => post({ html: DOC })));
        const refused = results.filter((r) => r.status === 429);
        (0, bun_test_1.expect)(refused.length).toBeGreaterThan(0);
        for (const r of refused) {
            (0, bun_test_1.expect)(r.headers.get('retry-after')).toBe('2');
            const body = (await r.json());
            (0, bun_test_1.expect)(body.ok).toBe(false);
            (0, bun_test_1.expect)(body.error).toMatch(/retry/i);
        }
        const ok = results.filter((r) => r.status === 200);
        (0, bun_test_1.expect)(ok.length).toBeGreaterThan(0);
    }, 180_000);
    (0, bun_test_1.test)('a queued render still produces a whole pdf', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, () => post({ html: DOC })));
        for (const r of results) {
            (0, bun_test_1.expect)(r.status).toBe(200);
            const body = (await r.json());
            (0, bun_test_1.expect)(body.ok).toBe(true);
            (0, bun_test_1.expect)(body.pages).toBe(1);
            (0, bun_test_1.expect)(Buffer.from(body.pdf, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
        }
    }, 120_000);
});
(0, bun_test_1.describe)('loopback boundary', () => {
    (0, bun_test_1.test)('refuses a request whose Host is not loopback', async () => {
        const r = await post({ html: DOC }, { host: 'attacker.example' });
        (0, bun_test_1.expect)(r.status).toBe(403);
        (0, bun_test_1.expect)((await r.json()).error).toContain('loopback');
    });
    (0, bun_test_1.test)('refuses a Host whose port is out of range', async () => {
        for (const host of ['localhost:99999', '127.0.0.1:70000', 'localhost:abc']) {
            const r = await post({ html: DOC }, { host });
            (0, bun_test_1.expect)([400, 403], `Host: ${host}`).toContain(r.status);
            (0, bun_test_1.expect)(await r.text()).not.toContain('source_lines');
        }
    });
    (0, bun_test_1.test)('accepts every loopback spelling of Host', async () => {
        for (const host of ['127.0.0.1', `127.0.0.1:${s.port}`, 'localhost', '[::1]', 'LOCALHOST']) {
            const r = await post({ html: DOC }, { host });
            (0, bun_test_1.expect)(r.status, `Host: ${host}`).toBe(200);
        }
    }, 120_000);
    (0, bun_test_1.test)('accepts an Origin at every loopback spelling, not just 127.0.0.1', async () => {
        for (const host of ['localhost', '[::1]', '127.0.0.1']) {
            const r = await post({ html: DOC }, { host, origin: `http://${host}:${s.port}` });
            (0, bun_test_1.expect)(r.status, `Origin: ${host}`).toBe(200);
        }
    }, 120_000);
    (0, bun_test_1.test)('refuses an Origin on a different port or a different scheme', async () => {
        const port = s.port ?? 0;
        for (const bad of [`http://localhost:${port + 1}`, `http://127.0.0.1:${port - 1}`]) {
            const r = await post({ html: DOC }, { origin: bad });
            (0, bun_test_1.expect)(r.status, `Origin: ${bad}`).toBe(403);
        }
    }, 60_000);
    (0, bun_test_1.test)('sends no CORS headers, so another origin cannot read responses', async () => {
        const r = await post({ html: DOC }, { origin: 'https://evil.example' });
        (0, bun_test_1.expect)(r.headers.get('access-control-allow-origin')).toBeNull();
        (0, bun_test_1.expect)(r.headers.get('access-control-allow-headers')).toBeNull();
    }, 60_000);
});
(0, bun_test_1.describe)('routing', () => {
    (0, bun_test_1.test)('unknown paths are 404', async () => {
        (0, bun_test_1.expect)((await fetch(`${origin}/nope`)).status).toBe(404);
    });
    (0, bun_test_1.test)('GET on /render is 404, not a render', async () => {
        (0, bun_test_1.expect)((await fetch(`${origin}/render`)).status).toBe(404);
    });
    (0, bun_test_1.test)('asset paths cannot escape the viewer directory', async () => {
        const r = await fetch(`${origin}/assets/..%2f..%2fpackage.json`);
        (0, bun_test_1.expect)([403, 404]).toContain(r.status);
        if (r.status === 200)
            throw new Error('traversal succeeded');
    });
});
(0, bun_test_1.describe)('page limit', () => {
    const sections = (n) => `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style>` +
        Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>` +
            Array.from({ length: 8 }, () => `<p>office efficient different flags finished warehouse loading invoices.</p>`).join('')).join('');
    (0, bun_test_1.test)('a document inside the limit is served', async () => {
        const r = await post({ html: sections(2) });
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)((await r.json()).ok).toBe(true);
    }, 90_000);
    (0, bun_test_1.test)('pageRanges is exempt, because its count is what was emitted not the document', async () => {
        const r = await post({ html: sections(120), pageRanges: '1-2' });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(body.partial).toBe(true);
        (0, bun_test_1.expect)(body.pages).toBe(2);
    }, 120_000);
});
(0, bun_test_1.describe)('response format', () => {
    const DOC2 = `<!doctype html><meta charset="utf-8"><title>Format</title>
<style>@page{size:A4;margin:12mm}</style><h1>Report</h1><p>office efficient flags finished</p>`;
    (0, bun_test_1.test)('json is the default and carries the report', async () => {
        const r = await post({ html: DOC2, author: 'Someone' });
        (0, bun_test_1.expect)(r.headers.get('content-type')).toMatch(/application\/json/);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(body.pages).toBe(1);
        (0, bun_test_1.expect)(Array.isArray(body.findings)).toBe(true);
        (0, bun_test_1.expect)(Buffer.from(body.pdf, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    }, 90_000);
    (0, bun_test_1.test)('responseFormat pdf returns the bytes and the report as headers', async () => {
        const r = await post({
            html: DOC2,
            author: 'Someone',
            responseFormat: 'pdf',
        });
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)(r.headers.get('content-type')).toBe('application/pdf');
        (0, bun_test_1.expect)(r.headers.get('x-letterpress-pages')).toBe('1');
        (0, bun_test_1.expect)(r.headers.get('x-letterpress-tagged')).toBe('true');
        (0, bun_test_1.expect)(Number(r.headers.get('content-length'))).toBeGreaterThan(1000);
        const bytes = new Uint8Array(await r.arrayBuffer());
        (0, bun_test_1.expect)(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    }, 90_000);
    (0, bun_test_1.test)('a pdf response names its error findings, not just their number', async () => {
        const r = await post({
            html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>
        <h1>Report</h1><p>{{leftover}}</p>`,
            author: 'Someone',
            responseFormat: 'pdf',
        });
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)(r.headers.get('x-letterpress-errors')).toBe('unfilled-placeholder');
        (0, bun_test_1.expect)(Buffer.from(await r.arrayBuffer())
            .subarray(0, 5)
            .toString()).toBe('%PDF-');
    }, 90_000);
    (0, bun_test_1.test)('a clean pdf response reports no errors', async () => {
        const r = await post({ html: DOC2, author: 'Someone', responseFormat: 'pdf' });
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)(r.headers.get('x-letterpress-errors')).toBe('');
    }, 90_000);
    (0, bun_test_1.test)('the pdf header agrees with the json body about which findings are errors', async () => {
        const body = {
            html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>
        <h1>Report</h1><p>{{leftover}}</p>`,
            author: 'Someone',
        };
        const json = (await (await post(body)).json());
        const pdf = await post({ ...body, responseFormat: 'pdf' });
        const fromJson = json.findings
            .filter((f) => f.severity === 'error')
            .map((f) => f.code)
            .join(',');
        (0, bun_test_1.expect)(pdf.headers.get('x-letterpress-errors')).toBe(fromJson);
        (0, bun_test_1.expect)(Number(pdf.headers.get('x-letterpress-findings'))).toBe(json.findings.length);
    }, 120_000);
    (0, bun_test_1.test)('both formats return the same document', async () => {
        process.env.SOURCE_DATE_EPOCH = '1700000000';
        try {
            const viaJson = (await (await post({ html: DOC2, author: 'Someone' })).json());
            const viaPdf = new Uint8Array(await (await post({ html: DOC2, author: 'Someone', responseFormat: 'pdf' })).arrayBuffer());
            const fromJson = Buffer.from(viaJson.pdf, 'base64');
            (0, bun_test_1.expect)(fromJson.byteLength).toBe(viaPdf.byteLength);
            (0, bun_test_1.expect)(fromJson.equals(Buffer.from(viaPdf))).toBe(true);
            (0, bun_test_1.expect)(viaJson.pages).toBe(1);
        }
        finally {
            delete process.env.SOURCE_DATE_EPOCH;
        }
    }, 120_000);
    (0, bun_test_1.test)('the binary response is smaller, because base64 inflates by a third', async () => {
        const jsonBytes = (await (await post({ html: DOC2 })).arrayBuffer()).byteLength;
        const pdfBytes = (await (await post({ html: DOC2, responseFormat: 'pdf' })).arrayBuffer())
            .byteLength;
        (0, bun_test_1.expect)(pdfBytes).toBeLessThan(jsonBytes);
    }, 120_000);
    (0, bun_test_1.test)('an unknown responseFormat is refused rather than ignored', async () => {
        const r = await post({ html: DOC2, responseFormat: 'nope' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        (0, bun_test_1.expect)((await r.json()).error).toMatch(/responseFormat/);
    }, 60_000);
    (0, bun_test_1.test)('metadata reaches the renderer over http', async () => {
        const r = await post({
            html: DOC2,
            author: 'Ahammed Sahad',
            subject: 'CV',
        });
        const body = (await r.json());
        const info = Buffer.from(body.pdf, 'base64').toString('latin1');
        (0, bun_test_1.expect)(info).toContain('/Author (Ahammed Sahad)');
        (0, bun_test_1.expect)(info).toContain('/Subject (CV)');
    }, 90_000);
});
(0, bun_test_1.describe)('a limit that cannot be read', () => {
    (0, bun_test_1.test)('an unreadable limit falls back and says so', () => {
        const seen = [];
        const warn = (m) => seen.push(m);
        const previous = process.env.HTML2PDF_MAX_PAGES;
        try {
            process.env.HTML2PDF_MAX_PAGES = 'abc';
            (0, bun_test_1.expect)((0, server_ts_1.limitFromEnv)('HTML2PDF_MAX_PAGES', 6000, 1, warn)).toBe(6000);
            (0, bun_test_1.expect)(seen.join('\n')).toMatch(/HTML2PDF_MAX_PAGES="abc" is not a number/);
            (0, bun_test_1.expect)(seen.join('\n')).toMatch(/using 6000/);
            seen.length = 0;
            process.env.HTML2PDF_MAX_PAGES = '0';
            (0, bun_test_1.expect)((0, server_ts_1.limitFromEnv)('HTML2PDF_MAX_PAGES', 6000, 1, warn)).toBe(6000);
            (0, bun_test_1.expect)(seen.join('\n')).toMatch(/is not a number of at least 1/);
        }
        finally {
            if (previous === undefined)
                delete process.env.HTML2PDF_MAX_PAGES;
            else
                process.env.HTML2PDF_MAX_PAGES = previous;
        }
    });
    (0, bun_test_1.test)('a readable limit is used, and an absent one is the default', () => {
        const previous = process.env.HTML2PDF_MAX_PAGES;
        const warn = () => { };
        try {
            process.env.HTML2PDF_MAX_PAGES = '42.9';
            (0, bun_test_1.expect)((0, server_ts_1.limitFromEnv)('HTML2PDF_MAX_PAGES', 6000, 1, warn)).toBe(42);
            delete process.env.HTML2PDF_MAX_PAGES;
            (0, bun_test_1.expect)((0, server_ts_1.limitFromEnv)('HTML2PDF_MAX_PAGES', 6000, 1, warn)).toBe(6000);
            process.env.HTML2PDF_MAX_PAGES = '   ';
            (0, bun_test_1.expect)((0, server_ts_1.limitFromEnv)('HTML2PDF_MAX_PAGES', 6000, 1, warn)).toBe(6000);
        }
        finally {
            if (previous === undefined)
                delete process.env.HTML2PDF_MAX_PAGES;
            else
                process.env.HTML2PDF_MAX_PAGES = previous;
        }
    });
    (0, bun_test_1.test)('author, subject and keywords are type-checked like every other field', async () => {
        for (const key of ['author', 'subject', 'keywords']) {
            const r = await post({ html: DOC, [key]: 123 });
            (0, bun_test_1.expect)(r.status, key).toBe(400);
            (0, bun_test_1.expect)(await r.text(), key).toContain(`${key} must be a string`);
        }
    }, 60_000);
    (0, bun_test_1.test)('timeoutMs of 0 falls back rather than becoming a zero deadline', async () => {
        (0, bun_test_1.expect)((await post({ html: DOC, timeoutMs: 0 })).status).toBe(200);
    }, 60_000);
});
//# sourceMappingURL=server.test.js.map