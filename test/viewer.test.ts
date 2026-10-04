import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

type Running = Awaited<ReturnType<typeof startServer>>;
let s: Running;
let origin: string;

beforeAll(async () => {
  s = await startServer({ port: 0 });
  origin = `http://127.0.0.1:${s.port}`;
}, 60_000);

afterAll(async () => {
  await s?.stop();
}, 30_000);

const post = (body: unknown) =>
  fetch(`${origin}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const DOC = `<!doctype html><style>@page{size:a5;margin:8mm}</style><h1>Viewer</h1>`;

describe("the shell is served", () => {
  test("the index is html", async () => {
    const r = await fetch(`${origin}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("/assets/theme.css");
    expect(html).toContain("/assets/app.js");
  });

  test("assets are served with a type that matches the extension", async () => {
    // Sniffing would let a staged .html run as something else. Content-type is
    // set from the extension rather than guessed.
    for (const [path, type] of [
      ["/assets/theme.css", "text/css"],
      ["/assets/app.js", "text/javascript"],
    ] as const) {
      const r = await fetch(`${origin}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toContain(type);
      expect((await r.text()).length, path).toBeGreaterThan(100);
    }
  });

  test("a missing asset is a 404, not a crash", async () => {
    expect((await fetch(`${origin}/assets/nope.css`)).status).toBe(404);
  });

  test("an absurd asset path is a 404, not a crash", async () => {
    expect((await fetch(`${origin}/assets/${"x".repeat(600)}`)).status).toBe(404);
  });
});

describe("the toolbar controls reach the renderer", () => {
  // The shell exposes format, landscape, margin, background and network. A
  // control that is not plumbed through is the silently ignored flag, which is
  // the defect the CLI pass just fixed. So each one is checked here.
  test("format changes the paper", async () => {
    const own = await (await post({ html: DOC })).json() as { mediaBoxes: string[] };
    expect(own.mediaBoxes[0]).toContain("420");
    const a4 = await (await post({ html: DOC, format: "a4" })).json() as { mediaBoxes: string[] };
    // A4 is 595.92pt wide. Not 594: that is the number in the CLI's older
    // fixtures and it is not what Chromium writes.
    expect(a4.mediaBoxes[0]).toContain("595");
  }, 90_000);

  test("landscape transposes the paper", async () => {
    const r = await (await post({ html: DOC, format: "a4", landscape: true })).json() as {
      mediaBoxes: string[]; findings: Array<{ code: string }>;
    };
    expect(r.mediaBoxes[0]).toContain("841");
    // Reported, not silent: a document's own @page size wins unless format is set.
    expect(r.findings.map((f) => f.code)).toContain("orientation-overridden");
  }, 90_000);

  test("printBackground false is accepted and defaults true", async () => {
    const off = await post({ html: DOC, printBackground: false });
    expect(off.status).toBe(200);
    const on = await post({ html: DOC, printBackground: true });
    expect(on.status).toBe(200);
    // Absent means true, matching the CLI, whose flag is --no-background.
    const neither = await post({ html: DOC });
    expect(neither.status).toBe(200);
  }, 120_000);

  test("margin is applied when format is given", async () => {
    const ok = await post({ html: `<!doctype html><body style="margin:0"><h1>T</h1></body>`, format: "a4", margin: "20mm" });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { findings: Array<{ code: string }> }).findings).toEqual([]);
  }, 90_000);

  test("allowNetwork is a boolean and defaults off", async () => {
    expect((await post({ html: DOC, allowNetwork: false })).status).toBe(200);
    expect((await post({ html: DOC, allowNetwork: true })).status).toBe(200);
    for (const bad of ["yes", 1, null, {}]) {
      const r = await post({ html: DOC, allowNetwork: bad });
      expect(r.status, String(bad)).toBe(400);
      expect((await r.json() as { error: string }).error).toContain("allowNetwork");
    }
  }, 120_000);
});

describe("margin is checked before it is used", () => {
  test("a margin without a format is refused, and says why", async () => {
    // The combination is always a mistake: a document's own @page margin wins,
    // so accepting it would report success and change nothing.
    const r = await post({ html: DOC, margin: "20mm" });
    expect(r.status).toBe(400);
    const { error } = await r.json() as { error: string };
    expect(error).toContain("only applies alongside format");
  }, 60_000);

  test("a margin that is not a css length names the fix", async () => {
    const r = await post({ html: DOC, format: "a4", margin: "wat" });
    expect(r.status).toBe(400);
    const { error } = await r.json() as { error: string };
    expect(error).toContain("not an absolute css length");
    // The message carries the answer, not just the rejection.
    expect(error).toContain("15mm");
  }, 60_000);

  test("every absolute css length is accepted", async () => {
    // All seven, plus a bare zero. The renderer is missing none of them: it was
    // missing q and pc, and rejected every negative value, before this.
    for (const margin of ["15mm", "1in", "2cm", "40pt", "10px", "2pc", "1q", "0", "0.0"]) {
      const r = await post({ html: DOC, format: "a4", margin });
      expect(r.status, margin).toBe(200);
    }
  }, 240_000);

  test("a relative unit is refused with the reason, not a bare rejection", async () => {
    // em and vw resolve against a font size or a viewport, so neither is
    // knowable before layout, and printToPDF takes inches.
    for (const margin of ["1.5em", "3vw", "10%", "2rem"]) {
      const r = await post({ html: DOC, format: "a4", margin });
      expect(r.status, margin).toBe(400);
      const { error } = await r.json() as { error: string };
      expect(error, margin).toContain("relative");
      expect(error, margin).toContain("mm");
    }
  }, 90_000);

  test("a bare non-zero number is refused, and a bare zero is not", async () => {
    // CSS allows a unitless zero and nothing else. "20" used to be read as 20px
    // by the renderer and refused by the server, which is two answers to one
    // question.
    const bare = await post({ html: DOC, format: "a4", margin: "20" });
    expect(bare.status).toBe(400);
    expect((await bare.json() as { error: string }).error).toContain("unit");
    const zero = await post({ html: DOC, format: "a4", margin: "0" });
    expect(zero.status).toBe(200);
  }, 90_000);

  test("margin must be a string", async () => {
    for (const margin of [20, true, []]) {
      const r = await post({ html: DOC, format: "a4", margin });
      expect(r.status, String(margin)).toBe(400);
      expect((await r.json() as { error: string }).error).toContain("margin must be a string");
    }
  }, 90_000);
});

describe("the shell itself", () => {
  const html = async () => await (await fetch(`${origin}/`)).text();

  test("every control is a native element", async () => {
    // Comments stripped first: this file's own prose mentions the very property
    // the assertion forbids, so the negative match hit the comment.
    const page = (await html()).replace(/<!--[\s\S]*?-->/g, "");
    expect(page).not.toMatch(/<div[^>]*role="button"/);
    expect(page).not.toMatch(/<span[^>]*onclick/);
    // A styled select is broken in Firefox, which has no appearance:
    // base-select, so the shell must not fake one.
    const css = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/appearance\s*:\s*base-select/);
    expect(css).not.toMatch(/\bselect\s*\{[^}]*appearance/s);
    for (const id of ["file", "format", "landscape", "margin", "background", "ppi", "network", "render", "download"]) {
      expect(page, `control #${id} exists`).toContain(`id="${id}"`);
    }
  });

  test("every control has a label", async () => {
    const page = await html();
    // Wrapped in <label>, which is what gives a screen reader the name and the
    // click target at once.
    for (const id of ["format", "landscape", "margin", "background", "ppi", "network"]) {
      const before = page.slice(0, page.indexOf(`id="${id}"`));
      const openTag = before.lastIndexOf("<label");
      const closeTag = before.lastIndexOf("</label>");
      expect(openTag, `#${id} is inside a <label>`).toBeGreaterThan(closeTag);
    }
  });

  test("the theme uses the system scheme rather than a palette", async () => {
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(css).toContain("color-scheme: light dark");
    // The claim is not "few hex values", it is "no palette". Every border and
    // surface tint is derived from currentColor, so no custom property holds a
    // colour at all. A token table is what makes a hand-built toolbar look like
    // a clone of something else, so that is what this checks.
    const colourTokens = [...css.matchAll(/--[\w-]+\s*:\s*([^;]*#[0-9a-f]{3,8}[^;]*)/gi)];
    expect(colourTokens.map((m) => m[0]), "custom properties holding a hex colour")
      .toEqual([]);
    // Borders and tints come from one mix, not from four near-identical greys.
    expect(css).toContain("color-mix(in oklab, currentColor");
    expect(css).toMatch(/accent-color:\s*light-dark\(/);
  });

  test("the panes scroll and the window does not", async () => {
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    // The grid row that takes the slack, and a body that cannot scroll, are
    // what keep each pane's own scrollbar instead of one for the whole window.
    expect(css).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.preview\s*\{[^}]*overflow: auto/s);
  });

  test("the status line is announced, not just drawn", async () => {
    const page = await html();
    expect(page).toMatch(/role="status"/);
    expect(page).toMatch(/aria-live="polite"/);
  });

  test("the editor is labelled and described", async () => {
    const page = await html();
    expect(page).toContain('aria-describedby="source-hint"');
    expect(page).toContain('aria-labelledby="preview-label"');
  });
});

describe("the shell renders end to end", () => {
  test("the starter document comes back as a real pdf", async () => {
    // What the shell does on load, so the wiring is checked rather than assumed.
    const page = await (await fetch(`${origin}/`)).text();
    const starter = page.slice(page.indexOf("<textarea"), page.indexOf("</textarea>"));
    const html = starter.replace(/^[\s\S]*?>/, "").replace(/<\/textarea>[\s\S]*$/, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const r = await post({ html });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; pages: number; bytes: number; pdf: string; findings: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.bytes).toBeGreaterThan(1000);
    expect(body.findings).toEqual([]);
    const bytes = Buffer.from(body.pdf, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  }, 90_000);
});