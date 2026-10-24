"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flagsUsed = flagsUsed;
exports.flagNames = flagNames;
exports.parseArgs = parseArgs;
exports.tokenize = tokenize;
const render_ts_1 = require("./render.ts");
const report_ts_1 = require("./report.ts");
function wholeNumber(v) {
    if (!/^\d+$/.test(v))
        return undefined;
    return Number(v);
}
function fail(m) {
    throw new report_ts_1.UsageError(m);
}
function valueAfter(argv, i, flag) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-'))
        fail(`option ${flag} needs a value`);
    return v;
}
const consumedValue = () => ({ kind: 'next', consumed: 2 });
const consumedFlag = () => ({ kind: 'next', consumed: 1 });
function setHelp(opts) {
    opts.help = true;
    return consumedFlag();
}
function setOut(opts, argv, i, a) {
    opts.out = valueAfter(argv, i, a);
    return consumedValue();
}
function setTemplate(opts, argv, i, a) {
    opts.template = valueAfter(argv, i, a);
    return consumedValue();
}
function setListTemplates(opts) {
    opts.listTemplates = true;
    return consumedFlag();
}
function setData(opts, argv, i, a) {
    opts.data = valueAfter(argv, i, a);
    return consumedValue();
}
function setFormat(opts, argv, i, a) {
    const v = valueAfter(argv, i, a).trim().toLowerCase();
    if (!(v in render_ts_1.FORMATS)) {
        return {
            kind: 'error',
            error: `unknown format "${v}". try: ${Object.keys(render_ts_1.FORMATS).join(', ')}`,
        };
    }
    opts.format = v;
    return consumedValue();
}
function setLandscape(opts) {
    opts.landscape = true;
    return consumedFlag();
}
function setMargin(opts, argv, i) {
    const v = argv[i + 1];
    const looksLikeFlag = v !== undefined && v.startsWith('-') && !/^-[.\d]/.test(v);
    if (v === undefined || looksLikeFlag) {
        return { kind: 'error', error: 'option --margin needs a value' };
    }
    opts.margin = v;
    return consumedValue();
}
function setNetwork(opts) {
    opts.allowNetwork = true;
    return consumedFlag();
}
function setRoot(opts, argv, i, a) {
    opts.root = valueAfter(argv, i, a);
    return consumedValue();
}
function setAuth(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    if (!v.includes(':')) {
        return { kind: 'error', error: '--auth takes user:password' };
    }
    opts.auth = v;
    return consumedValue();
}
function setNoBackground(opts) {
    opts.background = false;
    return consumedFlag();
}
function setNoScript(opts) {
    opts.noScript = true;
    return consumedFlag();
}
function setSettle(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    const n = wholeNumber(v);
    if (n === undefined) {
        return {
            kind: 'error',
            error: `--settle needs a whole number of milliseconds, got "${v}"`,
        };
    }
    opts.settleMs = n;
    return consumedValue();
}
function setMaxImagePpi(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    if (!/^\d+$/.test(v)) {
        return { kind: 'error', error: `--max-image-ppi needs a whole number, got "${v}"` };
    }
    opts.maxImagePpi = Number(v);
    return consumedValue();
}
function setRenderTimeout(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    const n = wholeNumber(v);
    if (n === undefined || n < 1000) {
        return { kind: 'error', error: `--timeout needs at least 1000ms, got "${v}"` };
    }
    opts.timeoutMs = n;
    return consumedValue();
}
function setAuthor(opts, argv, i, a) {
    opts.author = valueAfter(argv, i, a);
    if (!opts.author.trim())
        return { kind: 'error', error: '--author needs a name' };
    return consumedValue();
}
function setSubject(opts, argv, i, a) {
    opts.subject = valueAfter(argv, i, a);
    if (!opts.subject.trim())
        return { kind: 'error', error: '--subject needs text' };
    return consumedValue();
}
function setKeywords(opts, argv, i, a) {
    opts.keywords = valueAfter(argv, i, a);
    if (!opts.keywords.trim())
        return { kind: 'error', error: '--keywords needs text' };
    return consumedValue();
}
function setBeforePrint(opts, argv, i, a) {
    opts.beforePrint = valueAfter(argv, i, a);
    if (!opts.beforePrint.trim())
        return { kind: 'error', error: '--before-print needs an expression' };
    return consumedValue();
}
function setPageRanges(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    const problem = (0, render_ts_1.pageRangesProblem)(v);
    if (problem !== null) {
        return {
            kind: 'error',
            error: `--page-ranges takes page numbers and ranges separated by commas, like "1-3" or ` +
                `"1,4-6"; ${problem}`,
        };
    }
    opts.pageRanges = v
        .split(',')
        .map((p) => p.trim())
        .join(',');
    return consumedValue();
}
function setProbe(opts, argv, i, a) {
    const v = valueAfter(argv, i, a);
    const known = PROBES;
    if (!known.includes(v)) {
        return {
            kind: 'error',
            error: `--probe takes one of ${known.join(', ')}, got "${v}"`,
        };
    }
    opts.probe = v;
    return consumedValue();
}
const PROBES = ['gaps', 'fonts'];
function setJson(opts) {
    opts.json = true;
    return consumedFlag();
}
function setQuiet(opts) {
    opts.quiet = true;
    return consumedFlag();
}
const HANDLERS = new Map([
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
    ['--auth', setAuth],
    ['--no-background', setNoBackground],
    ['--no-script', setNoScript],
    ['--settle', setSettle],
    ['--max-image-ppi', setMaxImagePpi],
    ['--timeout', setRenderTimeout],
    ['--author', setAuthor],
    ['--subject', setSubject],
    ['--keywords', setKeywords],
    ['--before-print', setBeforePrint],
    ['--page-ranges', setPageRanges],
    ['--probe', setProbe],
    ['--json', setJson],
    ['-q', setQuiet],
    ['--quiet', setQuiet],
]);
function expandEquals(argv) {
    const out = [];
    for (const a of argv) {
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 2 && HANDLERS.has(a.slice(0, eq))) {
                out.push(a.slice(0, eq), a.slice(eq + 1));
                continue;
            }
        }
        out.push(a);
    }
    return out;
}
function flagsUsed(argv) {
    const used = [];
    for (const a of expandEquals(argv)) {
        if (HANDLERS.has(a))
            used.push(a);
    }
    return used;
}
function flagNames() {
    return [...HANDLERS.keys()].filter((k) => k.startsWith('--'));
}
function applyFlag(opts, argv, i, a) {
    const handler = HANDLERS.get(a);
    if (handler)
        return handler(opts, argv, i, a);
    if (a.startsWith('-') && a !== '-')
        return { kind: 'error', error: `unknown option "${a}"` };
    return { kind: 'rest', value: a, consumed: 1 };
}
function resolveInput(opts, rest) {
    if (!rest.length) {
        if (opts.template)
            return undefined;
        return 'no input. pass a file, - for stdin, a URL, or --template with --data';
    }
    if (opts.template)
        return 'pass either an input file or --template with --data, not both';
    opts.input = rest[0] ?? '';
    if (/^https?:\/\//i.test(opts.input))
        opts.allowNetwork = true;
    return undefined;
}
function finish(opts, rest) {
    if (opts.help || opts.listTemplates)
        return { opts };
    if (rest.length > 1) {
        return { opts, error: `expected one input, got ${rest.length}: ${rest.join(', ')}` };
    }
    if (opts.data && !opts.template)
        return { opts, error: '--data needs --template' };
    if (opts.template && !opts.data)
        return { opts, error: '--template needs --data' };
    const inputError = resolveInput(opts, rest);
    if (inputError)
        return { opts, error: inputError };
    if (opts.margin && !opts.format) {
        return {
            opts,
            error: "--margin only applies with --format, because the document's own @page wins otherwise",
        };
    }
    return { opts };
}
function parseArgs(argv) {
    const { opts, rest, error } = tokenize(argv);
    if (error)
        return { opts, error };
    return finish(opts, rest);
}
function tokenize(argv) {
    argv = expandEquals(argv);
    const flags = [];
    const opts = {
        landscape: false,
        allowNetwork: false,
        background: true,
        noScript: false,
        settleMs: 0,
        timeoutMs: 30_000,
        maxImagePpi: 300,
        json: false,
        quiet: false,
    };
    const rest = [];
    for (let i = 0; i < argv.length;) {
        const a = argv[i] ?? '';
        if (HANDLERS.has(a))
            flags.push(a);
        const step = applyFlag(opts, argv, i, a);
        if (step.kind === 'error')
            return { opts, rest, flags, error: step.error };
        if (step.kind === 'rest')
            rest.push(step.value);
        i += step.consumed;
    }
    return { opts, rest, flags };
}
//# sourceMappingURL=args.js.map