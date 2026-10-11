import { $ } from 'bun';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASELINE = new URL('../waivers/baseline.jscpd.json', import.meta.url);
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'jscpd-'));
await $`bunx --package jscpd@5.4.1 jscpd --min-tokens 50 --reporters json --silent --output ${dir} src test`.quiet();
const total = JSON.parse(readFileSync(join(dir, 'jscpd-report.json'), 'utf8')).statistics.total;
rmSync(dir, { recursive: true });
console.log(
  `duplication: ${total.clones} clones, ${total.duplicatedLines} lines (baseline ${base.clones}/${base.duplicatedLines})`,
);
if (total.clones > base.clones || total.duplicatedLines > base.duplicatedLines) {
  console.error(
    'new duplication vs baseline: extract shared code, then lower waivers/baseline.jscpd.json',
  );
  process.exit(1);
}
