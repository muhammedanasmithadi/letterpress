import { expect, test } from 'bun:test';
import {
  declaredPageMargin,
  declaredPageSize,
  pageRules,
  stripPageSize,
} from '../src/pdf.ts';

// `declaredPageSize` is what the pipeline asks before it decides whether the document has
// chosen its own paper. When it says yes, no paper is sent to Chromium at all and the
// fallback is Letter. A false yes therefore does not merely mislabel a finding -- it
// changes the sheet, with nothing reported. It had no test at all.

test('a live @page size is read', () => {
  expect(declaredPageSize('<style>@page{size:A4}</style>')).toBe('a4');
  expect(declaredPageSize('<style>@page { size: 210mm 297mm }</style>')).toBe('210mm 297mm');
  expect(declaredPageMargin('<style>@page{size:A4;margin:2cm}</style>')).toBe('2cm');
});

test('a commented-out @page is not a live one', () => {
  // The case that shipped: the author's `@page { size: A4 }` sits in an HTML comment, the
  // probe reported A4, `preferCSSPageSize` went on, no paper was sent, and the A4 document
  // printed on Letter.
  expect(declaredPageSize('<!-- <style>@page{size:A4}</style> --><p>x')).toBeNull();
  expect(declaredPageSize('<!-- @page { size: A4 } --><p>x')).toBeNull();
  expect(declaredPageMargin('<!-- @page { margin: 0 } --><p>x')).toBeNull();
});

test('a CSS comment was already skipped, and still is', () => {
  expect(declaredPageSize('<style>/* @page{size:A4} */</style><p>x')).toBeNull();
  expect(declaredPageSize('<style>/* @page{size:A4} */ @page{size:A3}</style>')).toBe('a3');
});

test('an unterminated HTML comment runs to the end, as it does in a browser', () => {
  // If the comment stopped at the first `-->` that was never typed, the live @page behind
  // it would be counted and the paper flipped the other way: a Letter sheet on an A4
  // document, which is the same defect wearing the other hat.
  expect(declaredPageSize('<!-- oops <style>@page{size:A4}</style>')).toBeNull();
});

test('a live rule after a closed comment is still found', () => {
  expect(declaredPageSize('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toBe('a3');
  expect(pageRules('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toHaveLength(1);
});

test('text that is not a stylesheet is not a page rule', () => {
  // The same defect, four more sources of text that is not CSS. Each one reads back as a
  // live declaration, and a live declaration turns off the paper sent to Chromium.
  const notCss = [
    '<!-- <style>@page{size:A4}</style> -->',
    '<!-- @page { size: A4 } -->',
    '<script>const css = "@page{size:A4}";</script>',
    '<script>if (x) { s = "@page{size:A4}" }</script>',
    "<div onclick=\"go('@page{size:A4}')\">x</div>",
    '<style>p::after{content:"@page { size: A4 }"}</style>',
  ];
  for (const html of notCss) {
    expect({ html, size: declaredPageSize(html) }).toEqual({ html, size: null });
    expect({ html, margin: declaredPageMargin(html) }).toEqual({ html, margin: null });
  }
});

test('a live rule in any stylesheet position is still found', () => {
  expect(declaredPageSize('<style media="print">@page{size:A3}</style>')).toBe('a3');
  expect(declaredPageSize('<p>x<style>@page{size:A5}</style>')).toBe('a5');
  // And behind each of the non-CSS sources above.
  expect(declaredPageSize('<script>"@page{size:A4}"</script><style>@page{size:A3}</style>')).toBe(
    'a3',
  );
});

test('a page name in prose is not a declaration', () => {
  expect(declaredPageSize('<p>Print it on A4 paper please.</p>')).toBeNull();
});

test('stripPageSize takes the size out of a live rule and leaves the rest alone', () => {
  expect(stripPageSize('<style>@page{size:A4}</style>')).toBe('<style>@page{}</style>');
  expect(stripPageSize('<style>@page{size:A4;margin:2cm}</style>')).toBe(
    '<style>@page{margin:2cm}</style>',
  );
  expect(stripPageSize('<style>@page{margin:2cm;size:A4}</style>')).toBe(
    '<style>@page{margin:2cm}</style>',
  );
  // Named pages, so the right rule is the one that changes.
  expect(stripPageSize('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe(
    '<style>@page cover{}@page{}</style>',
  );
});

test('stripPageSize leaves a stylesheet with no page rule byte-identical', () => {
  const html = '<style>p{color:red;font:12pt serif}</style><p>x</p>';
  expect(stripPageSize(html)).toBe(html);
});

test('stripPageSize does not reach into a script', () => {
  // It replaced across the whole document. A page builder holding this string in
  // JavaScript had it rewritten to "@page{}", and a template injected at load time then
  // carried no page size at all -- the print pipeline changing the document it was asked to
  // print. The string is the evidence; the pipeline's contract is to change paper only.
  const script = `<script>const css = "@page{size:A4}";</script>`;
  expect(stripPageSize(script + '<style>@page{size:A4}</style>')).toBe(
    script + '<style>@page{}</style>',
  );
  expect(stripPageSize(`<div style="@page{size:A4}">x</div>`)).toBe(
    '<div style="@page{size:A4}">x</div>',
  );
});

test('stripPageSize keeps the rest of the document intact', () => {
  const html =
    '<!doctype html><html><head><style>@page{size:A4}</style></head>' +
    '<body><h1>T</h1><!-- @page{size:A4} --></body></html>';
  const out = stripPageSize(html);
  expect(out).toBe(
    '<!doctype html><html><head><style>@page{}</style></head>' +
      '<body><h1>T</h1><!-- @page{size:A4} --></body></html>',
  );
  // And what it stripped is what it claims to have stripped.
  expect(declaredPageSize(out)).toBeNull();
});
