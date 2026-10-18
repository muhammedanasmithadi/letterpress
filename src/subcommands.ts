/**
 * Subcommands that do not render.
 *
 * `letterpress` renders, and that is the thing it is for. These two are about
 * a file that already exists: `validate` checks it, `page` explains what the
 * tool made of its `@page` rules before it ever printed anything. Both run
 * without a browser, which is the whole reason they are separate commands rather
 * than flags on the render path.
 */
import { readFile } from 'node:fs/promises';

import { tokenize } from './args.ts';
import { formatBytes } from './cli.ts';
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

export async function runValidate(argv: string[]): Promise<number> {
  const { opts, rest, error } = tokenize(argv);
  if (error) return fail(error);
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
  if (rest.length !== 1) return fail('page takes exactly one file: letterpress page <file.html>');
  const path = rest[0]!;
  let html: string;
  try {
    html = await readFile(path, 'utf8');
  } catch (e) {
    return fail(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }

  const rules = pageRules(html);
  const size = declaredPageSize(html);
  const margin = declaredPageMargin(html);
  const orientation = declaredPageOrientation(html);

  const analysis: Record<string, unknown> = {
    path,
    declared: { size, margin, orientation, rules },
    landscape: landscapeOutcome(size, orientation),
    format: opts.format ? injectPageRule(html, `size: ${opts.format}`) : null,
    marginOverride: opts.margin ? injectPageRule(html, `margin: ${opts.margin}`) : null,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    return 0;
  }

  if (!opts.quiet) {
    process.stdout.write(`${path}\n`);
    process.stdout.write(`  declared size         ${size ?? '(none)'}\n`);
    process.stdout.write(`  declared margin       ${margin ?? '(none)'}\n`);
    process.stdout.write(`  declared orientation  ${orientation ?? '(none)'}\n`);
    process.stdout.write(`  @page rules           ${rules.length}\n`);
    for (const r of rules) process.stdout.write(`    ${r}\n`);
    process.stdout.write(`  with --landscape      ${landscapeOutcome(size, orientation)}\n`);
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
            : `applied only alongside --format, which is where the paper is set`),
      );
    }
  }
  return 0;
}

/**
 * What `--landscape` does to this document, in one line.
 *
 * Four cases, and the first two are the ones a single boolean gets wrong.
 * `transposePageSize` returns null for both a document that declares no paper
 * and one that declares `size: auto`, and they are opposites: with no
 * declaration the flag goes straight to the print engine and works, while
 * `size: auto` is refused with an error finding and the sheet stays portrait.
 * Reporting the second reason for the first is how a correct flag gets called
 * broken.
 */
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
