import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser } from '../src/browser.ts';
import { streamRange, trySplit } from '../src/pdfparts.ts';
import { render } from '../src/render.ts';
import { stripRedundantSpans } from '../src/spans.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
import { encryptedFixture } from './fixtures.ts';
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
