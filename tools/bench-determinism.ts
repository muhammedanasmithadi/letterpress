/**
 * Byte-identity across two renders, with and without a pinned clock.
 *
 * /CreationDate has one-second resolution, so two renders a second apart differ
 * even when nothing else does. That is not a defect — it is what SOURCE_DATE_EPOCH
 * exists for — but it means "two renders are identical" is only a true claim when
 * the clock is pinned.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "/home/anas/Projects/html2pdf/src/browser.ts";
import { render } from "/home/anas/Projects/html2pdf/src/render.ts";
const html = `<!doctype html><meta charset="utf-8"><title>Format</title>
<style>@page{size:A4;margin:12mm}</style><h1>Report</h1><p>office efficient flags finished</p>`;
const profile = await mkdtemp(join(tmpdir(), "lp-d2-"));
const b = await Browser.launch({ profile });

async function pair(label: string) {
  const a = Buffer.from((await render(b, { html, author: "Someone" })).pdf);
  await Bun.sleep(1100); // straddle a second boundary on purpose
  const c = Buffer.from((await render(b, { html, author: "Someone" })).pdf);
  const same = a.equals(c);
  let diffAt = -1;
  if (!same) for (let i = 0; i < Math.min(a.length, c.length); i++) if (a[i] !== c[i]) { diffAt = i; break; }
  console.log(`  ${label.padEnd(22)} identical=${same}  lengths ${a.length}/${c.length}` +
    (diffAt >= 0 ? `  first diff at ${diffAt}: ${JSON.stringify(a.toString("latin1").slice(diffAt - 30, diffAt + 20))} vs ${JSON.stringify(c.toString("latin1").slice(diffAt - 30, diffAt + 20))}` : ""));
}

await pair("no pinned clock");
process.env.SOURCE_DATE_EPOCH = "1700000000";
await pair("SOURCE_DATE_EPOCH set");
delete process.env.SOURCE_DATE_EPOCH;
await b.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
