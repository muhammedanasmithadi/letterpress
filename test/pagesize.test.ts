import { expect, test } from 'bun:test';
import {
  declaredPageMargin,
  declaredPageSize,
  pageRules,
  stripPageSize,
  transposePageSize,
} from '../src/pdf.ts';
import { declaredPageOrientation } from '../src/render.ts';

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

test('an apostrophe in a CSS comment is not a string delimiter', () => {
  // The same defect from the other side. Stripping quoted strings before CSS comments let
  // the apostrophe in `trade's` open a string, which then closed at the next quote in the
  // document -- the one in `content: 'The Estuary Chronicle'` -- and swallowed the whole
  // @page rule in between. `declaredPageSize` answered null, `preferCSSPageSize` was never
  // turned on, no paper was sent, and a ledger-landscape newspaper printed on A4 with no
  // finding at all.
  //
  // The comment has to be closed by a second quote for the phantom string to close on
  // something, so the fixture carries one. A comment holding the document's only quote
  // does not reproduce it, which is why a shorter fixture would have looked fine.
  const html =
    "<style>\n/* the trade's word for it */\n" +
    "@page { size: ledger landscape; margin: 10mm; @bottom-left { content: 'X' } }\n" +
    '</style>';
  expect(declaredPageSize(html)).toBe('ledger landscape');
  expect(pageRules(html)).toHaveLength(1);
});

test('text that is not a stylesheet is not a page rule', () => {
  // The same defect, four more sources of text that is not CSS. Each one reads back as a
  // live declaration, and a live declaration turns off the paper sent to Chromium.
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

test('transposePageSize turns a portrait declaration landscape and keeps the margin', () => {
  // The whole point is that the document keeps its own paper and its own margin. A rewrite
  // that dropped the margin to buy an orientation would trade one silent wrong page for
  // another, so the margin is asserted, not assumed.
  expect(transposePageSize('<style>@page{size:A4;margin:15mm}</style>')).toBe(
    '<style>@page{size: a4 landscape;margin:15mm}</style>',
  );
  // Two lengths swap edges rather than taking a keyword, so the paper stays the paper.
  expect(transposePageSize('<style>@page{size:210mm 297mm}</style>')).toBe(
    '<style>@page{size: 297mm 210mm}</style>',
  );
  // Mixed units are still two edges.
  expect(transposePageSize('<style>@page{size:8.5in 11in}</style>')).toBe(
    '<style>@page{size: 11in 8.5in}</style>',
  );
  // Named pages, so every rule is transposed and the rule after it is intact.
  expect(transposePageSize('<style>@page cover{size:A3}@page{size:A4}</style>')).toBe(
    '<style>@page cover{size: a3 landscape}@page{size: a4 landscape}</style>',
  );
  // The space before a brace survives: `size: letter }` must not become `size: letter }`
  // with the brace welded to the keyword.
  expect(transposePageSize('<style>@page :first { size: letter }</style>')).toBe(
    '<style>@page :first { size: letter landscape }</style>',
  );
});

test('transposePageSize never turns landscape back to portrait', () => {
  // Swapping unconditionally turned `297mm 210mm` -- already landscape, and the one
  // spelling that needs no change at all -- into portrait. A document that had it right
  // would have been printed wrong by a request asking for what it already had.
  expect(transposePageSize('<style>@page{size:297mm 210mm}</style>')).toBeNull();
  expect(transposePageSize('<style>@page{size:A4 landscape}</style>')).toBeNull();
  expect(declaredPageOrientation('<style>@page{size:297mm 210mm}</style>')).toBe('landscape');
  expect(declaredPageOrientation('<style>@page{size:A4 landscape}</style>')).toBe('landscape');
  expect(declaredPageOrientation('<style>@page{size:210mm 297mm}</style>')).toBe('portrait');
  expect(declaredPageOrientation('<style>@page{size:A4}</style>')).toBe('portrait');
  expect(declaredPageOrientation('<style>p{color:red}</style>')).toBeNull();
});

test('transposePageSize returns null rather than guessing a paper', () => {
  // `auto` names no sheet, so there is no portrait spelling to rotate. Returning null is
  // what keeps the finding honest: the engine reports that the request could not be
  // honoured instead of printing a sheet the document never asked for.
  expect(transposePageSize('<style>@page{size:auto;margin:10mm}</style>')).toBeNull();
  expect(transposePageSize('<style>@page{size:whatever}</style>')).toBeNull();
  // Nor is there anything to do when no page is declared at all.
  expect(transposePageSize('<style>p{color:red}</style>')).toBeNull();
  expect(transposePageSize('<p>no stylesheet</p>')).toBeNull();
});

test('transposePageSize does not reach into a comment, a string, or a script', () => {
  // A commented-out page rule is itself a match for the rule pattern, so the rule has to
  // be skipped in the same pass that finds it. The measured first version transposed the
  // `size` inside the comment as readily as the live one: a page nobody had written gained
  // a landscape declaration.
  expect(transposePageSize('<style>/* @page{size:A5} */ @page{margin:10mm}</style>')).toBeNull();
  // A live rule behind a comment is still transposed, and the comment is byte-identical.
  expect(transposePageSize('<style>/* keep */ @page{size:A5}</style>')).toBe(
    '<style>/* keep */ @page{size: a5 landscape}</style>',
  );
  // A string that reads like a declaration, inside a live rule.
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
  // And what it wrote is what it claims: a declaration the engine will read as landscape.
  expect(declaredPageOrientation(out)).toBe('landscape');
  expect(declaredPageSize(out)).toBe('a4 landscape');
  expect(declaredPageMargin(out)).toBe('1in');
});
