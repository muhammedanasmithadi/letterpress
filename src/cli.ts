#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { FORMATS, render, type Format, type Finding } from "./render.ts";

const USAGE = `html2pdf - render HTML to PDF through Chromium's own print engine

usage
  html2pdf [options] <file.html>
  cat page.html | html2pdf [options] -
  html2pdf [options] https://example.com   (implies --allow-network)

options
  -o, --out <path>        output PDF (default: input name with .pdf)
      --format <name>     a3 a4 a5 legal letter tabloid; default is whatever
                          the document's own @page declares
      --landscape         print in landscape
      --margin <length>   CSS length such as 15mm; requires --format
      --allow-network     permit remote http(s) requests instead of blocking
      --no-background     omit background graphics
      --settle <ms>       extra wait after fonts resolve (default 0)
      --timeout <ms>      per-render deadline (default 30000)
      --json              machine-readable result on stdout
  -q, --quiet             suppress the human summary
  -h, --help              this text

exit codes
  0 rendered   1 render failed   2 bad usage
`;

type Options = {
  input?: string;
  out?: string;
  format?: Format;
  landscape: boolean;
  margin?: string;
  allowNetwork: boolean;
  background: boolean;
  settleMs: number;
  timeoutMs: number;
  json: boolean;
  quiet: boolean;
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
      case "-h": case "--help": opts.input = undefined; (opts as any).help = true; break;
      case "-o": case "--out": opts.out = need(i, a); i++; break;
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
  if ((opts as any).help) return { opts };
  if (!rest.length) return { opts, error: "no input. pass a file, - for stdin, or a URL" };
  opts.input = rest[0];
  if (/^https?:\/\//i.test(opts.input)) { opts.allowNetwork = true; opts.input = opts.input; }
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
  if ((opts as any).help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const outPath = opts.out ?? defaultOut(opts.input!);
  const profile = await mkdtemp(join(tmpdir(), "html2pdf-cli-"));
  let browser: Browser | undefined;

  try {
    const request = opts.input === "-"
      ? { html: await readStdin() }
      : /^https?:\/\//i.test(opts.input!)
        ? { url: opts.input! }
        : { path: opts.input! };

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

    for (const f of result.findings) {
      if (!opts.quiet) process.stderr.write(`${report(f)}\n`);
    }

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

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}