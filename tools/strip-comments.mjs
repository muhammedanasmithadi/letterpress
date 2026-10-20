/**
 * Remove comments from source files, once.
 *
 * A migration tool, not a gate: it rewrites the files it is pointed at. The
 * gate that keeps the count from going back up is `tools/lint-comments.mjs`.
 *
 * The comment ranges come from the parser, so a `//` inside a string or a
 * regular expression is untouched -- see `tools/comment-ranges.mjs`.
 *
 * A comment that is a machine directive stays: `noqa`, `prettier-ignore` and
 * the like are instructions to a tool.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { commentRanges } from './comment-ranges.mjs';

const DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:noqa\b|eslint-disable|eslint-enable|oxlint-disable(?:-next-line|-line)?|prettier-ignore|@ts-|nosemgrep|cspell:|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|go:|fmt:|isort:|#\s*(?:noqa|pragma|type:|fmt:|isort:))/;

/**
 * The span to delete for one comment.
 *
 * A comment on a line of its own takes the whole line, indentation and all.
 * A comment sharing a line with code takes only itself, and the space after
 * it, so the code keeps its position.
 */
function spanToRemove(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  const after = text.slice(end);
  const afterLine = after.indexOf('\n') === -1 ? after.length : after.indexOf('\n');

  if (before.trim() === '') {
    // Alone on its line: take the line, and the newline that ends it.
    return [lineStart, end + (afterLine === after.length ? 0 : 1)];
  }
  // Beside code: take the comment and one space, if there is one.
  let stop = end;
  if (text[stop] === ' ') stop++;
  return [start, stop];
}

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  const ranges = commentRanges(file, text).filter(
    ([start, end]) => !DIRECTIVE.test(text.slice(start, end)),
  );
  if (!ranges.length) {
    console.log(`${file}: nothing to remove`);
    continue;
  }
  let out = text;
  // Back to front, so the offsets of the earlier ranges stay valid.
  for (const [start, end] of ranges.reverse()) {
    const [from, to] = spanToRemove(text, start, end);
    out = out.slice(0, from) + out.slice(to);
  }
  // Three blank lines in a row is one too many.
  out = out.replace(/\n{4,}/g, '\n\n\n');
  writeFileSync(file, out);
  console.log(`${file}: removed ${ranges.length}`);
}
