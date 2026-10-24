"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const selection_ts_1 = require("../src/selection.ts");
let browser;
let profile;
const PARAGRAPH = `<p>WAVE To. Pack my box with five dozen liquor jugs, and consider the office that
  efficient, affluent and difficult people occupy. A well-set page gives the eye a path to
  follow: the measure is short enough that the return sweep is accurate.</p>`;
const page = (align) => `<!doctype html><meta charset="utf-8">
  <style>@page{size:A4;margin:48mm}
    body{font-family:'Noto Serif',serif;font-size:10.5pt;line-height:1.5}
    p{text-align:${align};margin:0}</style>${PARAGRAPH}`;
function said(r) {
    return r.findings.find((f) => f.code === 'selection-fragmented')?.message;
}
(0, bun_test_1.describe)('word gaps a browser will break a selection on', () => {
    (0, bun_test_1.test)('justified text is reported and ragged-right text is not', async () => {
        const justified = await (0, render_ts_1.render)(browser, { html: page('justify'), author: 's' });
        const ragged = await (0, render_ts_1.render)(browser, { html: page('left'), author: 's' });
        const message = said(justified);
        (0, bun_test_1.expect)(message).toBeDefined();
        (0, bun_test_1.expect)(/0\.\d\d em/.test(message)).toBe(true);
        (0, bun_test_1.expect)(/text-align:justify/.test(message)).toBe(true);
        (0, bun_test_1.expect)(said(ragged) ?? '').not.toMatch(/word space/);
    }, 120_000);
    (0, bun_test_1.test)('the measurement agrees with what a browser does', async () => {
        const ROWS = 30;
        const COLS = 3;
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8">
        <style>@page{size:A4;margin:15mm} body{font-family:'Noto Sans',sans-serif;font-size:8.5pt}
        table{width:100%;border-collapse:collapse} td{padding:3.2pt 6pt}</style>
        <table>${Array.from({ length: ROWS }, (_, i) => `<tr><td>S-${i}</td><td>${i}.000</td><td>${i}.500</td></tr>`).join('')}</table>`,
            author: 's',
        });
        const flow = (0, selection_ts_1.textFlow)(r.pdf);
        (0, bun_test_1.expect)(flow).not.toBeNull();
        (0, bun_test_1.expect)(flow.jump).toBe(ROWS * (COLS - 1));
        (0, bun_test_1.expect)(flow.tooWide).toBe(0);
    }, 120_000);
    (0, bun_test_1.test)('spans are stripped by default, and reported when kept', async () => {
        const html = `<!doctype html><meta charset="utf-8">
      <style>@page{size:A4;margin:20mm}
        body{font-family:'Noto Serif',serif;font-size:11pt;text-align:left}</style>
      <p>${'Body text that fills a line and wraps with office affluent. '.repeat(12)}</p>`;
        const r = await (0, render_ts_1.render)(browser, { html, author: 's' });
        const spans = r.findings.find((f) => f.code === 'ligature-spans');
        (0, bun_test_1.expect)(spans).toBeDefined();
        (0, bun_test_1.expect)(spans.message).toMatch(/removed \d+ of \d+/);
        (0, bun_test_1.expect)(said(r)).toBeUndefined();
        const kept = await (0, render_ts_1.render)(browser, { html, author: 's', keepLigatureSpans: true });
        (0, bun_test_1.expect)(kept.findings.map((f) => f.code)).not.toContain('ligature-spans');
        (0, bun_test_1.expect)((0, selection_ts_1.textFlow)(kept.pdf).spans).toBeGreaterThan(5);
        (0, bun_test_1.expect)(said(kept)).toMatch(/marked-content spans/);
    }, 120_000);
    (0, bun_test_1.test)('a document with no text reports nothing rather than guessing', async () => {
        const bare = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4}</style><hr>`,
            author: 's',
        });
        (0, bun_test_1.expect)(said(bare)).toBeUndefined();
    }, 120_000);
    (0, bun_test_1.test)('a file with no words in it is a different answer from one it cannot read', () => {
        (0, bun_test_1.expect)((0, selection_ts_1.textFlow)(Buffer.from('not a pdf'))).toBeNull();
        const empty = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n');
        (0, bun_test_1.expect)((0, selection_ts_1.textFlow)(new Uint8Array(empty))).toBeNull();
    });
});
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'lp-sel-profile-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
});
//# sourceMappingURL=selection.test.js.map