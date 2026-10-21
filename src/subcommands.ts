import { readFile } from 'node:fs/promises';

import { flagsUsed, tokenize } from './args.ts';
import { formatBytes } from './report.ts';
import { validate } from './validate.ts';
import {
  declaredPageSize,
  declaredPageMargin,
  declaredPageOrientation,
  pageRules,
  injectPageRule,
} from './pdf.ts';

function fail(msg: string, code = 2): number {
  process.stderr.write(`${msg}\n`);
  return code;
}

const VALIDATE_FLAGS = new Set(['--json', '--quiet', '-q']);
const PAGE_FLAGS = new Set(['--format', '--margin', '--json', '--quiet', '-q']);

function refusedFlags(argv: string[], allowed: Set<string>, name: string): string | null {
  for (const flag of flagsUsed(argv)) {
    if (!allowed.has(flag)) return `${name} does not take ${flag}`;
  }
  return null;
}

export async function runValidate(argv: string[]): Promise<number> {
  const { opts, rest, error } = tokenize(argv);
  if (error) return fail(error);
  if (opts.help) {
    process.stdout.write('letterpress validate <file.pdf>\n');
    return 0;
  }
  const refused = refusedFlags(argv, VALIDATE_FLAGS, 'validate');
  if (refused !== null) return fail(refused);
  if (rest.length !== 1)
    return fail('validate takes exactly one file: letterpress validate <file.pdf>');
  const path = rest[0]!;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    return fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }

  const result = validate(bytes);
  const size = bytes.byteLength;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, path, bytes: size, findings: result.findings }, null, 2)}\n`,
    );
  } else {
    for (const f of result.findings) process.stderr.write(`${reportFinding(f)}\n`);
    if (!opts.quiet) {
      process.stdout.write(
        `${path}  ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}  ` +
          `${result.ok ? 'ok' : 'not ok'}  ${formatBytes(size)}\n`,
      );
    }
  }
  return result.ok ? 0 : 1;
}

export async function runPage(argv: string[]): Promise<number> {
  const { opts, rest, error } = tokenize(argv);
  if (error) return fail(error);
  if (opts.help) {
    process.stdout.write('letterpress page <file.html> [--format <name>] [--margin <length>]\n');
    return 0;
  }
  const refused = refusedFlags(argv, PAGE_FLAGS, 'page');
  if (refused !== null) return fail(refused);
  if (rest.length !== 1) return fail('page takes exactly one file: letterpress page <file.html>');
  const path = rest[0]!;
  let html: string;
  try {
    html = await readFile(path, 'utf8');
  } catch (e) {
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
    for (const r of rules) process.stdout.write(`    ${r}\n`);
    process.stdout.write(`  with --landscape      ${analysis.landscape}\n`);
    if (opts.format) {
      process.stdout.write(
        `  with --format ${opts.format}    the document's @page size is stripped and the request applied ` +
          `(page-size-override), and with --landscape the paper is transposed rather than the declaration\n`,
      );
    }
    if (opts.margin) {
      process.stdout.write(
        `  with --margin ${opts.margin}   ` +
          (margin
            ? `a document's own @page margin wins, so this is dropped (margin-ignored)`
            : `applied only alongside --format, which is where the paper is set`) +
          `\n`,
      );
    }
  }
  return 0;
}

export type PageAnalysis = {
  path: string;
  declared: {
    size: string | null;
    margin: string | null;
    orientation: string | null;
    rules: string[];
  };
  landscape: string;
  format: string | null;
  marginOverride: string | null;
};

export function pageAnalysis(
  html: string,
  path: string,
  format?: string,
  margin?: string,
): PageAnalysis {
  const rules = pageRules(html);
  const size = declaredPageSize(html);
  const declaredMargin = declaredPageMargin(html);
  const orientation = declaredPageOrientation(html);
  return {
    path,
    declared: { size, margin: declaredMargin, orientation, rules },
    landscape: landscapeOutcome(size, orientation),
    format: format ? injectPageRule(html, `size: ${format}`) : null,
    marginOverride: margin ? injectPageRule(html, `margin: ${margin}`) : null,
  };
}

function landscapeOutcome(size: string | null, orientation: string | null): string {
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

function reportFinding(f: { severity: string; code: string; message: string }): string {
  return `${f.severity.toUpperCase()} ${f.code}  ${f.message}`;
}
