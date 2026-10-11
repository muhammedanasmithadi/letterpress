/**
 * The file handed back to the caller is the last thing the pipeline produces and the first
 * thing anybody trusts. Nothing was checking it.
 *
 * `mergeTextRuns` rewrites content streams and `stampPdf` rewrites bytes in place, and both
 * run after the last gate. The merge proves itself by replaying both streams and comparing
 * every glyph position, which is a real proof about glyph positions and says nothing about
 * whether the file opens. The stamp had no proof at all.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
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

test('a stamp that would damage the file is discarded, not returned', async () => {
  // Reached by forcing the check to fail, which no ordinary document does. A code path that
  // nothing can reach is a code path nobody has shown works.
  mock.module('../src/verify.ts', () => ({
    verify: () => ({ ok: false, failures: ['the xref table does not resolve'] }),
    repairOrKeep: (original: Uint8Array) => ({
      pdf: original,
      applied: false,
      failures: ['the repair threw: forced by this test'],
    }),
  }));
  const forced = await import('../src/render.ts');

  const r = await forced.render(browser, {
    html: '<!doctype html><meta charset="utf-8"><p>x</p>',
  });

  const findings = r.findings;
  expect(findings.some((f) => f.code === 'repair-rejected')).toBe(true);
  expect(findings.some((f) => f.code === 'output-unverified')).toBe(true);
  // An error, not a warning: the caller is holding bytes this pipeline believes are broken.
  expect(findings.find((f) => f.code === 'output-unverified')!.severity).toBe('error');
  // And it still returns bytes rather than throwing, because the document did render.
  expect(r.pdf.byteLength).toBeGreaterThan(0);
}, 90_000);
