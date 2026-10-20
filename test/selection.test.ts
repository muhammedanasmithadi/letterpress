import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { textFlow } from '../src/selection.ts';

let browser: Browser;
let profile: string;

const PARAGRAPH = `<p>WAVE To. Pack my box with five dozen liquor jugs, and consider the office that
  efficient, affluent and difficult people occupy. A well-set page gives the eye a path to
  follow: the measure is short enough that the return sweep is accurate.</p>`;

const page = (align: string): string => `<!doctype html><meta charset="utf-8">
  <style>@page{size:A4;margin:48mm}
    body{font-family:'Noto Serif',serif;font-size:10.5pt;line-height:1.5}
    p{text-align:${align};margin:0}</style>${PARAGRAPH}`;

function said(r: { findings: Array<{ code: string; message: string }> }): string | undefined {
  return r.findings.find((f) => f.code === 'selection-fragmented')?.message;
}

describe('word gaps a browser will break a selection on', () => {
  test('justified text is reported and ragged-right text is not', async () => {
    const justified = await render(browser, { html: page('justify'), author: 's' });
    const ragged = await render(browser, { html: page('left'), author: 's' });

    const message = said(justified);
    expect(message).toBeDefined();
    expect(/0\.\d\d em/.test(message!)).toBe(true);
    expect(/text-align:justify/.test(message!)).toBe(true);

    expect(said(ragged) ?? '').not.toMatch(/word space/);
  }, 120_000);

  test('the measurement agrees with what a browser does', async () => {
    const ROWS = 30;
    const COLS = 3;
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8">
        <style>@page{size:A4;margin:15mm} body{font-family:'Noto Sans',sans-serif;font-size:8.5pt}
        table{width:100%;border-collapse:collapse} td{padding:3.2pt 6pt}</style>
        <table>${Array.from(
          { length: ROWS },
          (_, i) => `<tr><td>S-${i}</td><td>${i}.000</td><td>${i}.500</td></tr>`,
        ).join('')}</table>`,
      author: 's',
    });
    const flow = textFlow(r.pdf);
    expect(flow).not.toBeNull();
    expect(flow!.jump).toBe(ROWS * (COLS - 1));
    expect(flow!.tooWide).toBe(0);
  }, 120_000);

  test('spans are stripped by default, and reported when kept', async () => {
    const html = `<!doctype html><meta charset="utf-8">
      <style>@page{size:A4;margin:20mm}
        body{font-family:'Noto Serif',serif;font-size:11pt;text-align:left}</style>
      <p>${'Body text that fills a line and wraps with office affluent. '.repeat(12)}</p>`;

    const r = await render(browser, { html, author: 's' });
    const spans = r.findings.find((f) => f.code === 'ligature-spans');
    expect(spans).toBeDefined();
    expect(spans!.message).toMatch(/removed \d+ of \d+/);
    expect(said(r)).toBeUndefined();

    const kept = await render(browser, { html, author: 's', keepLigatureSpans: true });
    expect(kept.findings.map((f) => f.code)).not.toContain('ligature-spans');
    expect(textFlow(kept.pdf)!.spans).toBeGreaterThan(5);
    expect(said(kept)).toMatch(/marked-content spans/);
  }, 120_000);

  test('a document with no text reports nothing rather than guessing', async () => {
    const bare = await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4}</style><hr>`,
      author: 's',
    });
    expect(said(bare)).toBeUndefined();
  }, 120_000);

  test('a file with no words in it is a different answer from one it cannot read', () => {
    expect(textFlow(Buffer.from('not a pdf'))).toBeNull();
    const empty = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n',
    );
    expect(textFlow(new Uint8Array(empty))).toBeNull();
  });
});

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'lp-sel-profile-'));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});
