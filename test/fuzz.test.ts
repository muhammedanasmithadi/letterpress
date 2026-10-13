/**
 * The fuzzer as a regression gate: a small fixed-seed batch through the same
 * contract `tools/fuzz.ts` checks at depth. The seed is fixed so the documents
 * never change; run the tool with `--count 200` to explore beyond them.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { document, fuzzOne, rng } from '../tools/fuzz.ts';
import { fuzzRepair, mutate, REPAIRS } from '../tools/fuzzpdf.ts';
import { render } from '../src/render.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;

beforeAll(async () => {
  t = await launchTestBrowser('fuzz');
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

test('fifteen fixed documents hold the render contract', async () => {
  // Seed 20261013: fifteen documents, zero failures measured at introduction. If this
  // fails, the tool prints the seed, index and reason; re-run the tool with
  // --seed 20261013 to reproduce, and the shrunk repro lands in the out dir.
  for (let i = 0; i < 15; i++) {
    const { html } = document(20261013, i);
    const res = await fuzzOne(t.browser, 20261013, i, html);
    expect(res.ok, `seed 20261013 doc ${i}: ${res.reason}\n${html.slice(0, 600)}`).toBe(true);
    expect(res.pages).toBeGreaterThan(0);
  }
}, 240_000);

test('every repair holds its contract on mutated files', async () => {
  // Two renders, forty mutants each across all six mutation kinds, every repair.
  // The corpus is rendered, not synthetic: repairs behave differently on real
  // object graphs. Mutants and repairs are pure functions, so this is CPU-bound.
  const r1 = await render(t.browser, {
    html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>The official fish fills five.</p>`,
    author: 'fuzz',
  });
  const r2 = await render(t.browser, {
    html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}table,td{border:1pt solid #999}</style><table><tr><td>a</td><td>b</td></tr></table>`,
    author: 'fuzz',
  });
  const r = rng(4242);
  let checked = 0;
  for (const src of [r1.pdf, r2.pdf]) {
    for (let i = 0; i < 40; i++) {
      const { bytes, name } = mutate(r, src, Math.floor(r() * 6));
      for (const repair of REPAIRS) {
        const res = fuzzRepair(repair, bytes);
        expect(
          res.ok,
          `${repair.name} on ${name} mutant of ${bytes.length} bytes: ${res.reason}`,
        ).toBe(true);
        checked++;
      }
    }
  }
  expect(checked).toBe(2 * 40 * REPAIRS.length);
}, 120_000);
