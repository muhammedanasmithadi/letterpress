#!/usr/bin/env bun
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = exports.flagNames = void 0;
exports.main = main;
exports.listTemplates = listTemplates;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("./browser.ts");
const args_ts_1 = require("./args.ts");
const report_ts_1 = require("./report.ts");
const pageside_ts_1 = require("./pageside.ts");
var args_ts_2 = require("./args.ts");
Object.defineProperty(exports, "flagNames", { enumerable: true, get: function () { return args_ts_2.flagNames; } });
Object.defineProperty(exports, "parseArgs", { enumerable: true, get: function () { return args_ts_2.parseArgs; } });
const render_ts_1 = require("./render.ts");
const template_ts_1 = require("./template.ts");
const USAGE = `letterpress - render HTML to PDF through Chromium's own print engine

usage
  letterpress [options] <file.html>
  cat page.html | letterpress [options] -
  letterpress [options] --template invoice --data order.json
  letterpress [options] https://example.com   (implies --allow-network)

  letterpress validate <file.pdf>              check a pdf that already exists
  letterpress page <file.html>                 explain the document’s @page rules
  letterpress mcp                              serve the model context protocol on
                                                stdin and stdout, for an agent that
                                                speaks it

options
  -o, --out <path>        output PDF (default: input name with .pdf)
  -t, --template <name>   fill a bundled template, e.g. invoice
      --list-templates    print the bundled template names and exit
  -d, --data <path>       JSON data file for --template
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
function defaultOut(input) {
    if (input === '-')
        return 'out.pdf';
    try {
        const u = new URL(input);
        const name = u.pathname.split('/').filter(Boolean).pop() ?? 'index';
        return `${name.replace(/\.html?$/i, '') || 'index'}.pdf`;
    }
    catch {
        const base = input.split('/').filter(Boolean).pop() ?? 'out';
        return (base.replace(/\.html?$/i, '') || 'out') + '.pdf';
    }
}
async function readStdin({ timeoutMs, maxBytes, }) {
    const chunks = [];
    let total = 0;
    const pump = (async () => {
        const reader = Bun.stdin.stream().getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = value;
            total += chunk.byteLength;
            if (total > maxBytes) {
                throw new Error(`stdin is over the ${(maxBytes / 1048576).toFixed(0)}MB limit at ${(total / 1048576).toFixed(1)}MB. ` +
                    `write the document to a file and pass the path.`);
            }
            chunks.push(chunk);
        }
        return chunks;
    })();
    const guard = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`stdin was still open after ${(timeoutMs / 1000).toFixed(0)}s, so there is nothing to render. ` +
            `the pipe is either trickling or not closing. raise --timeout if the document really is that slow.`)), timeoutMs);
        t.unref?.();
        pump.then(() => clearTimeout(t), () => clearTimeout(t));
    });
    await Promise.race([pump, guard]);
    const decoder = new TextDecoder();
    let out = '';
    for (const c of chunks)
        out += decoder.decode(c, { stream: true });
    return out + decoder.decode();
}
function report(finding) {
    return finding.severity === 'error' ? `error: ${finding.message}` : `warn:  ${finding.message}`;
}
function killBrowserByProfile(profile) {
    if (process.platform.toUpperCase() !== 'LINUX')
        return;
    try {
        for (const entry of (0, node_fs_1.readdirSync)('/proc')) {
            if (!/^\d+$/.test(entry))
                continue;
            const pid = Number(entry);
            if (pid === process.pid)
                continue;
            try {
                if (!(0, node_fs_1.readFileSync)(`/proc/${pid}/cmdline`, 'utf8').includes(profile))
                    continue;
                process.kill(pid, 'SIGKILL');
            }
            catch { }
        }
    }
    catch { }
}
function parseAuth(raw) {
    if (raw === undefined || raw.trim() === '')
        return undefined;
    const i = raw.indexOf(':');
    if (i < 0)
        throw new report_ts_1.UsageError('--auth takes user:password');
    return { username: raw.slice(0, i), password: raw.slice(i + 1) };
}
function probeFor(name) {
    if (name === 'gaps')
        return pageside_ts_1.wideGaps;
    if (name === 'fonts')
        return pageside_ts_1.fontProbe;
    return undefined;
}
async function requestFor(opts) {
    if (opts.template && opts.data) {
        return { html: await fillBundledTemplate(opts.template, opts.data) };
    }
    if (opts.input === '-') {
        return {
            html: await readStdin({
                timeoutMs: opts.timeoutMs,
                maxBytes: 64 * 1024 * 1024,
            }),
        };
    }
    if (/^https?:\/\//i.test(opts.input))
        return { url: opts.input };
    return { path: opts.input };
}
async function fillBundledTemplate(template, dataPath) {
    const raw = await Bun.file(dataPath).text();
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`${dataPath} is not valid JSON: ${e.message}`);
    }
    const tplPath = (0, node_path_1.join)(import.meta.dir, '..', 'templates', `${template}.html`);
    if (!(await Bun.file(tplPath).exists())) {
        throw new Error(`no bundled template named "${template}". try --list-templates`);
    }
    return (0, template_ts_1.render)(await Bun.file(tplPath).text(), buildTemplateData(data));
}
function sweepAndExit(signal, profile, current) {
    const browser = current();
    if (browser)
        void browser.close().catch(() => { });
    killBrowserByProfile(profile);
    try {
        const mine = [`letterpress-${process.pid}-`, 'letterpress-cli-'];
        for (const entry of (0, node_fs_1.readdirSync)((0, node_os_1.tmpdir)())) {
            if (mine.some((p) => entry.startsWith(p)))
                (0, node_fs_1.rmSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), entry), { recursive: true, force: true });
        }
        (0, node_fs_1.rmSync)(profile, { recursive: true, force: true });
    }
    catch { }
    process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
}
async function writeAtomic(outPath, pdf) {
    const partial = `${outPath}.${process.pid}.part`;
    try {
        await Bun.write(partial, pdf);
        await (0, promises_1.rename)(partial, outPath);
    }
    catch (e) {
        await (0, promises_1.rm)(partial, { force: true }).catch(() => { });
        throw e;
    }
}
function reportOutcome(opts, result, outPath) {
    for (const f of result.findings)
        process.stderr.write(`${report(f)}\n`);
    const contradicted = result.findings.some((f) => f.severity === 'error');
    const bytes = result.pdf.byteLength;
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({
            ok: !contradicted,
            path: outPath,
            ms: result.ms,
            source: result.source,
            blocked: result.blocked,
            ...result.info,
            probe: result.probe,
            findings: result.findings,
        }, null, 2)}\n`);
    }
    else if (!opts.quiet) {
        const shape = result.info.mediaBoxes[0] ?? 'unknown';
        process.stdout.write(`${outPath}  ${result.info.pages} page${result.info.pages === 1 ? '' : 's'}  ${(0, report_ts_1.formatBytes)(bytes)}  ${result.ms}ms  ${shape}\n`);
    }
    if (contradicted) {
        process.stderr.write('the pdf was written, but a finding above is an error: it is not the document you asked for.\n');
        return 1;
    }
    return 0;
}
async function subcommand(argv) {
    const name = argv[0];
    if (name === 'mcp') {
        const { runMcp } = await Promise.resolve().then(() => __importStar(require('./mcp.ts')));
        return runMcp();
    }
    if (name !== 'validate' && name !== 'page')
        return null;
    const { runValidate, runPage } = await Promise.resolve().then(() => __importStar(require('./subcommands.ts')));
    return (name === 'validate' ? runValidate : runPage)(argv.slice(1));
}
async function main(argv) {
    const sub = await subcommand(argv);
    if (sub !== null)
        return sub;
    let parsed;
    try {
        parsed = (0, args_ts_1.parseArgs)(argv);
    }
    catch (e) {
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
    let auth;
    try {
        auth = parseAuth(opts.auth ?? process.env.LETTERPRESS_AUTH);
    }
    catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
        return 2;
    }
    const outPath = opts.out ?? (opts.template ? `${opts.template}.pdf` : defaultOut(opts.input));
    const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-cli-'));
    let browser;
    const onSignal = (signal) => sweepAndExit(signal, profile, () => browser);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    try {
        const request = await requestFor(opts);
        browser = await browser_ts_1.Browser.launch({ profile });
        const result = await (0, render_ts_1.render)(browser, {
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
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (opts.json)
            process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
        else
            process.stderr.write(`render failed: ${message}\n`);
        return 1;
    }
    finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    }
}
async function listTemplates() {
    const dir = (0, node_path_1.join)(import.meta.dir, '..', 'templates');
    const names = [];
    for await (const entry of new Bun.Glob('*.html').scan({ cwd: dir }))
        names.push(entry.replace(/\.html$/, ''));
    return names.sort();
}
function vatRateOf(data) {
    const rateInput = data.vat_rate ?? data.vatRate ?? 0.2;
    const vatRate = Number(rateInput);
    if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) {
        throw new template_ts_1.TemplateError([
            `vat_rate must be a number between 0 and 1, got ${JSON.stringify(rateInput)}. ` +
                `use 0.2 for twenty percent.`,
        ]);
    }
    return vatRate;
}
function lineItemsOf(items) {
    const lineItems = items.map((i, at) => {
        const qty = Number(i.qty ?? i.quantity ?? 1);
        const unit = Number(i.unit ?? i.price ?? 0);
        if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
            throw new template_ts_1.TemplateError([
                `items[${at}] has a qty or unit that is not a number: ` +
                    `${JSON.stringify({ qty: i.qty ?? i.quantity, unit: i.unit ?? i.price })}`,
            ]);
        }
        return { description: String(i.description ?? i.item ?? ''), qty, unit };
    });
    if (!lineItems.length) {
        throw new template_ts_1.TemplateError([
            'items is empty, so the invoice would print a header and a total with no ' +
                'line items between them. pass at least one item, or check the data file.',
        ]);
    }
    return lineItems;
}
function reconcileTotals(data, totals) {
    for (const [key, computed] of [
        ['subtotal', totals.subtotalValue],
        ['vat', totals.vatValue],
        ['total', totals.totalValue],
    ]) {
        const claimed = data[key];
        if (claimed === undefined || claimed === null || claimed === '')
            continue;
        const digits = typeof claimed === 'number' ? String(claimed) : String(claimed).replace(/[^\d.-]/g, '');
        const parsed = typeof claimed === 'number' ? claimed : Number(digits);
        if (!digits.trim() || !Number.isFinite(parsed)) {
            throw new template_ts_1.TemplateError([
                `${key} in the data file is ${JSON.stringify(claimed)}, which is not a number. ` +
                    `remove ${key} to let it be computed from the line items.`,
            ]);
        }
        if (Math.abs(parsed - computed) > 0.005) {
            throw new template_ts_1.TemplateError([
                `${key} in the data file is ${claimed}, but the line items add up to ${(0, template_ts_1.money)(computed)}. ` +
                    `the computed figure is printed, because printing the supplied one would send a wrong total. ` +
                    `remove ${key} from the data file to let it always be computed.`,
            ]);
        }
    }
}
function copyTextFields(data, out) {
    for (const k of ['company', 'invoice_no', 'company_secondary', 'note', 'currency']) {
        if (typeof data[k] === 'string')
            out[`${k}_text`] = (0, template_ts_1.escapeCss)(data[k]);
    }
    if (Array.isArray(data.bill_to_lines))
        out.bill_to_lines = (0, template_ts_1.lines)(data.bill_to_lines.map(String));
    if (Array.isArray(data.company_lines))
        out.company_lines = (0, template_ts_1.lines)(data.company_lines.map(String));
}
function buildTemplateData(data) {
    const out = {};
    for (const [k, v] of Object.entries(data))
        out[k] = v;
    const hasItems = Array.isArray(data.items) || Array.isArray(data.lines);
    if (!hasItems && data.rows !== undefined) {
        throw new template_ts_1.TemplateError([
            'rows is pre-built table markup and cannot be checked against a total. ' +
                'give items instead: an array of {description, qty, unit}, and the rows, ' +
                'subtotal, vat and total are all computed from them.',
        ]);
    }
    if (hasItems) {
        const raw = (data.items ?? data.lines);
        if (!Array.isArray(raw))
            throw new template_ts_1.TemplateError(['items must be an array']);
        const items = raw;
        const vatRate = vatRateOf(data);
        const totals = (0, template_ts_1.invoiceTotals)(lineItemsOf(items), {
            vatRate,
            currency: String(data.currency ?? 'EUR'),
        });
        Object.assign(out, totals);
        reconcileTotals(data, totals);
    }
    copyTextFields(data, out);
    return out;
}
if (import.meta.main) {
    process.exit(await main(Bun.argv.slice(2)));
}
//# sourceMappingURL=cli.js.map