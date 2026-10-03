#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { FORMATS, render, type Format, type Finding } from "./render.ts";
import { invoiceTotals, lines, render as fillTemplate, type TemplateData } from "./template.ts";

const USAGE = `html2pdf - render HTML to PDF through Chromium's own print engine

usage
  html2pdf [options] <file.html>
  cat page.html | html2pdf [options] -
  html2pdf [options] --template invoice --data order.json
  html2pdf [options] https://example.com   (implies --allow-network)

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
      --no-background     omit background graphics
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
  background: boolean;
  settleMs: number;
  timeoutMs: number;
  json: boolean;
  quiet: boolean;
  help?: boolean;
};

type ParseResult = { opts: Options; error?: string };

export function parseArgs(argv: string[]): ParseResult {
  const opts: Options = {
    landscape: false, allowNetwork: false, background: true,
    settleMs: 0, timeoutMs: 30_000, json: false, quiet: false,
  };
  const rest: string[] = [];

  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) return fail(`option ${flag} needs a value`);
    return v;
  };
  const fail = (m: string): never => { throw new UsageError(m); };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": opts.help = true; break;
      case "-o": case "--out": opts.out = need(i, a); i++; break;
      case "-t": case "--template": opts.template = need(i, a); i++; break;
      case "--list-templates": opts.listTemplates = true; break;
      case "-d": case "--data": opts.data = need(i, a); i++; break;
      case "--format": {
        const v = need(i, a).toLowerCase(); i++;
        if (!(v in FORMATS)) return { opts, error: `unknown format "${v}". try: ${Object.keys(FORMATS).join(", ")}` };
        opts.format = v as Format;
        break;
      }
      case "--landscape": opts.landscape = true; break;
      case "--margin": opts.margin = need(i, a); i++; break;
      case "--allow-network": opts.allowNetwork = true; break;
      case "--no-background": opts.background = false; break;
      case "--settle": opts.settleMs = Number(need(i, a)); i++; break;
      case "--timeout": opts.timeoutMs = Number(need(i, a)); i++; break;
      case "--json": opts.json = true; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      default:
        if (a.startsWith("-") && a !== "-") return { opts, error: `unknown option "${a}"` };
        rest.push(a);
    }
  }

  if (rest.length > 1) return { opts, error: `expected one input, got ${rest.length}: ${rest.join(", ")}` };
  if (opts.help || opts.listTemplates) return { opts };
  if (opts.data && !opts.template) return { opts, error: "--data needs --template" };
  if (opts.template && !opts.data) return { opts, error: "--template needs --data" };
  if (rest.length) {
    if (opts.template) return { opts, error: "pass either an input file or --template with --data, not both" };
    opts.input = rest[0];
    if (/^https?:\/\//i.test(opts.input)) opts.allowNetwork = true;
  } else if (!opts.template) {
    return { opts, error: "no input. pass a file, - for stdin, a URL, or --template with --data" };
  }
  if (opts.margin && !opts.format) return { opts, error: "--margin only applies with --format, because the document's own @page wins otherwise" };
  return { opts };
}

export class UsageError extends Error {}

function defaultOut(input: string): string {
  if (input === "-") return "out.pdf";
  try {
    const u = new URL(input);
    const name = u.pathname.split("/").filter(Boolean).pop() ?? "index";
    return `${name.replace(/\.html?$/i, "") || "index"}.pdf`;
  } catch {
    const base = input.split("/").filter(Boolean).pop() ?? "out";
    return base.replace(/\.html?$/i, "") + ".pdf";
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Uint8Array);
  let out = "";
  for (const c of chunks) out += new TextDecoder().decode(c, { stream: true });
  return out;
}

function report(finding: Finding): string {
  return finding.severity === "error" ? `error: ${finding.message}` : `warn:  ${finding.message}`;
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
    process.stdout.write(names.length ? `${names.join("\n")}\n` : "no templates bundled\n");
    return 0;
  }

  const outPath = opts.out ?? (opts.template ? `${opts.template}.pdf` : defaultOut(opts.input!));
  const profile = await mkdtemp(join(tmpdir(), "html2pdf-cli-"));
  let browser: Browser | undefined;

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
      const tplPath = join(import.meta.dir, "..", "templates", `${opts.template}.html`);
      if (!(await Bun.file(tplPath).exists())) {
        throw new Error(`no bundled template named "${opts.template}". try --list-templates`);
      }
      request = { html: fillTemplate(await Bun.file(tplPath).text(), buildTemplateData(data)) };
    } else if (opts.input === "-") {
      request = { html: await readStdin() };
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
    });

    await Bun.write(outPath, result.pdf);
    const bytes = result.pdf.byteLength;

    // Warnings are diagnostics, not part of the human summary, so --quiet
    // silences the summary line only. Swallowing these leaves a pipeline
    // holding a PDF full of broken images with nothing said about it.
    for (const f of result.findings) process.stderr.write(`${report(f)}\n`);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true, path: outPath, pages: result.info.pages, bytes,
        ms: result.ms, source: result.source,
        mediaBoxes: result.info.mediaBoxes, imageObjects: result.info.imageObjects,
        tagged: result.info.tagged, blocked: result.blocked,
        findings: result.findings,
      }, null, 2)}\n`);
    } else if (!opts.quiet) {
      const shape = result.info.mediaBoxes[0] ?? "unknown";
      process.stdout.write(`${outPath}  ${result.info.pages} page${result.info.pages === 1 ? "" : "s"}  ${formatBytes(bytes)}  ${result.ms}ms  ${shape}\n`);
    }
    return result.findings.some((f) => f.code === "url-render-blocked") ? 1 : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`render failed: ${message}\n`);
    return 1;
  } finally {
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
  const dir = join(import.meta.dir, "..", "templates");
  const names: string[] = [];
  for await (const entry of new Bun.Glob("*.html").scan({ cwd: dir })) names.push(entry.replace(/\.html$/, ""));
  return names.sort();
}

/**
 * Turn a JSON order into template values. Line items become table rows and the
 * totals are computed here, so the caller never hand-writes a sum that the
 * document then has to be trusted to reproduce.
 */
function buildTemplateData(data: Record<string, unknown>): TemplateData {
  const out: TemplateData = {};
  for (const [k, v] of Object.entries(data)) out[k] = v as TemplateData[string];

  const items = (data.items ?? data.lines ?? []) as Array<Record<string, number | string>>;
  if (Array.isArray(items) && items.length) {
    const totals = invoiceTotals(
      items.map((i) => ({ description: String(i.description ?? i.item ?? ""), qty: Number(i.qty ?? i.quantity ?? 1), unit: Number(i.unit ?? i.price ?? 0) })),
      { vatRate: Number(data.vat_rate ?? data.vatRate ?? 0.2), currency: String(data.currency ?? "EUR") },
    );
    Object.assign(out, totals);
  }
  if (Array.isArray(data.bill_to_lines)) out.bill_to_lines = lines(data.bill_to_lines.map(String));
  if (Array.isArray(data.company_lines)) out.company_lines = lines(data.company_lines.map(String));
  return out;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}