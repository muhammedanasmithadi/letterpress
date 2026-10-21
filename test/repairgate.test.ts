import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { repairOrKeep } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('repairgate');
  browser = t.browser;
}, 120_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

const HTML =
  '<!doctype html><meta charset="utf-8"><title>Gate</title>' +
  '<style>@page{size:A4;margin:18mm}</style><h1>Gate</h1><p>office efficient flags finished</p>';

function corruptContent(pdf: Uint8Array): Uint8Array {
  const raw = Buffer.from(pdf);
  const text = raw.toString('latin1');
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf('\nendstream', start);
    if (end - start < 16) continue;
    const payload = raw.subarray(start, end);
    let drawn: Buffer;
    try {
      drawn = inflateSync(payload);
    } catch {
      continue;
    }
    if (!drawn.includes('BT')) continue;
    const at = 4 + (drawn.length % Math.max(1, payload.length - 8));
    payload[at] = (payload[at] ?? 0) ^ 0xff;
    payload[at + 1] = (payload[at + 1] ?? 0) ^ 0xff;
    payload[at + 2] = (payload[at + 2] ?? 0) ^ 0xff;
    return raw;
  }
  throw new Error('no text-bearing content stream to corrupt');
}

describe('the gate on a repair', () => {
  test('a repair that damages the document is refused', async () => {
    const good = (await render(browser, { html: HTML, author: 'A Person' })).pdf;
    const corrupted = corruptContent(good);

    const kept = repairOrKeep(good, () => corrupted);
    expect(kept.applied).toBe(false);
    expect(kept.failures.length).toBeGreaterThan(0);
    expect(Buffer.from(kept.pdf).equals(Buffer.from(good))).toBe(true);
  }, 120_000);

  test('a repair that changes nothing is not a failure', async () => {
    const good = (await render(browser, { html: HTML, author: 'A Person' })).pdf;
    const kept = repairOrKeep(good, (p) => p);
    expect(kept.applied).toBe(false);
    expect(kept.failures).toEqual([]);
  }, 120_000);
});
