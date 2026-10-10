import { $ } from 'bun';
import { readFileSync, existsSync } from 'node:fs';

const BASELINE = new URL('../waivers/baseline.lizard.txt', import.meta.url);
const LIZARD = (process.env.LIZARD_BIN ?? 'uvx lizard').split(' ');
const out = await $`${LIZARD} -C 15 -L 200 --csv src/`.text();
const known = new Set(
  existsSync(BASELINE)
    ? readFileSync(BASELINE, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [],
);

const fresh = [];
for (const line of out.split('\n')) {
  const cols = line.split(',');
  if (cols.length < 8 || cols[0].trim() === 'NLOC') continue;
  const ccn = Number(cols[1]);
  const length = Number(cols[4]);
  const file = cols[6].replace(/"/g, '').trim();
  const func = cols[7].replace(/"/g, '').trim();
  if (ccn > 15 || length > 200) fresh.push(`${file}::${func}`);
}
const current = [...new Set(fresh)].sort();
const added = current.filter((k) => !known.has(k));
const fixed = [...known].filter((k) => !current.includes(k));
if (added.length > 0) {
  console.error(`new complexity breaches (CC>15 or L>200):\n${added.join('\n')}`);
  process.exit(1);
}
console.log(`lizard ratchet ok (${current.length} known, ${fixed.length} fixed)`);
