/**
 * The fuzzer as a regression gate: a small fixed-seed batch through the same
 * contract `tools/fuzz.ts` checks at depth. The seed is fixed so the documents
 * never change; run the tool with `--count 200` to explore beyond them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFindings, document, fuzzOne, rng } from '../tools/fuzz.ts';
import {
  exoticCorpus,
  fuzzExoticFile,
  fuzzRepair,
  ghostscriptOk,
  mutate,
  REPAIRS,
  type ExoticFile,
} from '../tools/fuzzpdf.ts';
import { render } from '../src/render.ts';
import { assemblePdf } from './fixtures.ts';
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

describe('harness units (no browser)', () => {
  test('rng is deterministic per seed and varies across seeds', () => {
    const a = rng(7);
    const seq = [a(), a(), a()];
    const b = rng(7);
    expect([b(), b(), b()]).toEqual(seq);
    const c = rng(8);
    expect(c()).not.toBe(seq[0]);
  });

  test('documents are complete HTML with a head, blocks and tail', () => {
    const { html, head, tail, blocks } = document(99, 3);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith('</body></html>')).toBe(true);
    expect(html).toBe(head + blocks.join('\n') + tail);
    // Empty bodies occur by design (a tenth of documents); the joins hold either way.
  });

  test('every mutation kind returns named bytes without throwing', () => {
    const src = Buffer.from('%PDF-1.4\n1 0 obj\n<< /A 1 >>\nendobj\ntrailer\n<< /Size 2 >>\n');
    const r = rng(11);
    const names = new Set<string>();
    for (let kind = 0; kind < 6; kind++) {
      const { bytes, name } = mutate(r, src, kind);
      expect(name.length).toBeGreaterThan(0);
      expect(bytes.length).toBeGreaterThan(0);
      names.add(name);
    }
    expect(names.size).toBe(6);
    // Tiny and empty inputs take the early exits, not the floor.
    expect(mutate(r, new Uint8Array(0), 0).bytes.length).toBe(0);
    expect(mutate(r, new Uint8Array(0), 3).bytes.length).toBe(0);
    expect(mutate(r, Buffer.from('x'), 1).bytes.length).toBe(1);
  });

  test('fuzzRepair names a throw, an emptying and a corruption', () => {
    const pdf = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    ]);
    const throwing = {
      name: 'boom',
      run: (_p: Uint8Array): Uint8Array => {
        throw new Error('nope');
      },
    };
    expect(fuzzRepair(throwing, pdf).ok).toBe(false);
    expect(fuzzRepair(throwing, pdf).reason).toContain('threw');
    const emptying = { name: 'void', run: (_p: Uint8Array): Uint8Array => new Uint8Array(0) };
    expect(fuzzRepair(emptying, pdf).ok).toBe(false);
    const corrupting = {
      name: 'rot',
      run: (p: Uint8Array): Uint8Array => {
        const b = Buffer.from(p);
        b[20] = 0x58;
        return b;
      },
    };
    // A single flipped byte breaks the xref, so a valid file in means a refusal out.
    expect(fuzzRepair(corrupting, pdf).ok).toBe(false);
    expect(fuzzRepair(corrupting, pdf).reason).toContain('corrupted a valid file');
    const keeping = { name: 'same', run: (p: Uint8Array): Uint8Array => p };
    expect(fuzzRepair(keeping, pdf).ok).toBe(true);
  });

  test('fuzzExoticFile names a throw, an emptying and a rewrite', () => {
    const pdf = assemblePdf(['<< /Type /Catalog /Pages 2 0 R >>']);
    const file: ExoticFile = { kind: 'encrypted', detail: 'unit', bytes: pdf };
    const throwing = {
      name: 'boom',
      run: (_p: Uint8Array): Uint8Array => {
        throw new Error('nope');
      },
    };
    expect(fuzzExoticFile(file, [throwing]).failures.join(';')).toContain('threw');
    const emptying = { name: 'void', run: (_p: Uint8Array): Uint8Array => new Uint8Array(0) };
    expect(fuzzExoticFile(file, [emptying]).failures.join(';')).toContain('emptied');
    const keeping = { name: 'same', run: (p: Uint8Array): Uint8Array => p };
    expect(fuzzExoticFile(file, [keeping]).failures).toEqual([]);
  });

  test('checkFindings rejects malformed findings and unknown severities', () => {
    expect(checkFindings([{ code: 'x', severity: 'warn', message: 'm' }])).toBeUndefined();
    expect(checkFindings([{ code: '', severity: 'warn', message: 'm' }])).toContain('malformed');
    expect(checkFindings([{ code: 'x', severity: 'warn', message: '' }])).toContain('malformed');
    // Findings arrive from the page as JSON, so the severity is unknown at runtime
    // no matter what the type says: cast through unknown to test the check itself.
    const bogus = { code: 'x', severity: 'bogus', message: 'm' } as unknown as {
      code: string;
      severity: 'error';
      message: string;
    };
    expect(checkFindings([bogus])).toContain('unknown severity');
  });

  test('ghostscript is present and the producer yields both shapes', async () => {
    expect(await ghostscriptOk()).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'letterpress-fuzzexotic-'));
    try {
      const base = assemblePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
      ]);
      const files = await exoticCorpus([base], dir);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.kind === 'linearized')).toBe(true);
      expect(files.some((f) => f.kind === 'encrypted')).toBe(true);
      for (const f of files) {
        expect(fuzzExoticFile(f).failures).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
