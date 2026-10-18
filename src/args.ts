/**
 * Command-line argument parsing, shared by the render command and the
 * subcommands that do not render.
 */
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

import { FORMATS, type Format } from './render.ts';
import { UsageError } from './cli.ts';
function wholeNumber(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v);
}

export type ParseResult = { opts: Options; error?: string };

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

/** Every long flag the parser accepts, for the help-text parity test. */
export function flagNames(): string[] {
  return [...HANDLERS.keys()].filter((k) => k.startsWith('--'));
}

/** Apply the token at `argv[i]`, or classify it as a positional argument. */
export function applyFlag(opts: Options, argv: string[], i: number, a: string): Step {
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
  const { opts, rest, error } = tokenize(argv);
  if (error) return { opts, error };
  return finish(opts, rest);
}

/**
 * The token loop on its own, without the rules about what the command as a
 * whole must look like.
 *
 * `validate` and `page` take the same flags and mean the same things by them,
 * but the rules `finish` enforces -- one input, `--data` needs `--template`,
 * `--margin` needs `--format` -- are the render's, and a check of an existing
 * pdf has no template and no html. Handing them the same tokens without the
 * same verdicts is the point; copying the loop to get it was 15 duplicated
 * lines that would have drifted the first time a flag was added.
 */
export function tokenize(argv: string[]): {
  opts: Options;
  rest: string[];
  error?: string;
} {
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
    if (step.kind === 'error') return { opts, rest, error: step.error };
    if (step.kind === 'rest') rest.push(step.value);
    i += step.consumed;
  }
  return { opts, rest };
}
