"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const fontdesc_ts_1 = require("../src/fontdesc.ts");
const tounicode_ts_1 = require("../src/tounicode.ts");
const meta_ts_1 = require("../src/meta.ts");
function doc(sections) {
    const body = Array.from({ length: sections }, (_, i) => `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1} of section ${i + 1}. office efficient different flags finished warehouse loading invoices.</p>`).join('')}`).join('');
    return `<!doctype html><meta charset="utf-8"><title>Doc</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const letter = `<!doctype html><meta charset="utf-8"><title>Letter</title>
<h1>Letter</h1><p>Dear Sir,</p><p>office efficient different flags finished</p><p>Yours faithfully,</p>`;
async function hit(browser, target) {
    let sections = Math.max(1, Math.round(target / 5));
    for (let i = 0; i < 6; i++) {
        const r = await (0, render_ts_1.render)(browser, { html: doc(sections), timeoutMs: 120_000 });
        if (r.info.pages >= target)
            return { html: doc(sections), pages: r.info.pages };
        sections = Math.ceil(sections * (target / r.info.pages) * 1.05);
    }
    return { html: doc(sections), pages: -1 };
}
const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-bl-'));
const probe = await browser_ts_1.Browser.launch({ profile });
const resumePath = process.env.RESUME_DOC;
const resumeHtml = `<!doctype html><meta charset="utf-8"><title>Resume</title>` +
    `<style>@page{size:A4;margin:14mm}body{font-family:sans-serif;font-size:9.5pt}` +
    `h1{font-size:18pt;margin:0}h2{font-size:11pt;border-bottom:1pt solid #999;margin:8pt 0 4pt}` +
    `table{width:100%;border-collapse:collapse}td{padding:1pt 4pt;vertical-align:top}</style>` +
    `<h1>Jane Doe</h1><p>Engineer -- jobs@example.com -- 555-0100</p>` +
    `<h2>Experience</h2><table>` +
    Array.from({ length: 8 }, (_, i) => `<tr><td><b>Role ${i + 1}</b>, Company ${i + 1}</td><td>202${i}-202${i + 1}</td></tr>` +
        `<tr><td colspan="2">Shipped features, fixed defects, measured everything twice.</td></tr>`).join('') +
    `</table><h2>Skills</h2><p>Engines, pipelines, proofs, and the occasional benchmark.</p>`;
const workloads = [
    ['letter', { html: letter }],
    resumePath ? ['resume', { path: resumePath }] : ['resume', { html: resumeHtml }],
    ['20p', await hit(probe, 20)],
    ['100p', await hit(probe, 100)],
    ['400p', await hit(probe, 400)],
];
const measured = workloads.map(([n, r]) => [n, r.pages ?? null]);
await probe.close();
await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
const pct = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s[Math.floor(s.length / 2)];
    const first = s[0];
    const last = s[s.length - 1];
    if (mid === undefined || first === undefined || last === undefined)
        throw new Error('pct needs at least one sample');
    return {
        p50: Math.round(mid),
        min: Math.round(first),
        max: Math.round(last),
    };
};
const out = [];
for (const [name, req] of workloads) {
    const cold = [];
    const repair = [];
    let bytes = 0;
    let pages = 0;
    for (let i = 0; i < 3; i++) {
        const p = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-cold-'));
        const b = await browser_ts_1.Browser.launch({ profile: p });
        const t0 = Bun.nanoseconds();
        const r = await (0, render_ts_1.render)(b, req);
        cold.push((Bun.nanoseconds() - t0) / 1e6);
        pages = r.info.pages;
        bytes = r.pdf.byteLength;
        const t1 = Bun.nanoseconds();
        (0, meta_ts_1.addMetadata)((0, fontdesc_ts_1.fixFontDescriptors)((0, tounicode_ts_1.fixToUnicode)(r.pdf)), { author: 'bench' });
        repair.push((Bun.nanoseconds() - t1) / 1e6);
        await b.close();
        await (0, promises_1.rm)(p, { recursive: true, force: true }).catch(() => { });
    }
    const p2 = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-warm-'));
    const b2 = await browser_ts_1.Browser.launch({ profile: p2 });
    const warm = [];
    for (let i = 0; i < 5; i++) {
        const t0 = Bun.nanoseconds();
        await (0, render_ts_1.render)(b2, req);
        warm.push((Bun.nanoseconds() - t0) / 1e6);
    }
    await b2.close();
    await (0, promises_1.rm)(p2, { recursive: true, force: true }).catch(() => { });
    out.push({
        workload: name,
        pages,
        kb: Math.round(bytes / 1024),
        coldMs: pct(cold),
        warmMs: pct(warm),
        repairMs: pct(repair),
    });
}
console.log('pages actually produced:', JSON.stringify(measured));
console.table(out.map((r) => ({
    workload: r.workload,
    pages: r.pages,
    KB: r.kb,
    cold_p50: r.coldMs.p50,
    cold_max: r.coldMs.max,
    warm_p50: r.warmMs.p50,
    warm_max: r.warmMs.max,
    repair_p50: r.repairMs.p50,
    repair_pct_of_warm: +((100 * r.repairMs.p50) / r.warmMs.p50).toFixed(1),
})));
//# sourceMappingURL=bench-baseline.js.map