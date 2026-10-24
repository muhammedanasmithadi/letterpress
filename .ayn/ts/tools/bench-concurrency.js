"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_ts_1 = require("../src/server.ts");
function doc(sections) {
    const body = Array.from({ length: sections }, (_, i) => `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`).join('')}`).join('');
    return `<!doctype html><meta charset="utf-8"><title>D</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const server = await (0, server_ts_1.startServer)({ port: 0 });
await Bun.sleep(300);
const payload = JSON.stringify({ html: doc(3) });
async function one() {
    const t0 = Bun.nanoseconds();
    const url = `http://127.0.0.1:${server.port}/render`;
    // prettier-ignore
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
        body: payload,
    });
    const body = (await res.json());
    return { status: res.status, ms: (Bun.nanoseconds() - t0) / 1e6, ok: body.ok, pages: body.pages };
}
await one();
for (const n of [1, 2, 4, 8]) {
    const t0 = Bun.nanoseconds();
    const results = await Promise.all(Array.from({ length: n }, () => one()));
    const wall = (Bun.nanoseconds() - t0) / 1e6;
    const ok = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => r.status === 429 || r.status === 503).length;
    const lat = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`concurrency ${String(n).padStart(2)}: wall ${wall.toFixed(0).padStart(6)}ms  ` +
        `throughput ${(n / (wall / 1000)).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}/s  ` +
        `ok ${ok}/${n} refused ${refused}  ` +
        `latency p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms max ${lat[lat.length - 1].toFixed(0)}ms`);
}
await server.stop();
process.exit(0);
//# sourceMappingURL=bench-concurrency.js.map