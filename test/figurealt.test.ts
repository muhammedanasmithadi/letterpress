import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import {
  FIGURE_ALT_JS,
  figureOrder,
  fixFigureAlts,
  parseFigureAlts,
} from "../src/figurealt.ts";
import { pdfValue } from "../src/meta.ts";
import { verify } from "../src/verify.ts";
import { LATIN1, trySplit } from "../src/pdfparts.ts";

/**
 * Chromium carries an img's alt into a Figure structure element itself when the image
 * loads, so this repair is usually redundant. What is left is the broken-image path
 * and a figure container whose image was never tagged. The description is read from the
 * DOM and written into the structure tree afterwards.
 *
 * An earlier version of this file asserted the opposite -- that Chromium discarded the
 * attribute -- on the strength of ten measured forms. All ten used a base64 string that
 * was not valid base64, so no image ever loaded and what was measured was Chromium's
 * broken-image placeholder. The "the fixture image really is a loadable png" test below
 * exists because a naturalWidth of 0 would have caught it before any of that.
 *
 * What these tests protect is the pairing, not the presence of the key. A repair that
 * put an /Alt on every figure but attached the wrong description to the wrong figure
 * would pass any check for "an /Alt exists" and would be read aloud wrongly, which is
 * worse than saying nothing. So each figure's alt names its own position in the
 * document and the values must come back in that order -- a file-order scan returns
 * nested figures reversed and fails here.
 */

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAV0lEQVR42u3PMQEAAAgDoC251a3g" +
  "LyQgd2XZOwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwZJZBQAAHxVveUAAAAASUVORK5CYII=";

/** A figure whose alt names its own document position. */
const fig = (alt: string, caption: string) =>
  `<figure><img src="${PNG}" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;

const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm} img{width:15mm}</style><body><p>prose</p>${body}</body>`;

/** Decode both string forms: pdfValue writes ASCII as a literal and the rest as hex. */
function decodePdfString(raw: string): string {
  if (raw.startsWith("(")) {
    return raw.slice(1, -1)
      .replace(/\\([()\\])/g, "$1")
      .replace(/\\(\d{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  }
  const bytes = Buffer.from(raw.slice(1, -1).replace(/\s+/g, ""), "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  }
  return bytes.toString(LATIN1);
}

/** The /Alt of every Figure structure element, in structure-tree order. */
function readAlts(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) throw new Error("unparseable");
  const dicts = new Map(parts.objs.map((o) => {
    const text = o.bytes.toString(LATIN1);
    const at = text.search(/\bstream\b/);
    return [o.num, (at === -1 ? text : text.slice(0, at)).trim()] as const;
  }));
  return figureOrder(parts).map((num) => {
    const m = /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(dicts.get(num) ?? "");
    return m ? decodePdfString(m[1]!) : "";
  });
}

describe("pdfValue", () => {
  // The delimiters differ between the two forms, and leaving them out writes a bare
  // token where a value belongs: /Alt fig-1 rather than /Alt (fig-1). No structural
  // check objects to that and the repair's own gate passed, so it is asserted here.
  test("wraps printable ascii in parentheses", () => {
    expect(pdfValue("fig-1")).toBe("(fig-1)");
  });

  test("keeps a hex string's angle brackets", () => {
    expect(pdfValue("café")).toBe("<FEFF00630061006600E9>");
  });

  test("escapes the delimiters inside a literal", () => {
    expect(pdfValue("a (b) c")).toBe("(a \\(b\\) c)");
    expect(pdfValue("back\\slash")).toBe("(back\\\\slash)");
  });

  test("a value outside ascii never becomes a literal", () => {
    // The parens would be literal characters of the string, and the reader would
    // report the author as the whole hex.
    expect(pdfValue("日本語")).not.toContain("(");
  });
});

describe("parseFigureAlts", () => {
  test("reads a list of strings", () => {
    expect(parseFigureAlts('["a","b"]')).toEqual(["a", "b"]);
  });

  test("reads an empty list", () => {
    expect(parseFigureAlts("[]")).toEqual([]);
  });

  // Anything unexpected yields null, which skips the repair. Guessing would risk
  // attaching the wrong description to the wrong figure.
  test.each([
    ["not json", "not json"],
    ["an object", '{"a":1}'],
    ["a non-string element", '["a",1]'],
    ["a number", 42],
    ["undefined", undefined],
    ["null", null],
  ])("refuses %s", (_label, input) => {
    expect(parseFigureAlts(input as unknown)).toBeNull();
  });
});

describe("figure descriptions", () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-figalt-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  const CASES: Record<string, { body: string; alts: string[] }> = {
    "three side by side": {
      body: fig("fig-1", "capA") + fig("fig-2", "capB") + fig("fig-3", "capC"),
      alts: ["fig-1", "fig-2", "fig-3"],
    },
    "one nested inside another": {
      body: `<figure><img src="${PNG}" alt="fig-1"><figcaption>outer` +
        fig("fig-2", "inner") + `</figcaption></figure>`,
      alts: ["fig-1", "fig-2"],
    },
    "three levels deep": {
      body: `<figure><img src="${PNG}" alt="fig-1"><figcaption>c1` +
        `<figure><img src="${PNG}" alt="fig-2"><figcaption>c2` +
        fig("fig-3", "c3") + `</figcaption></figure></figcaption></figure>`,
      alts: ["fig-1", "fig-2", "fig-3"],
    },
    "flat, then nested, then flat": {
      body: fig("fig-1", "x1") +
        `<figure><img src="${PNG}" alt="fig-2"><figcaption>n1` +
        fig("fig-3", "n2") + `</figcaption></figure>` + fig("fig-4", "x2"),
      alts: ["fig-1", "fig-2", "fig-3", "fig-4"],
    },
    "a figure inside a paragraph": {
      body: `<p>${fig("fig-1", "pCap")}</p>` + fig("fig-2", "qCap"),
      alts: ["fig-1", "fig-2"],
    },
  };

  for (const [name, { body, alts }] of Object.entries(CASES)) {
    test(`${name}: described in document order`, async () => {
      const r = await render(browser, { html: DOC(body), author: "t" });
      expect(readAlts(r.pdf)).toEqual(alts);
      expect(verify(r.pdf).ok).toBe(true);
    }, 90_000);
  }

  test("a decorative figure is left undescribed rather than given invented text", async () => {
    const r = await render(browser, { html: DOC(fig("", "decorative") + fig("fig-2", "described")), author: "t" });
    expect(readAlts(r.pdf)).toEqual(["", "fig-2"]);
  }, 90_000);

  test("alt text survives non-ascii and pdf punctuation", async () => {
    const r = await render(browser, {
      html: DOC(fig("café — 日本語", "u1") + fig("a & b < c > d", "u2")),
      author: "t",
    });
    expect(readAlts(r.pdf)).toEqual(["café — 日本語", "a & b < c > d"]);
  }, 90_000);

  test("a figure with two images of its own gets no description", async () => {
    // Guessing which image was meant would attach the wrong text, so neither is used.
    const two = `<figure><img src="${PNG}" alt="one"><img src="${PNG}" alt="two"><figcaption>twoCap</figcaption></figure>`;
    const r = await render(browser, { html: DOC(two + fig("fig-2", "soloCap")), author: "t" });
    expect(readAlts(r.pdf)).toEqual(["", "fig-2"]);
  }, 90_000);

  test("a nested figure's image does not rob its parent of a description", async () => {
    // querySelectorAll is recursive, so a nested figure's image counts against the
    // outer one too: two images, so no description -- and the outer figure, which a
    // reader reaches first, was the one left silent.
    const body = `<figure><img src="${PNG}" alt="outer"><figcaption>outer` +
      fig("inner", "inner") + `</figcaption></figure>`;
    const r = await render(browser, { html: DOC(body), author: "t" });
    expect(readAlts(r.pdf)).toEqual(["outer", "inner"]);
  }, 90_000);

  test("a document with no figures is untouched", async () => {
    const r = await render(browser, { html: DOC("<p>prose only</p>"), author: "t" });
    expect(readAlts(r.pdf)).toEqual([]);
  }, 90_000);

  test("the repair is idempotent", async () => {
    const r = await render(browser, { html: DOC(fig("fig-1", "a") + fig("fig-2", "b")), author: "t" });
    const once = Buffer.from(r.pdf);
    // The DOM is read on every render, so a repair that appended rather than filled
    // in would accumulate /Alt keys on a re-run over the same bytes.
    expect(Buffer.from(fixFigureAlts(r.pdf, ["fig-1", "fig-2"])).equals(once)).toBe(true);
  }, 90_000);

  test("a list that does not match the figure count changes nothing", async () => {
    const r = await render(browser, { html: DOC(fig("fig-1", "a")), author: "t" });
    expect(Buffer.from(fixFigureAlts(r.pdf, ["fig-1", "fig-2"])).equals(Buffer.from(r.pdf))).toBe(true);
    expect(Buffer.from(fixFigureAlts(r.pdf, [])).equals(Buffer.from(r.pdf))).toBe(true);
  }, 90_000);

  test("the page script reports one entry per figure, in document order", async () => {
    // Counted against the live DOM, because the bug this guards was in the counting:
    // the script ran fine and returned a well-formed list of the wrong length.
    const tab = await browser.newTab();
    try {
      await tab.send("Page.enable");
      const { frameTree } = await tab.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      await tab.send("Page.setDocumentContent", {
        frameId: frameTree.frame.id,
        html: DOC(fig("outer", "o") + fig("inner", "i")),
      });
      await Bun.sleep(200);
      const res = await tab.send("Runtime.evaluate", {
        expression: FIGURE_ALT_JS, returnByValue: true, awaitPromise: false,
      }) as { result?: { value?: unknown } };
      expect(parseFigureAlts(res.result?.value)).toEqual(["outer", "inner"]);
    } finally {
      await tab.close();
    }
  }, 60_000);
});
describe("what Chromium does with an image's alt", () => {
  // The premise this file originally rested on was that Chromium discards the
  // attribute. It does not: with an image that loads, Chromium tags the image as a
  // nested Figure element and carries the alt itself. The ten forms that "proved"
  // otherwise used a base64 string that was not valid base64, so no image ever loaded.
  //
  // These tests pin the behaviour that is actually true, so the premise cannot be
  // re-invented from another broken fixture.

  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-figalt-premise-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  /** A one-pixel PNG, so the image genuinely loads rather than becoming a placeholder. */
  const REAL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("the fixture image really is a loadable png", async () => {
    const tab = await browser.newTab();
    try {
      await tab.send("Page.enable");
      const { frameTree } = await tab.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      await tab.send("Page.setDocumentContent", {
        frameId: frameTree.frame.id,
        html: `<!doctype html><img id="probe" src="${REAL}" alt="x">`,
      });
      await Bun.sleep(400);
      const res = await tab.send("Runtime.evaluate", {
        expression: `(() => { const i = document.getElementById('probe'); return JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight }); })()`,
        returnByValue: true,
      }) as { result?: { value?: string } };
      // naturalWidth is 0 for an image the browser could not decode. This is the check
      // that would have caught the invalid base64 before ten measurements were taken
      // on the strength of it.
      expect(JSON.parse(res.result?.value ?? "{}")).toEqual({ w: 1, h: 1 });
    } finally {
      await tab.close();
    }
  }, 60_000);

  test("chromium tags the image and carries the alt itself", async () => {
    const r = await render(browser, {
      html: DOC(`<p>before <img src="${REAL}" alt="the alt text"> after</p>`), author: "t",
    });
    const alts = readAlts(r.pdf);
    expect(alts).toContain("the alt text");
    // No finding at all: a loadable inline image is not a subresource failure.
    expect(r.findings.map((f) => f.code)).not.toContain("subresource-failed");
  }, 90_000);

  test("an img with no alt gets a Figure with no alt, and nothing is invented", async () => {
    const r = await render(browser, {
      html: DOC(`<p>before <img src="${REAL}"> after</p>`), author: "t",
    });
    expect(readAlts(r.pdf).filter((a) => a.length > 0)).toEqual([]);
  }, 90_000);

  test("the repair is a no-op when chromium already described the figure", async () => {
    // Measured: run against a real document it returned its input byte for byte,
    // because the PDF holds two Figure elements for one figure in the document.
    const html = DOC(fig("the alt text", "capA") + fig("second alt", "capB"));
    const r = await render(browser, { html, author: "t" });
    expect(Buffer.from(fixFigureAlts(r.pdf, ["the alt text"])).equals(Buffer.from(r.pdf))).toBe(true);
  }, 90_000);
});
