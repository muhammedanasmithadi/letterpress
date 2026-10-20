import { expect, test } from 'bun:test';
import {
  declaredPageMargin,
  declaredPageSize,
  pageRules,
  stripPageSize,
  transposePageSize,
} from '../src/pdf.ts';
import { declaredPageOrientation } from '../src/render.ts';

test('a live @page size is read', () => {
  expect(declaredPageSize('<style>@page{size:A4}</style>')).toBe('a4');
  expect(declaredPageSize('<style>@page { size: 210mm 297mm }</style>')).toBe('210mm 297mm');
  expect(declaredPageMargin('<style>@page{size:A4;margin:2cm}</style>')).toBe('2cm');
});

test('a commented-out @page is not a live one', () => {
  expect(declaredPageSize('<!-- <style>@page{size:A4}</style> --><p>x')).toBeNull();
  expect(declaredPageSize('<!-- @page { size: A4 } --><p>x')).toBeNull();
  expect(declaredPageMargin('<!-- @page { margin: 0 } --><p>x')).toBeNull();
});

test('a CSS comment was already skipped, and still is', () => {
  expect(declaredPageSize('<style>/* @page{size:A4} */</style><p>x')).toBeNull();
  expect(declaredPageSize('<style>/* @page{size:A4} */ @page{size:A3}</style>')).toBe('a3');
});

test('an unterminated HTML comment runs to the end, as it does in a browser', () => {
  expect(declaredPageSize('<!-- oops <style>@page{size:A4}</style>')).toBeNull();
});

test('a live rule after a closed comment is still found', () => {
  expect(declaredPageSize('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toBe('a3');
  expect(pageRules('<!-- @page{size:A4} --><style>@page{size:A3}</style>')).toHaveLength(1);
});

test('an apostrophe in a CSS comment is not a string delimiter', () => {
  const html =
    "<style>\n/* the trade's word for it */\n" +
    "@page { size: ledger landscape; margin: 10mm; @bottom-left { content: 'X' } }\n" +
    '</style>';
  expect(declaredPageSize(html)).toBe('ledger landscape');
  expect(pageRules(html)).toHaveLength(1);
});

test('text that is not a stylesheet is not a page rule', () => {
  const notCss = [
    '<!-- <style>@page{size:A4}</style> -->',
    '<!-- @page { size: A4 } -->',
    '<script>const css = "@page{size:A4}";</script>',
    '<script>if (x) { s = "@page{size:A4}" }</script>',
    '<div onclick="go(\'@page{size:A4}\')">x</div>',
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
  expect(stripPageSize('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe(
    '<style>@page cover{}@page{}</style>',
  );
});

test('stripPageSize leaves a stylesheet with no page rule byte-identical', () => {
  const html = '<style>p{color:red;font:12pt serif}</style><p>x</p>';
  expect(stripPageSize(html)).toBe(html);
});

test('stripPageSize does not reach into a script', () => {
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
  expect(declaredPageSize(out)).toBeNull();
});

test('transposePageSize turns a portrait declaration landscape and keeps the margin', () => {
  expect(transposePageSize('<style>@page{size:A4;margin:15mm}</style>')).toBe(
    '<style>@page{size: a4 landscape;margin:15mm}</style>',
  );
  expect(transposePageSize('<style>@page{size:210mm 297mm}</style>')).toBe(
    '<style>@page{size: 297mm 210mm}</style>',
  );
  expect(transposePageSize('<style>@page{size:8.5in 11in}</style>')).toBe(
    '<style>@page{size: 11in 8.5in}</style>',
  );
  expect(transposePageSize('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe(
    '<style>@page cover{size: a3 landscape}@page{size: a4 landscape}</style>',
  );
  expect(transposePageSize('<style>@page :first { size: letter }</style>')).toBe(
    '<style>@page :first { size: letter landscape }</style>',
  );
});

test('transposePageSize never turns landscape back to portrait', () => {
  expect(transposePageSize('<style>@page{size:297mm 210mm}</style>')).toBeNull();
  expect(transposePageSize('<style>@page{size:A4 landscape}</style>')).toBeNull();
  expect(declaredPageOrientation('<style>@page{size:297mm 210mm}</style>')).toBe('landscape');
  expect(declaredPageOrientation('<style>@page{size:A4 landscape}</style>')).toBe('landscape');
  expect(declaredPageOrientation('<style>@page{size:210mm 297mm}</style>')).toBe('portrait');
  expect(declaredPageOrientation('<style>@page{size:A4}</style>')).toBe('portrait');
  expect(declaredPageOrientation('<style>p{color:red}</style>')).toBeNull();
});

test('transposePageSize returns null rather than guessing a paper', () => {
  expect(transposePageSize('<style>@page{size:auto;margin:10mm}</style>')).toBeNull();
  expect(transposePageSize('<style>@page{size:whatever}</style>')).toBeNull();
  expect(transposePageSize('<style>p{color:red}</style>')).toBeNull();
  expect(transposePageSize('<p>no stylesheet</p>')).toBeNull();
});

test('transposePageSize does not reach into a comment, a string, or a script', () => {
  expect(transposePageSize('<style>/* @page{size:A5} */ @page{margin:10mm}</style>')).toBeNull();
  expect(transposePageSize('<style>/* keep */ @page{size:A5}</style>')).toBe(
    '<style>/* keep */ @page{size: a5 landscape}</style>',
  );
  expect(transposePageSize('<style>@page{content:"size:A5";size:legal}</style>')).toBe(
    '<style>@page{content:"size:A5";size: legal landscape}</style>',
  );
  const script = `<script>const css = "@page{size:A4}";</script>`;
  expect(transposePageSize(script + '<style>@page{size:A4}</style>')).toBe(
    script + '<style>@page{size: a4 landscape}</style>',
  );
});

test('transposePageSize keeps the rest of the document intact', () => {
  const html =
    '<!doctype html><html><head><style>@page{size:A4;margin:1in}</style></head>' +
    '<body><h1>T</h1><!-- @page{size:A4} --></body></html>';
  const out = transposePageSize(html)!;
  expect(out).toBe(
    '<!doctype html><html><head><style>@page{size: a4 landscape;margin:1in}</style></head>' +
      '<body><h1>T</h1><!-- @page{size:A4} --></body></html>',
  );
  expect(declaredPageOrientation(out)).toBe('landscape');
  expect(declaredPageSize(out)).toBe('a4 landscape');
  expect(declaredPageMargin(out)).toBe('1in');
});
