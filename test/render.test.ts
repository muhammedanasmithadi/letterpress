import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render, stageAssets } from "../src/render.ts";
import { pdfFonts, pdfImages, pdfInfo, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "letterpress-test-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm }
@page { @bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif } }
body { font-family: 'Noto Kufi Arabic', sans-serif; margin: 0 }
h1 { color: #123; font-size: 20pt }
.box { width: 40mm; height: 20mm; background: #cde; border: 1pt solid #456 }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums }
td, th { border: 0.5pt solid #999; padding: 2pt }
thead { display: table-header-group }
tr { break-inside: avoid }
</style></head><body>
<h1>Acceptance document</h1>
<p>Vector text, an Arabic line, and a CSS shape.</p>
<p lang="ar" dir="rtl">فاتورة اختبارية</p>
<div class="box"></div>
<table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
${Array.from({ length: 30 }, (_, i) => `<tr><td>Line ${i + 1}</td><td>${(i % 5) + 1}</td><td>${(9.5 + i).toFixed(2)}</td></tr>`).join("")}
</tbody></table>
</body></html>`;

test("renders the paper size the document declares, exactly", async () => {
  const r = await render(browser, { html: DOC });
  expect(r.info.pages).toBeGreaterThan(0);

  // poppler's own reading of the page geometry
  const info = await pdfInfo(r.pdf);
  expect(info.pages).toBe(r.info.pages);
  expect(info.pageSize).toContain("594.96");
  expect(info.pageSize).toContain("841.92");

  const box = r.info.mediaBoxes[0].match(/\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)!;
  expect(Number(box[3]) - Number(box[1])).toBeCloseTo(594.96, 1);
  expect(Number(box[4]) - Number(box[2])).toBeCloseTo(841.92, 1);
}, 30_000);

test("output is vector text with no raster image objects", async () => {
  const r = await render(browser, { html: DOC });

  expect(await pdfImages(r.pdf)).toHaveLength(0);
  expect(r.info.imageObjects).toBe(0);
  expect(r.info.type0Fonts).toBeGreaterThan(0);
  expect(r.info.toUnicodeMaps).toBeGreaterThan(0);
  expect(r.info.producer).toContain("Skia/PDF");
  expect(r.info.tagged).toBe(true);
  expect(r.info.outlineTitles).toContain("Acceptance document");

  const fonts = await pdfFonts(r.pdf);
  const rows = fonts.split("\n").slice(2).filter((l) => l.trim().length > 0);
  expect(rows.length).toBeGreaterThan(1);
  // every font must be embedded, subset, and carry a Unicode map, or the text
  // is neither portable nor selectable
  for (const row of rows) expect(row).toMatch(/\byes\s+yes\s+yes\b/);
  expect(fonts).toMatch(/Arabic/i);
}, 30_000);

test("text is extractable, in Latin and in Arabic", async () => {
  const r = await render(browser, { html: DOC });
  const text = await pdfText(r.pdf);
  expect(text).toContain("Acceptance document");
  expect(text).toContain("Vector text");
  // Arabic survived shaping and is recoverable through the ToUnicode map
  expect(text.replace(/\s+/g, "")).toContain("فاتورةاختبارية");
}, 30_000);

test("CSS margin boxes place real page numbers in the footer", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>
@page { size: A4; margin: 15mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 10pt sans-serif } }
body { font-family: sans-serif }
</style><p>one</p><p style="break-before:page">two</p><p style="break-before:page">three</p>`;
  const r = await render(browser, { html: doc });
  expect(r.info.pages).toBe(3);
  const text = await pdfText(r.pdf);
  expect(text).toContain("page 1 of 3");
  expect(text).toContain("page 3 of 3");
}, 30_000);

test("remote requests are blocked by default and reported as findings", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css">
<img src="https://example.invalid/a.png" width="10" height="10">
<p>Still renders.</p>`;
  const r = await render(browser, { html: doc });
  expect(r.blocked.length).toBeGreaterThanOrEqual(2);
  expect(r.blocked.some((u) => u.includes("example.invalid"))).toBe(true);
  expect(r.findings.map((f) => f.code)).toContain("network-blocked");
  expect(r.findings.find((f) => f.code === "network-blocked")!.url).toBeTruthy();
  expect(r.info.pages).toBeGreaterThan(0);
}, 30_000);

test("allowing network clears the findings", async () => {
  const doc = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<p>No remote assets here.</p>`;
  const r = await render(browser, { html: doc, allowNetwork: true });
  expect(r.blocked).toHaveLength(0);
  expect(r.findings.filter((f) => f.code === "network-blocked")).toHaveLength(0);
}, 30_000);

test("a request format overrides the document and says so", async () => {
  const r = await render(browser, { html: DOC, format: "letter" });
  const finding = r.findings.find((f) => f.code === "page-size-override");
  expect(finding).toBeTruthy();
  // Informational: the request is applied, so this records what happened rather
  // than warning about a problem. Letter is the paper that was asked for.
  expect(finding!.severity).toBe("info");
  const info = await pdfInfo(r.pdf);
  expect(info.pageSize).toMatch(/612/);
}, 30_000);

test("a hanging document fails with an error instead of hanging", async () => {
  const hanging = createServer(() => { /* accept, never answer */ });
  await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", () => r()));
  const port = (hanging.address() as { port: number }).port;

  const started = Bun.nanoseconds();
  let message = "";
  try {
    // preferFastPath off so the document really navigates: the fast path
    // installs HTML with no load event, so there is nothing left to stall.
    await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><img src="http://127.0.0.1:${port}/stall.png"><p>never finishes</p>`,
      allowNetwork: true,
      preferFastPath: false,
      timeoutMs: 2_000,
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
  hanging.close();

  // Whichever phase stalls, the message must name the deadline rather than
  // surfacing the raw socket error the closed tab produces.
  expect(message).toMatch(/navigation did not finish|printing exceeded/);
  expect(message).not.toContain("cdp socket closed");
  expect(elapsedMs).toBeLessThan(20_000);
}, 40_000);

test("the browser still renders after a timeout", async () => {
  const r = await render(browser, { html: DOC });
  expect(r.info.pages).toBeGreaterThan(0);
  expect(await pdfImages(r.pdf)).toHaveLength(0);
}, 30_000);

test("concurrent renders all succeed and agree on page count", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => render(browser, { html: DOC.replace("Acceptance document", `Doc ${i}`) })),
  );
  for (const r of results) expect(r.info.pages).toBeGreaterThan(0);
  expect(new Set(results.map((r) => r.info.pages)).size).toBe(1);
}, 60_000);

/* ------------------------------------------------------------------ *
 * A stylesheet brings its own references with it
 *
 * Staging read the document and nothing else, so a document whose CSS imported further
 * CSS lost everything past the first hop. Measured on a real site whose stylesheet opens
 * with sixteen `@import` lines: one file staged, sixteen missing, and the render reported
 * one failed subresource for each -- among them print.css, which for a renderer whose
 * whole job is printing is the worst file to be missing.
 *
 * Their paths resolve against the importing stylesheet's directory, not the document's.
 * ------------------------------------------------------------------ */

/** Every staged file under `dir`, as sorted paths relative to it. */
const staged = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  await walk(dir, "");
  return out.sort();
};

describe("stageAssets", () => {
  /** A small site on disk, plus an empty work directory to stage into. */
  async function site(): Promise<{ root: string; work: string }> {
    const root = await mkdtemp(join(tmpdir(), "lp-site-"));
    const work = await mkdtemp(join(tmpdir(), "lp-work-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(join(root, "fonts"), { recursive: true });
    await writeFile(join(root, "assets", "tokens.css"), ":root { --ink: #123 }\n");
    await writeFile(join(root, "assets", "print.css"), "@page { size: A4 }\n");
    await writeFile(join(root, "fonts", "body.woff2"), "not really a font");
    await writeFile(join(root, "assets", "main.css"), [
      '@import url("tokens.css");',
      '@import url("print.css");',
      '@font-face { src: url("../fonts/body.woff2"); }',
    ].join("\n"));
    return { root, work };
  }

  test("follows a stylesheet's own imports and url() targets", async () => {
    const { root, work } = await site();
    try {
      await stageAssets('<link rel="stylesheet" href="assets/main.css">', join(root, "index.html"), work);
      expect(await staged(work)).toEqual([
        "assets/main.css",
        "assets/print.css",
        "assets/tokens.css",
        // A url() resolving up out of assets/ but staying inside the document's tree.
        "fonts/body.woff2",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("two stylesheets importing each other terminate", async () => {
    const { root, work } = await site();
    try {
      await writeFile(join(root, "assets", "a.css"), '@import url("b.css");\n');
      await writeFile(join(root, "assets", "b.css"), '@import url("a.css");\n');
      await stageAssets('<link rel="stylesheet" href="assets/a.css">', join(root, "index.html"), work);
      expect(await staged(work)).toEqual(["assets/a.css", "assets/b.css"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("follows a script's own module imports", async () => {
    // The renderer already stages <script src>, so it has decided scripts affect the
    // printed page. A script that pulls in a sibling was being lost silently.
    const { root, work } = await site();
    try {
      await writeFile(join(root, "assets", "site.js"), "export const x = 1;\n");
      await writeFile(join(root, "assets", "widget.js"), "import './site.js';\n");
      await stageAssets('<script type="module" src="assets/widget.js"></script>', join(root, "index.html"), work);
      expect(await staged(work)).toEqual(["assets/site.js", "assets/widget.js"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("a computed specifier is left alone rather than guessed at", async () => {
    const { root, work } = await site();
    try {
      await writeFile(join(root, "assets", "dyn.js"), 'const n = "site"; import(`./${n}.js`);\n');
      await stageAssets('<script type="module" src="assets/dyn.js"></script>', join(root, "index.html"), work);
      expect(await staged(work)).toEqual(["assets/dyn.js"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("a stylesheet cannot walk out of the document's own directory", async () => {
    // The containment rule is unchanged by following imports: paths resolve against the
    // importing file's directory, and a target outside the root is still refused.
    const { root, work } = await site();
    const outside = await mkdtemp(join(tmpdir(), "lp-outside-"));
    try {
      await writeFile(join(outside, "secret.css"), "body { color: red }\n");
      await writeFile(join(root, "assets", "evil.css"), '@import url("../../../../../../etc/hostname");\n');
      await stageAssets('<link rel="stylesheet" href="assets/evil.css">', join(root, "index.html"), work);
      expect(await staged(work)).toEqual(["assets/evil.css"]);
    } finally {
      for (const d of [root, work, outside]) await rm(d, { recursive: true, force: true });
    }
  });
});


/* ------------------------------------------------------------------ *
 * A document in a subdirectory referencing ../assets
 *
 * The staging sandbox allowed a file only under the document's own directory, so
 * `site/lessons/x.html` referencing `../assets/styles.css` -- ordinary layout, and how
 * most sites are laid out -- was refused. Measured on a real ten-page site: eight pages
 * rendered with no stylesheet at all, and the only symptom was a failed subresource
 * naming a stylesheet that had loaded perfectly well.
 *
 * Widening is the caller's decision, because guessing wrong either loses a document's
 * assets or opens a filesystem boundary. The default is unchanged.
 * ------------------------------------------------------------------ */

describe("the asset root", () => {
  /** A site with the page in a subdirectory and its assets in the parent. */
  async function site(): Promise<{ root: string; work: string }> {
    const root = await mkdtemp(join(tmpdir(), "lp-root-site-"));
    const work = await mkdtemp(join(tmpdir(), "lp-root-work-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(join(root, "lessons"), { recursive: true });
    await writeFile(join(root, "assets", "styles.css"), "body { color: #123 }\n");
    return { root, work };
  }

  const has = async (dir: string, rel: string) => {
    try { await readdir(join(dir, rel)); return true; } catch { return false; }
  };

  test("by default a ../ reference is refused and reported, not silently dropped", async () => {
    const { root, work } = await site();
    const page = join(root, "lessons", "x.html");
    try {
      await writeFile(page, '<link rel="stylesheet" href="../assets/styles.css">');
      const html = await Bun.file(page).text();
      const refused = await stageAssets(html, page, work);
      expect(await has(work, "assets")).toBe(false);
      // And the caller is told which path and which flag, not just that something failed.
      // Reported whether or not the file is there: checking would make this a yes/no
      // oracle over arbitrary paths, which `server.ts` hands to whoever asked.
      expect(refused).toEqual([{ ref: "../assets/styles.css", abs: join(root, "assets", "styles.css"), why: "outside-root" }]);
    } finally {
      for (const d of [root, work]) await rm(d, { recursive: true, force: true });
    }
  });

  test("a named root allows it, and only within that root", async () => {
    const { root, work } = await site();
    const page = join(root, "lessons", "x.html");
    const outside = await mkdtemp(join(tmpdir(), "lp-root-out-"));
    try {
      await writeFile(page, [
        '<link rel="stylesheet" href="../assets/styles.css">',
        // One level further than the root reaches: still refused, because the root is a
        // boundary and not a suggestion.
        '<img src="../../secret.png">',
      ].join("\n"));
      await writeFile(join(outside, "secret.png"), "not really a png");
      const html = await Bun.file(page).text();
      await stageAssets(html, page, work, root);
      expect(await has(work, "assets")).toBe(true);
      // The thing that matters is what reached the work directory, not what was
      // reported. A refusal is the safe outcome; reading the file is not.
      expect(await staged(work)).toEqual(["assets/styles.css"]);
    } finally {
      for (const d of [root, work, outside]) await rm(d, { recursive: true, force: true });
    }
  });

  test("the root does not change what a relative path means", async () => {
    // It bounds where a resolved path may land. Two documents in different directories
    // both say `assets/styles.css`, and with one root each still resolves against itself.
    const { root, work } = await site();
    const page = join(root, "lessons", "x.html");
    try {
      await writeFile(page, '<link rel="stylesheet" href="assets/styles.css">');
      const html = await Bun.file(page).text();
      // Relative to the document, that is lessons/assets/styles.css -- which does not
      // exist -- so naming the parent root must not paper over it.
      await stageAssets(html, page, work, root);
      expect(await has(work, "assets")).toBe(false);
    } finally {
      for (const d of [root, work]) await rm(d, { recursive: true, force: true });
    }
  });
  test("a sibling of the document still loads when --root is given", async () => {
    // Found by an audit subagent, not by a test. Staging was filesystem-root-relative
    // while the document is served at `<origin>/input.html`, so relative paths resolve
    // against `/` and not against the document's directory. The `../assets` half of the
    // original fix happened to work -- `..` clamps to the same string either way -- and
    // `sibling.css`, the common case, was staged where nothing asked for it.
    const root = await mkdtemp(join(tmpdir(), "lp-sib-"));
    const work = await mkdtemp(join(tmpdir(), "lp-sibw-"));
    try {
      await mkdir(join(root, "assets"), { recursive: true });
      await mkdir(join(root, "lessons"), { recursive: true });
      await writeFile(join(root, "assets", "styles.css"), "body { color: #123 }\n");
      await writeFile(join(root, "lessons", "sibling.css"), "body { color: #456 }\n");
      const page = join(root, "lessons", "x.html");
      await writeFile(page, [
        '<link rel="stylesheet" href="../assets/styles.css">',
        '<link rel="stylesheet" href="sibling.css">',
      ].join("\n"));

      const html = await Bun.file(page).text();
      await stageAssets(html, page, work, root);
      // Both land where the browser, resolving from `/`, will ask for them.
      expect(await staged(work)).toEqual(["assets/styles.css", "sibling.css"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("a reference climbing above the origin clamps there, as a browser's does", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-clamp-"));
    const work = await mkdtemp(join(tmpdir(), "lp-clampw-"));
    try {
      // Three levels below the root, so `../../../` reaches it exactly. Two levels
      // climbed past it, and the containment check refused -- correctly, and a reminder
      // that the boundary is the filesystem's and not the URL's.
      await mkdir(join(root, "a", "b", "c"), { recursive: true });
      await writeFile(join(root, "a.css"), "a{}\n");
      const page = join(root, "a", "b", "c", "x.html");
      await writeFile(page, "");
      // Three levels up from deep/deeper, clamped at the origin: the browser asks for
      // /a.css. Needs a named root to get that far -- without one the reference is
      // outside the document's own directory and is refused outright.
      await stageAssets('<link rel="stylesheet" href="../../../a.css">', page, work, root);
      expect(await staged(work)).toEqual(["a.css"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("a reference still outside the named root is reported, not swallowed", async () => {
    // The finding used to be gated on `!req.root`, so passing the flag the finding asks
    // for was exactly what silenced it.
    const root = await mkdtemp(join(tmpdir(), "lp-rep-"));
    const work = await mkdtemp(join(tmpdir(), "lp-repw-"));
    const outside = await mkdtemp(join(tmpdir(), "lp-repo-"));
    try {
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "assets", "s.css"), "body{color:#123}\n");
      await writeFile(join(outside, "far.css"), "body{color:#456}\n");
      const page = join(root, "x.html");
      const html = `<link rel="stylesheet" href="assets/s.css"><link rel="stylesheet" href="../${basename(outside)}/far.css">`;
      const refused = await stageAssets(html, page, work, root);
      expect(await staged(work)).toEqual(["assets/s.css"]);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.abs).toBe(join(outside, "far.css"));
    } finally {
      for (const d of [root, work, outside]) await rm(d, { recursive: true, force: true });
    }
  });
  test("a refusal does not depend on whether the file is there", async () => {
    // An existence check made this a yes/no oracle over arbitrary paths: POST a document
    // naming /etc/passwd and get a finding, name a path that is not there and get none.
    // `server.ts` hands findings to whoever made the request, so existence and canonical
    // path were disclosed to anyone who could POST. The content was refused either way.
    const root = await mkdtemp(join(tmpdir(), "lp-oracle-"));
    const work = await mkdtemp(join(tmpdir(), "lp-oraclew-"));
    try {
      await writeFile(join(root, "x.html"), "");
      const page = join(root, "x.html");
      const html = [
        '<img src="../../../../../../etc/passwd">',
        '<img src="../../../../../../etc/definitely-not-here-xyz">',
      ].join("\n");
      const refused = await stageAssets(html, page, work);
      expect(refused).toHaveLength(2);
      // Same shape either way: the answer does not reveal which paths exist.
      expect(refused.every((r) => typeof r.abs === "string" && r.abs.startsWith("/"))).toBe(true);
      expect(await staged(work)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
  test("a symlink cannot pull a file in from outside the root", async () => {
    // The prefix test reads the path as written, and a symlink does not care. Measured:
    // `site/assets/link.txt` -> /tmp/elsewhere/secret.txt passed the check, was read, and
    // was served over loopback. The boundary is checked against the resolved path instead,
    // with the root resolved too so a root reached through a link still matches its own
    // contents.
    const root = await mkdtemp(join(tmpdir(), "lp-sym-"));
    const work = await mkdtemp(join(tmpdir(), "lp-symw-"));
    const outside = await mkdtemp(join(tmpdir(), "lp-symout-"));
    try {
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "assets", "ok.css"), "body{color:#123}\n");
      await writeFile(join(outside, "secret.txt"), "SECRET-OUTSIDE-ROOT");
      await symlink(join(outside, "secret.txt"), join(root, "assets", "link.txt"));
      const page = join(root, "x.html");
      await writeFile(page, '<link rel="stylesheet" href="assets/link.txt">');
      const refused = await stageAssets(await Bun.file(page).text(), page, work);

      expect(await staged(work)).toEqual([]);
      expect(refused.map((r) => r.abs)).toEqual([join(outside, "secret.txt")]);
    } finally {
      for (const d of [root, work, outside]) await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("a symlink that stays inside the root still works", async () => {
    // Sites use them constantly; refusing all of them would be a worse bug than the one
    // being fixed.
    const root = await mkdtemp(join(tmpdir(), "lp-sym2-"));
    const work = await mkdtemp(join(tmpdir(), "lp-sym2w-"));
    try {
      await mkdir(join(root, "assets"), { recursive: true });
      await mkdir(join(root, "shared"), { recursive: true });
      await writeFile(join(root, "shared", "real.css"), "body{color:#123}\n");
      await symlink(join(root, "shared", "real.css"), join(root, "assets", "alias.css"));
      const page = join(root, "x.html");
      await writeFile(page, '<link rel="stylesheet" href="assets/alias.css">');
      const refused = await stageAssets(await Bun.file(page).text(), page, work);

      expect(await staged(work)).toEqual(["assets/alias.css"]);
      expect(refused).toEqual([]);
      expect(await Bun.file(join(work, "assets", "alias.css")).text()).toBe("body{color:#123}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);
  test("a document reached through a symlink to its site still finds its assets", async () => {
    // A regression from 1e1bf89, found by an audit subagent. The boundary was checked in
    // two places: once on the resolved root and once on the path as written. Comparing a
    // resolved root against an unresolved path refuses a sibling that is not actually
    // outside anything, so a page served under a link to its site lost its stylesheet and
    // was told to pass --root for a path already inside the directory it had named.
    const parent = await mkdtemp(join(tmpdir(), "lp-symlinkdoc-"));
    const work = await mkdtemp(join(tmpdir(), "lp-symlinkdocw-"));
    try {
      await mkdir(join(parent, "site", "lessons"), { recursive: true });
      await writeFile(join(parent, "site", "lessons", "sibling.css"), "body{color:#123}\n");
      await writeFile(join(parent, "site", "lessons", "p.html"), '<link rel="stylesheet" href="sibling.css">');
      await symlink(join(parent, "site"), join(parent, "aslink"));

      const page = join(parent, "aslink", "lessons", "p.html");
      const refused = await stageAssets(await Bun.file(page).text(), page, work);
      expect(refused).toEqual([]);
      expect(await staged(work)).toEqual(["sibling.css"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);

  test("the same document under --root named through the link behaves identically", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lp-symlinkroot-"));
    const work = await mkdtemp(join(tmpdir(), "lp-symlinkrootw-"));
    try {
      await mkdir(join(parent, "site", "lessons"), { recursive: true });
      await writeFile(join(parent, "site", "lessons", "sibling.css"), "body{color:#123}\n");
      await writeFile(join(parent, "site", "lessons", "p.html"), '<link rel="stylesheet" href="sibling.css">');
      await symlink(join(parent, "site"), join(parent, "aslink"));

      const page = join(parent, "aslink", "lessons", "p.html");
      const refused = await stageAssets(await Bun.file(page).text(), page, work, join(parent, "aslink"));
      expect(refused).toEqual([]);
      expect(await staged(work)).toEqual(["sibling.css"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);
  test("an asset named after the served document is not staged over it", async () => {
    // Found by an audit subagent, and reproduced before fixing: a document linking a file
    // called input.html -- an ordinary name to choose -- had it staged over the served
    // copy. The caller asked for p.html and the render printed input.html's content, with
    // no finding at all.
    const root = await mkdtemp(join(tmpdir(), "lp-self-"));
    const work = await mkdtemp(join(tmpdir(), "lp-selfw-"));
    try {
      await writeFile(join(root, "input.html"), "<p>THE DECOY</p>");
      await writeFile(join(root, "p.html"), '<link rel="stylesheet" href="input.html"><p>THE DOCUMENT</p>');
      const page = join(root, "p.html");
      await Bun.write(join(work, "input.html"), "<p>THE DOCUMENT</p>");
      const refused = await stageAssets(await Bun.file(page).text(), page, work);

      expect(await Bun.file(join(work, "input.html")).text()).toBe("<p>THE DOCUMENT</p>");
      expect(refused).toEqual([{ ref: "input.html", abs: join(root, "input.html"), why: "document" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);

  test("the same applies to the override document's name", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-self2-"));
    const work = await mkdtemp(join(tmpdir(), "lp-self2w-"));
    try {
      await writeFile(join(root, "override.html"), "<p>DECOY</p>");
      await writeFile(join(root, "p.html"), '<link rel="stylesheet" href="override.html">');
      const page = join(root, "p.html");
      await Bun.write(join(work, "override.html"), "<p>THE DOCUMENT</p>");
      const refused = await stageAssets(await Bun.file(page).text(), page, work);

      expect(await Bun.file(join(work, "override.html")).text()).toBe("<p>THE DOCUMENT</p>");
      expect(refused.map((r) => r.why)).toEqual(["document"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);
});
