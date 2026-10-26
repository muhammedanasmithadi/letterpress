#!/usr/bin/env bun
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from './browser.ts';
import { parseArgs, type Options, type ParseResult, type ProbeName } from './args.ts';
import { formatBytes, UsageError } from './report.ts';
import { fontProbe, wideGaps } from './pageside.ts';

/**
 * Command-line interface for rendering HTML to PDF.
 *
 * @module
 */

/** CLI flag names and argument parser. */
export { flagNames, parseArgs } from './args.ts';
/** CLI options and parse result types. */
export type { Options, ParseResult } from './args.ts';
import { render, type Finding, type RenderRequest, type RenderResult } from './render.ts';

const USAGE = `letterpress - render HTML to PDF through Chromium's own print engine

usage
  letterpress [options] <file.html>
  cat page.html | letterpress [options] -
  letterpress [options] https://example.com   (implies --allow-network)

  letterpress validate <file.pdf>              check a pdf that already exists
  letterpress page <file.html>                 explain the document’s @page rules
  letterpress mcp                              serve the model context protocol on
                                                stdin and stdout, for an agent that
                                                speaks it

options
  -o, --out <path>        output PDF (default: input name with .pdf)
      --format <name>     a3 a4 a5 legal letter tabloid; default is whatever
                          the document's own @page declares, and a4 when the
                          document declares nothing
      --landscape         transpose the paper; a document that declares its own
                          @page keeps its size and margin and is turned, and is
                          only refused when the declaration names no paper
                          (size: auto), which has no portrait spelling to rotate
      --margin <length>   CSS length such as 15mm; needs --format, and is
                          ignored if the document declares @page margin
      --allow-network     permit remote http(s) requests instead of blocking
      --root <dir>        directory the document's assets may be read from
                          (default: the document's own directory). Needed when the
                          document sits in a subdirectory and references ../assets --
                          as most sites do
      --auth <user:pass>  credentials for HTTP Basic authentication when the
                          document or its assets require them. Also read from
                          the LETTERPRESS_AUTH environment variable
      --no-background     omit background graphics
      --no-script         do not run the document's JavaScript. the tool's own
                          measurements still run, so findings about the page
                          still report; js-error will not fire because no
                          script ran
      --max-image-ppi <n>  downsample images above this resolution (default
                          300, the print convention; 0 disables)
      --author <name>      pdf author. chromium drops the document's own
                          <meta name="author">, so pass it here to keep it
      --subject <text>     pdf subject
      --keywords <text>    pdf keywords
      --before-print <js>  run this JavaScript in the page after layout and before
                          printing; use it to set state the document computes at
                          print time
      --page-ranges <spec> print only these pages: 1-3, or 1,4-6. counters keep
                          counting the whole document, so page numbers in a footer
                          stay the numbers the reader sees, not 1,2,3 of the extract
      --settle <ms>       extra wait after fonts resolve (default 0)
      --timeout <ms>      per-render deadline (default 30000)
      --json              machine-readable result on stdout
      --probe <name>      ask the loaded page a question of its own and put the
                          answer in --json as "probe". gaps: where a browser will break a
                          text selection. fonts: the families the document asked for.
  -q, --quiet             suppress the human summary line. warnings and errors
                          are diagnostics and still go to stderr
  -h, --help              this text

notes
  page numbers and running headers belong in css @page margin boxes using
  counter(page). chromium implements neither target-counter() nor leader(), and
  discards the entire content declaration when it meets one, so a table of
  contents built that way prints nothing at all. the tool reports it.

exit codes
  0 rendered, nothing contradicted the request
  1 the render failed and no pdf was written, OR the pdf was written and a finding
    says it is not the document you asked for. These are not the same event and
    share a code, so a script cannot tell them from the status alone: with --json
    a failure carries an "error" key and a contradiction carries "findings". If
    you are not using --json, test for the output file rather than assuming.
  2 bad usage
`;

function defaultOut(input: string): string {
  if (input === '-') return 'out.pdf';
  try {
    const u = new URL(input);
    const name = u.pathname.split('/').filter(Boolean).pop() ?? 'index';
    return `${name.replace(/\.html?$/i, '') || 'index'}.pdf`;
  } catch {
    const base = input.split('/').filter(Boolean).pop() ?? 'out';
    return (base.replace(/\.html?$/i, '') || 'out') + '.pdf';
  }
}

async function readStdin({
  timeoutMs,
  maxBytes,
}: {
  timeoutMs: number;
  maxBytes: number;
}): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  const pump = (async () => {
    const reader = Bun.stdin.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `stdin is over the ${(maxBytes / 1048576).toFixed(0)}MB limit at ${(total / 1048576).toFixed(1)}MB. ` +
            `write the document to a file and pass the path.`,
        );
      }
      chunks.push(chunk);
    }
    return chunks;
  })();

  const guard = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `stdin was still open after ${(timeoutMs / 1000).toFixed(0)}s, so there is nothing to render. ` +
              `the pipe is either trickling or not closing. raise --timeout if the document really is that slow.`,
          ),
        ),
      timeoutMs,
    );

    t.unref?.();
    pump.then(
      () => clearTimeout(t),
      () => clearTimeout(t),
    );
  });

  await Promise.race([pump, guard]);
  const decoder = new TextDecoder();
  let out = '';
  for (const c of chunks) out += decoder.decode(c, { stream: true });
  return out + decoder.decode();
}

function report(finding: Finding): string {
  return finding.severity === 'error' ? `error: ${finding.message}` : `warn:  ${finding.message}`;
}

function killBrowserByProfile(profile: string): void {
  if (process.platform.toUpperCase() !== 'LINUX') return;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(profile)) continue;
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  } catch {}
}

function parseAuth(raw: string | undefined): { username: string; password: string } | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const i = raw.indexOf(':');
  if (i < 0) throw new UsageError('--auth takes user:password');
  return { username: raw.slice(0, i), password: raw.slice(i + 1) };
}

function probeFor(name: ProbeName | undefined): (() => unknown) | undefined {
  if (name === 'gaps') return wideGaps;
  if (name === 'fonts') return fontProbe;
  return undefined;
}

async function requestFor(opts: Options): Promise<RenderRequest> {
  if (opts.input === '-') {
    return {
      html: await readStdin({
        timeoutMs: opts.timeoutMs,
        maxBytes: 64 * 1024 * 1024,
      }),
    };
  }
  if (/^https?:\/\//i.test(opts.input!)) return { url: opts.input! };
  return { path: opts.input! };
}

function sweepAndExit(
  signal: NodeJS.Signals,
  profile: string,
  current: () => Browser | undefined,
): void {
  const browser = current();
  if (browser) void browser.close().catch(() => {});
  killBrowserByProfile(profile);

  try {
    const mine = [`letterpress-${process.pid}-`, 'letterpress-cli-'];
    for (const entry of readdirSync(tmpdir())) {
      if (mine.some((p) => entry.startsWith(p)))
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
    rmSync(profile, { recursive: true, force: true });
  } catch {}

  process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
}

async function writeAtomic(outPath: string, pdf: Uint8Array): Promise<void> {
  const partial = `${outPath}.${process.pid}.part`;
  try {
    await Bun.write(partial, pdf);
    await rename(partial, outPath);
  } catch (e) {
    await rm(partial, { force: true }).catch(() => {});
    throw e;
  }
}

function reportOutcome(opts: Options, result: RenderResult, outPath: string): number {
  for (const f of result.findings) process.stderr.write(`${report(f)}\n`);
  const contradicted = result.findings.some((f) => f.severity === 'error');
  const bytes = result.pdf.byteLength;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: !contradicted,
          path: outPath,
          ms: result.ms,
          source: result.source,
          blocked: result.blocked,
          ...result.info,
          probe: result.probe,
          findings: result.findings,
        },
        null,
        2,
      )}\n`,
    );
  } else if (!opts.quiet) {
    const shape = result.info.mediaBoxes[0] ?? 'unknown';
    process.stdout.write(
      `${outPath}  ${result.info.pages} page${result.info.pages === 1 ? '' : 's'}  ${formatBytes(bytes)}  ${result.ms}ms  ${shape}\n`,
    );
  }

  if (contradicted) {
    process.stderr.write(
      'the pdf was written, but a finding above is an error: it is not the document you asked for.\n',
    );
    return 1;
  }
  return 0;
}

async function subcommand(argv: string[]): Promise<number | null> {
  const name = argv[0];
  if (name === 'mcp') {
    const { runMcp } = await import('./mcp.ts');
    return runMcp();
  }
  if (name !== 'validate' && name !== 'page') return null;
  const { runValidate, runPage } = await import('./subcommands.ts');
  return (name === 'validate' ? runValidate : runPage)(argv.slice(1));
}

/**
 * Run the CLI with the given arguments.
 *
 * @param argv - The command-line arguments.
 * @returns The exit code.
 */
export async function main(argv: string[]): Promise<number> {
  const sub = await subcommand(argv);
  if (sub !== null) return sub;

  let parsed: ParseResult;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    return 2;
  }
  const { opts } = parsed;
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let auth: { username: string; password: string } | undefined;
  try {
    auth = parseAuth(opts.auth ?? process.env.LETTERPRESS_AUTH);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    return 2;
  }

  const outPath = opts.out ?? defaultOut(opts.input!);
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-cli-'));
  let browser: Browser | undefined;

  const onSignal = (signal: NodeJS.Signals) => sweepAndExit(signal, profile, () => browser);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  try {
    const request = await requestFor(opts);

    browser = await Browser.launch({ profile });
    const result = await render(browser, {
      ...request,
      format: opts.format,
      landscape: opts.landscape,
      margin: opts.margin,
      allowNetwork: opts.allowNetwork,
      printBackground: opts.background,
      noScript: opts.noScript,
      settleMs: opts.settleMs,
      timeoutMs: opts.timeoutMs,
      maxImagePpi: opts.maxImagePpi || undefined,
      root: opts.root,
      author: opts.author,
      subject: opts.subject,
      keywords: opts.keywords,
      beforePrint: opts.beforePrint,
      auth,
      pageRanges: opts.pageRanges,
      pageProbe: probeFor(opts.probe),
    });

    await writeAtomic(outPath, result.pdf);
    return reportOutcome(opts, result, outPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`render failed: ${message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
