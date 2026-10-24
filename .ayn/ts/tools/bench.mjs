"use strict";
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME ?? 'chromium';
const DIR = process.env.BENCH_DIR ?? join(tmpdir(), 'letterpress-bench');
const SMALL = process.env.SMALL_DOC ?? join(DIR, 'probe.html');
const BIG = process.env.BIG_DOC ?? join(DIR, 'big.html');
const PROFILE = join(DIR, 'profile');
function fixtures() {
    mkdirSync(DIR, { recursive: true });
    if (!process.env.SMALL_DOC && !existsSync(SMALL)) {
        writeFileSync(SMALL, '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>' +
            '<h1>Probe</h1><p>Body text for the timing run.</p>\n');
    }
    if (!process.env.BIG_DOC && !existsSync(BIG)) {
        const rows = Array.from({ length: 400 }, (_, i) => `<tr>${Array.from({ length: 24 }, (_, j) => `<td>r${i}c${j}</td>`).join('')}</tr>`).join('');
        writeFileSync(BIG, '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}table{border-collapse:collapse}</style>' +
            `<table>${rows}</table>\n`);
    }
}
fixtures();
const smallUrl = SMALL.startsWith('file:') ? SMALL : `file://${SMALL}`;
const bigUrl = BIG.startsWith('file:') ? BIG : `file://${BIG}`;
function launch() {
    const t0 = performance.now();
    const proc = spawn(CHROME, [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=${PROFILE}`,
        '--remote-debugging-port=0',
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    return new Promise((res, rej) => {
        let buf = '';
        const to = setTimeout(() => rej(new Error('no DevTools endpoint in 30s: ' + buf)), 30000);
        proc.stderr.on('data', (d) => {
            buf += d;
            const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (m) {
                clearTimeout(to);
                res({ proc, port: +m[1], spawned: t0 });
            }
        });
        proc.on('exit', (c) => {
            clearTimeout(to);
            rej(new Error('chromium exited ' + c + ': ' + buf));
        });
    });
}
function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pend.has(m.id)) {
            pend.get(m.id)(m);
            pend.delete(m.id);
        }
    };
    const send = (method, params = {}, timeout = 120000) => new Promise((res, rej) => {
        const n = ++id;
        pend.set(n, (m) => m.error ? rej(new Error(method + ' ' + JSON.stringify(m.error))) : res(m.result));
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
            if (pend.delete(n))
                rej(new Error(method + ' timeout'));
        }, timeout);
    });
    return new Promise((res, rej) => {
        ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || e.type)));
        ws.onopen = () => res({ ws, send });
    });
}
async function waitForPageSession(port, deadlineMs = 30000) {
    const started = Date.now();
    let lastErr;
    while (Date.now() - started < deadlineMs) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page) {
                const c = await connect(page.webSocketDebuggerUrl);
                await c.send('Page.enable', {}, 3000);
                return c;
            }
            lastErr = new Error('no page target yet');
        }
        catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('page session never became ready: ' + (lastErr?.message ?? lastErr));
}
async function newTab(port) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    return r.json();
}
async function render(client, url, opts = {}) {
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 600));
    const res = await client.send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        transferMode: 'ReturnAsBase64',
        ...opts,
    });
    return res.data.length;
}
function rss() {
    try {
        return Math.round(process.memoryUsage.rss() / 1048576);
    }
    catch {
        return -1;
    }
}
const RT = process.env.RT ?? '?';
let t0 = performance.now();
const { proc, port, spawned } = await launch();
const endpointMs = performance.now() - spawned;
const c0 = await waitForPageSession(port);
const bytes = await render(c0, smallUrl);
console.log(JSON.stringify({
    rt: RT,
    phase: 'cold',
    endpointMs: Math.round(endpointMs),
    totalMs: Math.round(performance.now() - t0),
    pdfB64: bytes,
    rssMB: rss(),
}));
{
    const t = performance.now();
    const times = [];
    for (let i = 0; i < 5; i++) {
        const a = performance.now();
        await render(c0, smallUrl);
        times.push(Math.round(performance.now() - a));
    }
    console.log(JSON.stringify({
        rt: RT,
        phase: 'warm-small',
        wallMs: Math.round(performance.now() - t),
        eachMs: times,
        rssMB: rss(),
    }));
}
for (const N of [2, 4, 8]) {
    const tabs = await Promise.all(Array.from({ length: N }, () => newTab(port)));
    const clients = await Promise.all(tabs.map((t) => connect(t.webSocketDebuggerUrl)));
    const t = performance.now();
    const lat = await Promise.all(clients.map(async (c) => {
        const a = performance.now();
        await render(c, smallUrl);
        return Math.round(performance.now() - a);
    }));
    const wall = Math.round(performance.now() - t);
    console.log(JSON.stringify({
        rt: RT,
        phase: `concurrent-${N}`,
        wallMs: wall,
        perClientMs: lat.sort((a, b) => a - b),
        rssMB: rss(),
    }));
    clients.forEach((c) => c.ws.close());
    await Promise.all(tabs.map((t) => fetch(`http://127.0.0.1:${port}/json/close/${t.id}`)));
}
{
    const a = performance.now();
    const n = await render(c0, bigUrl);
    console.log(JSON.stringify({
        rt: RT,
        phase: 'big-serial',
        ms: Math.round(performance.now() - a),
        pdfB64: n,
        rssMB: rss(),
    }));
}
try {
    process.kill(-proc.pid, 'SIGTERM');
}
catch { }
await new Promise((r) => setTimeout(r, 2000));
try {
    process.kill(-proc.pid, 'SIGKILL');
}
catch { }
process.exit(0);
//# sourceMappingURL=bench.mjs.map