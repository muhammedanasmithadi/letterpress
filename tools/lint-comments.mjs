import * as ts from 'typescript-api';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = new URL('../waivers/baseline.comments.json', import.meta.url);

const ROOTS = ['src', 'test', 'viewer', 'tools'];
const EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:noqa\b|eslint-disable|eslint-enable|oxlint-disable(?:-next-line|-line)?|prettier-ignore|@ts-|nosemgrep|cspell:|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|go:|fmt:|isort:|#\s*(?:noqa|pragma|type:|fmt:|isort:))/;

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (EXT.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

function commentRanges(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map();
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      found.set(r.pos, [r.pos, r.end]);
    }
    for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) {
      found.set(r.pos, [r.pos, r.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found.values()].sort((a, b) => a[0] - b[0]);
}

function commentsIn(file, text) {
  let count = 0;
  for (const [start, end] of commentRanges(file, text)) {
    if (!DIRECTIVE.test(text.slice(start, end))) count++;
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

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify({ files: current, total }, null, 2) + '\n');
  console.log(`comments: ${total} across ${Object.keys(current).length} files (baseline written)`);
  process.exit(0);
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
