"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const html = `<!doctype html><meta charset="utf-8"><title>Format</title>
<style>@page{size:A4;margin:12mm}</style><h1>Report</h1><p>office efficient flags finished</p>`;
const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-d2-'));
const b = await browser_ts_1.Browser.launch({ profile });
async function pair(label) {
    const a = Buffer.from((await (0, render_ts_1.render)(b, { html, author: 'Someone' })).pdf);
    await Bun.sleep(1100);
    const c = Buffer.from((await (0, render_ts_1.render)(b, { html, author: 'Someone' })).pdf);
    const same = a.equals(c);
    let diffAt = -1;
    if (!same)
        for (let i = 0; i < Math.min(a.length, c.length); i++)
            if (a[i] !== c[i]) {
                diffAt = i;
                break;
            }
    console.log(`  ${label.padEnd(22)} identical=${same}  lengths ${a.length}/${c.length}` +
        (diffAt >= 0
            ? `  first diff at ${diffAt}: ${JSON.stringify(a.toString('latin1').slice(diffAt - 30, diffAt + 20))} vs ${JSON.stringify(c.toString('latin1').slice(diffAt - 30, diffAt + 20))}`
            : ''));
}
await pair('no pinned clock');
process.env.SOURCE_DATE_EPOCH = '1700000000';
await pair('SOURCE_DATE_EPOCH set');
delete process.env.SOURCE_DATE_EPOCH;
await b.close();
await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
//# sourceMappingURL=bench-determinism.js.map