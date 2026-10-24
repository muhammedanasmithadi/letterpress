"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const findings_ts_1 = require("../src/findings.ts");
const SRC = (0, node_path_1.join)(import.meta.dir, '..', 'src');
const README = (0, node_path_1.join)(import.meta.dir, '..', 'README.md');
const LITERAL = /code:\s*['"]([a-z0-9-]+)['"],\s*\n\s*severity:\s*['"]([a-z]+)['"]/g;
const ADDED = /add\(\s*['"]([a-z0-9-]+)['"],\s*['"](error|warn|info)['"]/g;
async function sourceFiles() {
    const names = await (0, promises_1.readdir)(SRC);
    return names.filter((n) => n.endsWith('.ts')).map((n) => (0, node_path_1.join)(SRC, n));
}
async function emitted() {
    const found = new Map();
    const add = (code, severity) => {
        if (!found.has(code))
            found.set(code, new Set());
        found.get(code).add(severity);
    };
    for (const file of await sourceFiles()) {
        const text = await (0, promises_1.readFile)(file, 'utf8');
        for (const m of text.matchAll(LITERAL))
            add(m[1], m[2]);
        for (const m of text.matchAll(ADDED))
            add(m[1], m[2]);
    }
    return found;
}
async function documented() {
    const lines = (await (0, promises_1.readFile)(README, 'utf8')).split('\n');
    const start = lines.findIndex((l) => l.startsWith('| code '));
    (0, bun_test_1.expect)(start, 'the README has no findings table').toBeGreaterThan(-1);
    const rows = new Map();
    const seen = new Map();
    for (const [at, line] of lines.slice(start + 2).entries()) {
        if (!line.startsWith('|'))
            break;
        const m = /^\|\s*`([a-z0-9-]+)`\s*\|(.*?)\|\s*$/.exec(line);
        if (!m)
            continue;
        const code = m[1];
        const first = seen.get(code);
        if (first !== undefined) {
            throw new Error(`the README lists \`${code}\` twice, on rows ${first + start + 3} and ${at + start + 3}. ` +
                `a second row for a code is invisible to the map below, so it would never be compared.`);
        }
        seen.set(code, at + start + 3);
        rows.set(code, m[2].replace(/\s+/g, ' ').trim());
    }
    return rows;
}
(0, bun_test_1.describe)('the findings manifest', () => {
    (0, bun_test_1.test)('every code the source emits is listed, at the severity it is emitted at', async () => {
        const found = await emitted();
        const problems = [];
        for (const [code, severities] of found) {
            const spec = findings_ts_1.FINDINGS[code];
            if (!spec) {
                problems.push(`${code} is emitted but not in the manifest`);
                continue;
            }
            for (const severity of severities) {
                if (spec.severity !== severity) {
                    problems.push(`${code} is emitted as ${severity} and listed as ${spec.severity}`);
                }
            }
        }
        (0, bun_test_1.expect)(problems).toEqual([]);
    });
    (0, bun_test_1.test)('every code the manifest lists is emitted somewhere', async () => {
        const found = await emitted();
        const listed = findings_ts_1.FINDING_CODES.filter((c) => !found.has(c));
        (0, bun_test_1.expect)(listed, 'listed but never emitted').toEqual([]);
    });
    (0, bun_test_1.test)('no code is emitted at two severities', async () => {
        const found = await emitted();
        const split = [...found].filter(([, s]) => s.size > 1).map(([c, s]) => `${c}: ${[...s]}`);
        (0, bun_test_1.expect)(split).toEqual([]);
    });
    (0, bun_test_1.test)('the README documents every code, and says what the manifest says', async () => {
        const rows = await documented();
        const problems = [];
        for (const code of findings_ts_1.FINDING_CODES) {
            const spec = findings_ts_1.FINDINGS[code];
            const row = rows.get(code);
            if (row === undefined) {
                problems.push(`${code} is in the manifest but not in the README table`);
                continue;
            }
            if (row !== spec.summary) {
                problems.push(`${code}: README says "${row}", manifest says "${spec.summary}"`);
            }
        }
        (0, bun_test_1.expect)(problems).toEqual([]);
    });
    (0, bun_test_1.test)('the README documents nothing the manifest does not list', async () => {
        const rows = await documented();
        const extra = [...rows.keys()].filter((c) => !(c in findings_ts_1.FINDINGS));
        (0, bun_test_1.expect)(extra, 'documented but not in the manifest').toEqual([]);
    });
    (0, bun_test_1.test)('the severities are the three the tool uses', () => {
        for (const spec of Object.values(findings_ts_1.FINDINGS)) {
            (0, bun_test_1.expect)(['error', 'warn', 'info']).toContain(spec.severity);
        }
    });
    (0, bun_test_1.test)('codesAt returns only the codes of one severity', () => {
        (0, bun_test_1.expect)((0, findings_ts_1.codesAt)('error').every((c) => findings_ts_1.FINDINGS[c].severity === 'error')).toBe(true);
        (0, bun_test_1.expect)((0, findings_ts_1.codesAt)('error').length).toBeGreaterThan(0);
        (0, bun_test_1.expect)((0, findings_ts_1.codesAt)('error').length + (0, findings_ts_1.codesAt)('warn').length + (0, findings_ts_1.codesAt)('info').length).toBe(findings_ts_1.FINDING_CODES.length);
    });
    (0, bun_test_1.test)('every summary says something', () => {
        for (const [code, spec] of Object.entries(findings_ts_1.FINDINGS)) {
            (0, bun_test_1.expect)(spec.summary.length, code).toBeGreaterThan(10);
        }
    });
});
//# sourceMappingURL=findings.test.js.map