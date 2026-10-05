import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "/home/anas/Projects/html2pdf/src/browser.ts";
import { render } from "/home/anas/Projects/html2pdf/src/render.ts";
import { verify } from "/home/anas/Projects/html2pdf/src/verify.ts";
function doc(n: number) {
  const body = Array.from({ length: n }, (_, i) =>
    `<h2>Section ${i + 1}</h2>${Array.from({ length: 8 }, (_, j) =>
      `<p>Paragraph ${j + 1}. office efficient different flags finished.</p>`).join("")}`).join("");
  return `<!doctype html><meta charset="utf-8"><title>D</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const profile = await mkdtemp(join(tmpdir(), "lp-gc-"));
const b = await Browser.launch({ profile });
console.log("verify() cost on already-shipped output (the worst case: always runs):");
for (const n of [1, 20, 100, 200]) {
  const r = await render(b, { html: doc(n), author: "Bench" });
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Bun.nanoseconds();
    verify(r.pdf);
    times.push((Bun.nanoseconds() - t0) / 1e6);
  }
  times.sort((a, b2) => a - b2);
  const med = times[2]!;
  console.log(`  ${String(r.info.pages).padStart(3)} pages  ${(r.pdf.byteLength/1024).toFixed(0).padStart(5)} KB  verify ${med.toFixed(1).padStart(6)} ms   render was ${r.ms} ms   ${(100*med/r.ms).toFixed(1)}% of render`);
}
await b.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
