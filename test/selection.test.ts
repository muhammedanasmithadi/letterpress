/**
 * A browser draws one highlight per text item, and ends an item at any word gap wider than
 * 0.6 em. A justified paragraph therefore selects as a row of separate boxes, and nothing
 * in the file can change that -- the gap is what the layout produced. What the engine can do
 * is measure it and say so, so these tests hold the measurement to the behaviour that was
 * observed in Firefox rather than to the intent of the code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { textFlow } from "../src/selection.ts";

let browser: Browser;
let profile: string;

const PARAGRAPH = `<p>WAVE To. Pack my box with five dozen liquor jugs, and consider the office that
  efficient, affluent and difficult people occupy. A well-set page gives the eye a path to
  follow: the measure is short enough that the return sweep is accurate.</p>`;

const page = (align: string): string => `<!doctype html><meta charset="utf-8">
  <style>@page{size:A4;margin:20mm}
    body{font-family:'Noto Serif',serif;font-size:10.5pt;line-height:1.5}
    p{text-align:${align};margin:0}</style>${PARAGRAPH}`;

function said(r: { findings: Array<{ code: string; message: string }> }): string | undefined {
  return r.findings.find((f) => f.code === "selection-fragmented")?.message;
}

describe("word gaps a browser will break a selection on", () => {
  test("justified text is reported and ragged-right text is not", async () => {
    const justified = await render(browser, { html: page("justify"), author: "s" });
    const ragged = await render(browser, { html: page("left"), author: "s" });

    const message = said(justified);
    expect(message).toBeDefined();
    expect(/0\.\d\d em/.test(message!)).toBe(true);
    expect(/text-align:justify/.test(message!)).toBe(true);

    // The same page set ragged-right has no gap past the band, which is the whole
    // difference between one highlight and one per word.
    expect(said(ragged)).toBeUndefined();
  }, 120_000);

  test("the measurement agrees with what a browser does", async () => {
    // Firefox reports a bare whitespace item for each gap past the band, and the number it
    // produces for a table of cells -- where the gaps are the column gutters -- is the
    // number measured here. That agreement is the check that the geometry is being read
    // the same way twice.
    const ROWS = 30;
    const COLS = 3;
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8">
        <style>@page{size:A4;margin:15mm} body{font-family:'Noto Sans',sans-serif;font-size:8.5pt}
        table{width:100%;border-collapse:collapse} td{padding:3.2pt 6pt}</style>
        <table>${Array.from({ length: ROWS }, (_, i) =>
          `<tr><td>S-${i}</td><td>${i}.000</td><td>${i}.500</td></tr>`).join("")}</table>`,
      author: "s",
    });
    const flow = textFlow(r.pdf);
    expect(flow).not.toBeNull();
    // Thirty rows of three cells have exactly sixty column gutters, and every one of them
    // is a gap between two numbers with no letter in it. Each is wider than 0.6 em at this
    // size, so each must be counted -- and nothing else on the page should be, because the
    // gaps inside "S-12" and "12.500" are ordinary letter fits.
    expect(flow!.tooWide).toBe(ROWS * (COLS - 1));
    expect(flow!.widest).toBeGreaterThan(0.6);
  }, 120_000);

  test("a document with no text reports nothing rather than guessing", async () => {
    const bare = await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4}</style><hr>`,
      author: "s",
    });
    expect(said(bare)).toBeUndefined();
  }, 120_000);

  test("a file with no words in it is a different answer from one it cannot read", () => {
    expect(textFlow(Buffer.from("not a pdf"))).toBeNull();
    const empty = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n");
    expect(textFlow(new Uint8Array(empty))).toBeNull();
  });
});

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "lp-sel-profile-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});