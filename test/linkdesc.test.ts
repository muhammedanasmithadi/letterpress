import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import {
  LINK_DESC_JS,
  fixLinkDescs,
  linkAnnotations,
  linkOrder,
  parseLinkDescs,
} from "../src/linkdesc.ts";
import { dictOf, insertIntoDict, trySplit } from "../src/pdfparts.ts";
import { verify } from "../src/verify.ts";

/**
 * Chromium writes a link annotation with no /Contents, and PDF/UA-1 clause 7.18.5
 * fails every link because of it.
 *
 * What these tests protect is the annotation pairing. A Link structure element and its
 * /Link annotation are separate objects whose numbers have no relation, so the pairing
 * has to come from somewhere real. It comes from the structure element's own object
 * reference, and the tests assert the right text lands on the right URI: a repair
 * that put every description on the first annotation would satisfy any check for "a
 * /Contents exists".
 */

const GIF = "data:image/gif;base64,R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==";
const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm}</style><body><p>prose</p>${body}</body>`;

/** Decode a whole delimited PDF string token. */
function decode(token: string): string {
  if (token.startsWith("(")) {
    return token.slice(1, -1)
      .replace(/\\([()\\])/g, "$1")
      .replace(/\\(\d{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  }
  if (!token.startsWith("<")) return token;
  const bytes = Buffer.from(token.slice(1, -1).replace(/\s+/g, ""), "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  }
  return bytes.toString("latin1");
}

/** (uri, contents) per link annotation, in annotation object order. */
function readAnnots(pdf: Uint8Array): Array<[string, string]> {
  const parts = trySplit(pdf);
  if (!parts) throw new Error("unparseable");
  const out: Array<[string, string]> = [];
  for (const o of parts.objs) {
    const text = dictOf(o);
    if (!/\/Subtype \/Link\b/.test(text)) continue;
    const uri = /\/URI\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1] ?? "?";
    const contents = /\/Contents\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(text)?.[1];
    out.push([decode(uri), contents ? decode(contents) : ""]);
  }
  return out;
}

describe("insertIntoDict", () => {
  // The one-liner this replaces is lastIndexOf(">>"), which is wrong whenever a
  // dictionary nests. A struct element whose /K holds an inline object reference
  // dictionary ends in ">> >>" and the last pair belongs to the inner one.
  test("inserts inside the outer dictionary, not a nested one", () => {
    const obj = "5 0 obj\n<</Type /Annot\n/Subtype /Link\n/A <</S /URI\n/URI (https://x.example/)>>\n/StructParent 1>>\nendobj";
    const out = insertIntoDict(obj, "/Contents (hello)");
    // The structural claim, not a formatting one: the entry lands after the nested
    // dictionary has closed and before the outer one does. Whitespace around the
    // insertion point is not the thing being tested.
    const nestedClose = out.indexOf("/URI (https://x.example/)>>") + "/URI (https://x.example/)>>".length;
    const at = out.indexOf("/Contents (hello)");
    const outerClose = out.lastIndexOf(">>");
    expect(at).toBeGreaterThan(nestedClose);
    expect(at).toBeLessThan(outerClose);
    // And the object is still one dictionary rather than two closed and reopened.
    expect(out.endsWith(">>\nendobj")).toBe(true);
  });

  test("inserts into a dictionary with no nesting", () => {
    expect(insertIntoDict("1 0 obj\n<</A 1>>\nendobj", "/B 2")).toBe("1 0 obj\n<</A 1/B 2\n>>\nendobj");
  });

  test("leaves a body with no dictionary alone", () => {
    expect(insertIntoDict("1 0 obj\n42\nendobj", "/B 2")).toBe("1 0 obj\n42\nendobj");
  });
});

describe("parseLinkDescs", () => {
  test("reads a list of strings", () => {
    expect(parseLinkDescs('["alpha","beta"]')).toEqual(["alpha", "beta"]);
  });

  test("reads an empty list", () => {
    expect(parseLinkDescs("[]")).toEqual([]);
  });

  // Anything unexpected yields null, which skips the repair. Guessing would put the
  // wrong description on the wrong link, and these are read aloud.
  test.each([
    ["not json", "nope"],
    ["an object", '{"a":1}'],
    ["a non-string element", '["a",1]'],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, input) => {
    expect(parseLinkDescs(input as unknown)).toBeNull();
  });
});

describe("link descriptions", () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), "letterpress-linkdesc-"));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  // `wanted`, not `expect`: a property called expect would shadow the matcher.
  const CASES: Record<string, { body: string; wanted: Array<[string, string]> }> = {
    "one link": {
      body: `<p><a href="https://a.example/">link-1</a></p>`,
      wanted: [["https://a.example/", "link-1"]],
    },
    "three links": {
      body: `<p><a href="https://a.example/">link-1</a> <a href="https://b.example/">link-2</a> ` +
        `<a href="https://c.example/">link-3</a></p>`,
      wanted: [
        ["https://a.example/", "link-1"],
        ["https://b.example/", "link-2"],
        ["https://c.example/", "link-3"],
      ],
    },
    // Two links, one address. Pairing by address would give both the same text.
    "the same address twice": {
      body: `<p><a href="https://a.example/">first</a> <a href="https://a.example/">second</a></p>`,
      wanted: [["https://a.example/", "first"], ["https://a.example/", "second"]],
    },
    "a link inside a heading, and one in a paragraph": {
      body: `<h2><a href="https://h.example/">heading link</a></h2><p><a href="https://p.example/">para link</a></p>`,
      wanted: [["https://h.example/", "heading link"], ["https://p.example/", "para link"]],
    },
    // An internal link gets a structure element but no annotation, because there is
    // nowhere to go. Pairing by counting would put the second description on the first
    // annotation; pairing by reference leaves the one real annotation correct.
    "an internal link that has no annotation": {
      body: `<p><a href="https://a.example/">ext</a></p><p><a href="#nowhere">int</a></p>`,
      wanted: [["https://a.example/", "ext"]],
    },
    "non-ascii text": {
      body: `<p><a href="https://a.example/">café — 日本語</a></p>`,
      wanted: [["https://a.example/", "café — 日本語"]],
    },
  };

  for (const [name, { body, wanted }] of Object.entries(CASES)) {
    test(`${name}: described on the right annotation`, async () => {
      const r = await render(browser, { html: DOC(body), author: "t" });
      // Every annotation must carry its own distinct description. Chromium writes none
      // of them -- verified by running fixLinkDescs against a file it produced -- so
      // this is the repair's output and not something inherited from the engine.
      expect(readAnnots(r.pdf)).toEqual(wanted);
      expect(verify(r.pdf).ok).toBe(true);
    }, 90_000);
  }

  test("a link wrapping an image is described on both of its annotations", async () => {
    // One Link element, two annotations: the image and the link area. The key is the
    // structure element's own /Obj reference, so both are found without guessing.
    const body = `<p><a href="https://x.example/"><img src="${GIF}" alt="a logo"></a></p>`;
    const r = await render(browser, { html: DOC(body), author: "t" });
    expect(readAnnots(r.pdf)).toEqual([
      ["https://x.example/", "a logo"],
      ["https://x.example/", "a logo"],
    ]);
  }, 90_000);

  test("a document with no links is untouched", async () => {
    const r = await render(browser, { html: DOC("<p>plain</p>"), author: "t" });
    expect(readAnnots(r.pdf)).toEqual([]);
  }, 90_000);

  test("the repair is idempotent", async () => {
    const r = await render(browser, {
      html: DOC(`<p><a href="https://a.example/">alpha</a></p>`), author: "t",
    });
    const once = Buffer.from(r.pdf);
    expect(Buffer.from(fixLinkDescs(r.pdf, ["alpha"])).equals(once)).toBe(true);
  }, 90_000);

  test("a description list of the wrong length changes nothing", async () => {
    const r = await render(browser, {
      html: DOC(`<p><a href="https://a.example/">alpha</a></p>`), author: "t",
    });
    expect(Buffer.from(fixLinkDescs(r.pdf, ["alpha", "beta"])).equals(Buffer.from(r.pdf))).toBe(true);
    expect(Buffer.from(fixLinkDescs(r.pdf, [])).equals(Buffer.from(r.pdf))).toBe(true);
  }, 90_000);

  test("only an object reference dictionary names the annotation", async () => {
    // A /K array also holds the MCID references that name the marked content. Taking
    // every number in it would write a /Contents onto the page's content streams.
    const r = await render(browser, {
      html: DOC(`<p><a href="https://a.example/">alpha</a></p>`), author: "t",
    });
    const parts = trySplit(r.pdf);
    if (!parts) throw new Error("unparseable");
    const link = linkOrder(parts)[0]!;
    const annots = linkAnnotations(parts, link);
    expect(annots).toHaveLength(1);
    const annot = parts.objs.find((o) => o.num === annots[0]!);
    expect(dictOf(annot!)).toMatch(/\/Subtype \/Link\b/);
  }, 90_000);

  test("the page script prefers the visible text, then the image alt, then the address", async () => {
    const tab = await browser.newTab();
    try {
      await tab.send("Page.enable");
      const { frameTree } = await tab.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      await tab.send("Page.setDocumentContent", {
        frameId: frameTree.frame.id,
        html: DOC(
          `<p><a href="https://a.example/">visible</a></p>` +
          `<p><a href="https://b.example/"><img src="${GIF}" alt="from alt"></a></p>` +
          `<p><a href="https://c.example/page"></a></p>`,
        ),
      });
      await Bun.sleep(200);
      const res = await tab.send("Runtime.evaluate", {
        expression: LINK_DESC_JS, returnByValue: true, awaitPromise: false,
      }) as { result?: { value?: unknown } };
      expect(parseLinkDescs(res.result?.value)).toEqual([
        "visible",
        "from alt",
        "https://c.example/page",
      ]);
    } finally {
      await tab.close();
    }
  }, 60_000);
});