#!/usr/bin/env bun
import { readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { FORMATS, render, type Format, type Finding } from "./render.ts";
import { TemplateError, escapeCss, invoiceTotals, lines, money, render as fillTemplate, type TemplateData } from "./template.ts";

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
      --no-background     omit background graphics
      --max-image-ppi <n>  downsample images above this resolution (default
                          300, the print convention; 0 disables)
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
  maxImagePpi: number;
  json: boolean;
  quiet: boolean;
  help?: boolean;
};

type ParseResult = { opts: Options; error?: string };

export function parseArgs(argv: string[]): ParseResult {
  const opts: Options = {
    landscape: false, allowNetwork: false, background: true,
    settleMs: 0, timeoutMs: 30_000, maxImagePpi: 300, json: false, quiet: false,
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
      case "--margin": {
        // A negative margin is valid CSS, so "-5mm" is a value the user typed.
        // need() rejects anything starting with "-", which reported "needs a
        // value" for a value that was right there.
        const v = a[i + 1];
        if (v === undefined) return { opts, error: "option --margin needs a value" };
        i++;
        opts.margin = v;
        break;
      }
      case "--allow-network": opts.allowNetwork = true; break;
      case "--no-background": opts.background = false; break;
      case "--settle": {
        const v = need(i, a); i++;
        const n = wholeNumber(v);
        // 0 is meaningful here and must be allowed: "do not wait" is a decision.
        if (n === undefined || n < 0) {
          return { opts, error: `--settle needs a whole number of milliseconds, got "${v}"` };
        }
        opts.settleMs = n;
        break;
      }
      case "--max-image-ppi": {
        const v = need(i, a); i++;
        if (!/^\d+$/.test(v)) return { opts, error: `--max-image-ppi needs a whole number, got "${v}"` };
        opts.maxImagePpi = Number(v);
        break;
      }
      case "--timeout": {
        const v = need(i, a); i++;
        const n = wholeNumber(v);
        // 0 and 1 both used to produce "cdp socket closed", naming an internal
        // protocol instead of the flag the user got wrong. They are rejected
        // here with the reason. A generous ceiling, because a deadline this tool
        // cannot honour is a different mistake from a small one.
        if (n === undefined || n < 1000) {
          return { opts, error: `--timeout needs at least 1000ms, got "${v}"` };
        }
        opts.timeoutMs = n;
        break;
      }
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

/** A whole number of milliseconds, or undefined. Rejects "", "abc", "1e9", "1.5". */
function wholeNumber(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v);
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

/**
 * Read stdin, with a deadline and a size cap.
 *
 * Measured: `{ printf "<html>"; sleep 600; } | letterpress - --timeout 5000` hung
 * past 25 seconds, because --timeout covers the render and not the read. A stuck
 * pipe produced no output, no file and no diagnostic, and there was no flag that
 * would end it.
 */
async function readStdin({ timeoutMs, maxBytes }: { timeoutMs: number; maxBytes: number }): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  // Raced against the clock rather than checked inside the loop. A pipe that
  // sends nothing and then holds open never yields another chunk, so a check
  // inside the loop never runs: measured, the first version of this still hung
  // past its own deadline and had to be killed at 40 seconds.
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
    const t = setTimeout(() => reject(new Error(
      `stdin was still open after ${(timeoutMs / 1000).toFixed(0)}s, so there is nothing to render. ` +
      `the pipe is either trickling or not closing. raise --timeout if the document really is that slow.`,
    )), timeoutMs);
    // Do not hold the event loop open for a timer nobody is waiting on.
    t.unref?.();
    pump.then(() => clearTimeout(t), () => clearTimeout(t));
  });

  await Promise.race([pump, guard]);
  let out = "";
  for (const c of chunks) out += new TextDecoder().decode(c, { stream: true });
  return out;
}

function report(finding: Finding): string {
  return finding.severity === "error" ? `error: ${finding.message}` : `warn:  ${finding.message}`;
}

/**
 * SIGKILL every chromium process carrying this run's profile path.
 *
 * Matching on the profile rather than signalling a process group: under
 * Bun.spawn the child shares the caller's group, so kill(-pid) signals the
 * user's whole shell. Measured doing exactly that.
 */
function killBrowserByProfile(profile: string): void {
  if (process.platform.toUpperCase() !== "LINUX") return;
  try {
    const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(profile)) continue;
        process.kill(pid, "SIGKILL");
      } catch { /* it exited while we looked */ }
    }
  } catch { /* /proc absent: orphans exit on their own within about 20s */ }
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
  const profile = await mkdtemp(join(tmpdir(), "letterpress-cli-"));
  let browser: Browser | undefined;

  // Ctrl-C must actually cancel. Measured before this existed: SIGINT was
  // swallowed, the render ran on for another 296 seconds past the deadline the
  // user had already given up on, then reported a timeout that had not happened
  // and exited 1. Someone watching a five minute render had no way out of it.
  //
  // The handler exits immediately rather than awaiting teardown, because the
  // teardown is what hangs. Chromium's zygote and crashpad children outlive
  // Browser.close and get reparented to init, so a plain exit leaves them
  // running: measured 3 to 7 orphan processes that lingered about twenty
  // seconds. Sending SIGKILL to the browser and its children by profile path
  // reaps them without waiting for anything to answer.
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    if (browser) void browser.close().catch(() => {});
    killBrowserByProfile(profile);
    // Removing the profile here rather than leaving it to the finally block,
    // which process.exit below never reaches. Measured: one leaked
    // /tmp/letterpress-cli-XXXXXX profile of seventeen files per interrupted run.
    // rm is a bounded unlink of one known directory, so it does not reintroduce
    // the hang the immediate exit exists to avoid.
    // render() owns its work directory and removes it in a finally, which this
    // exit also skips. The name is letterpress-<pid>-<n>, so sweeping by our own pid
    // is exact: another process's directories carry its pid, and the browser
    // profile has a different prefix entirely.
    try {
      const own = `letterpress-${process.pid}-`;
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(own)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
      rmSync(profile, { recursive: true, force: true });
    } catch { /* a leftover directory is better than a stuck process */ }
    // 130 for SIGINT and 128+n otherwise, which is what a shell expects.
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
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
      const tplPath = join(import.meta.dir, "..", "templates", `${opts.template}.html`);
      if (!(await Bun.file(tplPath).exists())) {
        throw new Error(`no bundled template named "${opts.template}". try --list-templates`);
      }
      request = { html: fillTemplate(await Bun.file(tplPath).text(), buildTemplateData(data)) };
    } else if (opts.input === "-") {
      request = { html: await readStdin({ timeoutMs: opts.timeoutMs ?? 30_000, maxBytes: 64 * 1024 * 1024 }) };
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
    });

    await Bun.write(outPath, result.pdf);
    const bytes = result.pdf.byteLength;

    // Warnings are diagnostics, not part of the human summary, so --quiet
    // silences the summary line only. Swallowing these leaves a pipeline
    // holding a PDF full of broken images with nothing said about it.
    for (const f of result.findings) process.stderr.write(`${report(f)}\n`);

    // An error-severity finding is the tool saying the render did not do what
    // was asked: --landscape silently produced a portrait page, or a remote URL
    // was rendered with its own subresources blocked. It used to exit 0 while
    // printing "error:" and reporting ok: true, so a script grepping stderr or
    // reading .ok saw success on a request the tool had just called a failure.
    //
    // Computed here and applied after the json is written. Returning early
    // instead left --json callers with empty stdout, which does not parse.
    const contradicted = result.findings.some((f) => f.severity === "error");

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        // false when a finding is an error: the pdf exists, but it is not the
        // document that was asked for, and saying ok next to a non-zero exit
        // would leave the caller to guess which one to believe.
        ok: !contradicted, path: outPath, pages: result.info.pages, bytes,
        ms: result.ms, source: result.source,
        mediaBoxes: result.info.mediaBoxes, imageObjects: result.info.imageObjects,
        tagged: result.info.tagged, blocked: result.blocked,
        findings: result.findings,
      }, null, 2)}\n`);
    } else if (!opts.quiet) {
      const shape = result.info.mediaBoxes[0] ?? "unknown";
      process.stdout.write(`${outPath}  ${result.info.pages} page${result.info.pages === 1 ? "" : "s"}  ${formatBytes(bytes)}  ${result.ms}ms  ${shape}\n`);
    }

    if (contradicted) {
      process.stderr.write(
        "the pdf was written, but a finding above is an error: it is not the document you asked for.\n",
      );
      return 1;
    }
    return result.findings.some((f) => f.code === "url-render-blocked") ? 1 : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`render failed: ${message}\n`);
    return 1;
  } finally {
    // Unregistered because main() is also called in-process, by tests and by
    // anything embedding this. Leaving three handlers behind per call fills the
    // listener list, and each stale one still closes a profile from a run that
    // finished long ago.
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
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

  // Computed totals always win over whatever the file claims. A supplied
  // subtotal is checked against the rows rather than trusted, because printing
  // a wrong figure on an invoice is the one failure this tool must not have.
  const hasItems = Array.isArray(data.items) || Array.isArray(data.lines);
  // Hand-written row markup with no line items bypasses the totals check
  // entirely, so the invoice prints whatever subtotal the file claims. Measured:
  // rows totalling 592.80 alongside "subtotal": "1" rendered "GBP 1" and exited 0.
  // There is one supported way to fill an invoice, so say which.
  if (!hasItems && data.rows !== undefined) {
    throw new TemplateError([
      "rows is pre-built table markup and cannot be checked against a total. " +
      "give items instead: an array of {description, qty, unit}, and the rows, " +
      "subtotal, vat and total are all computed from them.",
    ]);
  }
  if (hasItems) {
    const raw = (data.items ?? data.lines) as unknown;
    if (!Array.isArray(raw)) throw new TemplateError(["items must be an array"]);
    const items = raw as Array<Record<string, unknown>>;

    // The vat rate drives the total, so a rate that is not a number cannot be
    // rounded away. It used to become NaN, every comparison against it was
    // false, and the invoice printed whatever subtotal it was handed.
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
      // A price that silently reads as zero is a wrong invoice, not a cheap one.
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
        throw new TemplateError([
          `items[${at}] has a qty or unit that is not a number: ` +
          `${JSON.stringify({ qty: i.qty ?? i.quantity, unit: i.unit ?? i.price })}`,
        ]);
      }
      return { description: String(i.description ?? i.item ?? ""), qty, unit };
    });

    if (!lineItems.length) {
      // An empty table with a total underneath reads as a real invoice, and exit
      // code 0 says it worked.
      throw new TemplateError([
        "items is empty, so the invoice would print a header and a total with no " +
        "line items between them. pass at least one item, or check the data file.",
      ]);
    }

    const totals = invoiceTotals(lineItems, { vatRate, currency: String(data.currency ?? "EUR") });
    Object.assign(out, totals);
    for (const [key, computed] of [
      ["subtotal", totals.subtotalValue],
      ["vat", totals.vatValue],
      ["total", totals.totalValue],
    ] as const) {
      const claimed = data[key];
      if (claimed === undefined || claimed === null || claimed === "") continue;
      // Compare numbers. A supplied figure may carry separators, so parse
      // leniently, and treat an unparseable one as a mismatch rather than
      // letting it through.
      // Strip separators and currency marks first, so "1,409.60" and "GBP 1409.60"
      // are read as figures. If nothing numeric survives, say so: "abc" stripped
      // to "" and Number("") is 0, which reported "abc, but the line items add up
      // to 1,409.60" rather than "abc is not a number".
      const digits = typeof claimed === "number" ? String(claimed) : String(claimed).replace(/[^\d.\-]/g, "");
      const parsed = typeof claimed === "number" ? claimed : Number(digits);
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
  // A value used in a CSS string needs CSS escaping, not HTML escaping.
  for (const k of ["company", "invoice_no", "company_secondary", "note", "currency"]) {
    if (typeof data[k] === "string") out[`${k}_text`] = escapeCss(data[k] as string);
  }
  if (Array.isArray(data.bill_to_lines)) out.bill_to_lines = lines(data.bill_to_lines.map(String));
  if (Array.isArray(data.company_lines)) out.company_lines = lines(data.company_lines.map(String));
  return out;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}