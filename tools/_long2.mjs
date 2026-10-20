import { readFileSync } from 'node:fs';
import { commentRanges } from './comment-ranges.mjs';
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, 'utf8');
  for (const [s, e] of commentRanges(f, text)) {
    const t = text.slice(s, e);
    if (t.split('\n').length >= 3) {
      const line = text.slice(0, s).split('\n').length;
      console.log(`\n=== ${f}:${line} ===\n${t}`);
    }
  }
}
