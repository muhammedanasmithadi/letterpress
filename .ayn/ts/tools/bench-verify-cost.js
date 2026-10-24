"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const verify_ts_1 = require("../src/verify.ts");
function doc(n) {
    const body = Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`).join('')}`).join('');
    return `<!doctype html><meta charset="utf-8"><title>D</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-gc-'));
const b = await browser_ts_1.Browser.launch({ profile });
console.log('verify() cost on already-shipped output (the worst case: always runs):');
for (const n of [1, 20, 100, 200]) {
    const r = await (0, render_ts_1.render)(b, { html: doc(n), author: 'Bench' });
    const times = [];
    for (let i = 0; i < 5; i++) {
        const t0 = Bun.nanoseconds();
        (0, verify_ts_1.verify)(r.pdf);
        times.push((Bun.nanoseconds() - t0) / 1e6);
    }
    times.sort((a, b2) => a - b2);
    const med = times[2];
    console.log(`  ${String(r.info.pages).padStart(3)} pages  ${(r.pdf.byteLength / 1024).toFixed(0).padStart(5)} KB  verify ${med.toFixed(1).padStart(6)} ms   render was ${r.ms} ms   ${((100 * med) / r.ms).toFixed(1)}% of render`);
}
await b.close();
await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
//# sourceMappingURL=bench-verify-cost.js.map