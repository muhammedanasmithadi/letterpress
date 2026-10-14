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
import { join } from 'node:path';
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

export type ExoticKind = 'linearized' | 'encrypted';
export type ExoticFile = { kind: ExoticKind; detail: string; bytes: Uint8Array };

/** Ghostscript present and executable, the exotic producer's only requirement. */
export async function ghostscriptOk(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['gs', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Producer for files the renderer never emits but the repairs meet in the wild.
 * Ghostscript rewrites each base PDF linearized (-dFastWebView) and encrypted
 * (R2/40, R3/128 with a user password and with an empty one). R4/AES revisions
 * are beyond this Ghostscript (it says so: revisions 2 and 3 only), so those
 * stay an explicit gap rather than a silent one.
 *
 * Output bytes depend on the Ghostscript version, so everything downstream
 * asserts structure, never bytes.
 */
export async function exoticCorpus(bases: Uint8Array[], dir: string): Promise<ExoticFile[]> {
  const out: ExoticFile[] = [];
  const run = async (
    args: string[],
    input: string,
    output: string,
  ): Promise<Uint8Array | undefined> => {
    const proc = Bun.spawn(
      ['gs', '-q', '-dBATCH', '-dNOPAUSE', ...args, `-sOutputFile=${output}`, input],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    const code = await proc.exited;
    try {
      const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
      return code === 0 && bytes.length > 100 ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
  let n = 0;
  for (const base of bases) {
    const input = join(dir, `base-${n}.pdf`);
    await writeFile(input, base);
    const lin = await run(
      ['-dFastWebView', '-sDEVICE=pdfwrite'],
      input,
      join(dir, `base-${n}-linear.pdf`),
    );
    if (lin) out.push({ kind: 'linearized', detail: `fastwebview base-${n}`, bytes: lin });
    const variants: Array<[string, string[]]> = [
      ['r2-40', ['-sDEVICE=pdfwrite', '-sOwnerPassword=o123', '-dEncryptionR=2', '-dKeyLength=40']],
      [
        'r3-128-user',
        [
          '-sDEVICE=pdfwrite',
          '-sOwnerPassword=o123',
          '-sUserPassword=u123',
          '-dEncryptionR=3',
          '-dKeyLength=128',
        ],
      ],
      [
        'r3-128-empty',
        ['-sDEVICE=pdfwrite', '-sOwnerPassword=o123', '-dEncryptionR=3', '-dKeyLength=128'],
      ],
    ];
    for (const [detail, args] of variants) {
      const enc = await run(args, input, join(dir, `base-${n}-${detail}.pdf`));
      if (enc) out.push({ kind: 'encrypted', detail: `${detail} base-${n}`, bytes: enc });
    }
    n++;
  }
  return out;
}

export type ExoticResult = { file: ExoticFile; failures: string[]; notes: string[] };

/**
 * Multi-revision and encrypted inputs must pass through every repair
 * byte-identical: no repair sees the whole document (linearized later revisions
 * are invisible to the splitter) or anything at all (ciphertext), so any
 * rewrite is unsound. Plaintext metadata into an encrypted file would also leak
 * title and author around encryption the owner configured -- byte-identity
 * forbids that too, with no special case.
 */
export function fuzzExoticFile(file: ExoticFile, repairs: Repair[] = REPAIRS): ExoticResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const v = verify(file.bytes);
  notes.push(`verify(input)=${v.ok}`);
  for (const repair of repairs) {
    let out: Uint8Array;
    try {
      out = repair.run(file.bytes);
    } catch (e) {
      failures.push(`${repair.name} threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (out.length === 0 && file.bytes.length !== 0) {
      failures.push(`${repair.name} emptied the file`);
      continue;
    }
    if (!same(out, file.bytes)) {
      failures.push(
        `${repair.name} rewrote a ${file.kind} file (${file.bytes.length} -> ${out.length} bytes)`,
      );
    }
  }
  return { file, failures, notes };
}

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
      const n = 1 + pick(8);
      for (let i = 0; i < n; i++) buf[pick(buf.length)] = pick(256);
      return { bytes: buf, name: `flip${n}` };
    }
    case 1: {
      if (buf.length < 8) return { bytes: buf.subarray(0, 1), name: 'trunc1' };
      return { bytes: buf.subarray(0, 4 + pick(buf.length - 4)), name: 'truncate' };
    }
    case 2: {
      if (buf.length < 16) return { bytes: buf.subarray(0, 0), name: 'empty' };
      const at = pick(buf.length);
      const len = 1 + pick(Math.min(400, buf.length - at));
      return { bytes: Buffer.concat([buf.subarray(0, at), buf.subarray(at + len)]), name: 'cut' };
    }
    case 3: {
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
    // Compressed object streams (PDF 1.5+): trySplit only reads plain xref tables,
    // so these exercise the early-return paths, not the repairs.
    corpus.push(
      Buffer.from(
        '%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '10 0 obj\n<< /Type /ObjStm /N 2 /First 12 /Length 40 >>\nstream\n' +
          '1 0 2 10 << /A 1 >> << /B 2 >>\nendstream\nendobj\n' +
          'trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
        'latin1',
      ),
    );
    // An encryption dictionary: content is unreadable without the key.
    corpus.push(
      Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          'trailer\n<< /Size 2 /Root 1 0 R /Encrypt << /Filter /Standard /V 2 /Length 128 >> >>\n' +
          'startxref\n0\n%%EOF\n',
        'latin1',
      ),
    );

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

    if (argv.includes('--exotic')) {
      if (!(await ghostscriptOk())) {
        console.log('exotic corpus skipped: gs not found (Ghostscript 10+ with pdfwrite)');
      } else {
        const exoticDir = join(outDir, 'exotic');
        await mkdir(exoticDir, { recursive: true });
        const files = await exoticCorpus(corpus.slice(0, 3), exoticDir);
        let exoticFails = 0;
        for (const file of files) {
          await writeFile(
            join(exoticDir, `${file.kind}-${file.detail.replace(/[^a-z0-9-]+/gi, '_')}.pdf`),
            file.bytes,
          );
          const res = fuzzExoticFile(file);
          console.log(
            `${file.kind} ${file.detail}: ${res.failures.length ? 'FAIL' : 'keep'} ${res.notes.join(' ')}`,
          );
          for (const f of res.failures) {
            console.log(`  ${f}`);
            exoticFails++;
          }
        }
        console.log(`${files.length} exotic files, ${exoticFails} failures`);
        if (exoticFails) process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
