"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runValidate = runValidate;
exports.runPage = runPage;
exports.pageAnalysis = pageAnalysis;
const promises_1 = require("node:fs/promises");
const args_ts_1 = require("./args.ts");
const report_ts_1 = require("./report.ts");
const validate_ts_1 = require("./validate.ts");
const pdf_ts_1 = require("./pdf.ts");
function fail(msg, code = 2) {
    process.stderr.write(`${msg}\n`);
    return code;
}
const VALIDATE_FLAGS = new Set(['--json', '--quiet', '-q']);
const PAGE_FLAGS = new Set(['--format', '--margin', '--json', '--quiet', '-q']);
function refusedFlags(argv, allowed, name) {
    for (const flag of (0, args_ts_1.flagsUsed)(argv)) {
        if (!allowed.has(flag))
            return `${name} does not take ${flag}`;
    }
    return null;
}
async function runValidate(argv) {
    const { opts, rest, error } = (0, args_ts_1.tokenize)(argv);
    if (error)
        return fail(error);
    if (opts.help) {
        process.stdout.write('letterpress validate <file.pdf>\n');
        return 0;
    }
    const refused = refusedFlags(argv, VALIDATE_FLAGS, 'validate');
    if (refused !== null)
        return fail(refused);
    if (rest.length !== 1)
        return fail('validate takes exactly one file: letterpress validate <file.pdf>');
    const path = rest[0];
    let bytes;
    try {
        bytes = new Uint8Array(await (0, promises_1.readFile)(path));
    }
    catch (e) {
        return fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
    }
    const result = (0, validate_ts_1.validate)(bytes);
    const size = bytes.byteLength;
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: result.ok, path, bytes: size, findings: result.findings }, null, 2)}\n`);
    }
    else {
        for (const f of result.findings)
            process.stderr.write(`${reportFinding(f)}\n`);
        if (!opts.quiet) {
            process.stdout.write(`${path}  ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}  ` +
                `${result.ok ? 'ok' : 'not ok'}  ${(0, report_ts_1.formatBytes)(size)}\n`);
        }
    }
    return result.ok ? 0 : 1;
}
async function runPage(argv) {
    const { opts, rest, error } = (0, args_ts_1.tokenize)(argv);
    if (error)
        return fail(error);
    if (opts.help) {
        process.stdout.write('letterpress page <file.html> [--format <name>] [--margin <length>]\n');
        return 0;
    }
    const refused = refusedFlags(argv, PAGE_FLAGS, 'page');
    if (refused !== null)
        return fail(refused);
    if (rest.length !== 1)
        return fail('page takes exactly one file: letterpress page <file.html>');
    const path = rest[0];
    let html;
    try {
        html = await (0, promises_1.readFile)(path, 'utf8');
    }
    catch (e) {
        return fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
    }
    const analysis = pageAnalysis(html, path, opts.format, opts.margin);
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
        return 0;
    }
    if (!opts.quiet) {
        const { size, margin, orientation, rules } = analysis.declared;
        process.stdout.write(`${path}\n`);
        process.stdout.write(`  declared size         ${size ?? '(none)'}\n`);
        process.stdout.write(`  declared margin       ${margin ?? '(none)'}\n`);
        process.stdout.write(`  declared orientation  ${orientation ?? '(none)'}\n`);
        process.stdout.write(`  @page rules           ${rules.length}\n`);
        for (const r of rules)
            process.stdout.write(`    ${r}\n`);
        process.stdout.write(`  with --landscape      ${analysis.landscape}\n`);
        if (opts.format) {
            process.stdout.write(`  with --format ${opts.format}    the document's @page size is stripped and the request applied ` +
                `(page-size-override), and with --landscape the paper is transposed rather than the declaration\n`);
        }
        if (opts.margin) {
            process.stdout.write(`  with --margin ${opts.margin}   ` +
                (margin
                    ? `a document's own @page margin wins, so this is dropped (margin-ignored)`
                    : `applied only alongside --format, which is where the paper is set`) +
                `\n`);
        }
    }
    return 0;
}
function pageAnalysis(html, path, format, margin) {
    const rules = (0, pdf_ts_1.pageRules)(html);
    const size = (0, pdf_ts_1.declaredPageSize)(html);
    const declaredMargin = (0, pdf_ts_1.declaredPageMargin)(html);
    const orientation = (0, pdf_ts_1.declaredPageOrientation)(html);
    return {
        path,
        declared: { size, margin: declaredMargin, orientation, rules },
        landscape: landscapeOutcome(size, orientation),
        format: format ? (0, pdf_ts_1.injectPageRule)(html, `size: ${format}`) : null,
        marginOverride: margin ? (0, pdf_ts_1.injectPageRule)(html, `margin: ${margin}`) : null,
    };
}
function landscapeOutcome(size, orientation) {
    if (!size) {
        return 'passed straight to chromium: the document declares no paper, so there is nothing to transpose';
    }
    if (orientation === 'landscape')
        return 'already landscape: the declaration asks for it, so the flag changes nothing';
    if (size === 'auto') {
        return 'refused: the declaration names no paper to transpose (size: auto), so the pdf stays portrait (orientation-ignored)';
    }
    return 'transposed in place: the declaration keeps its own paper and margin, and only the orientation is turned (orientation-overridden)';
}
function reportFinding(f) {
    return `${f.severity.toUpperCase()} ${f.code}  ${f.message}`;
}
//# sourceMappingURL=subcommands.js.map