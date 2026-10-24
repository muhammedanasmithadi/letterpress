"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_ts_1 = require("../src/server.ts");
function doc(n) {
    const body = Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`).join('')}`).join('');
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
for (const n of [1, 4, 8, 12, 24, 40]) {
    const t0 = Bun.nanoseconds();
    const res = await Promise.all(Array.from({ length: n }, () => one()));
    const wall = (Bun.nanoseconds() - t0) / 1e6;
    const ok = res.filter((r) => r.ok).length;
    const refused = res.filter((r) => r.status === 429).length;
    const lat = res.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`burst ${String(n).padStart(2)}: wall ${wall.toFixed(0).padStart(6)}ms  ok ${ok}/${n}  refused ${refused}  ` +
        `throughput ${(n / (wall / 1000)).toFixed(2)}/s  p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms  max ${lat[lat.length - 1].toFixed(0)}ms`);
}
await server.stop();
process.exit(0);
//# sourceMappingURL=bench-burst.js.map