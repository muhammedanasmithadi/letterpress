import { readFileSync } from 'node:fs';

const FLOOR = 85;

const ELSEWHERE = ['src/pageside.ts'];

let found = 0;
let hit = 0;
let skippedFound = 0;
let skippedHit = 0;
let file = '';
for (const line of readFileSync('coverage/lcov.info', 'utf8').split('\n')) {
  if (line.startsWith('SF:')) file = line.slice(3);
  if (line.startsWith('LF:')) {
    if (ELSEWHERE.some((e) => file.endsWith(e))) skippedFound += Number(line.slice(3));
    else found += Number(line.slice(3));
  }
  if (line.startsWith('LH:')) {
    if (ELSEWHERE.some((e) => file.endsWith(e))) skippedHit += Number(line.slice(3));
    else hit += Number(line.slice(3));
  }
}
const pct = (100 * hit) / found;
console.log(
  `coverage: ${pct.toFixed(2)}% lines (floor ${FLOOR}%), ` +
    `${skippedHit}/${skippedFound} lines run in the browser and are not counted`,
);
if (pct < FLOOR) process.exit(1);
