import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '/home/anas/Projects/html2pdf/src/browser.ts';
import { render } from '/home/anas/Projects/html2pdf/src/render.ts';
import { readFileSync } from 'node:fs';

const html = readFileSync('/tmp/opencode/big/doc2000.html', 'utf8');

function rssTree(pid: number): number {
  let total = 0;
  const add = (p: number) => {
    try {
      const rss = Number(
        Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(p)])
          .stdout.toString()
          .trim(),
      );
      if (Number.isFinite(rss)) total += rss;
    } catch {}
  };
  add(pid);
  try {
    const kids = Bun.spawnSync(['pgrep', '-P', String(pid)])
      .stdout.toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const k of kids) add(Number(k));
  } catch {}
  return total;
}

async function run(browser: Browser, mode: 'base64' | 'stream', samples: number) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < samples; i++) {
    let peak = 0;
    const t0 = Bun.nanoseconds();
    const watch = setInterval(() => {
      const r = rssTree(process.pid);
      if (r > peak) peak = r;
    }, 120);
    const r = await render(browser, { html, transfer: mode, timeoutMs: 120_000 });
    clearInterval(watch);
    times.push((Bun.nanoseconds() - t0) / 1e6);
    bytes = r.pdf.byteLength;
    peak = Math.max(peak, rssTree(process.pid));
    if (i === samples - 1) {
      console.log(
        `  ${mode.padEnd(7)} peak_rss_observed=${(peak / 1024).toFixed(0)}MB  pages=${r.info.pages}`,
      );
    }
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)]!;
  console.log(
    `  ${mode.padEnd(7)} median ${(med / 1000).toFixed(2)}s  min ${(times[0]! / 1000).toFixed(2)}s  max ${(times[times.length - 1]! / 1000).toFixed(2)}s  pdf ${(bytes / 1024 / 1024).toFixed(1)}MB`,
  );
}

const profile = await mkdtemp(join(tmpdir(), 'lp-tr-'));
const browser = await Browser.launch({ profile });
await render(browser, { html: 'warm', timeoutMs: 60_000 });
console.log('2,000-page document, 3 samples each, one warm-up:');
await run(browser, 'base64', 3);
await run(browser, 'stream', 3);
await browser.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
