/**
 * Where the comments are in a file.
 *
 * The parser knows the difference between a regular expression and a
 * division, and between a template literal and a string, and a scanner does
 * not. A scanner reads the second slash of `/\/\*[\s\S]*?\*\//g` as the
 * start of a comment and everything after it as comment text, which is how a
 * count of 447 became 1,776. It also reads the `//` lines inside a template
 * literal as comments, when they are part of the string -- and this
 * repository ships a large block of browser JavaScript as a string.
 *
 * So the comments come from the parser: each node offers the comment ranges
 * attached to it, leading and trailing, and the same range can be offered
 * twice, so they are collected by position.
 */
import * as ts from 'typescript-api';

/** The comments in a file, as [start, end) offsets, in source order. */
export function commentRanges(file, text) {
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
