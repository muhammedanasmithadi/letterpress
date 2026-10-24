import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser } from '../src/browser.ts';
import { streamRange, trySplit } from '../src/pdfparts.ts';
import { render } from '../src/render.ts';
import { stripRedundantSpans } from '../src/spans.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
import { assemblePdf, deflated, encryptedFixture, streamText } from './fixtures.ts';
import { pdfText } from './poppler.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('spans');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

function streams(pdf: Uint8Array): string {
  let out = '';
  for (const o of trySplit(pdf)!.objs) {
    const range = streamRange(o.bytes);
    if (!range) continue;
    const raw = o.bytes.subarray(range.start, range.end);
    try {
      out += inflateSync(raw).toString('latin1');
    } catch {}
  }
  return out;
}

const squashText = (s: string): string => s.replace(/\s+/g, ' ').trim();

function marked(pdf: Uint8Array): { bdc: number; emc: number; actualText: number } {
  const text = streams(pdf);
  const count = (re: RegExp): number => (text.match(re) ?? []).length;
  return {
    bdc: count(/\bBDC\b/g),
    emc: count(/\bEMC\b/g),
    actualText: count(/\/ActualText/g),
  };
}

const PROSE = `<!doctype html><style>@page{size:A4;margin:15mm}
  body { font: 11pt "Noto Serif" }</style>
  <p>${'Body text that fills a line and wraps with specific workflows. '.repeat(18)}</p>`;

test('the repair removes the spans and changes no character', async () => {
  const r = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const before = await pdfText(r.pdf);
  expect(before.toLowerCase()).toContain('fills');
  expect(before.toLowerCase()).toContain('specific');

  const out = stripRedundantSpans(r.pdf);
  expect(out.stats.seen).toBeGreaterThan(0);
  expect(out.stats.stripped).toBeGreaterThan(0);
  expect(verify(out.pdf).ok).toBe(true);

  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
  expect(squash(await pdfText(out.pdf))).toBe(squash(before));
}, 240_000);

test('marked content is left balanced', async () => {
  const r = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const out = stripRedundantSpans(r.pdf);
  const counts = marked(out.pdf);
  expect({ bdc: counts.bdc, emc: counts.emc }).toEqual({ bdc: counts.bdc, emc: counts.bdc });
}, 240_000);

test('a span whose text the font does not also give is kept', async () => {
  const r = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const out = stripRedundantSpans(r.pdf);
  expect(marked(out.pdf).actualText).toBe(out.stats.kept);
}, 240_000);

test('the pipeline strips them, and keepLigatureSpans opts out', async () => {
  const stripped = await render(browser, { html: PROSE, author: 'spans', timeoutMs: 120_000 });
  const kept = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });

  const says = stripped.findings.find((f) => f.code === 'ligature-spans');
  expect(says).toBeDefined();
  expect(says!.message).toMatch(/removed \d+ of \d+/);
  expect(kept.findings.map((f) => f.code)).not.toContain('ligature-spans');

  expect(squashText(await pdfText(stripped.pdf))).toBe(squashText(await pdfText(kept.pdf)));
}, 240_000);

describe('ciphertext is not content', () => {
  test('no span is cut from it, and none is even counted', () => {
    const pdf = encryptedFixture();
    const out = stripRedundantSpans(pdf);
    expect(Buffer.from(out.pdf).equals(Buffer.from(pdf))).toBe(true);
    expect(out.stats).toEqual({ seen: 0, stripped: 0, kept: 0 });
  });
});

const CID_FONT = (kidNum: number, cmapNum: number): string =>
  `<</Type /Font /Subtype /Type0 /BaseFont /FIX+t /Encoding /Identity-H ` +
  `/DescendantFonts [${kidNum} 0 R] /ToUnicode ${cmapNum} 0 R>>`;
const CID_KID =
  '<</Type /Font /Subtype /CIDFontType2 /BaseFont /FIX+t ' +
  '/CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /DW 1000>>';
const CMAP = (rows: Array<[string, string]>): string =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /F def ` +
  `1 begincodespacerange <0000> <FFFF> endcodespacerange ${rows.length} beginbfchar\n` +
  rows.map(([c, u]) => `<${c}> <${u}>`).join('\n') +
  `\nendbfchar endcmap end`;

function spanFixture(body: string): { pdf: Uint8Array; streamNum: number } {
  const content = 'BT\n/F1 12 Tf\n1 0 0 1 10 700 Tm\n<0055> Tj\n' + body + '\n<0056> Tj\nET\n';
  const cmap = deflated(content);
  const f1Cmap = CMAP([
    ['0055', '0075'],
    ['0056', '0076'],
  ]);
  const f2Cmap = CMAP([['0676', '00660069']]);
  const pdf = assemblePdf([
    '<</Type /Catalog /Pages 2 0 R >>',
    '<</Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Contents 10 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> >>',
    CID_FONT(5, 8),
    CID_KID,
    CID_FONT(7, 9),
    CID_KID,
    { dict: `<</Length ${f1Cmap.length} >>`, payload: Buffer.from(f1Cmap, 'latin1') },
    { dict: `<</Length ${f2Cmap.length} >>`, payload: Buffer.from(f2Cmap, 'latin1') },
    { dict: `<</Length ${cmap.length} /Filter /FlateDecode >>`, payload: cmap },
  ]);
  return { pdf, streamNum: 10 };
}

test('a span whose body restates the font resolves through the body', () => {
  const { pdf, streamNum } = spanFixture(
    '/Span<</ActualText (fi) >> BDC\n/F2 12 Tf\n<0676> Tj\nEMC',
  );
  const before = streamText(pdf, streamNum);
  expect(before).toContain('/ActualText');

  const out = stripRedundantSpans(pdf);
  expect(out.stats).toEqual({ seen: 1, stripped: 1, kept: 0 });

  const after = streamText(out.pdf, streamNum);
  expect(after).not.toMatch(/ActualText|BDC|EMC/);
  expect(after).toContain('<0055> Tj');
  expect(after).toContain('<0056> Tj');
  expect(after).toContain('<0676> Tj');
});

test('a span body that switches fonts mid-span still resolves glyphs by their running font', () => {
  const { pdf, streamNum } = spanFixture(
    '/Span<</ActualText (fiu) >> BDC\n/F2 12 Tf\n<0676> Tj\n/F1 12 Tf\n<0055> Tj\nEMC',
  );
  const out = stripRedundantSpans(pdf);
  expect(out.stats).toEqual({ seen: 1, stripped: 1, kept: 0 });
  expect(streamText(out.pdf, streamNum)).not.toMatch(/ActualText|BDC|EMC/);
});

test('a span whose declared text the running font contradicts is kept', () => {
  const { pdf, streamNum } = spanFixture(
    '/Span<</ActualText (fi) >> BDC\n/F1 12 Tf\n<0055> Tj\nEMC',
  );
  const out = stripRedundantSpans(pdf);
  expect(out.stats).toEqual({ seen: 1, stripped: 0, kept: 1 });
  expect(streamText(out.pdf, streamNum)).toContain('/ActualText');
});

test('a span that restates its own font resolves through the body, not the previous run', async () => {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:15mm}body{font-family:sans-serif;margin:0}</style></head><body>` +
    `<p>alpha text here</p>` +
    `<p>go see <a href="#one">first target</a> and <a href="#two">second target</a> after.</p>` +
    `<p id="one">one prose</p><p id="two">two prose</p>` +
    `<p>zeta text here</p></body></html>`;
  const kept = await render(browser, {
    html,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const before = await pdfText(kept.pdf);
  expect(squashText(before)).toContain('first target');

  const out = stripRedundantSpans(kept.pdf);
  expect(out.stats.seen).toBe(1);
  expect(out.stats.stripped).toBe(1);
  expect(out.stats.kept).toBe(0);

  const after = await pdfText(out.pdf);
  expect(squashText(after)).toBe(squashText(before));
  expect(verify(out.pdf).ok).toBe(true);
}, 240_000);

test('the pipeline removes such a span and stays quiet about selection', async () => {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>` +
    `<style>@page{size:A4;margin:15mm}body{font-family:sans-serif;margin:0}</style></head><body>` +
    `<p>alpha text here</p>` +
    `<p>go see <a href="#one">first target</a> and <a href="#two">second target</a> after.</p>` +
    `<p id="one">one prose</p><p id="two">two prose</p>` +
    `<p>zeta text here</p></body></html>`;
  const r = await render(browser, { html, author: 'spans', timeoutMs: 120_000 });
  const says = r.findings.find((f) => f.code === 'ligature-spans');
  expect(says).toBeDefined();
  expect(says!.message).toMatch(/removed 1 of 1/);
  expect(r.findings.map((f) => f.code)).not.toContain('selection-fragmented');
  expect(verify(r.pdf).ok).toBe(true);
}, 240_000);
