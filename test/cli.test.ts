import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagNames, parseArgs } from '../src/cli.ts';
import { pdfInfo, pdfText } from './poppler.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let dir: string;
let doc: string;

const DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm; @bottom-center { content: counter(page) " of " counter(pages); font: 9pt sans-serif } }
/* A named family, not the generic sans-serif. A generic family resolves through
   fontconfig, so the page count came out 2 on the machine that wrote this and 1 on a
   CI runner with a different font set -- and the test was asserting on fontconfig's
   choice rather than on the cli. */
body { font-family: "DejaVu Sans", sans-serif }
td { border: 0.5pt solid #999; padding: 2pt }
</style></head><body><h1>CLI fixture</h1><p>Rendered from a file.</p>
<table>${Array.from({ length: 24 }, (_, i) => `<tr><td>Row ${i + 1}</td></tr>`).join('')}</table>
</body></html>`;

async function run(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'letterpress-cli-test-'));
  doc = join(dir, 'fixture.html');
  await writeFile(doc, DOC, 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('renders a file and reports where it went', async () => {
  const out = join(dir, 'one.pdf');

  const r = await run([doc, '-o', out, '--timeout', '120000']);

  expect(r.stderr).not.toMatch(/error:/);

  expect(r.code, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  const bytes = await Bun.file(out).arrayBuffer();
  expect(bytes.byteLength).toBeGreaterThan(1000);

  const info = await pdfInfo(new Uint8Array(bytes));

  expect(r.stdout).toMatch(new RegExp(`one\\.pdf\\s+${info.pages} pages?\\s+[\\d.]+ KB\\s+\\d+ms`));
  expect(info.pages).toBeGreaterThan(0);
  expect(info.pageSize).toContain('594.96');

  const second = await run([doc, '-o', join(dir, 'warn.json'), '--json']);
  const codes = JSON.parse(second.stdout) as {
    ok: boolean;
    findings: Array<{ code: string; severity: string }>;
  };
  expect(codes.ok).toBe(true);
  expect(second.code).toBe(0);
  for (const f of codes.findings) expect(f.severity).not.toBe('error');
}, 60_000);

test('a finding is printed to stderr and the document is still written', async () => {
  const broken = join(dir, 'broken.html');
  await writeFile(
    broken,
    `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>` +
      `<p>text</p><img src="does-not-exist.png">`,
    'utf8',
  );
  const out = join(dir, 'broken.pdf');
  const r = await run([broken, '-o', out]);
  expect(r.code).toBe(0);
  expect(r.stderr).toMatch(/^warn:/m);
  expect(r.stderr).not.toMatch(/error:/);

  expect((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(1000);
}, 60_000);

test('json output is machine readable', async () => {
  const out = join(dir, 'two.pdf');
  const r = await run([doc, '-o', out, '--json']);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.path).toBe(out);

  expect(parsed.pages).toBe(
    (await pdfInfo(new Uint8Array(await Bun.file(out).arrayBuffer()))).pages,
  );
  expect(parsed.bytes).toBeGreaterThan(1000);
  expect(typeof parsed.ms).toBe('number');
  expect(parsed.imageObjects).toBe(0);
  expect(Array.isArray(parsed.findings)).toBe(true);
}, 60_000);

test('derives the output name from the input', async () => {
  const r = await run([doc], undefined);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/fixture\.pdf/);
  expect(await Bun.file(join(process.cwd(), 'fixture.pdf')).exists()).toBe(true);
  await rm(join(process.cwd(), 'fixture.pdf'), { force: true });
}, 60_000);

test('reads HTML from stdin', async () => {
  const out = join(dir, 'piped.pdf');
  const r = await run(
    ['-', '-o', out, '--json'],
    '<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>From stdin</h1>',
  );

  expect(
    r.code,
    `exit ${r.code}\nstdout: ${r.stdout.slice(0, 400)}\nstderr: ${r.stderr.slice(0, 600)}`,
  ).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.source).toBe('html');
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  expect(await pdfText(bytes)).toContain('From stdin');
}, 60_000);

test('a format override is applied and reported', async () => {
  const out = join(dir, 'letter.pdf');
  const r = await run([doc, '-o', out, '--format', 'letter', '--json']);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.findings.some((f: { code?: string }) => f.code === 'page-size-override')).toBe(
    true,
  );
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  expect((await pdfInfo(bytes)).pageSize).toMatch(/612/);
}, 60_000);

test('blocked remote assets surface as warnings but still render', async () => {
  const remote = join(dir, 'remote.html');
  await writeFile(
    remote,
    `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css"><p>Kept.</p>`,
    'utf8',
  );
  const out = join(dir, 'remote.pdf');
  const r = await run([remote, '-o', out, '--json']);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.blocked.some((u: string) => u.includes('example.invalid'))).toBe(true);
  expect(r.stderr).toContain('blocked a remote request');
}, 60_000);

test('bad usage exits 2 without launching a browser', async () => {
  for (const args of [
    ['--format', 'nope', 'x.html'],
    ['--out'],
    ['--margin', '5mm', 'x.html'],
    [],
    ['--bogus'],
  ]) {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage');
  }
}, 30_000);

test('an option does not swallow the flag after it', async () => {
  // `--margin` took the next argv entry unconditionally, so `--margin --json doc.html`
  // consumed `--json` and threw it away. The error named the margin and never mentioned the
  // flag that had just been lost, so the obvious next move -- retyping the command -- fails
  // the same way.
  for (const flag of ['--json', '--landscape', '--format']) {
    const r = await run([join(dir, 'doc.html'), '--margin', flag]);
    expect(r.code, `${flag} after --margin`).toBe(2);
    expect(r.stderr, `${flag} after --margin`).toContain('--margin needs a value');
  }
}, 60_000);

test('a document named .html does not write a hidden .pdf', async () => {
  // `'.html'.replace(/\.html?$/i, '')` is the empty string, and `'' + '.pdf'` is a file named
  // `.pdf` in the current directory. The url branch guarded this and the file branch did not.
  const cwd = await mkdtemp(join(tmpdir(), 'letterpress-cwd-'));
  try {
    const doc = join(cwd, '.html');
    await Bun.write(doc, '<!doctype html><meta charset="utf-8"><p>dot html</p>');
    const proc = Bun.spawn(['bun', CLI, doc], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    await proc.exited;
    const entries = (await readdir(cwd)).sort();
    expect(entries).toEqual(['.html', 'out.pdf']);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);

test('a missing input fails with a readable message and exit 1', async () => {
  const r = await run([join(dir, 'does-not-exist.html')]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/render failed:/);
}, 60_000);

test('help exits 0 and documents the formats', async () => {
  const r = await run(['--help']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('a3 a4 a5 legal letter tabloid');
  expect(r.stdout).toContain('--root');
}, 30_000);

test('--root lets a document in a subdirectory reach its assets', async () => {
  await mkdir(join(dir, 'sub'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'print.css'), '@page { size: A5; margin: 5mm }');
  const page = join(dir, 'sub', 'page.html');
  await writeFile(
    page,
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../assets/print.css"><p>page</p>',
  );

  const without = await run(['--json', '--out', join(dir, 'a.pdf'), page]);
  expect(without.stdout).toContain('asset-outside-root');
  expect(without.stdout).toContain('--root');

  const withRoot = await run(['--json', '--root', dir, '--out', join(dir, 'b.pdf'), page]);
  expect(withRoot.stdout).not.toContain('asset-outside-root');
  expect(withRoot.stdout).not.toContain('subresource-failed');
}, 60_000);

describe('what exit code 1 means', () => {
  // The usage text said "1 render failed". Two of the three things that return 1
  // happen after a complete PDF has been written, so a script that trusted the
  // documented line and cleaned up on a non-zero status threw away the file it had
  // just been given.
  test('an error finding exits 1 and leaves a complete pdf on disk', async () => {
    const src = join(dir, 'contradicted.html');
    const out = join(dir, 'contradicted.pdf');
    await writeFile(
      src,
      '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>' +
        '<h1>Report</h1><p>{{leftover}}</p>',
      'utf8',
    );

    const r = await run(['--out', out, src]);
    expect(r.code, 'the finding is an error, so the status must be non-zero').toBe(1);
    expect(existsSync(out), 'exit 1 does not mean there is no pdf').toBe(true);
    expect(Bun.file(out).size).toBeGreaterThan(1000);
    // And it really is a readable PDF, not a truncated write.
    expect((await pdfInfo(new Uint8Array(await Bun.file(out).arrayBuffer()))).pages).toBe(1);
  }, 60_000);

  test('a render that produced nothing also exits 1, and writes nothing', async () => {
    const out = join(dir, 'never-written.pdf');
    const r = await run(['--out', out, join(dir, 'does-not-exist.html')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/render failed/);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  test('the two are told apart by --json, and the usage text says so', async () => {
    const src = join(dir, 'contradicted.html');
    const okJson = JSON.parse(
      (await run(['--json', '--out', join(dir, 'j1.pdf'), join(dir, 'does-not-exist.html')]))
        .stdout,
    ) as Record<string, unknown>;
    const badJson = JSON.parse(
      (await run(['--json', '--out', join(dir, 'j2.pdf'), src])).stdout,
    ) as Record<string, unknown>;

    // A machine can separate them; the bare status cannot.
    expect(okJson.error, 'a failure must say so').toBeString();
    expect(badJson.error, 'a contradiction is not a failure').toBeUndefined();
    expect(Array.isArray(badJson.findings)).toBe(true);

    // And the documented contract must not claim otherwise. If someone tightens the
    // wording, this test is the thing that notices.
    const help = await run(['--help']);
    expect(help.stdout).not.toMatch(/1\s+render failed/);
    expect(help.stdout).toMatch(/no pdf was written/);
    expect(help.stdout).toMatch(/not the document you asked for/);
  }, 90_000);
});

describe('argument parsing names the problem without launching a browser', () => {
  test('unknown options and bad values are usage errors', () => {
    expect(parseArgs(['--frobnicate', 'f.html']).error).toMatch(/unknown option "--frobnicate"/);
    expect(parseArgs(['--format', 'a9', 'f.html']).error).toMatch(/unknown format "a9"/);
    expect(parseArgs(['--margin']).error).toMatch(/option --margin needs a value/);
    expect(parseArgs(['--margin', '--json', 'f.html']).error).toMatch(/needs a value/);
    expect(parseArgs(['--max-image-ppi', 'lots', 'f.html']).error).toMatch(/needs a whole number/);
    expect(parseArgs(['--timeout', 'abc', 'f.html']).error).toMatch(/needs at least 1000ms/);
    expect(parseArgs(['--timeout', '999', 'f.html']).error).toMatch(/needs at least 1000ms/);
    expect(parseArgs(['--settle', 'soon', 'f.html']).error).toMatch(/needs a whole number/);
    expect(parseArgs(['--author', '  ', 'f.html']).error).toMatch(/--author needs a name/);
    expect(parseArgs(['--subject', ' ', 'f.html']).error).toMatch(/--subject needs text/);
    expect(parseArgs(['--keywords', '', 'f.html']).error).toMatch(/--keywords needs text/);
  });

  test('a missing option value throws a usage error', () => {
    // valueAfter throws rather than returning an error: main catches it for
    // exit 2, so the contract holds end to end, but parseArgs itself throws.
    expect(() => parseArgs(['-o'])).toThrow(/option -o needs a value/);
    expect(() => parseArgs(['--template', '--json'])).toThrow(/needs a value/);
  });

  test('structural mistakes name the combination, not the flag', () => {
    expect(parseArgs(['--data', 'd.json']).error).toMatch(/--data needs --template/);
    expect(parseArgs(['--template', 'invoice']).error).toMatch(/--template needs --data/);
    expect(parseArgs(['a.html', 'b.html']).error).toMatch(/expected one input, got 2/);
    expect(parseArgs([]).error).toMatch(/no input/);
    expect(parseArgs(['--template', 'invoice', '--data', 'd.json', 'a.html']).error).toMatch(
      /either an input file or --template/,
    );
    expect(parseArgs(['--margin', '15mm', 'a.html']).error).toMatch(/only applies with --format/);
  });

  test('good input parses to the documented defaults', () => {
    const r = parseArgs(['page.html']);
    expect(r.error).toBeUndefined();
    expect(r.opts.input).toBe('page.html');
    expect(r.opts).toMatchObject({
      landscape: false,
      allowNetwork: false,
      background: true,
      settleMs: 0,
      timeoutMs: 30_000,
      maxImagePpi: 300,
      json: false,
      quiet: false,
    });
    expect(
      parseArgs(['-q', '--json', '--no-background', '--landscape', 'p.html']).opts,
    ).toMatchObject({ quiet: true, json: true, background: false, landscape: true });
    // A URL implies remote traffic is wanted.
    expect(parseArgs(['https://example.com']).opts.allowNetwork).toBe(true);
  });
});

test('help documents every parsed flag, and every documented flag parses', async () => {
  // Help text and the HANDLERS table drift apart silently: a flag added to one
  // and not the other is either undiscoverable or rejected. Both directions.
  const help = await run(['--help']);
  const documented = new Set([...help.stdout.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
  for (const flag of flagNames()) {
    expect(documented.has(flag), `${flag} parses but --help never mentions it`).toBe(true);
  }
  for (const flag of documented) {
    // A documented flag may still need a value or conflict, but it must never
    // be an unknown option.
    const { error } = parseArgs([flag, 'x']);
    expect(error ?? '', `${flag} is documented but the parser rejects it`).not.toMatch(
      /unknown option/,
    );
  }
});
