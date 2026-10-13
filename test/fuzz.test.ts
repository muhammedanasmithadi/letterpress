/**
 * The fuzzer as a regression gate: a small fixed-seed batch through the same
 * contract `tools/fuzz.ts` checks at depth. The seed is fixed so the documents
 * never change; run the tool with `--count 200` to explore beyond them.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { document, fuzzOne } from '../tools/fuzz.ts';
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
