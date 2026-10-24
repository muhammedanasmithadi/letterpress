import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyListBody } from '../src/listbody.ts';
import { dictOf, trySplit } from '../src/pdfparts.ts';
import { verify } from '../src/verify.ts';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
import { sameBytes } from './fixtures.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('listbody');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm}body{font-family:sans-serif}</style><body>${body}</body>`;

function hasLBody(pdf: Uint8Array): boolean {
  const parts = trySplit(pdf);
  if (!parts) return false;
  return parts.objs.some((o) => /\/S\s*\/LBody\b/.test(dictOf(o)));
}

describe('the list body repair', () => {
  test('a simple list gets an LBody per item', async () => {
    const r = await render(browser, {
      html: DOC('<ul><li>first item</li><li>second item</li></ul>'),
      author: 't',
    });
    expect(hasLBody(r.pdf)).toBe(true);
    expect(r.findings.find((f) => f.code === 'list-bodied')).toBeTruthy();
    expect(verify(r.pdf).ok).toBe(true);
  }, 90_000);

  test('a list whose items contain paragraphs gets an LBody', async () => {
    const r = await render(browser, {
      html: DOC('<ul><li><p>para in item</p></li></ul>'),
      author: 't',
    });
    expect(hasLBody(r.pdf)).toBe(true);
    expect(verify(r.pdf).ok).toBe(true);
  }, 90_000);

  test('a document without lists is untouched', async () => {
    const r = await render(browser, { html: DOC('<p>plain prose</p>'), author: 't' });
    expect(hasLBody(r.pdf)).toBe(false);
    expect(r.findings.find((f) => f.code === 'list-bodied')).toBeUndefined();
  }, 90_000);

  test('running the repair again changes no byte', async () => {
    const r = await render(browser, { html: DOC('<ul><li>first item</li></ul>'), author: 't' });
    const again = applyListBody(r.pdf);
    expect(sameBytes(again, r.pdf)).toBe(true);
    expect(verify(again).ok).toBe(true);
  }, 90_000);

  test('applyListBody is a no-op on garbage', () => {
    const r = new Uint8Array([1, 2, 3]);
    expect(applyListBody(r)).toBe(r);
  });
});
