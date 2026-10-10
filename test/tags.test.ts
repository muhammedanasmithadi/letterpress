import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await Browser.launch({ profile: await mkdtempProfile() });
}, 60_000);

async function mkdtempProfile() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'letterpress-tags-'));
}

afterAll(async () => {
  await browser?.close();
});

async function roles(html: string): Promise<string[]> {
  const r = await render(browser, {
    html: `<!doctype html><html lang="en"><meta charset="utf-8">${html}`,
  });
  const text = Buffer.from(r.pdf).toString('latin1');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^0-9])\d+ \d+ obj\b([\s\S]*?)endobj/g)) {
    if (!/\/Type\s*\/StructElem/.test(m[1]!)) continue;
    const s = /\/S\s*\/(\w+)/.exec(m[1]!);
    if (s && s[1] !== 'Document') out.push(s[1]!);
  }
  return out;
}

describe('semantic elements are tagged with their own roles', () => {
  const cases: Array<[string, string, string]> = [
    ['h1', '<h1>One</h1>', 'H1'],
    ['h2', '<h2>Two</h2>', 'H2'],
    ['h3', '<h3>Three</h3>', 'H3'],
    ['h4', '<h4>Four</h4>', 'H4'],
    ['h5', '<h5>Five</h5>', 'H5'],
    ['h6', '<h6>Six</h6>', 'H6'],
    ['p', '<p>A paragraph.</p>', 'P'],
    ['ul and li', '<ul><li>one</li></ul>', 'LI'],
    ['ol', '<ol><li>first</li></ol>', 'L'],
    ['blockquote', '<blockquote>quoted</blockquote>', 'BlockQuote'],
    ['strong', '<p><strong>bold</strong></p>', 'Strong'],
    ['em', '<p><em>italic</em></p>', 'Em'],
    ['code', '<pre><code>x = 1</code></pre>', 'Code'],
    ['a href', `<p><a href="https://example.test">link</a></p>`, 'Link'],
    ['article', '<article>body</article>', 'Art'],
    ['aside', '<aside>note</aside>', 'Aside'],
  ];

  for (const [name, html, role] of cases) {
    test(`<${name}> is tagged ${role}`, async () => {
      expect(await roles(html)).toContain(role);
    });
  }

  test('a heading nested inside a list item keeps its heading role', async () => {
    expect(await roles('<ul><li><h1>Item</h1></li></ul>')).toContain('H1');
  });

  test('a heading split across spans is still one heading', async () => {
    const r = await roles('<h1><span>Split</span> <span>Heading</span></h1><p>body</p>');
    expect(r).toContain('H1');
    expect(r).toContain('P');
  });

  test('a table is tagged with its structure', async () => {
    const r = await roles(
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>',
    );
    for (const role of ['Table', 'TR', 'TH', 'TD']) expect(r).toContain(role);
  });

  test('a figure with a caption is tagged', async () => {
    const px =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await roles(
      `<figure><img src="${px}" alt="x" width="10" height="10"><figcaption>cap</figcaption></figure>`,
    );
    expect(r).toContain('Figure');
    expect(r).toContain('Caption');
  });
});

describe('elements with no semantics are tagged NonStruct, which is correct', () => {
  test('a div is NonStruct', async () => {
    expect(await roles('<div>text</div>')).toContain('NonStruct');
  });

  test('a span is NonStruct', async () => {
    expect(await roles('<p><span>inner</span></p>')).toContain('NonStruct');
  });

  test('a document of only divs and spans yields no heading or paragraph role', async () => {
    const r = await roles(
      '<section><div><span>Name</span></div><div><span>Role</span></div></section>' +
        '<div><ul><li>a</li><li>b</li></ul></div>',
    );
    expect(r.filter((x) => /^H\d/.test(x))).toEqual([]);
    expect(r).not.toContain('P');

    expect(r).toContain('LI');
  });
});

describe('known gaps, recorded rather than papered over', () => {
  test('a description list produces no semantic role', async () => {
    const r = await roles('<dl><dt>term</dt><dd>definition</dd></dl>');

    expect(r.length, 'the document produced no structure elements at all').toBeGreaterThan(0);
    expect(r.every((x) => x === 'NonStruct')).toBe(true);
  });

  test('sectioning elements other than article and aside produce no role', async () => {
    for (const html of [
      '<section><p>x</p></section>',
      '<nav>link</nav>',
      '<main>body</main>',
      '<header>head</header>',
      '<footer>foot</footer>',
    ]) {
      const r = await roles(html);

      expect(r.length, `${html} produced no structure elements at all`).toBeGreaterThan(0);
      expect(r.filter((x) => x === 'Sect')).toEqual([]);
    }
  });
});

describe('the tree is structurally sound', () => {
  test('the catalog marks the document and names a tree root', async () => {
    const r = await render(browser, { html: '<!doctype html><h1>T</h1><p>x</p>' });
    expect(r.info.tagged).toBe(true);
    const text = Buffer.from(r.pdf).toString('latin1');
    expect(text).toContain('/Type /StructTreeRoot');
    expect(text).toContain('/Type /MarkInfo');
    expect(text).toContain('/Marked true');
  });

  test('the language reaches both the catalog and the document element', async () => {
    const r = await render(browser, { html: `<!doctype html><html lang="fr"><h1>T</h1>` });
    const text = Buffer.from(r.pdf).toString('latin1');

    const objs = new Map<number, string>();
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
      objs.set(Number(m[1]), m[2]!);
    }
    const catalog = objs.get(Number(/\/Root (\d+) 0 R/.exec(text)![1]))!;

    expect(/\/Lang \((fr[^)]*)\)/.exec(catalog)).not.toBeNull();
    const doc = objs.get(
      Number(
        /\/K\s+(\d+) 0 R/.exec(
          objs.get(Number(/\/StructTreeRoot (\d+) 0 R/.exec(catalog)![1]))!,
        )![1],
      ),
    )!;
    expect(/\/S \/Document/.test(doc)).toBe(true);
    expect(/\/Lang \(fr\)/.test(doc)).toBe(true);
  });

  test('every structure element resolves and every parent points back', async () => {
    const r = await render(browser, {
      html: '<!doctype html><h1>T</h1><p>one</p><ul><li>a</li></ul><h2>S</h2><p>two</p>',
    });
    const text = Buffer.from(r.pdf).toString('latin1');
    const objs = new Map<number, string>();
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
      objs.set(Number(m[1]), m[2]!);
    }

    const rootNum = Number(/\/Root (\d+) 0 R/.exec(text)![1]);
    const root = objs.get(rootNum)!;
    expect(root).toContain('/StructTreeRoot');
    const treeRootNum = Number(/\/StructTreeRoot (\d+) 0 R/.exec(root)![1]);
    const treeRoot = objs.get(treeRootNum)!;
    expect(treeRoot).toContain('/Type /StructTreeRoot');
    expect(treeRoot).toContain('/ParentTree');

    const childrenOf = (body: string) => {
      const arr = /\/K\s*\[([^\]]*)\]/.exec(body);
      if (arr) return [...arr[1]!.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
      const one = /\/K\s+(\d+)\s+0\s+R/.exec(body);
      return one ? [Number(one[1])] : [];
    };
    const seen = new Set<number>();
    const walk = (n: number, parent: number | null) => {
      expect(seen.has(n)).toBe(false);
      seen.add(n);
      const body = objs.get(n);
      expect(body).toBeDefined();
      if (parent !== null) {
        const p = /\/P\s+(\d+)\s+0\s+R/.exec(body!);
        expect(p).not.toBeNull();
        expect(Number(p![1])).toBe(parent);
      }
      for (const k of childrenOf(body!)) walk(k, n);
    };
    const docChild = Number(/\/K\s+(\d+) 0 R/.exec(treeRoot)![1]);
    walk(docChild, null);
    expect(seen.size).toBeGreaterThan(5);
  });

  test('every parent tree key names an element that exists', async () => {
    const r = await render(browser, {
      html: '<!doctype html><h1>T</h1><p>one</p><ul><li>a</li></ul><p>two</p>',
    });
    const text = Buffer.from(r.pdf).toString('latin1');
    const objs = new Map<number, string>();
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)\bendobj/g)) {
      objs.set(Number(m[1]), m[2]!);
    }
    const catalog = objs.get(Number(/\/Root (\d+) 0 R/.exec(text)![1]))!;
    const treeRoot = objs.get(Number(/\/StructTreeRoot (\d+) 0 R/.exec(catalog)![1]))!;
    expect(treeRoot).toContain('/ParentTreeNextKey');
    const ptNum = Number(/\/ParentTree (\d+) 0 R/.exec(treeRoot)![1]);
    const pt = objs.get(ptNum)!;

    const refs = [...pt.matchAll(/(\d+) 0 R/g)];
    expect(refs.length, 'the parent tree named no objects').toBeGreaterThan(0);
    for (const m of refs) {
      expect(objs.get(Number(m[1]))).toBeDefined();
    }
  });
});
