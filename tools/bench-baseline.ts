/**
 * Baseline, with every workload's page count measured rather than assumed.
 *
 * The first attempt labelled its workloads 1p/20p/200p and they turned out to be
 * 1, 12 and 113 pages. Page count is therefore measured and printed, and the
 * target is hit by growing the document until printToPDF says it has enough.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "/home/anas/Projects/html2pdf/src/browser.ts";
import { render } from "/home/anas/Projects/html2pdf/src/render.ts";
import { fixFontDescriptors } from "/home/anas/Projects/html2pdf/src/fontdesc.ts";
import { fixToUnicode } from "/home/anas/Projects/html2pdf/src/tounicode.ts";
import { addMetadata } from "/home/anas/Projects/html2pdf/src/meta.ts";

function doc(sections: number) {
  const body = Array.from({ length: sections }, (_, i) =>
    `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) =>
      `<p>Paragraph ${j + 1} of section ${i + 1}. office efficient different flags finished warehouse loading invoices.</p>`).join("")}`
  ).join("");
  return `<!doctype html><meta charset="utf-8"><title>Doc</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}

const letter = `<!doctype html><meta charset="utf-8"><title>Letter</title>
<h1>Letter</h1><p>Dear Sir,</p><p>office efficient different flags finished</p><p>Yours faithfully,</p>`;

/** Grow the document until printToPDF reports at least `target` pages. */
async function hit(browser: Browser, target: number) {
  let sections = Math.max(1, Math.round(target / 5));
  for (let i = 0; i < 6; i++) {
    const r = await render(browser, { html: doc(sections), timeoutMs: 120_000 });
    if (r.info.pages >= target) return { html: doc(sections), pages: r.info.pages };
    sections = Math.ceil(sections * (target / r.info.pages) * 1.05);
  }
  return { html: doc(sections), pages: -1 };
}

const profile = await mkdtemp(join(tmpdir(), "lp-bl-"));
const probe = await Browser.launch({ profile });
const resumePath = "/home/anas/Documents/Resumes/html/Ahammed_Sahad_Resume.html";
const workloads: Array<[string, any]> = [
  ["letter", { html: letter }],
  ["resume", { path: resumePath }],
  ["20p", (await hit(probe, 20))],
  ["100p", (await hit(probe, 100))],
  ["400p", (await hit(probe, 400))],
];
const measured = workloads.map(([n, r]) => [n, r.pages ?? null] as [string, number | null]);
await probe.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

const pct = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: Math.round(s[Math.floor(s.length / 2)]), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
};

const out: any[] = [];
for (const [name, req] of workloads) {
  const cold: number[] = []; const repair: number[] = []; let bytes = 0; let pages = 0;
  for (let i = 0; i < 3; i++) {
    const p = await mkdtemp(join(tmpdir(), "lp-cold-"));
    const b = await Browser.launch({ profile: p });
    const t0 = Bun.nanoseconds();
    const r = await render(b, req as any);
    cold.push((Bun.nanoseconds() - t0) / 1e6);
    pages = r.info.pages; bytes = r.pdf.byteLength;
    const t1 = Bun.nanoseconds();
    addMetadata(fixFontDescriptors(fixToUnicode(r.pdf)), { author: "bench" });
    repair.push((Bun.nanoseconds() - t1) / 1e6);
    await b.close(); await rm(p, { recursive: true, force: true }).catch(() => {});
  }
  const p2 = await mkdtemp(join(tmpdir(), "lp-warm-"));
  const b2 = await Browser.launch({ profile: p2 });
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Bun.nanoseconds();
    await render(b2, req as any);
    warm.push((Bun.nanoseconds() - t0) / 1e6);
  }
  await b2.close(); await rm(p2, { recursive: true, force: true }).catch(() => {});
  out.push({ workload: name, pages, kb: Math.round(bytes / 1024), coldMs: pct(cold), warmMs: pct(warm), repairMs: pct(repair) });
}
console.log("pages actually produced:", JSON.stringify(measured));
console.table(out.map((r) => ({
  workload: r.workload, pages: r.pages, KB: r.kb,
  cold_p50: r.coldMs.p50, cold_max: r.coldMs.max,
  warm_p50: r.warmMs.p50, warm_max: r.warmMs.max,
  repair_p50: r.repairMs.p50,
  repair_pct_of_warm: +(100 * r.repairMs.p50 / r.warmMs.p50).toFixed(1),
})));
