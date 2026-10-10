/**
 * Folding per-glyph positioning into TJ arrays must change nothing but the spelling.
 *
 * The first version of this wrote the object header twice. Every check inside the module
 * passed -- the replay said every glyph landed in the same place, because both sides were
 * wrong in the same way -- and so did verify(), which compares content streams and not the
 * header above them. The file rendered blank and extracted as nothing. What caught it was
 * rasterising both files and comparing the pixels, which is why that is the assertion here
 * rather than the replay.
 *
 * The baseline is Chromium's own output, printed here rather than through render(),
 * because render() merges on the way out and a merged file is a fixed point of the
 * transform. Comparing a merge against another merge proves nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { mergeTextRuns, textRunProfile } from "../src/tjmerge.ts";
import { verify } from "../src/verify.ts";
import { pdfText, pdfWords } from "./poppler.ts";

let browser: Browser;
let profile: string;

const DOCS: Array<[name: string, css: string, body: string]> = [
  [
    "prose",
    `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif;font-size:11pt;line-height:1.4}
     p.even{text-align:justify}`,
    `<p>The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. WAVE To.</p>
     <p class="even">A justified paragraph, so the inter-word adjustments are not all the same
     and the merge has to carry every one of them: the quick brown fox again and again.</p>`,
  ],
  [
    "headings and a list",
    `@page{size:A4;margin:20mm} body{font-family:'Noto Sans',sans-serif} h1{font-size:20pt} h2{font-size:14pt} li{margin:2pt}`,
    `<h1>Heading one</h1><p>Some text under it.</p><h2>Heading two</h2>
     <ul><li>first item</li><li>second item</li><li>third item</li></ul>`,
  ],
  [
    "a table",
    `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif} table{border-collapse:collapse;width:100%}
     td,th{border:0.5pt solid #999;padding:3pt}`,
    `<table><tr><th>Item</th><th>Value</th></tr>${Array.from({ length: 25 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>${i * 7}</td></tr>`).join("")}</table>`,
  ],
  [
    "three fonts",
    `@page{size:A4;margin:20mm} body{font-family:'Noto Serif',serif}
     .s{font-family:'Noto Sans',sans-serif} .m{font-family:'Noto Sans Mono',monospace}`,
    `<p>Serif text. <span class="s">Sans text.</span> <span class="m">monospace()</span> Back to serif.</p>`,
  ],
  [
    "glyphs outside the Latin block",
    `@page{size:A4;margin:20mm} body{font-family:'Noto Sans',sans-serif;font-size:12pt}`,
    `<p>Crème brûlée, naïve piñata. 日本語のテキスト Selecting across a fallback font.</p>`,
  ],
];

function page(name: string, css: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title><style>${css}</style>${body}`;
}

/** Chromium's own bytes for this document, with nothing of ours applied. */
async function chromiumPrint(html: string): Promise<Uint8Array> {
  const tab = await browser.newTab("about:blank");
  try {
    await tab.send("Page.enable");
    const frameId = (await tab.send("Page.getFrameTree")).frameTree.frame.id;
    await tab.send("Page.setDocumentContent", { frameId, html });
    const res = await tab.send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateTaggedPDF: true,
      transferMode: "ReturnAsBase64",
    });
    return new Uint8Array(Buffer.from(res.data, "base64"));
  } finally {
    await browser.closeTab(tab);
  }
}

async function rasterise(pdf: Uint8Array, dir: string, tag: string): Promise<Buffer> {
  const path = join(dir, `${tag}.pdf`);
  await Bun.write(path, pdf);
  await Bun.$`pdftoppm -png -r 100 ${path} ${join(dir, tag)}`.quiet();
  return Buffer.from(await Bun.file(join(dir, `${tag}-1.png`)).arrayBuffer());
}

function said(text: { findings: Array<{ code: string; message: string }> }, code: string): string | undefined {
  return text.findings.find((f) => f.code === code)?.message;
}

describe("merging text runs", () => {
  test("the page survives the merge unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-tj-"));
    try {
      for (const [name, css, body] of DOCS) {
        const before = await chromiumPrint(page(name, css, body));
        const { pdf: after, stats } = mergeTextRuns(before);

        // Assert that it happened. Without this the equality assertions below all hold
        // while the transform quietly did nothing.
        expect([name, stats.merged]).not.toEqual([name, 0]);
        expect([name, Buffer.from(after).equals(Buffer.from(before))]).toEqual([name, false]);

        // The text a reader would copy is the same, character for character.
        expect([name, await pdfText(after)]).toEqual([name, await pdfText(before)]);
        // And so is where it sits. Reading the text proves nothing about position: poppler
        // reports the right word whether the glyph is a hundredth of a point out or dead
        // on. The boxes are what catch a wrong advance width, which moves every glyph after
        // it while leaving the characters and the pixels alone.
        const before0 = await pdfWords(before);
        const words = await pdfWords(after);
        expect([name, words.map((w) => w.text)]).toEqual([name, before0.map((w) => w.text)]);
        expect([name, words.length > 0]).toEqual([name, true]);
        for (const [i, word] of words.entries()) {
          const was = before0[i]!;
          expect([name, i, Math.abs(word.xMin - was.xMin) < 0.01]).toEqual([name, i, true]);
          expect([name, i, Math.abs(word.xMax - was.xMax) < 0.01]).toEqual([name, i, true]);
        }
        // The page a reader would look at is the same, pixel for pixel.
        expect([name, (await rasterise(after, dir, "b")).equals(await rasterise(before, dir, "a"))]).toEqual([name, true]);
        // And it is still a PDF rather than a file that happens to parse.
        expect([name, verify(after).ok]).toEqual([name, true]);
        const gs = await Bun.$`gs -o /dev/null -sDEVICE=nullpage ${join(dir, "b.pdf")} 2>&1`.text();
        expect([name, /error/i.test(gs)]).toEqual([name, false]);

        // Chromium emits one show operator per glyph; after the merge every remaining one
        // is a TJ array.
        const profile = textRunProfile(after);
        expect([name, profile.tj]).toEqual([name, profile.showOps]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 300_000);

  test("the pipeline reports what it folded and what it left alone", async () => {
    for (const [name, css, body] of DOCS) {
      const r = await render(browser, { html: page(name, css, body), author: "tj" });
      const message = said(r, "text-runs-merged");
      // Reported for every document. A transform that stays quiet about the runs it
      // refused is indistinguishable from one that is not running.
      expect([name, message !== undefined]).toEqual([name, true]);
      expect([name, /glyph positions verified unchanged/.test(message!)]).toEqual([name, true]);
      expect([name, /left all \d+ text blocks alone/.test(message!)]).toEqual([name, false]);
    }
  }, 300_000);

  test("merging an already merged file changes nothing", async () => {
    const before = await chromiumPrint(page("prose", DOCS[0]![1], DOCS[0]![2]));
    const once = mergeTextRuns(before).pdf;
    const twice = mergeTextRuns(once);
    // A transform that is not a fixed point would move every glyph a second time.
    expect(Buffer.from(twice.pdf).equals(Buffer.from(once))).toBe(true);
    expect(twice.stats.merged).toBe(0);
  }, 120_000);

  test("a file it cannot handle is returned untouched", () => {
    const junk = mergeTextRuns(Buffer.from("not a pdf"));
    expect(Buffer.from(junk.pdf).toString()).toBe("not a pdf");
    expect(junk.stats.merged).toBe(0);

    const bare = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n");
    const empty = mergeTextRuns(new Uint8Array(bare));
    expect(empty.pdf.byteLength).toBe(bare.byteLength);
    expect(empty.stats.blocks).toBe(0);
  });
});

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "lp-tj-profile-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});