"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const pdf_ts_1 = require("../src/pdf.ts");
const render_ts_1 = require("../src/render.ts");
(0, bun_test_1.test)('a live @page size is read', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style>@page{size:A4}</style>')).toBe('a4');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style>@page { size: 210mm 297mm }</style>')).toBe('210mm 297mm');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageMargin)('<style>@page{size:A4;margin:2cm}</style>')).toBe('2cm');
});
(0, bun_test_1.test)('a commented-out @page is not a live one', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<!-- <style>@page{size:A4}</style> --><p>x')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<!-- @page { size: A4 } --><p>x')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageMargin)('<!-- @page { margin: 0 } --><p>x')).toBeNull();
});
(0, bun_test_1.test)('a CSS comment was already skipped, and still is', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style>/* @page{size:A4} */</style><p>x')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style>/* @page{size:A4} */ @page{size:A3}</style>')).toBe('a3');
});
(0, bun_test_1.test)('an unterminated HTML comment runs to the end, as it does in a browser', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<!-- oops <style>@page{size:A4}</style>')).toBeNull();
});
(0, bun_test_1.test)('an unterminated CSS comment runs to the end, as it does in a browser', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style>/* oops @page{size:A4}')).toBeNull();
});
(0, bun_test_1.test)('a live rule after a closed comment is still found', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toBe('a3');
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toHaveLength(1);
});
(0, bun_test_1.test)('an apostrophe in a CSS comment is not a string delimiter', () => {
    const html = "<style>\n/* the trade's word for it */\n" +
        "@page { size: ledger landscape; margin: 10mm; @bottom-left { content: 'X' } }\n" +
        '</style>';
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)(html)).toBe('ledger landscape');
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)(html)).toHaveLength(1);
});
(0, bun_test_1.test)('text that is not a stylesheet is not a page rule', () => {
    const notCss = [
        '<!-- <style>@page{size:A4}</style> -->',
        '<!-- @page { size: A4 } -->',
        '<script>const css = "@page{size:A4}";</script>',
        '<script>if (x) { s = "@page{size:A4}" }</script>',
        '<div onclick="go(\'@page{size:A4}\')">x</div>',
        '<style>p::after{content:"@page { size: A4 }"}</style>',
    ];
    for (const html of notCss) {
        (0, bun_test_1.expect)({ html, size: (0, pdf_ts_1.declaredPageSize)(html) }).toEqual({ html, size: null });
        (0, bun_test_1.expect)({ html, margin: (0, pdf_ts_1.declaredPageMargin)(html) }).toEqual({ html, margin: null });
    }
});
(0, bun_test_1.test)('a live rule in any stylesheet position is still found', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<style media="print">@page{size:A3}</style>')).toBe('a3');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<p>x<style>@page{size:A5}</style>')).toBe('a5');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<script>"@page{size:A4}"</script><style>@page{size:A3}</style>')).toBe('a3');
});
(0, bun_test_1.test)('a page name in prose is not a declaration', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)('<p>Print it on A4 paper please.</p>')).toBeNull();
});
(0, bun_test_1.test)('stripPageSize takes the size out of a live rule and leaves the rest alone', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)('<style>@page{size:A4}</style>')).toBe('<style>@page{}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)('<style>@page{size:A4;margin:2cm}</style>')).toBe('<style>@page{margin:2cm}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)('<style>@page{margin:2cm;size:A4}</style>')).toBe('<style>@page{margin:2cm}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe('<style>@page cover{}@page{}</style>');
});
(0, bun_test_1.test)('stripPageSize leaves a stylesheet with no page rule byte-identical', () => {
    const html = '<style>p{color:red;font:12pt serif}</style><p>x</p>';
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)(html)).toBe(html);
});
(0, bun_test_1.test)('stripPageSize does not reach into a script', () => {
    const script = `<script>const css = "@page{size:A4}";</script>`;
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)(script + '<style>@page{size:A4}</style>')).toBe(script + '<style>@page{}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.stripPageSize)(`<div style="@page{size:A4}">x</div>`)).toBe('<div style="@page{size:A4}">x</div>');
});
(0, bun_test_1.test)('stripPageSize keeps the rest of the document intact', () => {
    const html = '<!doctype html><html><head><style>@page{size:A4}</style></head>' +
        '<body><h1>T</h1><!-- @page{size:A4} --></body></html>';
    const out = (0, pdf_ts_1.stripPageSize)(html);
    (0, bun_test_1.expect)(out).toBe('<!doctype html><html><head><style>@page{}</style></head>' +
        '<body><h1>T</h1><!-- @page{size:A4} --></body></html>');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)(out)).toBeNull();
});
(0, bun_test_1.test)('transposePageSize turns a portrait declaration landscape and keeps the margin', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:A4;margin:15mm}</style>')).toBe('<style>@page{size: a4 landscape;margin:15mm}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:210mm 297mm}</style>')).toBe('<style>@page{size: 297mm 210mm}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:8.5in 11in}</style>')).toBe('<style>@page{size: 11in 8.5in}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe('<style>@page cover{size: a3 landscape}@page{size: a4 landscape}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page :first { size: letter }</style>')).toBe('<style>@page :first { size: letter landscape }</style>');
});
(0, bun_test_1.test)('transposePageSize never turns landscape back to portrait', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:297mm 210mm}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:A4 landscape}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)('<style>@page{size:297mm 210mm}</style>')).toBe('landscape');
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)('<style>@page{size:A4 landscape}</style>')).toBe('landscape');
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)('<style>@page{size:210mm 297mm}</style>')).toBe('portrait');
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)('<style>@page{size:A4}</style>')).toBe('portrait');
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)('<style>p{color:red}</style>')).toBeNull();
});
(0, bun_test_1.test)('transposePageSize returns null rather than guessing a paper', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:auto;margin:10mm}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{size:whatever}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>p{color:red}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<p>no stylesheet</p>')).toBeNull();
});
(0, bun_test_1.test)('transposePageSize does not reach into a comment, a string, or a script', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>/* @page{size:A5} */ @page{margin:10mm}</style>')).toBeNull();
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>/* keep */ @page{size:A5}</style>')).toBe('<style>/* keep */ @page{size: a5 landscape}</style>');
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)('<style>@page{content:"size:A5";size:legal}</style>')).toBe('<style>@page{content:"size:A5";size: legal landscape}</style>');
    const script = `<script>const css = "@page{size:A4}";</script>`;
    (0, bun_test_1.expect)((0, pdf_ts_1.transposePageSize)(script + '<style>@page{size:A4}</style>')).toBe(script + '<style>@page{size: a4 landscape}</style>');
});
(0, bun_test_1.test)('transposePageSize keeps the rest of the document intact', () => {
    const html = '<!doctype html><html><head><style>@page{size:A4;margin:1in}</style></head>' +
        '<body><h1>T</h1><!-- @page{size:A4} --></body></html>';
    const out = (0, pdf_ts_1.transposePageSize)(html);
    (0, bun_test_1.expect)(out).toBe('<!doctype html><html><head><style>@page{size: a4 landscape;margin:1in}</style></head>' +
        '<body><h1>T</h1><!-- @page{size:A4} --></body></html>');
    (0, bun_test_1.expect)((0, render_ts_1.declaredPageOrientation)(out)).toBe('landscape');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageSize)(out)).toBe('a4 landscape');
    (0, bun_test_1.expect)((0, pdf_ts_1.declaredPageMargin)(out)).toBe('1in');
});
(0, bun_test_1.test)('the page rule scan does not grow with the size of the document', () => {
    const doc = `<style>${'@page '.repeat(40_000)}</style>`;
    const started = Date.now();
    const rules = (0, pdf_ts_1.pageRules)(doc);
    const took = Date.now() - started;
    (0, bun_test_1.expect)(rules).toEqual([]);
    (0, bun_test_1.expect)(took).toBeLessThan(3000);
});
(0, bun_test_1.test)('a page rule is found where a rule used to be looked for', () => {
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<style>@page{size:A4}</style>')).toEqual(['@page{size:A4}']);
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<style>@page :first{margin:1in}@page{size:A4}</style>')).toEqual([
        '@page :first{margin:1in}',
        '@page{size:A4}',
    ]);
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<!-- <style>@page{size:A4}</style> --><p>x')).toEqual([]);
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<style>/* @page{size:A4} */ @page{size:B5}</style>')).toEqual([
        '@page{size:B5}',
    ]);
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<style>@page{content:"}"}</style>')).toEqual(['@page{content:""}']);
    (0, bun_test_1.expect)((0, pdf_ts_1.pageRules)('<style>@page{size:A4}')).toEqual(['@page{size:A4}']);
});
//# sourceMappingURL=pagesize.test.js.map