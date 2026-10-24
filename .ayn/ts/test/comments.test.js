"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const lint_comments_ts_1 = require("../tools/lint-comments.ts");
const count = (source) => (0, lint_comments_ts_1.commentsIn)('probe.ts', source);
(0, bun_test_1.describe)('the comment gate', () => {
    (0, bun_test_1.test)('it finds a comment on a line of its own', () => {
        (0, bun_test_1.expect)(count('// one\nexport const a = 1;\n')).toBe(1);
    });
    (0, bun_test_1.test)('it finds a comment at the end of a line of code', () => {
        (0, bun_test_1.expect)(count('export const a = 1; // one\n')).toBe(1);
    });
    (0, bun_test_1.test)('it finds a comment in an empty block, which belongs to no node', () => {
        (0, bun_test_1.expect)(count('export function f() {\n  // one\n}\n')).toBe(1);
    });
    (0, bun_test_1.test)('it finds a comment between two statements', () => {
        (0, bun_test_1.expect)(count('export const a = 1;\n// one\nexport const b = 2;\n')).toBe(1);
    });
    (0, bun_test_1.test)('it finds a block comment', () => {
        (0, bun_test_1.expect)(count('/* one */\nexport const a = 1;\n')).toBe(1);
    });
    (0, bun_test_1.test)('it does not count a // inside a string', () => {
        (0, bun_test_1.expect)(count("export const a = '// not a comment';\n")).toBe(0);
    });
    (0, bun_test_1.test)('it does not count a // inside a template literal', () => {
        (0, bun_test_1.expect)(count('export const a = `\n// not a comment\n`;\n')).toBe(0);
    });
    (0, bun_test_1.test)('it does not count a // inside a regular expression', () => {
        (0, bun_test_1.expect)(count('export const a = /\\/\\*x\\*\\//g;\n')).toBe(0);
    });
    (0, bun_test_1.test)('it does not count a machine directive', () => {
        for (const directive of [
            '// nosemgrep: a reason',
            '// prettier-ignore',
            '// oxlint-disable-next-line',
            '// eslint-disable-next-line',
            '/* eslint-disable */',
        ]) {
            (0, bun_test_1.expect)(count(`${directive}\nexport const a = 1;\n`), directive).toBe(0);
        }
    });
    (0, bun_test_1.test)('it counts a comment that merely mentions a directive', () => {
        (0, bun_test_1.expect)(count('// the nosemgrep directive is not this one\nexport const a = 1;\n')).toBe(1);
    });
    (0, bun_test_1.test)('every comment in a file is found, and found once', () => {
        const source = [
            '// one',
            'export function f() {',
            '  // two',
            '}',
            'export const a = 1; // three',
            '/* four */',
            'export const b = 2;',
        ].join('\n');
        (0, bun_test_1.expect)(count(source)).toBe(4);
        const ranges = (0, lint_comments_ts_1.commentRanges)('probe.ts', source);
        (0, bun_test_1.expect)(new Set(ranges.map((r) => r[0])).size).toBe(ranges.length);
    });
});
(0, bun_test_1.describe)('the comments inside a template literal', () => {
    (0, bun_test_1.test)('it counts the comments in a block of javascript', () => {
        const source = ['const x = 1;', '// one', '// two', 'return x;'].join('\n');
        (0, bun_test_1.expect)((0, lint_comments_ts_1.literalComments)('probe.ts', `const AUDIT = String.raw\`${source}\`;`)).toBe(2);
    });
    (0, bun_test_1.test)('it does not count a pattern that looks like a comment', () => {
        const source = '/\\*[sS]*?\\*/|"(?:\\\\[sS]|[^"\\\\])*"';
        (0, bun_test_1.expect)((0, lint_comments_ts_1.literalComments)('probe.ts', `const AUDIT = String.raw\`${source}\`;`)).toBe(0);
    });
    (0, bun_test_1.test)('it does not count a comment in a document', () => {
        const source = '<!doctype html><style>/* a css comment */</style>';
        (0, bun_test_1.expect)((0, lint_comments_ts_1.literalComments)('probe.ts', `const html = \`${source}\`;`)).toBe(0);
    });
});
//# sourceMappingURL=comments.test.js.map