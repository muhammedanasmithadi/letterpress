/**
 * Can the pipeline tell the difference between "repaired" and "corrupted"?
 *
 * Three properties a verification gate would check, applied to what the pipeline
 * actually ships and to a deliberately corrupted file. If nothing distinguishes
 * them, then a repair that silently misplaces glyphs is indistinguishable from a
 * good one at runtime.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "/home/anas/Projects/html2pdf/src/browser.ts";
import { render } from "/home/anas/Projects/html2pdf/src/render.ts";
import { trySplit } from "/home/anas/Projects/html2pdf/src/pdfparts.ts";

function xrefOk(pdf: Uint8Array): { ok: boolean; why: string } {
  const parts = trySplit(pdf);
  if (!parts) return { ok: false, why: "not a linear pdf" };
  const text = Buffer.from(pdf).toString("latin1");
  const sx = Number(text.match(/startxref\s+(\d+)/)?.[1] ?? -1);
  if (sx < 0 || text.slice(sx, sx + 4) !== "xref") return { ok: false, why: "startxref does not point at a table" };
  if (text.match(/startxref/g)!.length !== 1) return { ok: false, why: "more than one startxref" };
  const h = text.slice(sx).match(/^xref\s+0\s+(\d+)\s/)!;
  const table = text.slice(sx + h[0].length);
  const size = Number(h[1]);
  for (let n = 1; n < size; n++) {
    const e = table.slice(n * 20, n * 20 + 20);
    if (e.length < 20) return { ok: false, why: `truncated xref entry ${n}` };
    if (e[17] !== "n") continue;
    const off = Number(e.slice(0, 10));
    if (!text.startsWith(`${n} 0 obj`, off)) return { ok: false, why: `xref entry ${n} points at the wrong object` };
  }
  if (!text.includes(`/Size ${size}`)) return { ok: false, why: "trailer /Size disagrees with the table" };
  return { ok: true, why: "resolves" };
}

function refsResolve(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString("latin1");
  const d = new Set([...text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)].map((m) => Number(m[1])));
  return [...text.matchAll(/(?:^|[^0-9])(\d+) 0 R\b/g)].every((m) => d.has(Number(m[1])));
}

function lengthsMatch(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString("latin1");
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj\b([\s\S]*?)\bendobj/g)) {
    const body = m[2]!;
    const len = body.split("stream")[0]!.match(/\/Length (\d+)/);
    const at = body.match(/stream\r?\n/);
    if (!len || !at || at.index === undefined) continue;
    const end = body.lastIndexOf("\nendstream");
    if (Buffer.from(body, "latin1").subarray(at.index + at[0].length, end).length !== Number(len[1])) return false;
  }
  return true;
}

const profile = await mkdtemp(join(tmpdir(), "lp-gate-"));
const b = await Browser.launch({ profile });
const html = `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><h1>Gate</h1><p>office efficient flags finished</p>`;
const good = (await render(b, { html, author: "A Person" })).pdf;

// Corrupt in the way a bad repair does: structurally valid, content wrong.
const t = Buffer.from(good).toString("latin1");
const i = t.search(/\[<[0-9A-Fa-f]{4}>/);
const corrupted = i >= 0
  ? Buffer.from(t.slice(0, i + 1) + "7 ".repeat(200) + t.slice(i + 1), "latin1")
  : good;

for (const [label, pdf] of [["shipped output", good], ["content corrupted", corrupted]] as const) {
  console.log(`${label.padEnd(18)} xref=${xrefOk(pdf).why.padEnd(38)} refs=${refsResolve(pdf)} lengths=${lengthsMatch(pdf)}`);
}
await b.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
