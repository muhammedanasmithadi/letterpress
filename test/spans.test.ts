import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Browser } from '../src/browser.ts';
import { streamRange, trySplit } from '../src/pdfparts.ts';
import { render } from '../src/render.ts';
import { stripRedundantSpans } from '../src/spans.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
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

/** Every inflated content stream in a file, concatenated: the text an operator runs on. */
function streams(pdf: Uint8Array): string {
  let out = '';
  for (const o of trySplit(pdf)!.objs) {
    const range = streamRange(o.bytes);
    if (!range) continue;
    const raw = o.bytes.subarray(range.start, range.end);
    try {
      out += inflateSync(raw).toString('latin1');
    } catch {
      // Not a stream, or not one this can inflate. Neither is a finding here.
    }
  }
  return out;
}

const squashText = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Counts across a whole file, so a test says what it means once. */
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
  // Kept, so this exercises the repair on bytes the pipeline has not touched. The
  // default path strips them before the caller ever sees the file.
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

  // The assertion the gate could not make. Whitespace is collapsed because line breaking in
  // the extraction follows item boundaries, which is exactly what the repair changes.
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
  expect(squash(await pdfText(out.pdf))).toBe(squash(before));
}, 240_000);

test('marked content is left balanced', async () => {
  // A content stream with one BDC against nineteen EMC is malformed, and poppler says so and
  // carries on. Skipping the EMC removals passed verify() and every structural check.
  // Kept, so this exercises the repair on bytes the pipeline has not touched. The
  // default path strips them before the caller ever sees the file.
  const r = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const out = stripRedundantSpans(r.pdf);
  // A stream with one BDC against nineteen EMC is malformed. poppler says so and carries on,
  // and verify() passes it, because the gate checks structure and not text.
  const counts = marked(out.pdf);
  expect({ bdc: counts.bdc, emc: counts.emc }).toEqual({ bdc: counts.bdc, emc: counts.bdc });
}, 240_000);

test('a span whose text the font does not also give is kept', async () => {
  // The guard that makes the default safe. A span is the only copy of its text when the
  // glyphs inside do not resolve to the same characters, and removing it would lose them.
  // Kept, so this exercises the repair on bytes the pipeline has not touched. The
  // default path strips them before the caller ever sees the file.
  const r = await render(browser, {
    html: PROSE,
    author: 'spans',
    keepLigatureSpans: true,
    timeoutMs: 120_000,
  });
  const out = stripRedundantSpans(r.pdf);
  // Everything removed was provably redundant; anything left is kept on purpose.
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

  // The finding is the only difference in what the caller is told, and both files still read.
  expect(squashText(await pdfText(stripped.pdf))).toBe(squashText(await pdfText(kept.pdf)));
}, 240_000);
