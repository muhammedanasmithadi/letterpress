import { readFileSync } from 'node:fs';

const FLOOR = 90;
let found = 0;
let hit = 0;
for (const line of readFileSync('coverage/lcov.info', 'utf8').split('\n')) {
  if (line.startsWith('LF:')) found += Number(line.slice(3));
  if (line.startsWith('LH:')) hit += Number(line.slice(3));
}
const pct = (100 * hit) / found;
console.log(`coverage: ${pct.toFixed(2)}% lines (floor ${FLOOR}%)`);
if (pct < FLOOR) process.exit(1);
