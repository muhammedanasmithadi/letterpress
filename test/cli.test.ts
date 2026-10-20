import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagNames, parseArgs } from '../src/cli.ts';
import { pdfInfo, pdfText } from './poppler.ts';
import { readFile } from 'node:fs/promises';

const bytesOf = async (p: string) => new Uint8Array(await readFile(p));

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

describe('what --json carries', () => {
  // The summary fields were always there. These are the ones that were computed
  // and then thrown away, and two of them were wrong before this: `pageSizes`
  // returned `[""]` for every page of every document, and `outlineTitles` listed
  // the bookmarks in reverse.
  const DOC =
    `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}@page :first{size:Letter}` +
    `body{font-family:"DejaVu Sans",sans-serif}p{page-break-before:always}</style></head>` +
    `<body><h1>One</h1><h2>Two</h2><h3>Three</h3><p>a</p><p>b</p></body></html>`;

  let out: string;
  let got: Record<string, unknown>;

  beforeAll(async () => {
    const src = join(dir, 'info.html');
    await writeFile(src, DOC, 'utf8');
    out = join(dir, 'info.pdf');
    const res = await run(['-o', out, '-q', src, '--json']);
    expect(res.code).toBe(0);
    got = JSON.parse(res.stdout) as Record<string, unknown>;
  }, 120_000);

  test('every field of the inspected pdf is there, not a chosen few', () => {
    for (const key of [
      'header',
      'producer',
      'pages',
      'mediaBoxes',
      'pageSizes',
      'imageObjects',
      'fontFiles',
      'type0Fonts',
      'toUnicodeMaps',
      'tagged',
      'outlineTitles',
      'encrypted',
    ]) {
      expect(got, key).toHaveProperty(key);
    }
  });

  test('the fields describe this document, and only this document', async () => {
    expect(got.header).toBe('%PDF-1.4');
    expect(got.tagged).toBe(true);
    expect(got.encrypted).toBe(false);
    expect(got.fontFiles).toBeGreaterThan(0);
    // A font with no ToUnicode map cannot be selected or searched.
    expect(got.toUnicodeMaps).toBeGreaterThan(0);
  });

  test('pageSizes says which page is which size, in page order', () => {
    // The reason this field exists next to `mediaBoxes`: mediaBoxes is a set of
    // distinct boxes, so it can say a document is mixed but not where the change
    // happens. The first page is Letter because `@page :first` says so.
    const sizes = got.pageSizes as string[];
    expect(sizes).toHaveLength(got.pages as number);
    expect(sizes[0]).toContain('612 792');
    expect(sizes[1]).toContain('594.95996 841.91998');
  });

  test('outlineTitles is the order a reader sees, not the order in the file', () => {
    // Chromium serialises an outline parent-first and backwards, so the file
    // order of this document is document, Three, Two, One. A consumer building
    // a table of contents from file order emits it reversed.
    expect(got.outlineTitles).toEqual(['One', 'Two', 'Three']);
  });

  test('the summary fields still come first and keep their names', () => {
    for (const key of ['ok', 'path', 'bytes', 'ms', 'source', 'blocked', 'findings']) {
      expect(got, key).toHaveProperty(key);
    }
    expect(got.path).toBe(out);
  });
});

describe('--probe', () => {
  test('gaps names the element that produces a wide gap', async () => {
    const src = join(dir, 'probe-gaps.html');
    await writeFile(
      src,
      `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}` +
        `body{margin:0;font:12pt serif}.row{display:flex;gap:24px}</style></head>` +
        `<body><div class="row"><span>a</span><span>b</span></div></body></html>`,
      'utf8',
    );
    const { code, stdout } = await run([
      '-o',
      join(dir, 'probe-gaps.pdf'),
      '-q',
      src,
      '--probe',
      'gaps',
      '--json',
    ]);
    expect(code).toBe(0);
    const probe = (JSON.parse(stdout) as { probe: Array<{ cause: string; em: number }> }).probe;
    expect(probe.length).toBeGreaterThan(0);
    expect(probe[0]!.cause).toBe('flex-gap');
  }, 120_000);

  test('fonts reports the families the document asked for', async () => {
    const src = join(dir, 'probe-fonts.html');
    await writeFile(
      src,
      `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head>` +
        `<body><p style="font-family:'No Such Face'">x</p></body></html>`,
      'utf8',
    );
    const { code, stdout } = await run([
      '-o',
      join(dir, 'probe-fonts.pdf'),
      '-q',
      src,
      '--probe',
      'fonts',
      '--json',
    ]);
    expect(code).toBe(0);
    const probe = (JSON.parse(stdout) as { probe: Array<{ family: string }> }).probe;
    expect(probe.map((f) => f.family)).toContain('No Such Face');
  }, 120_000);

  test('no probe means no probe key with a value', async () => {
    const src = join(dir, 'probe-none.html');
    await writeFile(src, `<html lang="en"><body><p>x</p></body></html>`, 'utf8');
    const { stdout } = await run(['-o', join(dir, 'probe-none.pdf'), '-q', src, '--json']);
    expect((JSON.parse(stdout) as { probe?: unknown }).probe ?? null).toBeNull();
  }, 120_000);

  test('a probe it does not have is a usage error naming the ones it does', async () => {
    const src = join(dir, 'probe-none.html');
    const { code, stderr } = await run(['--probe', 'everything', src]);
    expect(code).toBe(2);
    expect(stderr).toContain('gaps, fonts');
  }, 60_000);
});

describe('--no-script', () => {
  test('document scripts do not run, but the tool still reports on the page', async () => {
    const src = join(dir, 'noscript.html');
    await writeFile(
      src,
      `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}body{font:12pt serif}</style></head>` +
        `<body><p>static</p><script>document.body.insertAdjacentHTML('beforeend','<p>JS_RAN</p>')</script></body></html>`,
      'utf8',
    );
    const out = join(dir, 'noscript.pdf');
    const { code, stdout } = await run(['-o', out, '-q', src, '--no-script', '--json']);
    expect(code).toBe(0);
    const got = JSON.parse(stdout) as { findings: Array<{ code: string }> };
    expect(got.findings.map((f) => f.code)).toContain('scripts-disabled');
    const text = await pdfText(await bytesOf(out));
    expect(text).toContain('static');
    expect(text).not.toContain('JS_RAN');
  }, 120_000);

  test('a missing colon in --auth is a usage error', async () => {
    const src = join(dir, 'noscript.html');
    const { code, stderr } = await run(['--auth', 'no-colon', src]);
    expect(code).toBe(2);
    expect(stderr).toContain('--auth takes user:password');
  }, 60_000);
});

describe('--before-print', () => {
  test('the expression runs in the page before printing', async () => {
    const src = join(dir, 'beforeprint.html');
    await writeFile(
      src,
      `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}body{font:12pt serif}</style></head>` +
        `<body><p>before</p></body></html>`,
      'utf8',
    );
    const out = join(dir, 'beforeprint.pdf');
    const { code } = await run([
      '-o',
      out,
      '-q',
      src,
      '--before-print',
      "document.body.insertAdjacentHTML('beforeend','<p>PRINTED</p>')",
    ]);
    expect(code).toBe(0);
    const text = await pdfText(await bytesOf(out));
    expect(text).toContain('PRINTED');
  }, 120_000);

  test('an empty expression is a usage error', async () => {
    const src = join(dir, 'beforeprint.html');
    const { code, stderr } = await run(['--before-print', '   ', src]);
    expect(code).toBe(2);
    expect(stderr).toContain('--before-print needs an expression');
  }, 60_000);
});

describe('--page-ranges', () => {
  // The engine and the HTTP API have had this since before the cli did; the
  // flag was the missing piece, so these pin the parts a caller cannot see from
  // the parser alone.
  const paged = (n: number) =>
    `<!doctype html><html lang="en"><head><style>` +
    `@page { size: A4; margin: 12mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }` +
    `body { font-family: "DejaVu Sans", sans-serif } h2 { page-break-before: always }` +
    `</style></head><body>` +
    Array.from({ length: n }, (_, i) => `<p>body ${i + 1}</p><h2>head ${i + 1}</h2>`).join('') +
    `</body></html>`;

  let src: string;

  beforeAll(async () => {
    src = join(dir, 'ranges.html');
    await writeFile(src, paged(5), 'utf8');
  }, 30_000);

  test('it prints the named pages and no others', async () => {
    const out = join(dir, 'ranges-a.pdf');
    const { code } = await run(['-o', out, '-q', src, '--page-ranges', '2-3']);
    expect(code).toBe(0);
    const bytes = await bytesOf(out);
    expect((await pdfInfo(bytes)).pages).toBe(2);
    const text = await pdfText(bytes);
    expect(text).toContain('body 2');
    expect(text).not.toContain('body 5');
  }, 120_000);

  test('a list and a single page are both accepted', async () => {
    for (const [spec, want] of [
      ['1', 1],
      ['1,4', 2],
      ['2-3,5', 3],
    ] as const) {
      const out = join(dir, `ranges-${spec.replace(/\W/g, '')}.pdf`);
      const { code } = await run(['-o', out, '-q', src, '--page-ranges', spec]);
      expect(code, spec).toBe(0);
      expect((await pdfInfo(await bytesOf(out))).pages, spec).toBe(want);
    }
  }, 180_000);

  test('page numbers in a footer keep counting the whole document', async () => {
    // The reason this is worth stating: an extract renumbered from 1 would make
    // "page 1 of 2" out of two pages of a four-page document, which is a
    // different document. Chromium keeps the document's own numbering.
    const out = join(dir, 'ranges-counters.pdf');
    // The total is read from the full render rather than written down: a
    // hardcoded page count is a test that fails when the fixture's markup
    // changes rather than when the behaviour does. Measured 6, not the 5 the
    // fixture's five sections suggest.
    const whole = join(dir, 'ranges-whole.pdf');
    await run(['-o', whole, '-q', src]);
    const total = (await pdfInfo(await bytesOf(whole))).pages;

    await run(['-o', out, '-q', src, '--page-ranges', '3-4']);
    const text = await pdfText(await bytesOf(out));
    expect(text).toContain(`page 3 of ${total}`);
    expect(text).toContain(`page 4 of ${total}`);
    expect(text).not.toContain('page 1 of 2');
  }, 120_000);

  test('omitting it renders every page', async () => {
    const out = join(dir, 'ranges-all.pdf');
    const { code } = await run(['-o', out, '-q', src]);
    expect(code).toBe(0);
    expect((await pdfInfo(await bytesOf(out))).pages).toBeGreaterThan(2);
  }, 120_000);

  test('a spec it cannot read is refused before a browser is launched', async () => {
    // The alternative is Chromium rejecting the string a few hundred ms into a
    // render, as a protocol error naming the transport rather than the input.
    for (const spec of ['0-3', 'abc', '1,,2', '1-', '']) {
      const { code, stdout } = await run(['-o', join(dir, 'bad.pdf'), src, '--page-ranges', spec]);
      expect(code, spec).toBe(2);
      expect(stdout, spec).not.toContain('BADPATH');
      expect(stdout, spec).toBe('');
    }
    const { stderr } = await run(['--page-ranges', 'abc', src]);
    expect(stderr).toContain('--page-ranges takes page numbers and ranges');
  }, 60_000);
});

describe('letterpress validate', () => {
  const PDF_DOC =
    `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:15mm}</style></head>` +
    `<body><h1>Heading</h1><p>Some text.</p><ul><li>one</li><li>two</li></ul></body></html>`;

  let good: string;
  let broken: string;

  beforeAll(async () => {
    const html = join(dir, 'validate.html');
    await writeFile(html, PDF_DOC, 'utf8');
    good = join(dir, 'validate.pdf');
    broken = join(dir, 'broken.pdf');
    const rendered = await run(['-o', good, '-q', html]);
    expect(rendered.code).toBe(0);
    await writeFile(broken, 'not a pdf at all', 'utf8');
  }, 120_000);

  test('a pdf this tool just wrote passes, with the exit code to match', async () => {
    const { code, stdout, stderr } = await run(['validate', good]);
    expect(stderr).not.toMatch(/ERROR/);
    expect(stdout).toMatch(/0 findings/);
    expect(code).toBe(0);
  });

  test('a file that is not a pdf fails, and says which check said so', async () => {
    const { code, stdout, stderr } = await run(['validate', broken]);
    expect(stderr).toContain('not-a-pdf');
    expect(stdout).toContain('not ok');
    expect(code).toBe(1);
  });

  test('--json carries the findings and the verdict', async () => {
    const { code, stdout } = await run(['validate', broken, '--json']);
    const got = JSON.parse(stdout) as {
      ok: boolean;
      bytes: number;
      findings: Array<{ code: string }>;
    };
    expect(got.ok).toBe(false);
    expect(got.bytes).toBeGreaterThan(0);
    expect(got.findings.map((f) => f.code)).toEqual(['not-a-pdf']);
    expect(code).toBe(1);
  });

  test('a missing file is a usage error, not a failed check', async () => {
    // Exit 2, distinct from 1: nothing was inspected, so a script cannot mistake
    // "I could not look" for "I looked and it is wrong".
    const { code, stdout } = await run(['validate', join(dir, 'absent.pdf')]);
    expect(stdout).not.toContain('not ok');
    expect(code).toBe(2);
  });

  test('no file is a usage error rather than reading stdin', async () => {
    const { code } = await run(['validate']);
    expect(code).toBe(2);
  });
});

describe('letterpress page', () => {
  const write = async (name: string, css: string) => {
    const p = join(dir, name);
    await writeFile(
      p,
      `<!doctype html><html><head><style>${css}</style></head><body>x</body></html>`,
    );
    return p;
  };

  test('it reports what the document declared', async () => {
    const p = await write('paged.html', '@page{size:A4;margin:15mm}@page :first{margin:20mm}');
    const { code, stdout } = await run(['page', p]);
    expect(code).toBe(0);
    expect(stdout).toContain('a4');
    expect(stdout).toContain('15mm');
    expect(stdout).toContain('@page rules           2');
  });

  test('--landscape is explained per document, and the two null cases are opposites', async () => {
    // A document declaring no paper passes the flag straight to chromium and it
    // works; `size: auto` is refused and the sheet stays portrait. Both are
    // `transposePageSize` returning null, and reporting the second reason for
    // the first is how a working flag gets called broken.
    const none = await run(['page', await write('nopage.html', 'body{color:red}')]);
    expect(none.stdout).toContain('passed straight to chromium');

    const auto = await run(['page', await write('auto.html', '@page{size:auto;margin:1in}')]);
    expect(auto.stdout).toContain('refused');
    expect(auto.stdout).toContain('orientation-ignored');

    const portrait = await run(['page', await write('portrait.html', '@page{size:A4;margin:1in}')]);
    expect(portrait.stdout).toContain('transposed in place');

    const landscape = await run([
      'page',
      await write('land.html', '@page{size:A4 landscape;margin:1in}'),
    ]);
    expect(landscape.stdout).toContain('already landscape');
  });

  test('--json carries the same facts as the text', async () => {
    const p = await write('paged2.html', '@page{size:Letter;margin:1in}');
    const { stdout } = await run(['page', p, '--json']);
    const got = JSON.parse(stdout) as {
      declared: { size: string; margin: string; orientation: string; rules: string[] };
    };
    expect(got.declared.size).toBe('letter');
    expect(got.declared.margin).toBe('1in');
    expect(got.declared.orientation).toBe('portrait');
    expect(got.declared.rules).toHaveLength(1);
  });

  test('it needs exactly one file', async () => {
    const { code } = await run(['page']);
    expect(code).toBe(2);
  });
});
