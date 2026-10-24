import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { applyRoleMap } from '../src/rolemap.ts';
import { dictOf, trySplit } from '../src/pdfparts.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('rolemap');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm}body{font-family:sans-serif}</style><body>${body}</body>`;

function roleMapOf(pdf: Uint8Array): string | undefined {
  const parts = trySplit(pdf);
  if (!parts) return undefined;
  for (const o of parts.objs) {
    if (/\/Type\s*\/StructTreeRoot/.test(dictOf(o))) {
      const m = /\/RoleMap\s*<<([^<>]*)>>/.exec(dictOf(o));
      return m ? m[1]!.trim() : undefined;
    }
  }
  return undefined;
}

describe('the role map repair', () => {
  test('an Aside element gets a RoleMap entry mapping it to Sect', async () => {
    const r = await render(browser, { html: DOC('<aside>wrote in prose</aside>'), author: 't' });
    expect(roleMapOf(r.pdf)).toBe('/Aside /Sect');
    expect(r.findings.find((f) => f.code === 'role-mapped')).toBeTruthy();
    expect(verify(r.pdf).ok).toBe(true);
  }, 90_000);

  test('a document without non-standard types is untouched', async () => {
    const r = await render(browser, { html: DOC('<p>plain prose</p>'), author: 't' });
    expect(roleMapOf(r.pdf)).toBeUndefined();
    expect(r.findings.find((f) => f.code === 'role-mapped')).toBeUndefined();
  }, 90_000);

  test('running the repair again on a mapped file changes no byte', async () => {
    const r = await render(browser, { html: DOC('<aside>wrote in prose</aside>'), author: 't' });
    const again = applyRoleMap(r.pdf);
    expect(Buffer.from(again).equals(Buffer.from(r.pdf))).toBe(true);
    expect(verify(again).ok).toBe(true);
  }, 90_000);

  test('applyRoleMap is a no-op when there is nothing to map', () => {
    const r = new Uint8Array([1, 2, 3]);
    expect(applyRoleMap(r)).toBe(r);
  });
});
