"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const cli_ts_1 = require("../src/cli.ts");
const poppler_ts_1 = require("./poppler.ts");
const promises_2 = require("node:fs/promises");
const bytesOf = async (p) => new Uint8Array(await (0, promises_2.readFile)(p));
const CLI = (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts');
let dir;
let doc;
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
async function run(args, stdin) {
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
(0, bun_test_1.beforeAll)(async () => {
    dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-cli-test-'));
    doc = (0, node_path_1.join)(dir, 'fixture.html');
    await (0, promises_1.writeFile)(doc, DOC, 'utf8');
});
(0, bun_test_1.afterAll)(async () => {
    await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
});
(0, bun_test_1.test)('renders a file and reports where it went', async () => {
    const out = (0, node_path_1.join)(dir, 'one.pdf');
    const r = await run([doc, '-o', out, '--timeout', '120000']);
    (0, bun_test_1.expect)(r.stderr).not.toMatch(/error:/);
    (0, bun_test_1.expect)(r.code, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    const bytes = await Bun.file(out).arrayBuffer();
    (0, bun_test_1.expect)(bytes.byteLength).toBeGreaterThan(1000);
    const info = await (0, poppler_ts_1.pdfInfo)(new Uint8Array(bytes));
    (0, bun_test_1.expect)(r.stdout).toMatch(new RegExp(`one\\.pdf\\s+${info.pages} pages?\\s+[\\d.]+ KB\\s+\\d+ms`));
    (0, bun_test_1.expect)(info.pages).toBeGreaterThan(0);
    (0, bun_test_1.expect)(info.pageSize).toContain('594.96');
    const second = await run([doc, '-o', (0, node_path_1.join)(dir, 'warn.json'), '--json']);
    const codes = JSON.parse(second.stdout);
    (0, bun_test_1.expect)(codes.ok).toBe(true);
    (0, bun_test_1.expect)(second.code).toBe(0);
    for (const f of codes.findings)
        (0, bun_test_1.expect)(f.severity).not.toBe('error');
}, 60_000);
(0, bun_test_1.test)('a finding is printed to stderr and the document is still written', async () => {
    const broken = (0, node_path_1.join)(dir, 'broken.html');
    await (0, promises_1.writeFile)(broken, `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>` +
        `<p>text</p><img src="does-not-exist.png">`, 'utf8');
    const out = (0, node_path_1.join)(dir, 'broken.pdf');
    const r = await run([broken, '-o', out]);
    (0, bun_test_1.expect)(r.code).toBe(0);
    (0, bun_test_1.expect)(r.stderr).toMatch(/^warn:/m);
    (0, bun_test_1.expect)(r.stderr).not.toMatch(/error:/);
    (0, bun_test_1.expect)((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(1000);
}, 60_000);
(0, bun_test_1.test)('json output is machine readable', async () => {
    const out = (0, node_path_1.join)(dir, 'two.pdf');
    const r = await run([doc, '-o', out, '--json']);
    (0, bun_test_1.expect)(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    (0, bun_test_1.expect)(parsed.ok).toBe(true);
    (0, bun_test_1.expect)(parsed.path).toBe(out);
    (0, bun_test_1.expect)(parsed.pages).toBe((await (0, poppler_ts_1.pdfInfo)(new Uint8Array(await Bun.file(out).arrayBuffer()))).pages);
    (0, bun_test_1.expect)(parsed.bytes).toBeGreaterThan(1000);
    (0, bun_test_1.expect)(typeof parsed.ms).toBe('number');
    (0, bun_test_1.expect)(parsed.imageObjects).toBe(0);
    (0, bun_test_1.expect)(Array.isArray(parsed.findings)).toBe(true);
}, 60_000);
(0, bun_test_1.test)('derives the output name from the input', async () => {
    const r = await run([doc], undefined);
    (0, bun_test_1.expect)(r.code).toBe(0);
    (0, bun_test_1.expect)(r.stdout).toMatch(/fixture\.pdf/);
    (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(process.cwd(), 'fixture.pdf')).exists()).toBe(true);
    await (0, promises_1.rm)((0, node_path_1.join)(process.cwd(), 'fixture.pdf'), { force: true });
}, 60_000);
(0, bun_test_1.test)('reads HTML from stdin', async () => {
    const out = (0, node_path_1.join)(dir, 'piped.pdf');
    const r = await run(['-', '-o', out, '--json'], '<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>From stdin</h1>');
    (0, bun_test_1.expect)(r.code, `exit ${r.code}\nstdout: ${r.stdout.slice(0, 400)}\nstderr: ${r.stderr.slice(0, 600)}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    (0, bun_test_1.expect)(parsed.ok).toBe(true);
    (0, bun_test_1.expect)(parsed.source).toBe('html');
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(bytes)).toContain('From stdin');
}, 60_000);
(0, bun_test_1.test)('a character on a chunk boundary in stdin survives', async () => {
    const out = (0, node_path_1.join)(dir, 'boundary.pdf');
    const head = '<!doctype html><meta charset="utf-8"><p>';
    const body = new TextEncoder().encode(head + 'x'.repeat(65_535 - head.length) + '\u65e5ENDMARKER</p>');
    const cut = 65_536;
    const proc = Bun.spawn(['bun', CLI, '-', '-o', out, '--json'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
    });
    proc.stdin.write(body.subarray(0, cut));
    await Bun.sleep(200);
    proc.stdin.write(body.subarray(cut));
    await proc.stdin.end();
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    (0, bun_test_1.expect)(code, `exit ${code}\nstderr: ${stderr.slice(0, 600)}`).toBe(0);
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    const text = await (0, poppler_ts_1.pdfText)(bytes);
    (0, bun_test_1.expect)(text).toContain('ENDMARKER');
    (0, bun_test_1.expect)(text).toContain('\u65e5');
}, 60_000);
(0, bun_test_1.test)('a page range that starts after it ends is a usage error', async () => {
    const r = await run(['--page-ranges', '3-1', '-o', (0, node_path_1.join)(dir, 'bad.pdf'), doc]);
    (0, bun_test_1.expect)(r.code).toBe(2);
    (0, bun_test_1.expect)(r.stderr).toContain('starts after it ends');
}, 30_000);
(0, bun_test_1.test)('a paper name is read the way the model context protocol reads it', async () => {
    const out = (0, node_path_1.join)(dir, 'trimmed.pdf');
    const r = await run(['--format', ' a4 ', '-o', out, doc]);
    (0, bun_test_1.expect)(r.code, `exit ${r.code}\n${r.stderr.slice(0, 300)}`).toBe(0);
}, 60_000);
(0, bun_test_1.test)('a flag may carry its value with an equals sign', async () => {
    const out = (0, node_path_1.join)(dir, 'equals.pdf');
    const r = await run(['--format=a4', '-o', out, doc]);
    (0, bun_test_1.expect)(r.code, `exit ${r.code}\n${r.stderr.slice(0, 300)}`).toBe(0);
    (0, bun_test_1.expect)(await Bun.file(out).exists()).toBe(true);
}, 60_000);
(0, bun_test_1.test)('help is help, whatever else is on the command line', async () => {
    const r = await run(['--help', 'a.html', 'b.html']);
    (0, bun_test_1.expect)(r.code).toBe(0);
    (0, bun_test_1.expect)(r.stdout).toContain('letterpress');
}, 30_000);
(0, bun_test_1.test)('a subcommand refuses a flag it does not take', async () => {
    const r = await run(['validate', '--template', 'x']);
    (0, bun_test_1.expect)(r.code).toBe(2);
    (0, bun_test_1.expect)(r.stderr).toContain('validate does not take --template');
}, 30_000);
(0, bun_test_1.test)('a subcommand has its own help', async () => {
    const r = await run(['page', '--help']);
    (0, bun_test_1.expect)(r.code).toBe(0);
    (0, bun_test_1.expect)(r.stdout).toContain('letterpress page');
}, 30_000);
(0, bun_test_1.test)('a format override is applied and reported', async () => {
    const out = (0, node_path_1.join)(dir, 'letter.pdf');
    const r = await run([doc, '-o', out, '--format', 'letter', '--json']);
    const parsed = JSON.parse(r.stdout);
    (0, bun_test_1.expect)(parsed.findings.some((f) => f.code === 'page-size-override')).toBe(true);
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(bytes)).pageSize).toMatch(/612/);
}, 60_000);
(0, bun_test_1.test)('blocked remote assets surface as warnings but still render', async () => {
    const remote = (0, node_path_1.join)(dir, 'remote.html');
    await (0, promises_1.writeFile)(remote, `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css"><p>Kept.</p>`, 'utf8');
    const out = (0, node_path_1.join)(dir, 'remote.pdf');
    const r = await run([remote, '-o', out, '--json']);
    const parsed = JSON.parse(r.stdout);
    (0, bun_test_1.expect)(parsed.ok).toBe(true);
    (0, bun_test_1.expect)(parsed.blocked.some((u) => u.includes('example.invalid'))).toBe(true);
    (0, bun_test_1.expect)(r.stderr).toContain('blocked a remote request');
}, 60_000);
(0, bun_test_1.test)('bad usage exits 2 without launching a browser', async () => {
    for (const args of [
        ['--format', 'nope', 'x.html'],
        ['--out'],
        ['--margin', '5mm', 'x.html'],
        [],
        ['--bogus'],
    ]) {
        const r = await run(args);
        (0, bun_test_1.expect)(r.code).toBe(2);
        (0, bun_test_1.expect)(r.stderr).toContain('usage');
    }
}, 30_000);
(0, bun_test_1.test)('an option does not swallow the flag after it', async () => {
    for (const flag of ['--json', '--landscape', '--format']) {
        const r = await run([(0, node_path_1.join)(dir, 'doc.html'), '--margin', flag]);
        (0, bun_test_1.expect)(r.code, `${flag} after --margin`).toBe(2);
        (0, bun_test_1.expect)(r.stderr, `${flag} after --margin`).toContain('--margin needs a value');
    }
}, 60_000);
(0, bun_test_1.test)('a document named .html does not write a hidden .pdf', async () => {
    const cwd = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-cwd-'));
    try {
        const doc = (0, node_path_1.join)(cwd, '.html');
        await Bun.write(doc, '<!doctype html><meta charset="utf-8"><p>dot html</p>');
        const proc = Bun.spawn(['bun', CLI, doc], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env },
        });
        await proc.exited;
        const entries = (await (0, promises_1.readdir)(cwd)).sort();
        (0, bun_test_1.expect)(entries).toEqual(['.html', 'out.pdf']);
    }
    finally {
        await (0, promises_1.rm)(cwd, { recursive: true, force: true }).catch(() => { });
    }
}, 60_000);
(0, bun_test_1.test)('a missing input fails with a readable message and exit 1', async () => {
    const r = await run([(0, node_path_1.join)(dir, 'does-not-exist.html')]);
    (0, bun_test_1.expect)(r.code).toBe(1);
    (0, bun_test_1.expect)(r.stderr).toMatch(/render failed:/);
}, 60_000);
(0, bun_test_1.test)('help exits 0 and documents the formats', async () => {
    const r = await run(['--help']);
    (0, bun_test_1.expect)(r.code).toBe(0);
    (0, bun_test_1.expect)(r.stdout).toContain('a3 a4 a5 legal letter tabloid');
    (0, bun_test_1.expect)(r.stdout).toContain('--root');
}, 30_000);
(0, bun_test_1.test)('--root lets a document in a subdirectory reach its assets', async () => {
    await (0, promises_1.mkdir)((0, node_path_1.join)(dir, 'sub'), { recursive: true });
    await (0, promises_1.mkdir)((0, node_path_1.join)(dir, 'assets'), { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(dir, 'assets', 'print.css'), '@page { size: A5; margin: 5mm }');
    const page = (0, node_path_1.join)(dir, 'sub', 'page.html');
    await (0, promises_1.writeFile)(page, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../assets/print.css"><p>page</p>');
    const without = await run(['--json', '--out', (0, node_path_1.join)(dir, 'a.pdf'), page]);
    (0, bun_test_1.expect)(without.stdout).toContain('asset-outside-root');
    (0, bun_test_1.expect)(without.stdout).toContain('--root');
    const withRoot = await run(['--json', '--root', dir, '--out', (0, node_path_1.join)(dir, 'b.pdf'), page]);
    (0, bun_test_1.expect)(withRoot.stdout).not.toContain('asset-outside-root');
    (0, bun_test_1.expect)(withRoot.stdout).not.toContain('subresource-failed');
}, 60_000);
(0, bun_test_1.describe)('what exit code 1 means', () => {
    (0, bun_test_1.test)('an error finding exits 1 and leaves a complete pdf on disk', async () => {
        const src = (0, node_path_1.join)(dir, 'contradicted.html');
        const out = (0, node_path_1.join)(dir, 'contradicted.pdf');
        await (0, promises_1.writeFile)(src, '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style>' +
            '<h1>Report</h1><p>{{leftover}}</p>', 'utf8');
        const r = await run(['--out', out, src]);
        (0, bun_test_1.expect)(r.code, 'the finding is an error, so the status must be non-zero').toBe(1);
        (0, bun_test_1.expect)((0, node_fs_1.existsSync)(out), 'exit 1 does not mean there is no pdf').toBe(true);
        (0, bun_test_1.expect)(Bun.file(out).size).toBeGreaterThan(1000);
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(new Uint8Array(await Bun.file(out).arrayBuffer()))).pages).toBe(1);
    }, 60_000);
    (0, bun_test_1.test)('a render that produced nothing also exits 1, and writes nothing', async () => {
        const out = (0, node_path_1.join)(dir, 'never-written.pdf');
        const r = await run(['--out', out, (0, node_path_1.join)(dir, 'does-not-exist.html')]);
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.stderr).toMatch(/render failed/);
        (0, bun_test_1.expect)((0, node_fs_1.existsSync)(out)).toBe(false);
    }, 60_000);
    (0, bun_test_1.test)('the two are told apart by --json, and the usage text says so', async () => {
        const src = (0, node_path_1.join)(dir, 'contradicted.html');
        const okJson = JSON.parse((await run(['--json', '--out', (0, node_path_1.join)(dir, 'j1.pdf'), (0, node_path_1.join)(dir, 'does-not-exist.html')]))
            .stdout);
        const badJson = JSON.parse((await run(['--json', '--out', (0, node_path_1.join)(dir, 'j2.pdf'), src])).stdout);
        (0, bun_test_1.expect)(okJson.error, 'a failure must say so').toBeString();
        (0, bun_test_1.expect)(badJson.error, 'a contradiction is not a failure').toBeUndefined();
        (0, bun_test_1.expect)(Array.isArray(badJson.findings)).toBe(true);
        const help = await run(['--help']);
        (0, bun_test_1.expect)(help.stdout).not.toMatch(/1\s+render failed/);
        (0, bun_test_1.expect)(help.stdout).toMatch(/no pdf was written/);
        (0, bun_test_1.expect)(help.stdout).toMatch(/not the document you asked for/);
    }, 90_000);
});
(0, bun_test_1.describe)('argument parsing names the problem without launching a browser', () => {
    (0, bun_test_1.test)('unknown options and bad values are usage errors', () => {
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--frobnicate', 'f.html']).error).toMatch(/unknown option "--frobnicate"/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--format', 'a9', 'f.html']).error).toMatch(/unknown format "a9"/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--margin']).error).toMatch(/option --margin needs a value/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--margin', '--json', 'f.html']).error).toMatch(/needs a value/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--max-image-ppi', 'lots', 'f.html']).error).toMatch(/needs a whole number/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--timeout', 'abc', 'f.html']).error).toMatch(/needs at least 1000ms/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--timeout', '999', 'f.html']).error).toMatch(/needs at least 1000ms/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--settle', 'soon', 'f.html']).error).toMatch(/needs a whole number/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--author', '  ', 'f.html']).error).toMatch(/--author needs a name/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--subject', ' ', 'f.html']).error).toMatch(/--subject needs text/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--keywords', '', 'f.html']).error).toMatch(/--keywords needs text/);
    });
    (0, bun_test_1.test)('a missing option value throws a usage error', () => {
        (0, bun_test_1.expect)(() => (0, cli_ts_1.parseArgs)(['-o'])).toThrow(/option -o needs a value/);
        (0, bun_test_1.expect)(() => (0, cli_ts_1.parseArgs)(['--template', '--json'])).toThrow(/needs a value/);
    });
    (0, bun_test_1.test)('structural mistakes name the combination, not the flag', () => {
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--data', 'd.json']).error).toMatch(/--data needs --template/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--template', 'invoice']).error).toMatch(/--template needs --data/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['a.html', 'b.html']).error).toMatch(/expected one input, got 2/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)([]).error).toMatch(/no input/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--template', 'invoice', '--data', 'd.json', 'a.html']).error).toMatch(/either an input file or --template/);
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['--margin', '15mm', 'a.html']).error).toMatch(/only applies with --format/);
    });
    (0, bun_test_1.test)('good input parses to the documented defaults', () => {
        const r = (0, cli_ts_1.parseArgs)(['page.html']);
        (0, bun_test_1.expect)(r.error).toBeUndefined();
        (0, bun_test_1.expect)(r.opts.input).toBe('page.html');
        (0, bun_test_1.expect)(r.opts).toMatchObject({
            landscape: false,
            allowNetwork: false,
            background: true,
            settleMs: 0,
            timeoutMs: 30_000,
            maxImagePpi: 300,
            json: false,
            quiet: false,
        });
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['-q', '--json', '--no-background', '--landscape', 'p.html']).opts).toMatchObject({ quiet: true, json: true, background: false, landscape: true });
        (0, bun_test_1.expect)((0, cli_ts_1.parseArgs)(['https://example.com']).opts.allowNetwork).toBe(true);
    });
});
(0, bun_test_1.test)('help documents every parsed flag, and every documented flag parses', async () => {
    const help = await run(['--help']);
    const documented = new Set([...help.stdout.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
    for (const flag of (0, cli_ts_1.flagNames)()) {
        (0, bun_test_1.expect)(documented.has(flag), `${flag} parses but --help never mentions it`).toBe(true);
    }
    for (const flag of documented) {
        const { error } = (0, cli_ts_1.parseArgs)([flag, 'x']);
        (0, bun_test_1.expect)(error ?? '', `${flag} is documented but the parser rejects it`).not.toMatch(/unknown option/);
    }
});
(0, bun_test_1.describe)('what --json carries', () => {
    const DOC = `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}@page :first{size:Letter}` +
        `body{font-family:"DejaVu Sans",sans-serif}p{page-break-before:always}</style></head>` +
        `<body><h1>One</h1><h2>Two</h2><h3>Three</h3><p>a</p><p>b</p></body></html>`;
    let out;
    let got;
    (0, bun_test_1.beforeAll)(async () => {
        const src = (0, node_path_1.join)(dir, 'info.html');
        await (0, promises_1.writeFile)(src, DOC, 'utf8');
        out = (0, node_path_1.join)(dir, 'info.pdf');
        const res = await run(['-o', out, '-q', src, '--json']);
        (0, bun_test_1.expect)(res.code).toBe(0);
        got = JSON.parse(res.stdout);
    }, 120_000);
    (0, bun_test_1.test)('every field of the inspected pdf is there, not a chosen few', () => {
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
            (0, bun_test_1.expect)(got, key).toHaveProperty(key);
        }
    });
    (0, bun_test_1.test)('the fields describe this document, and only this document', async () => {
        (0, bun_test_1.expect)(got.header).toBe('%PDF-1.4');
        (0, bun_test_1.expect)(got.tagged).toBe(true);
        (0, bun_test_1.expect)(got.encrypted).toBe(false);
        (0, bun_test_1.expect)(got.fontFiles).toBeGreaterThan(0);
        (0, bun_test_1.expect)(got.toUnicodeMaps).toBeGreaterThan(0);
    });
    (0, bun_test_1.test)('pageSizes says which page is which size, in page order', () => {
        const sizes = got.pageSizes;
        (0, bun_test_1.expect)(sizes).toHaveLength(got.pages);
        (0, bun_test_1.expect)(sizes[0]).toContain('612 792');
        (0, bun_test_1.expect)(sizes[1]).toContain('594.95996 841.91998');
    });
    (0, bun_test_1.test)('outlineTitles is the order a reader sees, not the order in the file', () => {
        (0, bun_test_1.expect)(got.outlineTitles).toEqual(['One', 'Two', 'Three']);
    });
    (0, bun_test_1.test)('the summary fields still come first and keep their names', () => {
        for (const key of ['ok', 'path', 'bytes', 'ms', 'source', 'blocked', 'findings']) {
            (0, bun_test_1.expect)(got, key).toHaveProperty(key);
        }
        (0, bun_test_1.expect)(got.path).toBe(out);
    });
});
(0, bun_test_1.describe)('--probe', () => {
    (0, bun_test_1.test)('gaps names the element that produces a wide gap', async () => {
        const src = (0, node_path_1.join)(dir, 'probe-gaps.html');
        await (0, promises_1.writeFile)(src, `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}` +
            `body{margin:0;font:12pt serif}.row{display:flex;gap:24px}</style></head>` +
            `<body><div class="row"><span>a</span><span>b</span></div></body></html>`, 'utf8');
        const { code, stdout } = await run([
            '-o',
            (0, node_path_1.join)(dir, 'probe-gaps.pdf'),
            '-q',
            src,
            '--probe',
            'gaps',
            '--json',
        ]);
        (0, bun_test_1.expect)(code).toBe(0);
        const probe = JSON.parse(stdout).probe;
        (0, bun_test_1.expect)(probe.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(probe[0].cause).toBe('flex-gap');
    }, 120_000);
    (0, bun_test_1.test)('fonts reports the families the document asked for', async () => {
        const src = (0, node_path_1.join)(dir, 'probe-fonts.html');
        await (0, promises_1.writeFile)(src, `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head>` +
            `<body><p style="font-family:'No Such Face'">x</p></body></html>`, 'utf8');
        const { code, stdout } = await run([
            '-o',
            (0, node_path_1.join)(dir, 'probe-fonts.pdf'),
            '-q',
            src,
            '--probe',
            'fonts',
            '--json',
        ]);
        (0, bun_test_1.expect)(code).toBe(0);
        const probe = JSON.parse(stdout).probe;
        (0, bun_test_1.expect)(probe.map((f) => f.family)).toContain('No Such Face');
    }, 120_000);
    (0, bun_test_1.test)('no probe means no probe key with a value', async () => {
        const src = (0, node_path_1.join)(dir, 'probe-none.html');
        await (0, promises_1.writeFile)(src, `<html lang="en"><body><p>x</p></body></html>`, 'utf8');
        const { stdout } = await run(['-o', (0, node_path_1.join)(dir, 'probe-none.pdf'), '-q', src, '--json']);
        (0, bun_test_1.expect)(JSON.parse(stdout).probe ?? null).toBeNull();
    }, 120_000);
    (0, bun_test_1.test)('a probe it does not have is a usage error naming the ones it does', async () => {
        const src = (0, node_path_1.join)(dir, 'probe-none.html');
        const { code, stderr } = await run(['--probe', 'everything', src]);
        (0, bun_test_1.expect)(code).toBe(2);
        (0, bun_test_1.expect)(stderr).toContain('gaps, fonts');
    }, 60_000);
});
(0, bun_test_1.describe)('--no-script', () => {
    (0, bun_test_1.test)('document scripts do not run, but the tool still reports on the page', async () => {
        const src = (0, node_path_1.join)(dir, 'noscript.html');
        await (0, promises_1.writeFile)(src, `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}body{font:12pt serif}</style></head>` +
            `<body><p>static</p><script>document.body.insertAdjacentHTML('beforeend','<p>JS_RAN</p>')</script></body></html>`, 'utf8');
        const out = (0, node_path_1.join)(dir, 'noscript.pdf');
        const { code, stdout } = await run(['-o', out, '-q', src, '--no-script', '--json']);
        (0, bun_test_1.expect)(code).toBe(0);
        const got = JSON.parse(stdout);
        (0, bun_test_1.expect)(got.findings.map((f) => f.code)).toContain('scripts-disabled');
        const text = await (0, poppler_ts_1.pdfText)(await bytesOf(out));
        (0, bun_test_1.expect)(text).toContain('static');
        (0, bun_test_1.expect)(text).not.toContain('JS_RAN');
    }, 120_000);
    (0, bun_test_1.test)('a missing colon in --auth is a usage error', async () => {
        const src = (0, node_path_1.join)(dir, 'noscript.html');
        const { code, stderr } = await run(['--auth', 'no-colon', src]);
        (0, bun_test_1.expect)(code).toBe(2);
        (0, bun_test_1.expect)(stderr).toContain('--auth takes user:password');
    }, 60_000);
});
(0, bun_test_1.describe)('--before-print', () => {
    (0, bun_test_1.test)('the expression runs in the page before printing', async () => {
        const src = (0, node_path_1.join)(dir, 'beforeprint.html');
        await (0, promises_1.writeFile)(src, `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}body{font:12pt serif}</style></head>` +
            `<body><p>before</p></body></html>`, 'utf8');
        const out = (0, node_path_1.join)(dir, 'beforeprint.pdf');
        const { code } = await run([
            '-o',
            out,
            '-q',
            src,
            '--before-print',
            "document.body.insertAdjacentHTML('beforeend','<p>PRINTED</p>')",
        ]);
        (0, bun_test_1.expect)(code).toBe(0);
        const text = await (0, poppler_ts_1.pdfText)(await bytesOf(out));
        (0, bun_test_1.expect)(text).toContain('PRINTED');
    }, 120_000);
    (0, bun_test_1.test)('an empty expression is a usage error', async () => {
        const src = (0, node_path_1.join)(dir, 'beforeprint.html');
        const { code, stderr } = await run(['--before-print', '   ', src]);
        (0, bun_test_1.expect)(code).toBe(2);
        (0, bun_test_1.expect)(stderr).toContain('--before-print needs an expression');
    }, 60_000);
});
(0, bun_test_1.describe)('--page-ranges', () => {
    const paged = (n) => `<!doctype html><html lang="en"><head><style>` +
        `@page { size: A4; margin: 12mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }` +
        `body { font-family: "DejaVu Sans", sans-serif } h2 { page-break-before: always }` +
        `</style></head><body>` +
        Array.from({ length: n }, (_, i) => `<p>body ${i + 1}</p><h2>head ${i + 1}</h2>`).join('') +
        `</body></html>`;
    let src;
    (0, bun_test_1.beforeAll)(async () => {
        src = (0, node_path_1.join)(dir, 'ranges.html');
        await (0, promises_1.writeFile)(src, paged(5), 'utf8');
    }, 30_000);
    (0, bun_test_1.test)('it prints the named pages and no others', async () => {
        const out = (0, node_path_1.join)(dir, 'ranges-a.pdf');
        const { code } = await run(['-o', out, '-q', src, '--page-ranges', '2-3']);
        (0, bun_test_1.expect)(code).toBe(0);
        const bytes = await bytesOf(out);
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(bytes)).pages).toBe(2);
        const text = await (0, poppler_ts_1.pdfText)(bytes);
        (0, bun_test_1.expect)(text).toContain('body 2');
        (0, bun_test_1.expect)(text).not.toContain('body 5');
    }, 120_000);
    (0, bun_test_1.test)('a list and a single page are both accepted', async () => {
        for (const [spec, want] of [
            ['1', 1],
            ['1,4', 2],
            ['2-3,5', 3],
        ]) {
            const out = (0, node_path_1.join)(dir, `ranges-${spec.replace(/\W/g, '')}.pdf`);
            const { code } = await run(['-o', out, '-q', src, '--page-ranges', spec]);
            (0, bun_test_1.expect)(code, spec).toBe(0);
            (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(await bytesOf(out))).pages, spec).toBe(want);
        }
    }, 180_000);
    (0, bun_test_1.test)('page numbers in a footer keep counting the whole document', async () => {
        const out = (0, node_path_1.join)(dir, 'ranges-counters.pdf');
        const whole = (0, node_path_1.join)(dir, 'ranges-whole.pdf');
        await run(['-o', whole, '-q', src]);
        const total = (await (0, poppler_ts_1.pdfInfo)(await bytesOf(whole))).pages;
        await run(['-o', out, '-q', src, '--page-ranges', '3-4']);
        const text = await (0, poppler_ts_1.pdfText)(await bytesOf(out));
        (0, bun_test_1.expect)(text).toContain(`page 3 of ${total}`);
        (0, bun_test_1.expect)(text).toContain(`page 4 of ${total}`);
        (0, bun_test_1.expect)(text).not.toContain('page 1 of 2');
    }, 120_000);
    (0, bun_test_1.test)('omitting it renders every page', async () => {
        const out = (0, node_path_1.join)(dir, 'ranges-all.pdf');
        const { code } = await run(['-o', out, '-q', src]);
        (0, bun_test_1.expect)(code).toBe(0);
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(await bytesOf(out))).pages).toBeGreaterThan(2);
    }, 120_000);
    (0, bun_test_1.test)('a spec it cannot read is refused before a browser is launched', async () => {
        for (const spec of ['0-3', 'abc', '1,,2', '1-', '']) {
            const { code, stdout } = await run(['-o', (0, node_path_1.join)(dir, 'bad.pdf'), src, '--page-ranges', spec]);
            (0, bun_test_1.expect)(code, spec).toBe(2);
            (0, bun_test_1.expect)(stdout, spec).not.toContain('BADPATH');
            (0, bun_test_1.expect)(stdout, spec).toBe('');
        }
        const { stderr } = await run(['--page-ranges', 'abc', src]);
        (0, bun_test_1.expect)(stderr).toContain('--page-ranges takes page numbers and ranges');
    }, 60_000);
});
(0, bun_test_1.describe)('letterpress page', () => {
    const PAGE_DOC = `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:15mm}</style></head>` +
        `<body><h1>Heading</h1></body></html>`;
    let doc;
    (0, bun_test_1.beforeAll)(async () => {
        doc = (0, node_path_1.join)(dir, 'page.html');
        await (0, promises_1.writeFile)(doc, PAGE_DOC, 'utf8');
    }, 30_000);
    (0, bun_test_1.test)('it says what the document declares', async () => {
        const { code, stdout } = await run(['page', doc]);
        (0, bun_test_1.expect)(code).toBe(0);
        (0, bun_test_1.expect)(stdout).toContain('declared size         a4');
        (0, bun_test_1.expect)(stdout).toContain('declared margin       15mm');
        (0, bun_test_1.expect)(stdout).toContain('@page rules           1');
        (0, bun_test_1.expect)(stdout).toContain('@page{size:A4;margin:15mm}');
    }, 30_000);
    (0, bun_test_1.test)('it says what a format and a margin would do', async () => {
        const { code, stdout } = await run(['page', '--format', 'a4', '--margin', '15mm', doc]);
        (0, bun_test_1.expect)(code).toBe(0);
        (0, bun_test_1.expect)(stdout).toContain('with --format a4');
        (0, bun_test_1.expect)(stdout).toContain('page-size-override');
        (0, bun_test_1.expect)(stdout).toContain('with --margin 15mm');
        (0, bun_test_1.expect)(stdout).toContain('margin-ignored');
    }, 30_000);
    (0, bun_test_1.test)('--json carries the same answer', async () => {
        const { code, stdout } = await run(['page', '--json', doc]);
        (0, bun_test_1.expect)(code).toBe(0);
        const got = JSON.parse(stdout);
        (0, bun_test_1.expect)(got.path).toBe(doc);
        (0, bun_test_1.expect)(got.declared.size).toBe('a4');
        (0, bun_test_1.expect)(got.declared.margin).toBe('15mm');
        (0, bun_test_1.expect)(got.declared.rules).toEqual(['@page{size:A4;margin:15mm}']);
        (0, bun_test_1.expect)(got.landscape).toContain('transposed');
    }, 30_000);
    (0, bun_test_1.test)('a missing file is a usage error', async () => {
        const { code, stdout } = await run(['page', (0, node_path_1.join)(dir, 'absent.html')]);
        (0, bun_test_1.expect)(stdout).not.toContain('declared size');
        (0, bun_test_1.expect)(code).toBe(2);
    }, 30_000);
});
(0, bun_test_1.describe)('letterpress validate', () => {
    const PDF_DOC = `<!doctype html><html lang="en"><head><style>@page{size:A4;margin:15mm}</style></head>` +
        `<body><h1>Heading</h1><p>Some text.</p><ul><li>one</li><li>two</li></ul></body></html>`;
    let good;
    let broken;
    (0, bun_test_1.beforeAll)(async () => {
        const html = (0, node_path_1.join)(dir, 'validate.html');
        await (0, promises_1.writeFile)(html, PDF_DOC, 'utf8');
        good = (0, node_path_1.join)(dir, 'validate.pdf');
        broken = (0, node_path_1.join)(dir, 'broken.pdf');
        const rendered = await run(['-o', good, '-q', html]);
        (0, bun_test_1.expect)(rendered.code).toBe(0);
        await (0, promises_1.writeFile)(broken, 'not a pdf at all', 'utf8');
    }, 120_000);
    (0, bun_test_1.test)('a pdf this tool just wrote passes, with the exit code to match', async () => {
        const { code, stdout, stderr } = await run(['validate', good]);
        (0, bun_test_1.expect)(stderr).not.toMatch(/ERROR/);
        (0, bun_test_1.expect)(stdout).toMatch(/0 findings/);
        (0, bun_test_1.expect)(code).toBe(0);
    });
    (0, bun_test_1.test)('a file that is not a pdf fails, and says which check said so', async () => {
        const { code, stdout, stderr } = await run(['validate', broken]);
        (0, bun_test_1.expect)(stderr).toContain('not-a-pdf');
        (0, bun_test_1.expect)(stdout).toContain('not ok');
        (0, bun_test_1.expect)(code).toBe(1);
    });
    (0, bun_test_1.test)('--json carries the findings and the verdict', async () => {
        const { code, stdout } = await run(['validate', broken, '--json']);
        const got = JSON.parse(stdout);
        (0, bun_test_1.expect)(got.ok).toBe(false);
        (0, bun_test_1.expect)(got.bytes).toBeGreaterThan(0);
        (0, bun_test_1.expect)(got.findings.map((f) => f.code)).toEqual(['not-a-pdf']);
        (0, bun_test_1.expect)(code).toBe(1);
    });
    (0, bun_test_1.test)('a missing file is a usage error, not a failed check', async () => {
        const { code, stdout } = await run(['validate', (0, node_path_1.join)(dir, 'absent.pdf')]);
        (0, bun_test_1.expect)(stdout).not.toContain('not ok');
        (0, bun_test_1.expect)(code).toBe(2);
    });
    (0, bun_test_1.test)('no file is a usage error rather than reading stdin', async () => {
        const { code } = await run(['validate']);
        (0, bun_test_1.expect)(code).toBe(2);
    });
});
(0, bun_test_1.describe)('letterpress page', () => {
    const write = async (name, css) => {
        const p = (0, node_path_1.join)(dir, name);
        await (0, promises_1.writeFile)(p, `<!doctype html><html><head><style>${css}</style></head><body>x</body></html>`);
        return p;
    };
    (0, bun_test_1.test)('it reports what the document declared', async () => {
        const p = await write('paged.html', '@page{size:A4;margin:15mm}@page :first{margin:20mm}');
        const { code, stdout } = await run(['page', p]);
        (0, bun_test_1.expect)(code).toBe(0);
        (0, bun_test_1.expect)(stdout).toContain('a4');
        (0, bun_test_1.expect)(stdout).toContain('15mm');
        (0, bun_test_1.expect)(stdout).toContain('@page rules           2');
    });
    (0, bun_test_1.test)('--landscape is explained per document, and the two null cases are opposites', async () => {
        const none = await run(['page', await write('nopage.html', 'body{color:red}')]);
        (0, bun_test_1.expect)(none.stdout).toContain('passed straight to chromium');
        const auto = await run(['page', await write('auto.html', '@page{size:auto;margin:1in}')]);
        (0, bun_test_1.expect)(auto.stdout).toContain('refused');
        (0, bun_test_1.expect)(auto.stdout).toContain('orientation-ignored');
        const portrait = await run(['page', await write('portrait.html', '@page{size:A4;margin:1in}')]);
        (0, bun_test_1.expect)(portrait.stdout).toContain('transposed in place');
        const landscape = await run([
            'page',
            await write('land.html', '@page{size:A4 landscape;margin:1in}'),
        ]);
        (0, bun_test_1.expect)(landscape.stdout).toContain('already landscape');
    });
    (0, bun_test_1.test)('--json carries the same facts as the text', async () => {
        const p = await write('paged2.html', '@page{size:Letter;margin:1in}');
        const { stdout } = await run(['page', p, '--json']);
        const got = JSON.parse(stdout);
        (0, bun_test_1.expect)(got.declared.size).toBe('letter');
        (0, bun_test_1.expect)(got.declared.margin).toBe('1in');
        (0, bun_test_1.expect)(got.declared.orientation).toBe('portrait');
        (0, bun_test_1.expect)(got.declared.rules).toHaveLength(1);
    });
    (0, bun_test_1.test)('it needs exactly one file', async () => {
        const { code } = await run(['page']);
        (0, bun_test_1.expect)(code).toBe(2);
    });
});
//# sourceMappingURL=cli.test.js.map