import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { render } from '../src/render.ts';
import { applyRolePlan, markedText, parseRoleCensus, rolePlan } from '../src/structroles.ts';
import { dictOf, structElementsInOrder, trySplit } from '../src/pdfparts.ts';
import type { FontTable } from '../src/textfont.ts';
import { verify } from '../src/verify.ts';
import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
import type { Browser } from '../src/browser.ts';

let t: TestBrowser;
let browser: Browser;

beforeAll(async () => {
  t = await launchTestBrowser('structroles');
  browser = t.browser;
}, 60_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 20_000);

const DOC = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>t</title>` +
  `<style>@page{size:A4;margin:20mm}body{font-family:sans-serif}</style><body>${body}</body>`;

const ROLED_DOC =
  '<h1>Ledger</h1><nav><a href="#a">alpha</a></nav>' +
  '<main><section><h2>One</h2><dl><dt>term one</dt><dd>def one</dd>' +
  '<dt>term two</dt><dd>def two</dd></dl></section></main>' +
  '<header>site header</header><footer>site footer</footer><p id="a">target prose</p>';

const BLOCKY_DOC =
  '<nav><a href="#a">alpha</a></nav><main><section><h2>One</h2>' +
  '<dl><dt>term A</dt><dd>def A <p>extra def para</p></dd><dd>def B</dd></dl>' +
  '</section></main><header>hdr one</header><footer>ft one</footer><p id="a">envoi prose</p>';

function rolesOf(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) return [];
  for (const o of parts.objs) {
    if (/\/Type\s*\/StructTreeRoot/.test(dictOf(o))) {
      const out: string[] = [];
      for (const role of ['Document', 'NonStruct', 'Sect', 'Part', 'L', 'LI']) {
        if (structElementsInOrder(parts, role).length > 0) out.push(role);
      }
      return out;
    }
  }
  return [];
}

const CENSUS_FOR_ROLED: unknown = JSON.stringify([
  { tag: 'nav', text: 'alpha', owner: -1 },
  { tag: 'main', text: 'One term one def one term two def two', owner: -1 },
  { tag: 'section', text: 'One term one def one term two def two', owner: 1 },
  { tag: 'dl', text: 'term one def one term two def two', owner: 2 },
  { tag: 'dt', text: 'term one', owner: 3 },
  { tag: 'dd', text: 'def one', owner: 3 },
  { tag: 'dt', text: 'term two', owner: 3 },
  { tag: 'dd', text: 'def two', owner: 3 },
  { tag: 'header', text: 'site header', owner: -1 },
  { tag: 'footer', text: 'site footer', owner: -1 },
]);

describe('the roles repair', () => {
  test('the six gap elements get their semantic roles and the leaves stay anonymous', async () => {
    const r = await render(browser, { html: DOC(ROLED_DOC), author: 't' });
    const found = rolesOf(r.pdf);
    for (const role of ['Sect', 'Part', 'L', 'LI', 'NonStruct']) {
      expect(found).toContain(role);
    }
    const note = r.findings.find((f) => f.code === 'role-retagged');
    expect(note).toBeTruthy();
    expect(note?.message).toContain('10');
  }, 90_000);

  test('an rtl landmark matches its visually ordered text and retags', async () => {
    const r = await render(browser, {
      html: DOC(
        '<div dir="rtl" lang="ar"><nav><p>مرحبا في الصفحة</p></nav>' +
          '<section><p>نص تقني صغير</p></section></div>',
      ),
      author: 't',
    });
    expect(rolesOf(r.pdf)).toContain('Sect');
    const note = r.findings.find((f) => f.code === 'role-retagged');
    expect(note?.message).toContain('2');
  }, 90_000);

  test('a definition list whose items hold blocks is skipped, landmarks still retag', async () => {
    const r = await render(browser, { html: DOC(BLOCKY_DOC), author: 't' });
    const found = rolesOf(r.pdf);
    expect(found).toContain('Sect');
    expect(found).toContain('Part');
    expect(found).not.toContain('L');
    expect(found).not.toContain('LI');
    expect(r.findings.find((f) => f.code === 'role-retagged')?.message).toContain('5');
  }, 90_000);

  test('two unrelated containers with equal text are both left unnamed', async () => {
    const r = await render(browser, {
      html: DOC('<nav>Menu</nav><header>Menu</header>'),
      author: 't',
    });
    const found = rolesOf(r.pdf);
    expect(found).toContain('NonStruct');
    expect(found).not.toContain('Sect');
    expect(found).not.toContain('Part');
    expect(r.findings.find((f) => f.code === 'role-retagged')).toBeUndefined();
  }, 90_000);

  test('a document without the six tags is untouched by the step', async () => {
    const r = await render(browser, {
      html: DOC('<div>plain</div><h1>Head</h1><p>prose</p>'),
      author: 't',
    });
    expect(r.findings.find((f) => f.code === 'role-retagged')).toBeUndefined();
  }, 90_000);

  test('running the plan again on repaired output changes no byte', async () => {
    const r = await render(browser, { html: DOC(ROLED_DOC), author: 't' });
    const elements = parseRoleCensus(CENSUS_FOR_ROLED);
    expect(elements.length).toBe(10);
    const plan = rolePlan(r.pdf, elements);
    expect(plan.entries.length).toBe(0);
    const again = applyRolePlan(r.pdf, plan);
    expect(Buffer.from(again).equals(Buffer.from(r.pdf))).toBe(true);
    expect(verify(again).ok).toBe(true);
  }, 90_000);
});

describe('the census parser', () => {
  test('it rebuilds rows from the page-side json and drops the rest', () => {
    const rows = parseRoleCensus(
      JSON.stringify([
        { tag: 'nav', text: ' A B ', owner: -1 },
        { tag: 'blockquote', text: 'nope', owner: -1 },
        { tag: 'dl', text: 'x', owner: 'third' },
        { tag: 'dt', text: 7, owner: -1 },
      ]),
    );
    expect(rows).toEqual([
      { tag: 'nav', text: 'AB', owner: -1 },
      { tag: 'dl', text: 'x', owner: -1 },
    ]);
  });

  test('garbage in, nothing out', () => {
    expect(parseRoleCensus('this is not json')).toEqual([]);
    expect(parseRoleCensus('42')).toEqual([]);
    expect(parseRoleCensus(undefined)).toEqual([]);
  });
});

describe('mcid text through the census walk', () => {
  const FAKE: FontTable = {
    codeBytes: 1,
    widthOf: () => 1000,
    unicodeOf: (code) => (code === 0x41 ? 'A' : code === 0x42 ? 'B' : ''),
  };

  const textFor = (body: string): string | undefined =>
    markedText(body, new Map([['F2', FAKE]])).get(0);

  test('a hex ActualText declares the character the zero-row body cannot name', () => {
    expect(
      textFor(
        '/P <</MCID 0 >> BDC /Span <</ActualText <FEFF0627> >> BDC /F2 12 Tf <0041> Tj EMC EMC',
      ),
    ).toBe('ا');
  });

  test('a nested dict inside the market content still finds the declared text and BDC', () => {
    expect(
      textFor(
        '/P <</MCID 0 >> BDC /Span <</ActualText (fi) /Why << /Inner (x) >> >> BDC' +
          ' /F2 12 Tf <0041> Tj EMC EMC',
      ),
    ).toBe('fi');
  });

  test('two utf-16 units arrive as two characters, one per unit', () => {
    expect(
      textFor(
        '/P <</MCID 0 >> BDC /Span <</ActualText <FEFF06270644> >> BDC /F2 12 Tf <0041> Tj EMC EMC',
      ),
    ).toBe('ال');
  });

  test('a reversed byte order mark swaps each unit like the span strip path does', () => {
    expect(
      textFor(
        '/P <</MCID 0 >> BDC /Span <</ActualText <FFFE66006900> >> BDC /F2 12 Tf <0041> Tj EMC EMC',
      ),
    ).toBe('fi');
  });

  test('plain glyph text without any span still lands in the mcid', () => {
    expect(textFor('/P <</MCID 0 >> BDC /F2 12 Tf <0042> Tj EMC')).toBe('B');
  });
});
