import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { pdfText, pdfToPng, pdfWords } from './poppler.ts';

const display = process.env.DISPLAY;
const canRunHeadful = Boolean(display);

const DOC = `<!doctype html><meta charset="utf-8"><title>Parity</title>
<style>
@page { size: A4; margin: 12mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { font-family: "DejaVu Serif", serif }
h2 { break-before: page }
</style>
<h1>Parity document</h1><p>office efficient flags finished. Section one.</p>
<h2>Two</h2><p>Second section, some body text to fill the page a little.</p>
<h2>Three</h2><ul><li>Alpha</li><li>Beta</li></ul>
<table><tr><th>Head</th></tr><tr><td>Cell</td></tr></table>`;

function roles(pdf: Uint8Array): string {
  const counts = new Map<string, number>();
  for (const m of Buffer.from(pdf)
    .toString('latin1')
    .matchAll(/\/Type \/StructElem\s*\/S\s*\/(\w+)/g)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return [...counts]
    .sort()
    .map(([role, n]) => `${role}=${n}`)
    .join(' ');
}

async function run(headless: boolean) {
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-parity-'));
  const browser = await Browser.launch({
    profile,
    headless,

    extraArgs: headless ? [] : ['--ozone-platform=x11', '--window-size=1280,1700'],
  });
  try {
    return await render(browser, { html: DOC, author: 'Parity' });
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

describe.skipIf(!canRunHeadful)('headful parity', () => {
  let headless: Awaited<ReturnType<typeof run>>;
  let headful: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    headless = await run(true);
    headful = await run(false);
  }, 180_000);

  test('a headful browser is really launched, not a headless one with a flag after it', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'letterpress-parity-probe-'));
    const browser = await Browser.launch({
      profile,
      headless: false,
      extraArgs: ['--ozone-platform=x11'],
    });
    const r = await render(browser, { html: '<p>probe</p>' });
    expect(r.info.pages).toBe(1);
    await browser.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }, 120_000);

  test('the same number of pages', () => {
    expect(headful.info.pages).toBe(headless.info.pages);
    expect(headless.info.pages).toBe(3);
  });

  test('the same page geometry', () => {
    expect(headful.info.mediaBoxes).toEqual(headless.info.mediaBoxes);
  });

  test('the same tagging', () => {
    expect(headful.info.tagged).toBe(headless.info.tagged);
    expect(headful.info.tagged).toBe(true);
  });

  test('the same structure tree, role for role', () => {
    expect(roles(headful.pdf)).toBe(roles(headless.pdf));
    expect(roles(headless.pdf)).toContain('H1=1');
    expect(roles(headless.pdf)).toContain('Table=1');
  });

  test('the same text, including the margin-box footer', async () => {
    const a = await pdfText(headless.pdf);
    const b = await pdfText(headful.pdf);
    expect(b).toBe(a);

    expect(a).toContain('page 3 of 3');
  });

  test('a comparable file size', () => {
    const delta = Math.abs(headful.pdf.byteLength - headless.pdf.byteLength);
    expect(delta).toBeLessThanOrEqual(64);
  });

  test('identical pixels on every page', async () => {
    const a = await pdfToPng(headless.pdf, { dpi: 110, prefix: join(tmpdir(), 'lp-parity-hl') });
    const b = await pdfToPng(headful.pdf, { dpi: 110, prefix: join(tmpdir(), 'lp-parity-hf') });
    try {
      expect(b.length).toBe(a.length);
      expect(a.length).toBe(3);
      for (let i = 0; i < a.length; i++) {
        const left = await Bun.file(a[i]!).arrayBuffer();
        const right = await Bun.file(b[i]!).arrayBuffer();
        expect(new Uint8Array(right).length).toBe(new Uint8Array(left).length);

        expect(Buffer.from(right).equals(Buffer.from(left))).toBe(true);
      }
    } finally {
      for (const f of [...a, ...b]) await rm(f, { force: true }).catch(() => {});
    }
  }, 180_000);
});

describe.skipIf(canRunHeadful)('headful parity', () => {
  test('is skipped without a display', () => {
    expect(process.env.DISPLAY).toBeFalsy();
  });
});

describe('headless is the default', () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'letterpress-parity-default-'));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  test('launching without headless still works and needs no display', async () => {
    const r = await render(browser, { html: `<!doctype html><p>plain</p>` });
    expect(r.info.pages).toBe(1);
  });
});

describe("the rewritten document is the browser's document", () => {
  const MERGE_DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Merge</title>
<style>@page{size:A4;margin:15mm} body{font-family:"Noto Serif",serif;font-size:11pt}</style></head>
<body><h1>Heading</h1>
<p>Paragraph text with enough words in it to fill a line or two of the page, so that the text runs are
long enough for the difference to show.</p>
<p>A second paragraph, because the first one is short.</p></body></html>`;

  test('the folding of the text runs keeps the text, the words and the page', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'letterpress-merge-'));
    const browser = await Browser.launch({ profile });
    let ours: Uint8Array;
    let theirs: Uint8Array;
    try {
      ours = (await render(browser, { html: MERGE_DOC, author: 'Merge' })).pdf;
      const tab = await browser.newTab('about:blank');
      await tab.send('Page.enable');
      const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
      await tab.send('Page.setDocumentContent', { frameId, html: MERGE_DOC });
      const printed = await tab.send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
      });
      theirs = new Uint8Array(Buffer.from(printed.data, 'base64'));
    } finally {
      await browser.close();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }

    expect(await pdfText(ours)).toBe(await pdfText(theirs));
    expect((await pdfWords(ours)).map((w) => [w.text, w.xMin, w.xMax])).toEqual(
      (await pdfWords(theirs)).map((w) => [w.text, w.xMin, w.xMax]),
    );

    const a = await gray(ours, 72, join(tmpdir(), 'lp-merge-ours'));
    const b = await gray(theirs, 72, join(tmpdir(), 'lp-merge-theirs'));
    try {
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      const left = pgmPixels(a[0]!);
      const right = pgmPixels(b[0]!);
      const differing = countDifferent(left, right);
      const total = left.length;
      expect(differing / total).toBeLessThan(0.001);
    } finally {
      for (const f of [...a, ...b]) await rm(f, { force: true }).catch(() => {});
    }
  }, 180_000);
});

async function gray(bytes: Uint8Array, dpi: number, prefix: string): Promise<string[]> {
  const path = join(tmpdir(), `lp-merge-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  await Bun.write(path, bytes);
  try {
    await Bun.$`gs -q -dNOPAUSE -dBATCH -sDEVICE=pgmraw -r${dpi} -sOutputFile=${prefix} ${path}`.quiet();
    const dir = dirname(prefix);
    const stem = basename(prefix);
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries
      .filter((n) => n === stem || n.startsWith(`${stem}-`))
      .filter((n) => !n.endsWith('.pdf'))
      .sort()
      .map((n) => join(dir, n));
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

function pgmPixels(file: string): Uint8Array {
  const raw = readFileSync(file);
  let at = 0;
  const line = (): string => {
    let out = '';
    while (at < raw.length && raw[at] !== 10) out += String.fromCharCode(raw[at++]!);
    at++;
    return out;
  };
  if (line().trim() !== 'P5') throw new Error('not a graymap');
  for (;;) {
    const text = line().trim();
    if (text.startsWith('#')) continue;
    if (text.split(/\s+/).length === 2) break;
  }
  line();
  return raw.subarray(at);
}

function countDifferent(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) return left.length;
  let n = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) n++;
  return n;
}
