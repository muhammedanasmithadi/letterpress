/**
 * Mutation fuzzing for the repair layer: corrupt PDFs in, invariants out.
 *
 * The repairs take untrusted bytes -- any file, any damage -- so each one
 * asserts the same contract against every mutant:
 *   1. it never throws;
 *   2. its output is non-empty;
 *   3. when the input verifies and the output differs from it, the output
 *      passes verify() -- a repair must never corrupt a valid file.
 * On a broken input no verifiability is required: the pipeline runs every
 * repair through repairOrKeep, which refuses non-verifying candidates.
 *
 * Deterministic: mulberry32 with an explicit seed. Corpus is three small
 * renders plus hostile statics (empty, garbage, truncation). Mutations flip,
 * cut, duplicate and splice bytes, and corrupt lengths and xref offsets.
 *
 * Run deep: `bun tools/fuzzpdf.ts --count 300 --seed 11 --out /tmp/opencode/fuzzpdf`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fixFontDescriptors } from '../src/fontdesc.ts';
import { fixRedundantFigures } from '../src/figrole.ts';
import { fixLinkDescs } from '../src/linkdesc.ts';
import { addMetadata, setDocTitle } from '../src/meta.ts';
import { mergeTextRuns } from '../src/tjmerge.ts';
import { stripRedundantSpans } from '../src/spans.ts';
import { fixToUnicode } from '../src/tounicode.ts';
import { verify } from '../src/verify.ts';
import { rng } from './fuzz.ts';

export type Repair = { name: string; run: (pdf: Uint8Array) => Uint8Array };

export const REPAIRS: Repair[] = [
  { name: 'fixToUnicode', run: (p) => fixToUnicode(p) },
  { name: 'fixFontDescriptors', run: (p) => fixFontDescriptors(p) },
  { name: 'mergeTextRuns', run: (p) => mergeTextRuns(p).pdf },
  { name: 'stripRedundantSpans', run: (p) => stripRedundantSpans(p).pdf },
  { name: 'fixRedundantFigures', run: (p) => fixRedundantFigures(p) },
  { name: 'fixLinkDescs', run: (p) => fixLinkDescs(p, ['a description']) },
  { name: 'addMetadata', run: (p) => addMetadata(p, {}) },
  { name: 'setDocTitle', run: (p) => setDocTitle(p, 'Fuzz') },
];

export type MutantFailure = {
  seed: number;
  index: number;
  repair: string;
  mutation: string;
  reason: string;
  input: Uint8Array;
};

/** Corrupt a buffer. Never throws: tiny inputs take the early exits. */
export function mutate(
  r: () => number,
  pdf: Uint8Array,
  kind: number,
): { bytes: Uint8Array; name: string } {
  const pick = (n: number) => Math.floor(r() * n);
  const buf = Buffer.from(pdf);
  switch (kind % 6) {
    case 0: {
      // Flip bytes throughout.
      const n = 1 + pick(8);
      for (let i = 0; i < n; i++) buf[pick(buf.length)] = pick(256);
      return { bytes: buf, name: `flip${n}` };
    }
    case 1: {
      // Truncate.
      if (buf.length < 8) return { bytes: buf.subarray(0, 1), name: 'trunc1' };
      return { bytes: buf.subarray(0, 4 + pick(buf.length - 4)), name: 'truncate' };
    }
    case 2: {
      // Delete a span.
      if (buf.length < 16) return { bytes: buf.subarray(0, 0), name: 'empty' };
      const at = pick(buf.length);
      const len = 1 + pick(Math.min(400, buf.length - at));
      return { bytes: Buffer.concat([buf.subarray(0, at), buf.subarray(at + len)]), name: 'cut' };
    }
    case 3: {
      // Duplicate a span.
      if (buf.length < 8) return { bytes: Buffer.concat([buf, buf]), name: 'double' };
      const at = pick(buf.length);
      const len = 1 + pick(Math.min(200, buf.length - at));
      const piece = buf.subarray(at, at + len);
      return {
        bytes: Buffer.concat([buf.subarray(0, at), piece, piece, buf.subarray(at + len)]),
        name: 'dup',
      };
    }
    case 4: {
      // Corrupt lengths and offsets: the values a parser trusts.
      let s = buf.toString('latin1');
      const which = pick(3);
      if (which === 0) s = s.replace(/\/Length\s+\d+/, '/Length 99999999');
      else if (which === 1) s = s.replace(/startxref\s+\d+/, 'startxref 3');
      else s = s.replace(/(\d{10}) 00000 n/, '9999999999 00000 n');
      return { bytes: Buffer.from(s, 'latin1'), name: 'lie' };
    }
    default: {
      // Splice in PDF-shaped garbage.
      const junk = Buffer.from(`${pick(99)} 0 obj\n<< /Type /Junk >>\nendobj\n`, 'latin1');
      const at = pick(buf.length + 1);
      return {
        bytes: Buffer.concat([buf.subarray(0, at), junk, buf.subarray(at)]),
        name: 'splice',
      };
    }
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One repair against one mutant. Never throws: failures are values. */
export function fuzzRepair(
  repair: Repair,
  pdf: Uint8Array,
): { ok: boolean; reason?: string; out?: Uint8Array } {
  let out: Uint8Array;
  try {
    out = repair.run(pdf);
  } catch (e) {
    return {
      ok: false,
      reason: `${repair.name} threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (out.length === 0 && pdf.length !== 0) {
    return { ok: false, reason: `${repair.name} returned empty output` };
  }
  // The verifiability clause applies only when the input verifies. On a broken input
  // every repair may fail to produce a valid file -- the pipeline runs each one through
  // repairOrKeep, which refuses non-verifying candidates, so junk-out-on-junk-in never
  // ships. What no layer contains is a repair corrupting a VALID file, and that is
  // what this checks: 285 flags on one seed all traced to already-broken inputs.
  if (!same(out, pdf) && verify(pdf).ok) {
    const v = verify(out);
    if (!v.ok) {
      return {
        ok: false,
        reason: `${repair.name} corrupted a valid file: ${v.failures.join('; ').slice(0, 160)}`,
      };
    }
  }
  return { ok: true, out };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (eq !== undefined) return eq;
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  const count = Number(flag('count', '300'));
  const seed = Number(flag('seed', String(Math.floor(Math.random() * 1e9))));
  const outDir = flag('out', '/tmp/opencode/fuzzpdf');
  const { Browser } = await import('../src/browser.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { render } = await import('../src/render.ts');
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-fuzzpdf-'));
  const browser = await Browser.launch({ profile });
  const failures: MutantFailure[] = [];
  let total = 0;
  try {
    const docs = [
      `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>The official fish fills five.</p>`,
      `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}table,td{border:1pt solid #999}</style><table><tr><td>a</td><td>b</td></tr></table>`,
      `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>@page{size:A4;margin:15mm}body{direction:rtl}</style></head><body><p>نص تجريبي هنا.</p></body></html>`,
    ];
    const corpus: Uint8Array[] = [];
    for (const html of docs) {
      corpus.push((await render(browser, { html, author: 'fuzz' })).pdf);
    }
    corpus.push(new Uint8Array(0));
    corpus.push(Buffer.from('not a pdf at all, just words', 'latin1'));
    corpus.push(Buffer.from('%PDF-1.4\ntrailer\n', 'latin1'));

    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      const src = corpus[Math.floor(r() * corpus.length)]!;
      const { bytes, name } = mutate(r, src, Math.floor(r() * 6));
      for (const repair of REPAIRS) {
        total++;
        const res = fuzzRepair(repair, bytes);
        if (!res.ok) {
          failures.push({
            seed,
            index: i,
            repair: repair.name,
            mutation: name,
            reason: res.reason!,
            input: bytes,
          });
          console.log(`FAIL seed=${seed} #${i} ${repair.name} on ${name}: ${res.reason}`);
        }
      }
      if ((i + 1) % 50 === 0) console.log(`…${i + 1}/${count}`);
    }
    console.log(
      `${total - failures.length}/${total} pass, ${failures.length} failures (seed ${seed})`,
    );
    if (failures.length) {
      await mkdir(outDir, { recursive: true });
      for (const [n, f] of failures.entries()) {
        await writeFile(join(outDir, `seed${f.seed}-${n}-${f.repair}-${f.mutation}.pdf`), f.input);
      }
      console.log(`mutants in ${outDir}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
