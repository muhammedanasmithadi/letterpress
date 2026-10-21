export type Options = {
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
  auth?: string;
  background: boolean;
  noScript: boolean;
  settleMs: number;
  timeoutMs: number;
  maxImagePpi: number;
  author?: string;
  subject?: string;
  keywords?: string;
  beforePrint?: string;
  pageRanges?: string;
  probe?: ProbeName;
  json: boolean;
  quiet: boolean;
  help?: boolean;
};

import { FORMATS, pageRangesProblem, type Format } from './render.ts';
import { UsageError } from './report.ts';
function wholeNumber(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v);
}

export type ParseResult = { opts: Options; error?: string };

type Step =
  | { kind: 'next'; consumed: number }
  | { kind: 'rest'; value: string; consumed: number }
  | { kind: 'error'; error: string };

type Handler = (opts: Options, argv: string[], i: number, a: string) => Step;

function fail(m: string): never {
  throw new UsageError(m);
}

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
  const v = valueAfter(argv, i, a).trim().toLowerCase();
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
  const v = argv[i + 1];
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

function setAuth(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  if (!v.includes(':')) {
    return { kind: 'error', error: '--auth takes user:password' };
  }
  opts.auth = v;
  return consumedValue();
}

function setNoBackground(opts: Options): Step {
  opts.background = false;
  return consumedFlag();
}

function setNoScript(opts: Options): Step {
  opts.noScript = true;
  return consumedFlag();
}

function setSettle(opts: Options, argv: string[], i: number, a: string): Step {
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

function setBeforePrint(opts: Options, argv: string[], i: number, a: string): Step {
  opts.beforePrint = valueAfter(argv, i, a);
  if (!opts.beforePrint.trim())
    return { kind: 'error', error: '--before-print needs an expression' };
  return consumedValue();
}

function setPageRanges(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  const problem = pageRangesProblem(v);
  if (problem !== null) {
    return {
      kind: 'error',
      error:
        `--page-ranges takes page numbers and ranges separated by commas, like "1-3" or ` +
        `"1,4-6"; ${problem}`,
    };
  }
  opts.pageRanges = v
    .split(',')
    .map((p) => p.trim())
    .join(',');
  return consumedValue();
}

function setProbe(opts: Options, argv: string[], i: number, a: string): Step {
  const v = valueAfter(argv, i, a);
  const known = PROBES as readonly string[];
  if (!known.includes(v)) {
    return {
      kind: 'error',
      error: `--probe takes one of ${known.join(', ')}, got "${v}"`,
    };
  }
  opts.probe = v as ProbeName;
  return consumedValue();
}

const PROBES = ['gaps', 'fonts'] as const;
export type ProbeName = (typeof PROBES)[number];

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

function expandEquals(argv: string[]): string[] {
  const out: string[] = [];
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

export function flagsUsed(argv: string[]): string[] {
  const used: string[] = [];
  for (const a of expandEquals(argv)) {
    if (HANDLERS.has(a)) used.push(a);
  }
  return used;
}

export function flagNames(): string[] {
  return [...HANDLERS.keys()].filter((k) => k.startsWith('--'));
}

function applyFlag(opts: Options, argv: string[], i: number, a: string): Step {
  const handler = HANDLERS.get(a);
  if (handler) return handler(opts, argv, i, a);
  if (a.startsWith('-') && a !== '-') return { kind: 'error', error: `unknown option "${a}"` };
  return { kind: 'rest', value: a, consumed: 1 };
}

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

function finish(opts: Options, rest: string[]): ParseResult {
  if (opts.help || opts.listTemplates) return { opts };
  if (rest.length > 1) {
    return { opts, error: `expected one input, got ${rest.length}: ${rest.join(', ')}` };
  }
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
  const { opts, rest, error } = tokenize(argv);
  if (error) return { opts, error };
  return finish(opts, rest);
}

export function tokenize(argv: string[]): {
  opts: Options;
  rest: string[];
  flags: string[];
  error?: string;
} {
  argv = expandEquals(argv);
  const flags: string[] = [];
  const opts: Options = {
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
  const rest: string[] = [];
  for (let i = 0; i < argv.length;) {
    const a = argv[i] ?? '';
    if (HANDLERS.has(a)) flags.push(a);
    const step = applyFlag(opts, argv, i, a);
    if (step.kind === 'error') return { opts, rest, flags, error: step.error };
    if (step.kind === 'rest') rest.push(step.value);
    i += step.consumed;
  }
  return { opts, rest, flags };
}
