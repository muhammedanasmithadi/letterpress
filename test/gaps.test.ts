/**
 * Naming which element produces a wide gap, rather than only how many there are.
 *
 * The PDF measurement says eight gaps, widest 0.67 em, and stops. That is not something
 * anyone can act on: the answer was `margin: 0 4px` on a `span.divider` two rules away.
 *
 * The page-side half of this failed twice before it worked, both times silently. A helper at
 * module scope is not in the page, so `wideGaps` threw and returned nothing; and the caller
 * passed `() => wideGaps()`, whose body is shipped to the browser where `wideGaps` is not a
 * name. Both look exactly like a document with no wide gaps. Hence `page-probe-failed`, and
 * hence the control below, which fails if the probe stops running.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Browser } from '../src/browser.ts';
import { wideGaps, type WideGap } from '../src/pageside.ts';
import { render } from '../src/render.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('gaps');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

async function probe(html: string): Promise<{ gaps: WideGap[]; codes: string[] }> {
  const r = await render(browser, { html, author: 'gaps', pageProbe: wideGaps });
  return { gaps: (r.probe as WideGap[] | undefined) ?? [], codes: r.findings.map((f) => f.code) };
}

test('a flex gap is named, with the element and the value', async () => {
  const { gaps, codes } = await probe(
    `<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .row { display: flex; gap: 24px }
     </style><div class="row"><span>alpha</span><span>beta</span></div>`,
  );
  expect(codes).not.toContain('page-probe-failed');
  expect(gaps.length).toBe(1);
  // 24px at 12pt is 1.6 em; the assertion is on the range because the em conversion depends
  // on the font the runner resolves, and on the presence of the answer, not its last digit.
  expect(gaps[0]!.cause).toBe('flex-gap');
  expect(gaps[0]!.selector).toContain('.row');
  expect(gaps[0]!.selector).toContain('span');
  expect(gaps[0]!.em).toBeGreaterThan(0.6);
}, 60_000);

test('justify-content: space-between is not reported as a gap', async () => {
  // It is a real gap and a reader does end an item at it, so it must be reported -- but
  // naming it `flex-gap` would send someone to a `gap` property that is not there.
  const { gaps } = await probe(
    `<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .row { display: flex; justify-content: space-between }
     </style><div class="row"><span>alpha</span><span>beta</span></div>`,
  );
  expect(gaps.length).toBe(1);
  expect(gaps[0]!.cause).toBe('space-between');
}, 60_000);

test("an element's own margin is named as a margin", async () => {
  const { gaps } = await probe(
    `<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .divider { margin: 0 10px }
     </style><p><span>alpha</span><span class="divider">·</span><span>beta</span></p>`,
  );
  expect(gaps.length).toBeGreaterThan(0);
  expect(gaps.every((g) => g.cause === 'margin')).toBe(true);
  expect(gaps[0]!.selector).toContain('.divider');
}, 60_000);

test('a gap a reader joins across is not reported at all', async () => {
  // The band is 0.102 to 0.6 em. A 3px space at 12pt is about 0.19 em: inside it, so it
  // stays in one text item and there is nothing to fix.
  const { gaps } = await probe(
    `<!doctype html><style>
       body { font: 12pt serif; margin: 0 }
       .a { margin-right: 3px }
     </style><p><span class="a">alpha</span><span>beta</span></p>`,
  );
  expect(gaps).toEqual([]);
}, 60_000);

test('a probe that cannot run says so instead of returning nothing', async () => {
  // A wrapper rather than the function itself: its body is shipped to the browser, where
  // `wideGaps` is not a name. This is the shape the first version of the tool used, and it
  // produced a report indistinguishable from a document with no wide gaps.
  const r = await render(browser, {
    html: '<!doctype html><p>x</p>',
    author: 'gaps',
    pageProbe: (() => wideGaps()) as () => unknown,
  });
  expect(r.probe).toBeUndefined();
  const finding = r.findings.find((f) => f.code === 'page-probe-failed');
  expect(finding).toBeDefined();
  // The message has to name the missing identifier, or it is a shrug.
  expect(finding!.message).toMatch(/wideGaps is not defined/);
}, 60_000);
