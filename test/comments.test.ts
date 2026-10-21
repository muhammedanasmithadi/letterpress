import { describe, expect, test } from 'bun:test';

import { commentRanges, commentsIn, literalComments } from '../tools/lint-comments.ts';

const count = (source: string) => commentsIn('probe.ts', source);

describe('the comment gate', () => {
  test('it finds a comment on a line of its own', () => {
    expect(count('// one\nexport const a = 1;\n')).toBe(1);
  });

  test('it finds a comment at the end of a line of code', () => {
    expect(count('export const a = 1; // one\n')).toBe(1);
  });

  test('it finds a comment in an empty block, which belongs to no node', () => {
    expect(count('export function f() {\n  // one\n}\n')).toBe(1);
  });

  test('it finds a comment between two statements', () => {
    expect(count('export const a = 1;\n// one\nexport const b = 2;\n')).toBe(1);
  });

  test('it finds a block comment', () => {
    expect(count('/* one */\nexport const a = 1;\n')).toBe(1);
  });

  test('it does not count a // inside a string', () => {
    expect(count("export const a = '// not a comment';\n")).toBe(0);
  });

  test('it does not count a // inside a template literal', () => {
    expect(count('export const a = `\n// not a comment\n`;\n')).toBe(0);
  });

  test('it does not count a // inside a regular expression', () => {
    expect(count('export const a = /\\/\\*x\\*\\//g;\n')).toBe(0);
  });

  test('it does not count a machine directive', () => {
    for (const directive of [
      '// nosemgrep: a reason',
      '// prettier-ignore',
      '// oxlint-disable-next-line',
      '// eslint-disable-next-line',
      '/* eslint-disable */',
    ]) {
      expect(count(`${directive}\nexport const a = 1;\n`), directive).toBe(0);
    }
  });

  test('it counts a comment that merely mentions a directive', () => {
    expect(count('// the nosemgrep directive is not this one\nexport const a = 1;\n')).toBe(1);
  });

  test('every comment in a file is found, and found once', () => {
    const source = [
      '// one',
      'export function f() {',
      '  // two',
      '}',
      'export const a = 1; // three',
      '/* four */',
      'export const b = 2;',
    ].join('\n');
    expect(count(source)).toBe(4);
    const ranges = commentRanges('probe.ts', source);
    expect(new Set(ranges.map((r) => r[0])).size).toBe(ranges.length);
  });
});

describe('the comments inside a template literal', () => {
  test('it counts the comments in a block of javascript', () => {
    const source = ['const x = 1;', '// one', '// two', 'return x;'].join('\n');
    expect(literalComments('probe.ts', `const AUDIT = String.raw\`${source}\`;`)).toBe(2);
  });

  test('it does not count a pattern that looks like a comment', () => {
    const source = '/\\*[sS]*?\\*/|"(?:\\\\[sS]|[^"\\\\])*"';
    expect(literalComments('probe.ts', `const AUDIT = String.raw\`${source}\`;`)).toBe(0);
  });

  test('it does not count a comment in a document', () => {
    const source = '<!doctype html><style>/* a css comment */</style>';
    expect(literalComments('probe.ts', `const html = \`${source}\`;`)).toBe(0);
  });
});
