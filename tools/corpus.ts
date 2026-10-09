/**
 * Render documents nobody designed these repairs against, and check every invariant
 * that is supposed to hold afterwards.
 *
 * The three repairs were written against the documents that exposed them: a resume, a
 * serif heading, a link. Every test since has been a document I chose. That is a sample
 * of one author's imagination, and generalisation was argued from the mechanism rather
 * than measured.
 *
 * This walks a directory of real HTML instead. The checks are the post-conditions of the
 * repair layer, not the repairs themselves:
 *
 *   1. verify() accepts the file. It is the gate, and a repair it rejected would have
 *      been reverted to Chromium's own bytes -- so a clean run also means no repair was
 *      thrown away.
 *   2. No `repair-rejected` finding, which says the same thing more directly.
 *   3. poppler reads it and reports a page count and a page size.
 *   4. ghostscript renders it with no error.
 *   5. pdftotext recovers text, and the text is a decent fraction of the source's.
 *   6. No font descriptor is left carrying a negative cap height.
 *   7. No unresolved ligature codepoints in any ToUnicode map.
 *   8. No image failed to load, unless the source itself references one that is absent.
 *
 * A failure here is not automatically a defect in the renderer. It is a place where a
 * document that was not considered has found something, which is the only way to find
 * those.
 *
 * Usage: bun tools/corpus.ts <dir-or-file> [...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { unresolvedFontMetrics } from "../src/fontdesc.ts";
import { unresolvedLigatures } from "../src/tounicode.ts";
import { verify } from "../src/verify.ts";
import { pdfInfo, pdfText } from "../test/poppler.ts";

/** Every .html file under a path, recursively, skipping obvious non-documents. */
function collect(target: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let st;
  try { st = statSync(target); } catch { return out; }
  if (st.isFile()) {
    if (/\.html?$/i.test(target)) out.push(target);
    return out;
  }
  for (const name of readdirSync(target)) {
    if (/^(node_modules|\.git|dist|build)$/.test(name)) continue;
    collect(join(target, name), out, depth + 1);
  }
  return out;
}

/** Printable characters the source actually contains, for the text-retention check. */
function sourceWords(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return (text.match(/[A-Za-z0-9\u00c0-\u024f\u4e00-\u9fff]{3,}/g) ?? []).length;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: bun tools/corpus.ts <dir-or-file> ...");
  process.exit(2);
}
const files = targets.flatMap((t) => collect(t)).sort();

const profile = await mkdtemp(join(tmpdir(), "letterpress-corpus-"));
const browser = await Browser.launch({ profile });
let clean = 0;
const problems: string[] = [];

console.log(`  ${files.length} document(s)\n`);
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const notes: string[] = [];
  let t0 = Bun.nanoseconds();
  let r;
  try {
    r = await render(browser, { path: file, author: "corpus", allowNetwork: false, timeoutMs: 120_000 });
  } catch (e) {
    problems.push(`${file}: render threw ${(e as Error).message.slice(0, 90)}`);
    console.log(`  FAIL ${file}\n       render threw: ${(e as Error).message.slice(0, 90)}`);
    continue;
  }
  const ms = (Bun.nanoseconds() - t0) / 1e6;

  // 1 and 2: the gate, and whether any repair was discarded.
  const v = verify(r.pdf);
  if (!v.ok) notes.push(`verify: ${v.failures.join("; ").slice(0, 70)}`);
  const rejected = r.findings.filter((f) => f.code === "repair-rejected");
  if (rejected.length) notes.push(`${rejected.length} repair(s) rejected`);

  // 3: poppler.
  let info;
  try {
    info = await pdfInfo(r.pdf);
  } catch (e) {
    notes.push(`pdfinfo threw: ${(e as Error).message.slice(0, 50)}`);
  }
  if (info) {
    if (info.pages < 1) notes.push("pdfinfo reports 0 pages");
    if (info.encrypted) notes.push("poppler says encrypted");
    if (!/[\d.]/.test(info.pageSize)) notes.push(`no page size: "${info.pageSize}"`);
  }

  // 4: ghostscript.
  const tmp = join(profile, "out.pdf");
  await Bun.write(tmp, r.pdf);
  const gs = await Bun.$`gs -o /dev/null -sDEVICE=nullpage ${tmp}`.quiet().nothrow();
  const gsErr = new TextDecoder().decode(gs.stderr).toString();
  if (gs.exitCode !== 0) notes.push(`ghostscript exit ${gs.exitCode}`);
  else if (/error/i.test(gsErr)) notes.push(`ghostscript: ${gsErr.split("\n").find((l) => /error/i.test(l))!.slice(0, 60)}`);

  // 5: text retention.
  const words = sourceWords(html);
  let got = 0;
  try {
    got = ((await pdfText(r.pdf)).match(/[A-Za-z0-9\u00c0-\u024f\u4e00-\u9fff]{3,}/g) ?? []).length;
  } catch { notes.push("pdftotext threw"); }
  const ratio = words > 0 ? got / words : 1;
  if (ratio < 0.5) notes.push(`text retention ${(ratio * 100).toFixed(0)}% of ${words} source words`);

  // 6 and 7: the post-conditions of the font and ligature repairs.
  const fontGaps = unresolvedFontMetrics(r.pdf);
  if (fontGaps.length) notes.push(`${fontGaps.length} font(s) with an underivable cap height`);
  const ligatures = unresolvedLigatures(r.pdf);
  if (ligatures.length) notes.push(`${ligatures.length} unresolved ligature(s)`);

  // 8: assets the document wanted and did not get.
  const failedAssets = r.findings.filter((f) => f.code === "subresource-failed");
  if (failedAssets.length) notes.push(`${failedAssets.length} subresource(s) failed`);

  const kb = (r.pdf.byteLength / 1024).toFixed(0).padStart(5);
  const status = notes.length === 0 ? "ok  " : "note";
  if (notes.length === 0) clean++;
  console.log(`  ${status} ${String(info?.pages ?? "?").padStart(3)}p ${kb}KB ${String(Math.round(ms)).padStart(6)}ms  ${file.replace(process.env.HOME ?? "/", "~")}`);
  for (const n of notes) {
    console.log(`         - ${n}`);
    problems.push(`${file}: ${n}`);
  }
}

await browser.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

console.log(`\n  ${clean}/${files.length} with nothing to report`);
if (problems.length) {
  console.log(`  ${problems.length} observation(s). Each is a document that was not considered.`);
}
