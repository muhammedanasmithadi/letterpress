import { startServer } from "/home/anas/Projects/html2pdf/src/server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function doc(sections: number) {
  const body = Array.from({ length: sections }, (_, i) =>
    `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) =>
      `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`).join("")}`).join("");
  return `<!doctype html><meta charset="utf-8"><title>D</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}

const profile = await mkdtemp(join(tmpdir(), "lp-scale-"));
let port = 0;
const server = await startServer({ profile, port: 0, onReady: () => {} }).catch(() => null);
void server;
await Bun.sleep(200);

const s = await startServer({ profile: await mkdtemp(join(tmpdir(), "lp-scale2-")), port: 8791 });
void s;
await Bun.sleep(300);

const payload = JSON.stringify({ html: doc(3) });
async function one() {
  const t0 = Bun.nanoseconds();
  const res = await fetch("http://127.0.0.1:8791/render", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:8791" },
    body: payload,
  });
  const body = await res.json() as any;
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
  console.log(
    `concurrency ${String(n).padStart(2)}: wall ${wall.toFixed(0).padStart(6)}ms  ` +
    `throughput ${(n / (wall / 1000)).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}/s  ` +
    `ok ${ok}/${n} refused ${refused}  ` +
    `latency p50 ${lat[Math.floor(lat.length / 2)]!.toFixed(0)}ms max ${lat[lat.length - 1]!.toFixed(0)}ms`);
}
process.exit(0);
