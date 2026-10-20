import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FINDINGS, FINDING_CODES, codesAt } from '../src/findings.ts';

const SRC = join(import.meta.dir, '..', 'src');
const README = join(import.meta.dir, '..', 'README.md');

const LITERAL = /code:\s*['"]([a-z0-9-]+)['"],\s*\n\s*severity:\s*['"]([a-z]+)['"]/g;

const ADDED = /add\(\s*['"]([a-z0-9-]+)['"],\s*['"](error|warn|info)['"]/g;

async function sourceFiles(): Promise<string[]> {
  const names = await readdir(SRC);
  return names.filter((n) => n.endsWith('.ts')).map((n) => join(SRC, n));
}

async function emitted(): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  const add = (code: string, severity: string) => {
    if (!found.has(code)) found.set(code, new Set());
    found.get(code)!.add(severity);
  };
  for (const file of await sourceFiles()) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(LITERAL)) add(m[1]!, m[2]!);
    for (const m of text.matchAll(ADDED)) add(m[1]!, m[2]!);
  }
  return found;
}

async function documented(): Promise<Map<string, string>> {
  const lines = (await readFile(README, 'utf8')).split('\n');
  const start = lines.findIndex((l) => l.startsWith('| code '));
  expect(start, 'the README has no findings table').toBeGreaterThan(-1);
  const rows = new Map<string, string>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|(.*?)\|\s*$/.exec(line);
    if (m) rows.set(m[1]!, m[2]!.replace(/\s+/g, ' ').trim());
  }
  return rows;
}

describe('the findings manifest', () => {
  test('every code the source emits is listed, at the severity it is emitted at', async () => {
    const found = await emitted();
    const problems: string[] = [];
    for (const [code, severities] of found) {
      const spec = FINDINGS[code];
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
    expect(problems).toEqual([]);
  });

  test('every code the manifest lists is emitted somewhere', async () => {
    const found = await emitted();
    const listed = FINDING_CODES.filter((c) => !found.has(c));
    expect(listed, 'listed but never emitted').toEqual([]);
  });

  test('no code is emitted at two severities', async () => {
    const found = await emitted();
    const split = [...found].filter(([, s]) => s.size > 1).map(([c, s]) => `${c}: ${[...s]}`);
    expect(split).toEqual([]);
  });

  test('the README documents every code, and says what the manifest says', async () => {
    const rows = await documented();
    const problems: string[] = [];
    for (const code of FINDING_CODES) {
      const spec = FINDINGS[code]!;
      const row = rows.get(code);
      if (row === undefined) {
        problems.push(`${code} is in the manifest but not in the README table`);
        continue;
      }
      if (row !== spec.summary) {
        problems.push(`${code}: README says "${row}", manifest says "${spec.summary}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('the README documents nothing the manifest does not list', async () => {
    const rows = await documented();
    const extra = [...rows.keys()].filter((c) => !(c in FINDINGS));
    expect(extra, 'documented but not in the manifest').toEqual([]);
  });

  test('the severities are the three the tool uses', () => {
    for (const spec of Object.values(FINDINGS)) {
      expect(['error', 'warn', 'info']).toContain(spec.severity);
    }
  });

  test('codesAt returns only the codes of one severity', () => {
    expect(codesAt('error').every((c) => FINDINGS[c]!.severity === 'error')).toBe(true);
    expect(codesAt('error').length).toBeGreaterThan(0);
    expect(codesAt('error').length + codesAt('warn').length + codesAt('info').length).toBe(
      FINDING_CODES.length,
    );
  });

  test('every summary says something', () => {
    for (const [code, spec] of Object.entries(FINDINGS)) {
      expect(spec.summary.length, code).toBeGreaterThan(10);
    }
  });
});
