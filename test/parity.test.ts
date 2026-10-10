import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { pdfText, pdfToPng } from './poppler.ts';

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
