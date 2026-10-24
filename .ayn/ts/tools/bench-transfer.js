"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const node_fs_1 = require("node:fs");
function bigDoc() {
    if (process.env.BIG_DOC)
        return (0, node_fs_1.readFileSync)(process.env.BIG_DOC, 'utf8');
    return (`<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}.s{break-before:page}</style>` +
        Array.from({ length: 2000 }, (_, i) => `<div class="s"><h1>Section ${i + 1}</h1><p>Body text for the transfer run.</p></div>`).join(''));
}
const html = bigDoc();
function rssTree(pid) {
    let total = 0;
    const add = (p) => {
        try {
            const rss = Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(p)])
                .stdout.toString()
                .trim());
            if (Number.isFinite(rss))
                total += rss;
        }
        catch { }
    };
    add(pid);
    try {
        const kids = Bun.spawnSync(['pgrep', '-P', String(pid)])
            .stdout.toString()
            .trim()
            .split('\n')
            .filter(Boolean);
        for (const k of kids)
            add(Number(k));
    }
    catch { }
    return total;
}
async function run(browser, mode, samples) {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < samples; i++) {
        let peak = 0;
        const t0 = Bun.nanoseconds();
        const watch = setInterval(() => {
            const r = rssTree(process.pid);
            if (r > peak)
                peak = r;
        }, 120);
        const r = await (0, render_ts_1.render)(browser, { html, transfer: mode, timeoutMs: 120_000 });
        clearInterval(watch);
        times.push((Bun.nanoseconds() - t0) / 1e6);
        bytes = r.pdf.byteLength;
        peak = Math.max(peak, rssTree(process.pid));
        if (i === samples - 1) {
            console.log(`  ${mode.padEnd(7)} peak_rss_observed=${(peak / 1024).toFixed(0)}MB  pages=${r.info.pages}`);
        }
    }
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    console.log(`  ${mode.padEnd(7)} median ${(med / 1000).toFixed(2)}s  min ${(times[0] / 1000).toFixed(2)}s  max ${(times[times.length - 1] / 1000).toFixed(2)}s  pdf ${(bytes / 1024 / 1024).toFixed(1)}MB`);
}
const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-tr-'));
const browser = await browser_ts_1.Browser.launch({ profile });
await (0, render_ts_1.render)(browser, { html: 'warm', timeoutMs: 60_000 });
console.log('2,000-page document, 3 samples each, one warm-up:');
await run(browser, 'base64', 3);
await run(browser, 'stream', 3);
await browser.close();
await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
//# sourceMappingURL=bench-transfer.js.map