/**
 * The page-side audit in `src/lint.ts`.
 *
 * It had no direct test at all, only indirect exercise through renders, which is why a
 * balanced-brace mistake in the 200-line page-side script went unnoticed: the script failed
 * to evaluate, every render reported `audit-failed`, and no assertion looked for the
 * findings it was supposed to produce. `parseAudit` below is the first thing that would have
 * caught it, and it is the cheapest test in this file -- it needs no browser.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('lint');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

const codes = (r: { findings: Array<{ code: string }> }): string[] => r.findings.map((f) => f.code);

test('the page-side script parses as javascript', () => {
  // It ships as a string, so nothing else in the build can see a syntax error. It has had
  // one, and the symptom was every document reporting that the checks could not run.
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'lint.ts'), 'utf8');
  const m = /const AUDIT = String\.raw`([\s\S]*?)`;\n/.exec(src);
  expect(m, 'could not find the AUDIT constant').not.toBeNull();
  expect(() => new Function(m![1]!)).not.toThrow();
});

test('the audit reports real findings rather than failing to run', async () => {
  const r = await render(browser, {
    html: `<!doctype html><meta charset="utf-8">
      <style>@page{size:A4;margin:15mm} h1::after{content:target-counter(h1, page)}</style>
      <h1>Report</h1><p>{{leftover}}</p>`,
    author: 'lint',
  });
  expect(codes(r)).not.toContain('audit-failed');
  expect(codes(r)).toContain('unfilled-placeholder');
}, 60_000);

test('a clean document reports nothing from the audit', async () => {
  const r = await render(browser, {
    html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>
      <p>Body text that fills a line and wraps.</p>`,
    author: 'lint',
  });
  expect(codes(r)).not.toContain('audit-failed');
  expect(codes(r)).not.toContain('unfilled-placeholder');
  expect(codes(r)).not.toContain('audit-partial');
}, 60_000);

test('a digit run is not reported as reversing into itself', async () => {
  // The message rendered the reversal by splitting on dashes and underscores only, so a
  // token written with spaces came back as "will print with its groups reversed (+971 50
  // 123 4567)" -- the original string, quoted as its own reversal. A reader who tried it
  // and it did not reverse had no reason to believe the rest.
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>رقم 971 50 123 4567</p></body></html>`,
    author: 'lint',
  });
  const run = r.findings.find((f) => f.code === 'rtl-digit-run');
  expect(run, 'no rtl-digit-run finding').toBeDefined();
  expect(run!.message).toMatch(/reorder under right-to-left layout/);
  // The claim and the quoted form must not contradict each other.
  expect(run!.message).not.toMatch(/reversed \(971 50 123 4567\)/);

  // And a dashed token still names its reversal, because that is the case the words
  // describe.
  const dashed = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>رقم 2026-10-03</p></body></html>`,
    author: 'lint',
  });
  const withDash = dashed.findings.find((f) => f.code === 'rtl-digit-run');
  expect(withDash!.message).toMatch(/reversed \(03-10-2026\)/);
}, 90_000);

test('an RTL paragraph ending in a Latin token still reports its digit run', async () => {
  // A computed right-to-left direction must not be overridden by a trailing
  // left-to-right word: the paragraph is laid out right-to-left, so a date in
  // it reorders even when "INV-2026-0147" happens to come after it.
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
      @page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
    </style></head><body><p>تاريخ 2026-10-03 . INV-2026-0147</p></body></html>`,
    author: 'lint',
  });
  expect(r.findings.some((f) => f.code === 'rtl-digit-run')).toBe(true);
}, 90_000);
