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

  const v = verify(r.pdf);
  if (!v.ok) notes.push(`verify: ${v.failures.join("; ").slice(0, 70)}`);
  const rejected = r.findings.filter((f) => f.code === "repair-rejected");
  if (rejected.length) notes.push(`${rejected.length} repair(s) rejected`);

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

  const tmp = join(profile, "out.pdf");
  await Bun.write(tmp, r.pdf);
  const gs = await Bun.$`gs -o /dev/null -sDEVICE=nullpage ${tmp}`.quiet().nothrow();
  const gsErr = new TextDecoder().decode(gs.stderr).toString();
  if (gs.exitCode !== 0) notes.push(`ghostscript exit ${gs.exitCode}`);
  else if (/error/i.test(gsErr)) notes.push(`ghostscript: ${gsErr.split("\n").find((l) => /error/i.test(l))!.slice(0, 60)}`);

  const words = sourceWords(html);
  let got = 0;
  try {
    got = ((await pdfText(r.pdf)).match(/[A-Za-z0-9\u00c0-\u024f\u4e00-\u9fff]{3,}/g) ?? []).length;
  } catch { notes.push("pdftotext threw"); }
  const ratio = words > 0 ? got / words : 1;
  if (ratio < 0.5) notes.push(`text retention ${(ratio * 100).toFixed(0)}% of ${words} source words`);

  const fontGaps = unresolvedFontMetrics(r.pdf);
  if (fontGaps.length) notes.push(`${fontGaps.length} font(s) with an underivable cap height`);
  const ligatures = unresolvedLigatures(r.pdf);
  if (ligatures.length) notes.push(`${ligatures.length} unresolved ligature(s)`);

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
