/**
 * What Chromium does with an image's alt text.
 *
 * This was a repair once. `src/figurealt.ts` wrote `/Alt` onto Figure structure
 * elements because ten measured forms said Chromium discarded the attribute. All ten
 * used a hand-written base64 string that was not valid base64 — 193 characters, not a
 * multiple of four — so Chromium rejected the image, drew its broken-image
 * placeholder, and painted the alt as untagged glyphs. What was measured was the
 * placeholder. With an image that loads, Chromium tags the image and carries the alt
 * itself, so the repair was a no-op in the ordinary case and has been deleted.
 *
 * Kept as a probe because the finding is worth being able to re-check, and because a
 * retraction that leaves no way to reproduce the evidence is just an assertion. Note
 * the first check: `naturalWidth` is 0 for an image the browser could not decode, and
 * reading that as "Chromium drops the alt" is the mistake this file exists to prevent.
 *
 * Usage: bun tools/probe-image-alt.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { dictOf, structElementsInOrder, trySplit } from "../src/pdfparts.ts";

/** A real 1x1 PNG. A hand-written base64 string is the trap this file is about. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CASES: Record<string, string> = {
  "img with alt": `<p>before <img src="${PNG}" alt="the alt text"> after</p>`,
  "img alt and title": `<p><img src="${PNG}" alt="the alt" title="the title"></p>`,
  "img alt and aria-label": `<p><img src="${PNG}" alt="the alt" aria-label="the label"></p>`,
  "img alt empty": `<p><img src="${PNG}" alt=""></p>`,
  "img no alt": `<p><img src="${PNG}"></p>`,
  "figure wrapping an img": `<figure><img src="${PNG}" alt="figure alt"><figcaption>cap</figcaption></figure>`,
  "svg role img": `<p><svg role="img" aria-label="svg label" width="20" height="20"><rect width="20" height="20" fill="#ccc"/></svg></p>`,
};

/** Is the fixture image actually decodable? The check that was missing for ten runs. */
async function imageLoads(browser: Browser): Promise<{ w: number; h: number }> {
  const tab = await browser.newTab();
  try {
    await tab.send("Page.enable");
    const { frameTree } = await tab.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
    await tab.send("Page.setDocumentContent", {
      frameId: frameTree.frame.id,
      html: `<!doctype html><img id="probe" src="${PNG}" alt="x">`,
    });
    await Bun.sleep(400);
    const res = await tab.send("Runtime.evaluate", {
      expression: `(() => { const i = document.getElementById('probe'); return JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight }); })()`,
      returnByValue: true,
    }) as { result?: { value?: string } };
    return JSON.parse(res.result?.value ?? "{}") as { w: number; h: number };
  } finally {
    await tab.close();
  }
}

const profile = await mkdtemp(join(tmpdir(), "letterpress-alt-probe-"));
const browser = await Browser.launch({ profile });
try {
  const probe = await imageLoads(browser);
  console.log(`fixture image: naturalWidth=${probe.w} naturalHeight=${probe.h}` +
    (probe.w > 0 ? "  (decodes)" : "  (BROKEN — every result below would be about the placeholder)"));
  console.log();

  const rows: Array<[string, number, number, string]> = [];
  for (const [name, body] of Object.entries(CASES)) {
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title>` +
      `<style>@page{size:A4;margin:20mm} img{width:20mm}</style><body><p>prose</p>${body}</body>`;
    const r = await render(browser, { html, author: "probe" });
    const parts = trySplit(r.pdf);
    const figures = parts ? structElementsInOrder(parts, "Figure").length : 0;
    const alts = parts
      ? structElementsInOrder(parts, "Figure")
        .map((n) => /\/Alt\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(dictOf(parts.objs.find((o) => o.num === n)!)))
        .filter(Boolean).length
      : 0;
    const codes = r.findings.map((f) => f.code).join(",") || "none";
    rows.push([name, figures, alts, codes]);
  }
  console.log(`  ${"case".padEnd(24)} ${"Figure elems".padEnd(12)} ${"with /Alt".padEnd(10)} findings`);
  for (const [name, figures, alts, codes] of rows) {
    console.log(`  ${name.padEnd(24)} ${String(figures).padEnd(12)} ${String(alts).padEnd(10)} ${codes}`);
  }
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}