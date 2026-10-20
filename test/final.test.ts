import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Browser } from '../src/browser.ts';
import { finalCheckFinding, render } from '../src/render.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('final');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

test('what a render returns passes the structural check', async () => {
  const shapes = [
    '<!doctype html><meta charset="utf-8"><p>Body text that fills a line and wraps.</p>',
    '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:2cm}</style><p>x</p>',
    '<!doctype html><meta charset="utf-8"><h1>T</h1><table><tr><td>a</td><td>b</td></tr></table>',
  ];
  for (const html of shapes) {
    const r = await render(browser, { html, author: 'a', subject: 's' });
    expect(r.findings.map((f) => f.code)).not.toContain('output-unverified');
    expect(verify(r.pdf).ok).toBe(true);
  }
}, 90_000);

test('a file that will not open is an error finding, not silence', async () => {
  const good = await render(browser, {
    html: '<!doctype html><meta charset="utf-8"><p>x</p>',
  });
  expect(finalCheckFinding(good.pdf)).toBeNull();

  const whole = new TextDecoder('latin1').decode(good.pdf);
  const broken: Array<[string, Uint8Array]> = [
    ['%%EOF removed', new TextEncoder().encode(whole.replace(/%%EOF\s*$/, ''))],
    ['header removed', new TextEncoder().encode(whole.replace(/^%PDF-[\d.]+\n/, ''))],
    ['body truncated', good.pdf.subarray(0, good.pdf.byteLength - 40)],
  ];
  for (const [name, bytes] of broken) {
    const finding = finalCheckFinding(bytes);
    expect({ name, found: finding !== null }).toEqual({ name, found: true });
    expect(finding!.severity).toBe('error');
    expect(finding!.message).toMatch(/structural check:/);
  }
}, 90_000);
