/**
 * The file handed back to the caller is the last thing the pipeline produces and the first
 * thing anybody trusts. Nothing was checking it.
 *
 * `mergeTextRuns` rewrites content streams and `stampPdf` rewrites bytes in place, and both
 * run after the last gate. The merge proves itself by replaying both streams and comparing
 * every glyph position, which is a real proof about glyph positions and says nothing about
 * whether the file opens. The stamp had no proof at all.
 *
 * The first version of the reporting test used `mock.module` on the verify module to force
 * the check to fail. That mock is global in Bun: the test passed locally because the files
 * ran in a different order, and in CI `final.test.ts` runs before `verify.test.ts` and broke
 * it. The decision is now a pure function of the bytes and needs no registry to reach.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { finalCheckFinding, render } from '../src/render.ts';
import { verify } from '../src/verify.ts';

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'letterpress-final-'));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}, 20_000);

test('what a render returns passes the structural check', async () => {
  // The invariant, over shapes that exercise different parts of the pipeline: prose with
  // ligatures to merge, a declared page size to strip, a document with no local assets.
  const shapes = [
    '<!doctype html><meta charset="utf-8"><p>Body text that fills a line and wraps.</p>',
    '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:2cm}</style><p>x</p>',
    '<!doctype html><meta charset="utf-8"><h1>T</h1><table><tr><td>a</td><td>b</td></tr></table>',
  ];
  for (const html of shapes) {
    const r = await render(browser, { html, author: 'a', subject: 's' });
    expect(r.findings.map((f) => f.code)).not.toContain('output-unverified');
    expect(verify(r.pdf).ok).toBe(true);
  }
}, 90_000);

test('a file that will not open is an error finding, not silence', async () => {
  const good = await render(browser, {
    html: '<!doctype html><meta charset="utf-8"><p>x</p>',
  });
  expect(finalCheckFinding(good.pdf)).toBeNull();

  // Each of these is a real way a file stops being readable, taken from what verify checks.
  const whole = new TextDecoder('latin1').decode(good.pdf);
  const broken: Array<[string, Uint8Array]> = [
    ['%%EOF removed', new TextEncoder().encode(whole.replace(/%%EOF\s*$/, ''))],
    ['header removed', new TextEncoder().encode(whole.replace(/^%PDF-[\d.]+\n/, ''))],
    ['body truncated', good.pdf.subarray(0, good.pdf.byteLength - 40)],
  ];
  for (const [name, bytes] of broken) {
    const finding = finalCheckFinding(bytes);
    expect({ name, found: finding !== null }).toEqual({ name, found: true });
    expect(finding!.severity).toBe('error');
    // The message has to carry the reason, or it is a shrug with a severity attached.
    expect(finding!.message).toMatch(/structural check:/);
  }
}, 90_000);
