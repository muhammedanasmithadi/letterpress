"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
function parseFonts(out) {
    return out
        .split('\n')
        .slice(2)
        .filter((l) => l.trim().length > 10)
        .map((l) => {
        const p = l.trim().split(/\s+/);
        return {
            name: p[0],
            type: p[1],
            emb: p[p.length - 5],
            sub: p[p.length - 4],
            uni: p[p.length - 3],
        };
    });
}
async function profile(path) {
    try {
        (0, node_fs_1.statSync)(path);
    }
    catch {
        return null;
    }
    const fonts = parseFonts(await Bun.$ `pdffonts ${path}`.text());
    const info = await Bun.$ `pdfinfo ${path}`.text();
    const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
    const tagged = /^\s*Tagged:\s+(\S+)/im.exec(info)?.[1] ?? '?';
    const bytes = (await Bun.file(path).arrayBuffer()).byteLength;
    const extracted = await Bun.$ `pdftotext ${path} -`.text();
    const yes = (v) => v === 'yes';
    return {
        pages,
        kbPerPage: Math.round(bytes / 1024 / Math.max(1, pages)),
        fonts: fonts.length,
        embedded: fonts.filter((f) => yes(f.emb)).length,
        subset: fonts.filter((f) => yes(f.sub)).length,
        toUnicode: fonts.filter((f) => yes(f.uni)).length,
        type3: fonts.filter((f) => /Type\s*3/.test(f.type)).length,
        tagged,
        words: extracted.split(/\s+/).filter(Boolean).length,
    };
}
const COLUMNS = [
    'pages',
    'kbPerPage',
    'fonts',
    'embedded',
    'subset',
    'toUnicode',
    'type3',
    'tagged',
    'words',
];
const HEAD = ['file', 'pages', 'KB/p', 'fonts', 'emb', 'sub', 'toUni', 'T3', 'tagged', 'words'];
const argv = process.argv.slice(2);
const oursAt = argv.indexOf('--ours');
let rows = [];
if (oursAt !== -1) {
    const htmlPath = argv[oursAt + 1];
    if (!htmlPath) {
        console.error('usage: bun tools/quality.ts --ours <file.html> <reference.pdf> ...');
        process.exit(2);
    }
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-quality-'));
    const browser = await browser_ts_1.Browser.launch({ profile: dir });
    let failed = false;
    try {
        const result = await (0, render_ts_1.render)(browser, { path: htmlPath, author: 'quality' });
        const out = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `letterpress-ours-${Date.now()}.pdf`);
        await Bun.write(out, result.pdf);
        rows.push({ label: 'ours', path: out });
    }
    catch (e) {
        console.error(`cannot render ${htmlPath}: ${e instanceof Error ? e.message : e}`);
        failed = true;
    }
    await browser.close();
    await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
    if (failed)
        process.exit(1);
    rows.push(...argv.slice(oursAt + 2).map((p) => ({ label: p.split('/').pop(), path: p })));
}
else {
    rows = argv.map((p) => ({ label: p.split('/').pop(), path: p }));
}
if (!rows.length) {
    console.error('usage: bun tools/quality.ts <file.pdf> ... | --ours <file.html> <reference.pdf> ...');
    process.exit(2);
}
let failed = false;
console.log('  ' +
    HEAD[0].padEnd(26) +
    HEAD.slice(1)
        .map((h) => h.padStart(7))
        .join(''));
for (const row of rows) {
    const p = await profile(row.path);
    if (!p) {
        console.log('  ' + row.label.padEnd(26) + ' (unreadable)');
        failed = true;
        continue;
    }
    const cells = COLUMNS.map((c) => String(p[c]).slice(0, 7));
    console.log('  ' + row.label.padEnd(26) + cells.map((c) => c.padStart(7)).join(''));
}
if (failed)
    process.exit(1);
//# sourceMappingURL=quality.js.map