import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "/home/anas/Projects/html2pdf/src/browser.ts";
import { render } from "/home/anas/Projects/html2pdf/src/render.ts";
import { fixToUnicode, unresolvedLigatures } from "/home/anas/Projects/html2pdf/src/tounicode.ts";
import { fixFontDescriptors } from "/home/anas/Projects/html2pdf/src/fontdesc.ts";

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function doc(body: string) {
  return `<!doctype html><meta charset="utf-8"><title>Doc</title>
<style>@page{size:A4;margin:18mm}body{font-family:"DejaVu Serif",serif}</style>${body}`;
}
const cases: Array<[string, any]> = [
  ["serif ligatures", { html: doc("<p>office efficient flags finished</p>") }],
  ["sans ligatures", { html: `<!doctype html><meta charset="utf-8"><title>Doc</title><p>office efficient flags finished</p>` }],
];
const profile = await mkdtemp(join(tmpdir(), "lp-i2-"));
const b = await Browser.launch({ profile });
for (const [name, req] of cases) {
  const r = await render(b, req);
  const tu = fixToUnicode(r.pdf);
  const fd = fixFontDescriptors(tu);
  console.log(`\n=== ${name} ===`);
  console.log(`  shipped ${r.pdf.byteLength} B, ligatures left ${unresolvedLigatures(r.pdf).length}`);
  console.log(`  fixToUnicode again: ${tu.byteLength} B, identical=${same(r.pdf, tu)}`);
  console.log(`  fixFontDescriptors after that: ${fd.byteLength} B, identical=${same(tu, fd)}`);
  if (!same(r.pdf, tu)) {
    const n = Math.min(r.pdf.length, tu.length);
    for (let i = 0; i < n; i++) if (r.pdf[i] !== tu[i]) {
      console.log(`  first diff at byte ${i}:`);
      console.log("    shipped:", JSON.stringify(Buffer.from(r.pdf).toString("latin1").slice(Math.max(0,i-70), i+40)));
      console.log("    re-run :", JSON.stringify(Buffer.from(tu).toString("latin1").slice(Math.max(0,i-70), i+40)));
      break;
    }
  }
}
await b.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
