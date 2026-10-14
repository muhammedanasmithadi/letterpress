/**
 * The gap between structural checks and content identity, demonstrated.
 *
 * xref/resolves, refs-resolve and lengths-match all pass on a file whose drawn
 * content was destroyed -- because none of them look at what the bytes draw.
 * Byte-identity against the original (repairOrKeep with it in hand) is what
 * catches content damage, and the second half below proves that too.
 *
 * An earlier version corrupted by splicing text into the raw file, but content
 * streams are Flate-compressed: its TJ-array pattern never matched anything, so
 * it "corrupted" nothing and both rows trivially agreed. Damage now goes into
 * the compressed payload at the same length, keeping every offset and Length
 * valid while the content dies.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { repairOrKeep } from '../src/verify.ts';
import { streamRange, trySplit } from '../src/pdfparts.ts';

function xrefOk(pdf: Uint8Array): { ok: boolean; why: string } {
  const parts = trySplit(pdf);
  if (!parts) return { ok: false, why: 'not a linear pdf' };
  const text = Buffer.from(pdf).toString('latin1');
  const sx = Number(text.match(/startxref\s+(\d+)/)?.[1] ?? -1);
  if (sx < 0 || text.slice(sx, sx + 4) !== 'xref')
    return { ok: false, why: 'startxref does not point at a table' };
  if (text.match(/startxref/g)!.length !== 1) return { ok: false, why: 'more than one startxref' };
  const h = text.slice(sx).match(/^xref\s+0\s+(\d+)\s/)!;
  const table = text.slice(sx + h[0].length);
  const size = Number(h[1]);
  for (let n = 1; n < size; n++) {
    const e = table.slice(n * 20, n * 20 + 20);
    if (e.length < 20) return { ok: false, why: `truncated xref entry ${n}` };
    if (e[17] !== 'n') continue;
    const off = Number(e.slice(0, 10));
    if (!text.startsWith(`${n} 0 obj`, off))
      return { ok: false, why: `xref entry ${n} points at the wrong object` };
  }
  if (!text.includes(`/Size ${size}`))
    return { ok: false, why: 'trailer /Size disagrees with the table' };
  return { ok: true, why: 'resolves' };
}

function refsResolve(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString('latin1');
  const d = new Set([...text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)].map((m) => Number(m[1])));
  return [...text.matchAll(/(?:^|[^0-9])(\d+) 0 R\b/g)].every((m) => d.has(Number(m[1])));
}

function lengthsMatch(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString('latin1');
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj\b([\s\S]*?)\bendobj/g)) {
    const body = m[2]!;
    const len = body.split('stream')[0]!.match(/\/Length (\d+)/);
    if (!len) continue;
    const range = streamRange(Buffer.from(body, 'latin1'));
    if (!range) continue;
    if (range.end - range.start !== Number(len[1])) return false;
  }
  return true;
}

const profile = await mkdtemp(join(tmpdir(), 'lp-gate-'));
const b = await Browser.launch({ profile });
const html = `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><h1>Gate</h1><p>office efficient flags finished</p>`;
const good = (await render(b, { html, author: 'A Person' })).pdf;

// Same-length damage inside a compressed text payload: every offset, Length and
// xref entry stays valid while the drawn content dies. Flipping the raw file
// text cannot do this -- streams are Flate-compressed, so a plaintext pattern
// never matches and the "corruption" is a no-op.
function corruptContent(pdf: Uint8Array): Uint8Array {
  const raw = Buffer.from(pdf);
  const text = raw.toString('latin1');
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf('\nendstream', start);
    if (end - start < 16) continue;
    const payload = raw.subarray(start, end);
    let drawn: Buffer;
    try {
      drawn = inflateSync(payload);
    } catch {
      continue;
    }
    if (!drawn.includes('BT')) continue;
    const at = 4 + (drawn.length % Math.max(1, payload.length - 8));
    payload[at] ^= 0xff;
    payload[at + 1] ^= 0xff;
    payload[at + 2] ^= 0xff;
    return raw;
  }
  throw new Error('no text-bearing content stream to corrupt');
}

const corrupted = corruptContent(good);

for (const [label, pdf] of [
  ['shipped output', good],
  ['content corrupted', corrupted],
] as const) {
  console.log(
    `${label.padEnd(18)} xref=${xrefOk(pdf).why.padEnd(38)} refs=${refsResolve(pdf)} lengths=${lengthsMatch(pdf)}`,
  );
}

const kept = repairOrKeep(good, () => corrupted);
console.log(
  kept.applied
    ? 'NO GAP: the corrupted file passed the gate'
    : `gap stands: structural checks pass, byte-identity refuses (${kept.failures.join('; ').slice(0, 100)})`,
);
if (kept.applied) process.exit(1);
await b.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
