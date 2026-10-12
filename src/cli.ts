#!/usr/bin/env bun
import { readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from './browser.ts';
import { FORMATS, render, type Format, type Finding } from './render.ts';
import {
  TemplateError,
  escapeCss,
  invoiceTotals,
  lines,
  money,
  render as fillTemplate,
  type TemplateData,
} from './template.ts';

const USAGE = `letterpress - render HTML to PDF through Chromium's own print engine

usage
  letterpress [options] <file.html>
  cat page.html | letterpress [options] -
  letterpress [options] --template invoice --data order.json
  letterpress [options] https://example.com   (implies --allow-network)

options
  -o, --out <path>        output PDF (default: input name with .pdf)
  -t, --template <name>   fill a bundled template, e.g. invoice
      --list-templates    print the bundled template names and exit
  -d, --data <path>       JSON data file for --template
      --format <name>     a3 a4 a5 legal letter tabloid; default is whatever
                          the document's own @page declares, and a4 when the
                          document declares nothing
      --landscape         ignored if the document declares @page size: pass
                          --format, or write "size: a4 landscape" in the css
      --margin <length>   CSS length such as 15mm; needs --format, and is
                          ignored if the document declares @page margin
      --allow-network     permit remote http(s) requests instead of blocking
      --root <dir>        directory the document's assets may be read from
                          (default: the document's own directory). Needed when the
                          document sits in a subdirectory and references ../assets --
                          as most sites do
      --no-background     omit background graphics
      --max-image-ppi <n>  downsample images above this resolution (default
                          300, the print convention; 0 disables)
      --author <name>      pdf author. chromium drops the document's own
                          <meta name="author">, so pass it here to keep it
      --subject <text>     pdf subject
      --keywords <text>    pdf keywords
      --settle <ms>       extra wait after fonts resolve (default 0)
      --timeout <ms>      per-render deadline (default 30000)
      --json              machine-readable result on stdout
  -q, --quiet             suppress the human summary line. warnings and errors
                          are diagnostics and still go to stderr
  -h, --help              this text

notes
  page numbers and running headers belong in css @page margin boxes using
  counter(page). chromium implements neither target-counter() nor leader(), and
  discards the entire content declaration when it meets one, so a table of
  contents built that way prints nothing at all. the tool reports it.

exit codes
  0 rendered   1 render failed   2 bad usage
`;

type Options = {
  input?: string;
  out?: string;
  template?: string;
  data?: string;
  listTemplates?: boolean;
  format?: Format;
  landscape: boolean;
  margin?: string;
  allowNetwork: boolean;
  root?: string;
  background: boolean;
  settleMs: number;
  timeoutMs: number;
  maxImagePpi: number;
  author?: string;
  subject?: string;
  keywords?: string;
  json: boolean;
  quiet: boolean;
  help?: boolean;
};

type ParseResult = { opts: Options; error?: string };

/** What handling one argv token produced: how far to advance, or the error that stopped. */
type Step =
  | { kind: 'next'; consumed: number }
  | { kind: 'rest'; value: string; consumed: number }
  | { kind: 'error'; error: string };

type Handler = (opts: Options, argv: string[], i: number, a: string) => Step;

/** Throw a usage error, caught by `main` and printed with the usage text. */
function fail(m: string): never {
  throw new UsageError(m);
}

/** The value after a flag, or a usage error naming the flag. */
function valueAfter(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('-')) fail(`option ${flag} needs a value`);
  return v;
}

const consumedValue = (): Step => ({ kind: 'next', consumed: 2 });
const consumedFlag = (): Step => ({ kind: 'next', consumed: 1 });

function setHelp(opts: Options): Step {
  opts.help = true;
  return consumedFlag();
}

function setOut(opts: Options, argv: string[], i: number, a: string): Step {
  opts.out = valueAfter(argv, i, a);
  return consumedValue();
}

function setTemplate(opts: Options, argv: string[], i: number, a: string): Step {
  opts.template = valueAfter(argv, i, a);
  return consumedValue();
}

function setListTemplates(opts: Options): Step {
  opts.listTemplates = true;
  return consumedFlag();
}

function setData(opts: Options, argv: string[], i: number, a: string): Step {
  opts.data = valueAfter(argv, i, a);
  return consumedValue();
}

function setFormat(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a).toLowerCase();
  if (!(v in FORMATS)) {
    return {
      kind: 'error',
      error: `unknown format "${v}". try: ${Object.keys(FORMATS).join(', ')}`,
    };
  }
  opts.format = v as Format;
  return consumedValue();
}

function setLandscape(opts: Options): Step {
  opts.landscape = true;
  return consumedFlag();
}

function setMargin(opts: Options, argv: string[], i: number): Step {
  // `argv[i + 1]`, like every other option that takes a value. This read `a[i + 1]`,
  // and `a` is the flag itself, so it indexed into the string "--margin" and returned
  // "r". `--margin 15mm` set the margin to "r", silently, and `--margin --json` looked
  // like a valid value too. The flag had never worked.
  const v = argv[i + 1];
  // A flag starts with a dash; a negative length does not. `--margin -5mm` is a value
  // the renderer then rejects with a proper message, and a test has said so since
  // before this was found -- calling it a missing argument would replace a useful
  // error with a confusing one.
  const looksLikeFlag = v !== undefined && v.startsWith('-') && !/^-[.\d]/.test(v);
  if (v === undefined || looksLikeFlag) {
    return { kind: 'error', error: 'option --margin needs a value' };
  }
  opts.margin = v;
  return consumedValue();
}

function setNetwork(opts: Options): Step {
  opts.allowNetwork = true;
  return consumedFlag();
}

function setRoot(opts: Options, argv: string[], i: number, a: string): Step {
  opts.root = valueAfter(argv, i, a);
  return consumedValue();
}

function setNoBackground(opts: Options): Step {
  opts.background = false;
  return consumedFlag();
}

function setSettle(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  const n = wholeNumber(v);
  if (n === undefined || n < 0) {
    return {
      kind: 'error',
      error: `--settle needs a whole number of milliseconds, got "${v}"`,
    };
  }
  opts.settleMs = n;
  return consumedValue();
}

function setMaxImagePpi(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  if (!/^\d+$/.test(v)) {
    return { kind: 'error', error: `--max-image-ppi needs a whole number, got "${v}"` };
  }
  opts.maxImagePpi = Number(v);
  return consumedValue();
}

function setRenderTimeout(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  const n = wholeNumber(v);
  if (n === undefined || n < 1000) {
    return { kind: 'error', error: `--timeout needs at least 1000ms, got "${v}"` };
  }
  opts.timeoutMs = n;
  return consumedValue();
}

function setAuthor(opts: Options, argv: string[], i: number, a: string): Step {
  opts.author = valueAfter(argv, i, a);
  if (!opts.author.trim()) return { kind: 'error', error: '--author needs a name' };
  return consumedValue();
}

function setSubject(opts: Options, argv: string[], i: number, a: string): Step {
  opts.subject = valueAfter(argv, i, a);
  if (!opts.subject.trim()) return { kind: 'error', error: '--subject needs text' };
  return consumedValue();
}

function setKeywords(opts: Options, argv: string[], i: number, a: string): Step {
  opts.keywords = valueAfter(argv, i, a);
  if (!opts.keywords.trim()) return { kind: 'error', error: '--keywords needs text' };
  return consumedValue();
}

function setJson(opts: Options): Step {
  opts.json = true;
  return consumedFlag();
}

function setQuiet(opts: Options): Step {
  opts.quiet = true;
  return consumedFlag();
}

const HANDLERS: Map<string, Handler> = new Map([
  ['-h', setHelp],
  ['--help', setHelp],
  ['-o', setOut],
  ['--out', setOut],
  ['-t', setTemplate],
  ['--template', setTemplate],
  ['--list-templates', setListTemplates],
  ['-d', setData],
  ['--data', setData],
  ['--format', setFormat],
  ['--landscape', setLandscape],
  ['--margin', setMargin],
  ['--allow-network', setNetwork],
  ['--root', setRoot],
  ['--no-background', setNoBackground],
  ['--settle', setSettle],
  ['--max-image-ppi', setMaxImagePpi],
  ['--timeout', setRenderTimeout],
  ['--author', setAuthor],
  ['--subject', setSubject],
  ['--keywords', setKeywords],
  ['--json', setJson],
  ['-q', setQuiet],
  ['--quiet', setQuiet],
]);

/** Apply the token at `argv[i]`, or classify it as a positional argument. */
function applyFlag(opts: Options, argv: string[], i: number, a: string): Step {
  const handler = HANDLERS.get(a);
  if (handler) return handler(opts, argv, i, a);
  if (a.startsWith('-') && a !== '-') return { kind: 'error', error: `unknown option "${a}"` };
  return { kind: 'rest', value: a, consumed: 1 };
}

/** Resolve the positional input, or the error that explains why it cannot be. */
function resolveInput(opts: Options, rest: string[]): string | undefined {
  if (!rest.length) {
    if (opts.template) return undefined;
    return 'no input. pass a file, - for stdin, a URL, or --template with --data';
  }
  if (opts.template) return 'pass either an input file or --template with --data, not both';
  opts.input = rest[0] ?? '';
  if (/^https?:\/\//i.test(opts.input)) opts.allowNetwork = true;
  return undefined;
}

/** Validate the parsed options once every argument has been seen. */
function finish(opts: Options, rest: string[]): ParseResult {
  if (rest.length > 1) {
    return { opts, error: `expected one input, got ${rest.length}: ${rest.join(', ')}` };
  }
  if (opts.help || opts.listTemplates) return { opts };
  if (opts.data && !opts.template) return { opts, error: '--data needs --template' };
  if (opts.template && !opts.data) return { opts, error: '--template needs --data' };
  const inputError = resolveInput(opts, rest);
  if (inputError) return { opts, error: inputError };
  if (opts.margin && !opts.format) {
    return {
      opts,
      error: "--margin only applies with --format, because the document's own @page wins otherwise",
    };
  }
  return { opts };
}

export function parseArgs(argv: string[]): ParseResult {
  const opts: Options = {
    landscape: false,
    allowNetwork: false,
    background: true,
    settleMs: 0,
    timeoutMs: 30_000,
    maxImagePpi: 300,
    json: false,
    quiet: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length;) {
    const step = applyFlag(opts, argv, i, argv[i] ?? '');
    if (step.kind === 'error') return { opts, error: step.error };
    if (step.kind === 'rest') rest.push(step.value);
    i += step.consumed;
  }
  return finish(opts, rest);
}

function wholeNumber(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v);
}

export class UsageError extends Error {}

function defaultOut(input: string): string {
  if (input === '-') return 'out.pdf';
  try {
    const u = new URL(input);
    const name = u.pathname.split('/').filter(Boolean).pop() ?? 'index';
    return `${name.replace(/\.html?$/i, '') || 'index'}.pdf`;
  } catch {
    const base = input.split('/').filter(Boolean).pop() ?? 'out';
    // `|| 'out'` for the same reason the url branch has it: a file literally named `.html`
    // strips to the empty string, and `'' + '.pdf'` is a hidden `.pdf` in the cwd. The url
    // branch guarded this and this one did not.
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
    for await (const chunk of Bun.stdin.stream()) {
      total += (chunk as Uint8Array).byteLength;
      if (total > maxBytes) {
        throw new Error(
          `stdin is over the ${(maxBytes / 1048576).toFixed(0)}MB limit at ${(total / 1048576).toFixed(1)}MB. ` +
            `write the document to a file and pass the path.`,
        );
      }
      chunks.push(chunk as Uint8Array);
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
  let out = '';
  for (const c of chunks) out += new TextDecoder().decode(c, { stream: true });
  return out;
}

function report(finding: Finding): string {
  return finding.severity === 'error' ? `error: ${finding.message}` : `warn:  ${finding.message}`;
}

function killBrowserByProfile(profile: string): void {
  if (process.platform.toUpperCase() !== 'LINUX') return;
  try {
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
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

export async function main(argv: string[]): Promise<number> {
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
  if (opts.listTemplates) {
    const names = await listTemplates();
    process.stdout.write(names.length ? `${names.join('\n')}\n` : 'no templates bundled\n');
    return 0;
  }

  const outPath = opts.out ?? (opts.template ? `${opts.template}.pdf` : defaultOut(opts.input!));
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-cli-'));
  let browser: Browser | undefined;

  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    if (browser) void browser.close().catch(() => {});
    killBrowserByProfile(profile);

    try {
      // Both prefixes, because `render` makes `letterpress-<pid>-n` work directories and
      // this function makes its own profile with an `letterpress-cli-` mkdtemp name. Sweeping only
      // first left every crashed run's profile behind for ever, which is the exact thing a
      // sweep is for.
      const mine = [`letterpress-${process.pid}-`, 'letterpress-cli-'];
      for (const entry of readdirSync(tmpdir())) {
        if (mine.some((p) => entry.startsWith(p)))
          rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
      rmSync(profile, { recursive: true, force: true });
    } catch {}

    process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  void interrupted;

  try {
    let request: { html?: string; path?: string; url?: string };
    if (opts.template && opts.data) {
      const raw = await Bun.file(opts.data).text();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw new Error(`${opts.data} is not valid JSON: ${(e as Error).message}`);
      }
      const tplPath = join(import.meta.dir, '..', 'templates', `${opts.template}.html`);
      if (!(await Bun.file(tplPath).exists())) {
        throw new Error(`no bundled template named "${opts.template}". try --list-templates`);
      }
      request = {
        html: fillTemplate(await Bun.file(tplPath).text(), buildTemplateData(data)),
      };
    } else if (opts.input === '-') {
      request = {
        html: await readStdin({
          timeoutMs: opts.timeoutMs ?? 30_000,
          maxBytes: 64 * 1024 * 1024,
        }),
      };
    } else if (/^https?:\/\//i.test(opts.input!)) {
      request = { url: opts.input! };
    } else {
      request = { path: opts.input! };
    }

    browser = await Browser.launch({ profile });
    const result = await render(browser, {
      ...request,
      format: opts.format,
      landscape: opts.landscape,
      margin: opts.margin,
      allowNetwork: opts.allowNetwork,
      printBackground: opts.background,
      settleMs: opts.settleMs,
      timeoutMs: opts.timeoutMs,
      maxImagePpi: opts.maxImagePpi || undefined,
      root: opts.root,
      author: opts.author,
      subject: opts.subject,
      keywords: opts.keywords,
    });

    // Written to a sibling and renamed, so an interrupted run cannot leave a truncated file
    // where the caller expects a whole one. The signal handler exits synchronously from
    // wherever it lands, and it can land here: `letterpress -o invoice.pdf` then Ctrl-C left
    // a partial PDF at that path and reported exit 130, with nothing to tell the two apart.
    const partial = `${outPath}.${process.pid}.part`;
    try {
      await Bun.write(partial, result.pdf);
      await rename(partial, outPath);
    } catch (e) {
      await rm(partial, { force: true }).catch(() => {});
      throw e;
    }
    const bytes = result.pdf.byteLength;

    for (const f of result.findings) process.stderr.write(`${report(f)}\n`);

    const contradicted = result.findings.some((f) => f.severity === 'error');

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: !contradicted,
            path: outPath,
            pages: result.info.pages,
            bytes,
            ms: result.ms,
            source: result.source,
            mediaBoxes: result.info.mediaBoxes,
            imageObjects: result.info.imageObjects,
            tagged: result.info.tagged,
            blocked: result.blocked,
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
    return result.findings.some((f) => f.code === 'url-render-blocked') ? 1 : 0;
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export async function listTemplates(): Promise<string[]> {
  const dir = join(import.meta.dir, '..', 'templates');
  const names: string[] = [];
  for await (const entry of new Bun.Glob('*.html').scan({ cwd: dir }))
    names.push(entry.replace(/\.html$/, ''));
  return names.sort();
}

function buildTemplateData(data: Record<string, unknown>): TemplateData {
  const out: TemplateData = {};
  for (const [k, v] of Object.entries(data)) out[k] = v as TemplateData[string];

  const hasItems = Array.isArray(data.items) || Array.isArray(data.lines);

  if (!hasItems && data.rows !== undefined) {
    throw new TemplateError([
      'rows is pre-built table markup and cannot be checked against a total. ' +
        'give items instead: an array of {description, qty, unit}, and the rows, ' +
        'subtotal, vat and total are all computed from them.',
    ]);
  }
  if (hasItems) {
    const raw = (data.items ?? data.lines) as unknown;
    if (!Array.isArray(raw)) throw new TemplateError(['items must be an array']);
    const items = raw as Array<Record<string, unknown>>;

    const rateInput = data.vat_rate ?? data.vatRate ?? 0.2;
    const vatRate = Number(rateInput);
    if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) {
      throw new TemplateError([
        `vat_rate must be a number between 0 and 1, got ${JSON.stringify(rateInput)}. ` +
          `use 0.2 for twenty percent.`,
      ]);
    }

    const lineItems = items.map((i, at) => {
      const qty = Number(i.qty ?? i.quantity ?? 1);
      const unit = Number(i.unit ?? i.price ?? 0);

      if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
        throw new TemplateError([
          `items[${at}] has a qty or unit that is not a number: ` +
            `${JSON.stringify({ qty: i.qty ?? i.quantity, unit: i.unit ?? i.price })}`,
        ]);
      }
      return { description: String(i.description ?? i.item ?? ''), qty, unit };
    });

    if (!lineItems.length) {
      throw new TemplateError([
        'items is empty, so the invoice would print a header and a total with no ' +
          'line items between them. pass at least one item, or check the data file.',
      ]);
    }

    const totals = invoiceTotals(lineItems, {
      vatRate,
      currency: String(data.currency ?? 'EUR'),
    });
    Object.assign(out, totals);
    for (const [key, computed] of [
      ['subtotal', totals.subtotalValue],
      ['vat', totals.vatValue],
      ['total', totals.totalValue],
    ] as const) {
      const claimed = data[key];
      if (claimed === undefined || claimed === null || claimed === '') continue;

      const digits =
        typeof claimed === 'number' ? String(claimed) : String(claimed).replace(/[^\d.-]/g, '');
      const parsed = typeof claimed === 'number' ? claimed : Number(digits);
      if (!digits.trim() || !Number.isFinite(parsed)) {
        throw new TemplateError([
          `${key} in the data file is ${JSON.stringify(claimed)}, which is not a number. ` +
            `remove ${key} to let it be computed from the line items.`,
        ]);
      }
      if (Math.abs(parsed - computed) > 0.005) {
        throw new TemplateError([
          `${key} in the data file is ${claimed}, but the line items add up to ${money(computed)}. ` +
            `the computed figure is printed, because printing the supplied one would send a wrong total. ` +
            `remove ${key} from the data file to let it always be computed.`,
        ]);
      }
    }
  }

  for (const k of ['company', 'invoice_no', 'company_secondary', 'note', 'currency']) {
    if (typeof data[k] === 'string') out[`${k}_text`] = escapeCss(data[k] as string);
  }
  if (Array.isArray(data.bill_to_lines)) out.bill_to_lines = lines(data.bill_to_lines.map(String));
  if (Array.isArray(data.company_lines)) out.company_lines = lines(data.company_lines.map(String));
  return out;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
