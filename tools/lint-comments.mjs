/**
 * Comments in code, counted and gated.
 *
 * The rule this enforces is from the coding guidelines: code reads by reading
 * it, and a comment that explains what the code does is the same sentence
 * twice. What survives in a comment is only a machine directive -- `noqa`,
 * `pragma`, `prettier-ignore`, and the like -- because those are instructions
 * to a tool rather than prose about the code.
 *
 * Rationale that must not be lost does not go into a comment; it goes into
 * docs/. This gate only counts what is in the source today, and the count is
 * a ratchet: the number may fall but not rise, and a file that had none may
 * not acquire some. That is the same shape as the duplication and complexity
 * gates, and it is why removing a comment is a change the gate can see.
 *
 * The count comes from the TypeScript scanner rather than a regex, because a
 * `//` inside a string is not a comment: this repository ships a large block of
 * JavaScript as a string to run in the browser, and a regex would count the
 * comment markers inside it.
 */
import * as ts from 'typescript-api';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = new URL('../waivers/baseline.comments.json', import.meta.url);

const ROOTS = ['src', 'test', 'viewer', 'tools'];
const EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * A comment that is an instruction to a tool, not prose.
 *
 * Same list as the guidelines' own tree check, plus `nosemgrep` and `cspell:`,
 * which this repository uses.
 */
const DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:noqa\b|eslint-disable|eslint-enable|oxlint-disable(?:-next-line|-line)?|prettier-ignore|@ts-|nosemgrep|cspell:|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|go:|fmt:|isort:|#\s*(?:noqa|pragma|type:|fmt:|isort:))/;

/** The script kind, so a `.js` file is scanned as JavaScript. */
function kindOf(file) {
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (EXT.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

/**
 * The comments in a file that are not machine directives.
 *
 * The scanner is asked for trivia, so it emits comments and whitespace but
 * not the tokens of the program itself. Each comment is then checked for a
 * directive; one that has it does not count.
 */
function commentsIn(file, text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, kindOf(file), text);
  let count = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    if (!DIRECTIVE.test(scanner.getTokenText())) count++;
  }
  return count;
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

const current = {};
let total = 0;
for (const root of ROOTS) {
  for (const file of files(root)) {
    const n = commentsIn(file, readFileSync(file, 'utf8'));
    if (n > 0) {
      current[file] = n;
      total += n;
    }
  }
}

const problems = [];
for (const [file, n] of Object.entries(current)) {
  const was = base.files[file] ?? 0;
  if (n > was) problems.push(`${file}: ${n} comments, was ${was}`);
}
for (const [file, n] of Object.entries(base.files)) {
  if (!(file in current)) problems.push(`${file}: ${n} comments, now 0 -- lower the baseline`);
}
if (total > base.total) {
  problems.push(`total: ${total} comments, baseline ${base.total}`);
}

console.log(
  `comments: ${total} across ${Object.keys(current).length} files (baseline ${base.total})`,
);
if (problems.length > 0) {
  console.error('new comments in code:\n' + problems.join('\n'));
  console.error('move the rationale into docs/, and lower waivers/baseline.comments.json');
  process.exit(1);
}
