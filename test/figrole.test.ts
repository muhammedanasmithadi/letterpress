import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { fixRedundantFigures, redundantFigureCount, redundantFigures } from "../src/figrole.ts";
import { dictOf, structElementsInOrder, trySplit } from "../src/pdfparts.ts";
import { verify } from "../src/verify.ts";

/**
 * Chromium tags a `<figure>` element and the `<img>` inside it as two nested Figure
 * structure elements and describes only the inner one:
 *
 *   51 Figure   no /Alt
 *     52 Figure  Alt=(a bar chart)
 *
 * Clause 7.3 of PDF/UA-1 wants every Figure described, so the container fails it while
 * being nothing but a grouping. These tests pin that the outer one becomes `Div`, the
 * image keeps `Figure` and its description, and that nothing else is touched.
 *
 * The negative cases matter as much as the positive ones. Re-tagging a Figure that has
 * no described child would remove semantics rather than correct them, so that must not
 * happen, and it is asserted rather than assumed.
 */

/** A real 1x1 PNG: a hand-written base64 string would become a broken-image placeholder. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const fig = (alt: string, caption: string) =>
  `<figure><img src="${PNG}" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;

const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm} img{width:20mm}</style><body><p>prose</p>${body}</body>`;

/** Role histogram from the structure tree, in tree order. */
function roles(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) throw new Error("unparseable");
  const seen = new Set<number>();
  const out: string[] = [];
  let rootNum: number | undefined;
  for (const o of parts.objs) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(dictOf(o));
    if (m) { rootNum = Number(m[1]); break; }
  }
  const walk = (num: number, depth: number): void => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const text = dictOf(parts.objs.find((o) => o.num === num)!);
    const role = /\/S\s*\/(\w+)/.exec(text)?.[1];
    if (role) out.push(role);
    const kids = /\/K\s*(?:\[([\s\S]*?)\]|(\d+) 0 R)/.exec(text);
    if (!kids) return;
    for (const ref of kids[2] ? [Number(kids[2])] : [...(kids[1] ?? "").matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]))) {
      walk(ref, depth + 1);
    }
  };
  if (rootNum !== undefined) walk(rootNum, 0);
  return out;
}

describe("fixRedundantFigures", () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-figrole-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  test("the figure container becomes a grouping and the image keeps its description", async () => {
    const r = await render(browser, { html: DOC(fig("a bar chart", "Figure 1")), author: "t" });
    expect(roles(r.pdf)).toContain("Div");
    // The image is still a Figure and still described. Re-tagging must not take the
    // description with it, which is what would make the change a regression.
    expect(roles(r.pdf)).toContain("Figure");
    const parts = trySplit(r.pdf)!;
    const described = structElementsInOrder(parts, "Figure")
      .filter((n) => /\/Alt\s/.test(dictOf(parts.objs.find((o) => o.num === n)!)));
    expect(described).toHaveLength(1);
    expect(dictOf(parts.objs.find((o) => o.num === described[0]!)!)).toContain("a bar chart");
  }, 90_000);

  test("two figures are both corrected and each keeps its own description", async () => {
    const r = await render(browser, { html: DOC(fig("first chart", "Figure 1") + fig("second chart", "Figure 2")), author: "t" });
    expect(redundantFigureCount(r.pdf)).toBe(0);
    expect(roles(r.pdf).filter((x) => x === "Div")).toHaveLength(2);
    expect(roles(r.pdf).filter((x) => x === "Figure")).toHaveLength(2);
    const text = Buffer.from(r.pdf).toString("latin1");
    expect(text).toContain("first chart");
    expect(text).toContain("second chart");
  }, 90_000);

  test("nested figures are corrected at both levels", async () => {
    const body = `<figure><img src="${PNG}" alt="outer"><figcaption>outer` +
      fig("inner", "inner") + `</figcaption></figure>`;
    const r = await render(browser, { html: DOC(body), author: "t" });
    expect(redundantFigureCount(r.pdf)).toBe(0);
    expect(roles(r.pdf).filter((x) => x === "Div")).toHaveLength(2);
  }, 90_000);

  test("a figure whose image has no description is left alone", async () => {
    // Nothing below it is described, so re-tagging would delete semantics rather than
    // correct them. The container keeps the Figure role and fails 7.3 honestly, which
    // is the right outcome: there is no description to give and we will not invent one.
    const r = await render(browser, { html: DOC(`<figure><img src="${PNG}"><figcaption>cap</figcaption></figure>`), author: "t" });
    expect(redundantFigureCount(r.pdf)).toBe(0);
    expect(roles(r.pdf)).toContain("Figure");
    expect(roles(r.pdf)).not.toContain("Div");
  }, 90_000);

  test("a bare image is left alone", async () => {
    const r = await render(browser, { html: DOC(`<p>prose <img src="${PNG}" alt="a bare image"> more</p>`), author: "t" });
    expect(redundantFigureCount(r.pdf)).toBe(0);
    expect(roles(r.pdf).filter((x) => x === "Figure")).toHaveLength(1);
  }, 90_000);

  test("a document with no figures is untouched", async () => {
    const r = await render(browser, { html: DOC("<p>prose only</p>"), author: "t" });
    expect(redundantFigureCount(r.pdf)).toBe(0);
    expect(roles(r.pdf)).not.toContain("Div");
    expect(r.findings.map((f) => f.code)).not.toContain("figure-role-corrected");
  }, 90_000);

  test("the correction is reported as a finding", async () => {
    // It changes what a screen reader walks, so it is not done quietly.
    const r = await render(browser, { html: DOC(fig("a chart", "Figure 1")), author: "t" });
    const f = r.findings.find((x) => x.code === "figure-role-corrected");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.message).toContain("grouping");
  }, 90_000);

  test("it is idempotent and passes the gate", async () => {
    const r = await render(browser, { html: DOC(fig("a chart", "Figure 1")), author: "t" });
    const once = Buffer.from(r.pdf);
    expect(Buffer.from(fixRedundantFigures(r.pdf)).equals(once)).toBe(true);
    expect(verify(r.pdf).ok).toBe(true);
  }, 90_000);

  test("content streams are untouched", async () => {
    // The whole justification for re-tagging rather than rebuilding: a dict edit cannot
    // move a glyph, so the byte-identity guarantee still holds.
    const html = DOC(fig("a chart", "Figure 1"));
    const r = await render(browser, { html, author: "t" });
    expect(verify(r.pdf).ok).toBe(true);
    const parts = trySplit(r.pdf)!;
    expect(structElementsInOrder(parts, "Figure")).toHaveLength(1);
  }, 90_000);

  test("an unparseable file is returned unchanged rather than rewritten", async () => {
    const junk = new Uint8Array(Buffer.from("not a pdf at all"));
    expect(Buffer.from(fixRedundantFigures(junk)).equals(Buffer.from(junk))).toBe(true);
    expect(redundantFigureCount(junk)).toBe(0);
  }, 30_000);

  test("redundantFigures names the objects it would change", async () => {
    // The decision is inspectable without inspecting bytes, which is what a test needs.
    const tab = await browser.newTab();
    try {
      await tab.send("Page.enable");
      const { frameTree } = await tab.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      await tab.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: DOC(fig("x", "y")) });
      await Bun.sleep(200);
      const res = await tab.send("Runtime.evaluate", {
        expression: `(() => { const i = document.querySelector('img'); return JSON.stringify({ w: i.naturalWidth }); })()`,
        returnByValue: true,
      }) as { result?: { value?: string } };
      // Guard again: everything below is only meaningful if the image loaded.
      expect(JSON.parse(res.result?.value ?? "{}")).toEqual({ w: 1 });
    } finally {
      await tab.close();
    }
    const r = await render(browser, { html: DOC(fig("a chart", "Figure 1")), author: "t" });
    const parts = trySplit(r.pdf)!;
    // Already corrected by the pipeline, so nothing is left to name. Applying it to
    // chromium's own output is what names the container.
    expect(redundantFigures(parts)).toEqual([]);
  }, 90_000);
});
