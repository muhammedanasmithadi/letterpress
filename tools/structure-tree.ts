/**
 * Dump a document's structure tree: what each element is, what it points at, and
 * which marked content blocks the page actually carries.
 *
 * Written to answer one question -- whether a Figure element names any content -- and
 * kept because that question recurs. The answer is not visible from the role names
 * alone. Measured on a figure document:
 *
 *   10 StructTreeRoot
 *     11 Document              -> 11, 13
 *       12 P                   -> 13 NonStruct (MCID 0)
 *       13 Figure              -> [14 Figure (MCID 1), 15 Caption]
 *         14 Figure  MCID 1    Alt=(A bar chart of quarterly revenue)
 *         15 Caption           -> 16 NonStruct (MCID 2)
 *
 * so the image is tagged as a Figure nested inside the Figure that came from the
 * <figure> element, and only the inner one carries the description.
 *
 * Two forms of /K have to be handled and both appear in Chromium's output:
 *
 *   /K 19                 a bare integer MCID, resolved against the element's /Pg
 *   /K [52 0 R 53 0 R]    a mix of child references and MCIDs
 *
 * An earlier version of this only understood the second, and reported no MCIDs at all
 * in any document, including ones known to be well formed.
 *
 * Usage: bun tools/structure-tree.ts <file.pdf> [more.pdf ...]
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dictOf, inflatedStream, trySplit } from "../src/pdfparts.ts";

/**
 * `/K` as a bare integer, as a child reference, or as an array of either.
 *
 * Deliberately wider than the renderer's `kidsOf`, because this is a reader rather than
 * a repair: it has to show the MCID forms too, since an MCID the tree names but the
 * stream lacks is exactly what a reader is looking for.
 */
const K_FORMS = /\/K\s*(\[[\s\S]*?\]|\d+\s+0\s+R|\d+)(?![\d.])/g;

export function structureTree(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) return ["not a linear pdf"];
  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  const lines: string[] = [];

  let rootNum: number | undefined;
  for (const o of parts.objs) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(dictOf(o));
    if (m) { rootNum = Number(m[1]); break; }
  }
  if (rootNum === undefined) return ["no /StructTreeRoot: the document is untagged"];

  const seen = new Set<number>();
  const show = (num: number, depth: number): void => {
    const pad = "  ".repeat(depth);
    const text = dictOf(byNum.get(num) ?? { num, bytes: Buffer.alloc(0) });
    const role = /\/S\s*\/(\w+)/.exec(text)?.[1] ?? "?";
    const alt = /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1] ?? "";
    const k = K_FORMS.exec(text)?.[1];
    K_FORMS.lastIndex = 0;

    let kind = "";
    if (k !== undefined) {
      if (/^\d+$/.test(k)) kind = `MCID ${k}`;
      else if (/^\d+\s+0\s+R$/.test(k)) kind = `child ${Number(/^(\d+)/.exec(k)![1])}`;
      else {
        const mcids = [...k.matchAll(/\/MCID\s+(\d+)/g)].map((m) => m[1]);
        const refs = [...k.matchAll(/(\d+) 0 R/g)].map((m) => m[1]);
        kind = `[ mcids=${mcids.join(",") || "-"} refs=${refs.join(",") || "-"} ]`;
      }
    }
    lines.push(`${pad}${num} ${role.padEnd(11)} ${kind.padEnd(30)} ${alt ? `Alt=${alt.slice(0, 48)}` : ""}`.trimEnd());

    if (seen.has(num)) return;
    seen.add(num);
    if (k === undefined) return;
    if (/^\d+$/.test(k)) return;
    if (/^\d+\s+0\s+R$/.test(k)) { show(Number(/^(\d+)/.exec(k)![1]), depth + 1); return; }
    for (const ref of k.matchAll(/(\d+) 0 R/g)) show(Number(ref[1]), depth + 1);
  };
  show(rootNum, 1);
  return lines;
}

/** The marked content blocks of the first page, with a sample of what each wraps. */
export function markedContent(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) return [];
  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  const lines: string[] = [];
  for (const o of parts.objs) {
    const text = dictOf(o);
    if (!/\/Type\s*\/Page\b/.test(text)) continue;
    const ref = Number(/\/Contents\s+(\d+) 0 R/.exec(text)?.[1]);
    const body = ref ? inflatedStream(byNum.get(ref) ?? { num: -1, bytes: Buffer.alloc(0) }, (b) => inflateSync(b)) : undefined;
    if (!body) continue;
    const rows = body.toString("latin1").split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const m = /\/(\w+)\s*<<\s*\/MCID\s+(\d+)/.exec(rows[i]!);
      if (!m) continue;
      const wrapped: string[] = [];
      for (let j = i + 1; j < rows.length && !/EMC/.test(rows[j]!); j++) {
        if (/\b(Tj|TJ|Do|f|S)\b/.test(rows[j]!)) wrapped.push(rows[j]!.trim());
        if (wrapped.length >= 3) break;
      }
      lines.push(`    MCID ${m[2]} tag=/${m[1]}  wraps: ${wrapped.join(" ; ").slice(0, 68)}`);
    }
  }
  return lines;
}

/** MCIDs the tree names, and MCIDs the stream carries, so gaps show up. */
export function mcidCensus(pdf: Uint8Array): { present: string[]; named: Set<string>; role: Map<string, string> } {
  const parts = trySplit(pdf);
  const present: string[] = [];
  const named = new Set<string>();
  const role = new Map<string, string>();
  if (!parts) return { present, named, role };
  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  for (const o of parts.objs) {
    const text = dictOf(o);
    if (!/\/Type\s*\/Page\b/.test(text)) continue;
    const ref = Number(/\/Contents\s+(\d+) 0 R/.exec(text)?.[1]);
    const body = ref ? inflatedStream(byNum.get(ref) ?? { num: -1, bytes: Buffer.alloc(0) }, (b) => inflateSync(b)) : undefined;
    if (body) for (const m of body.toString("latin1").matchAll(/\/MCID\s+(\d+)/g)) present.push(m[1]!);
  }
  let rootNum: number | undefined;
  for (const o of parts.objs) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(dictOf(o));
    if (m) { rootNum = Number(m[1]); break; }
  }
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const text = dictOf(byNum.get(num) ?? { num, bytes: Buffer.alloc(0) });
    const r = /\/S\s*\/(\w+)/.exec(text)?.[1] ?? "?";
    for (const m of text.matchAll(K_FORMS)) {
      const block = m[1]!;
      if (/^\d+$/.test(block)) { named.add(block); if (!role.has(block)) role.set(block, r); }
      else if (/^\d+\s+0\s+R$/.test(block)) walk(Number(/^(\d+)/.exec(block)![1]), depth + 1);
      else {
        for (const id of block.matchAll(/\/MCID\s+(\d+)/g)) { named.add(id[1]!); if (!role.has(id[1]!)) role.set(id[1]!, r); }
        for (const ref of block.matchAll(/(\d+) 0 R/g)) walk(Number(ref[1]), depth + 1);
      }
    }
  };
  if (rootNum !== undefined) walk(rootNum, 0);
  return { present: [...new Set(present)].sort((a, b) => Number(a) - Number(b)), named, role };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun tools/structure-tree.ts <file.pdf> ...");
    process.exit(2);
  }
  for (const file of files) {
    const pdf = new Uint8Array(readFileSync(file));
    console.log(`\n${file}`);
    for (const line of structureTree(pdf)) console.log(`  ${line}`);
    const blocks = markedContent(pdf);
    if (blocks.length) {
      console.log("\n  marked content in the page stream:");
      for (const l of blocks) console.log(l);
    }
    const census = mcidCensus(pdf);
    const orphans = census.present.filter((m) => !census.named.has(m));
    const ghosts = [...census.named].filter((m) => !census.present.includes(m));
    console.log(`\n  MCIDs present [${census.present.join(",")}]  named [${[...census.named].sort((a, b) => Number(a) - Number(b)).join(",")}]`);
    if (orphans.length) console.log(`  in the stream, named by nothing: ${orphans.join(",")}`);
    if (ghosts.length) console.log(`  named by the tree, absent from the stream: ${ghosts.join(",")}`);
  }
}