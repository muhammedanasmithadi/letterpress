import { startServer } from '/home/anas/Projects/html2pdf/src/server.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function doc(n: number) {
  const body = Array.from(
    { length: n },
    (_, i) =>
      `<h2>Section ${i + 1}</h2>${Array.from(
        { length: 8 },
        (_, j) => `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`,
      ).join('')}`,
  ).join('');
  return `<!doctype html><meta charset="utf-8"><title>D</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const profile = await mkdtemp(join(tmpdir(), 'lp-s2-'));
await startServer({ profile, port: 8793 });
await Bun.sleep(300);
const payload = JSON.stringify({ html: doc(3) });
async function one() {
  const t0 = Bun.nanoseconds();
  const res = await fetch('http://127.0.0.1:8793/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8793' },
    body: payload,
  });
  const body = (await res.json()) as any;
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
  console.log(
    `burst ${String(n).padStart(2)}: wall ${wall.toFixed(0).padStart(6)}ms  ok ${ok}/${n}  refused ${refused}  ` +
      `throughput ${(n / (wall / 1000)).toFixed(2)}/s  p50 ${lat[Math.floor(lat.length / 2)]!.toFixed(0)}ms  max ${lat[lat.length - 1]!.toFixed(0)}ms`,
  );
}
process.exit(0);
