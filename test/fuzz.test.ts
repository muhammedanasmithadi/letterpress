/**
 * The fuzzer as a regression gate: a small fixed-seed batch through the same
 * contract `tools/fuzz.ts` checks at depth. The seed is fixed so the documents
 * never change; run the tool with `--count 200` to explore beyond them.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { document, fuzzOne, rng } from '../tools/fuzz.ts';
import { fuzzExoticFile, fuzzRepair, mutate, REPAIRS, type ExoticFile } from '../tools/fuzzpdf.ts';
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

test('exotic files pass through every repair byte-identical', async () => {
  // Committed producer outputs (Ghostscript 10.06.0): a linearized file with a
  // later revision the splitter cannot see, and an R3-encrypted file whose
  // content is ciphertext. Both must survive every repair unchanged -- any
  // rewrite from a fragment, or plaintext spliced into ciphertext, is unsound.
  // Deep exploration lives in the tool (--exotic); these two pin the contract.
  const dir = join(import.meta.dir, 'data');
  const cases: Array<{ file: string; kind: ExoticFile['kind']; marker: RegExp }> = [
    { file: 'linearized.pdf', kind: 'linearized', marker: /\/Linearized\b/ },
    { file: 'encrypted-r3.pdf', kind: 'encrypted', marker: /\/Encrypt\b/ },
  ];
  for (const { file, kind, marker } of cases) {
    const bytes = new Uint8Array(await Bun.file(join(dir, file)).arrayBuffer());
    expect(bytes.length, `${file} is empty`).toBeGreaterThan(100);
    const text = Buffer.from(bytes).toString('latin1');
    expect(marker.test(text), `${file} lost its shape`).toBe(true);
    const res = fuzzExoticFile({ kind, detail: file, bytes });
    expect(res.failures, `${file}: ${res.failures.join('; ')}`).toEqual([]);
  }
});
