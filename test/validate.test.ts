import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { mcidCensus, validate } from '../src/validate.ts';
import { assemblePdf, encryptedFixture } from './fixtures.ts';
import { launchTestBrowser, closeTestBrowser } from './browser.ts';

/**
 * A pdf whose structure tree and page stream agree or deliberately do not.
 *
 * `stream` is what the page draws, `named` is what the structure tree points
 * at, and the two disagreeing is the whole subject: an id in only one of them
 * is unreachable from one side or the other.
 *
 * The streams are plain rather than flate on purpose. That is legal, and it is
 * what caught a real bug -- see the note in `pageContent`.
 */
function fixture(opts: { stream: number[]; named: number[]; tagged?: boolean }): Uint8Array {
  const content = opts.stream
    .map((m) => `/P << /MCID ${m} /S /P >> BDC BT (x) Tj ET EMC`)
    .join('\n');
  const objs: Array<string | { dict: string; payload: Buffer }> = [
    `<< /Type /Catalog /Pages 2 0 R${opts.tagged === false ? '' : ' /StructTreeRoot 6 0 R'} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: `<< /Length ${content.length} >>`, payload: Buffer.from(content, 'latin1') },
  ];
  if (opts.tagged !== false) {
    const k = opts.named.map((m) => `<< /MCID ${m} >>`).join(' ');
    objs.push(`<< /Type /StructElem /S /Document /P 6 0 R /K [${k}] >>`);
    objs.push('<< /Type /StructTreeRoot /K 5 0 R >>');
  }
  return assemblePdf(objs);
}

const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

describe('checking a pdf that already exists', () => {
  let browser: Browser;

  beforeAll(async () => {
    ({ browser } = await launchTestBrowser('validate'));
  }, 60_000);
  afterAll(async () => {
    await closeTestBrowser({ browser, profile: '' });
  }, 60_000);

  test('a tagged document whose halves agree has nothing to say', () => {
    const pdf = fixture({ stream: [0, 1, 2], named: [0, 1, 2] });
    expect(codes(validate(pdf))).toEqual([]);
    expect(validate(pdf).ok).toBe(true);
  });

  test('a block in the stream that no structure element names is reported', () => {
    // The text draws. A reader navigating by structure walks past all of it,
    // because there is nothing to walk to.
    const pdf = fixture({ stream: [0, 5], named: [0] });
    const f = validate(pdf).findings.find((x) => x.code === 'structure-orphan-mcid');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.message).toContain('5');
  });

  test('a block the tree names that is not in any stream is reported', () => {
    // The opposite, and worse for a reader: the document says there is
    // something there, and navigating to it lands on nothing.
    const pdf = fixture({ stream: [0], named: [0, 7] });
    const f = validate(pdf).findings.find((x) => x.code === 'structure-ghost-mcid');
    expect(f).toBeDefined();
    expect(f!.message).toContain('7');
    // The role is named, so the finding says which node is stranded.
    expect(f!.message).toContain('Document');
  });

  test('a document with no structure tree is reported as untagged, not as broken', () => {
    const pdf = fixture({ stream: [0], named: [], tagged: false });
    const found = validate(pdf);
    expect(codes(found)).toEqual(['untagged-document']);
    expect(found.findings[0]!.severity).toBe('info');
    // Info does not make a file wrong, so the exit code stays 0.
    expect(found.ok).toBe(true);
  });

  test('a file that is not a pdf is refused rather than half-read', () => {
    const found = validate(new TextEncoder().encode('this is not a pdf'));
    expect(codes(found)).toEqual(['not-a-pdf']);
    expect(found.ok).toBe(false);
  });

  test('an encrypted file says so instead of reporting what it cannot read', () => {
    // Nothing inside can be decompressed without the password, so every other
    // check would be reporting its own inability as a property of the file.
    const found = validate(encryptedFixture());
    expect(codes(found)).toEqual(['encrypted-document']);
    expect(found.ok).toBe(false);
  });

  test('the census reads both ends of the file', () => {
    const pdf = fixture({ stream: [3, 1], named: [1, 2] });
    const census = mcidCensus(pdf);
    expect(census.present).toEqual(['1', '3']);
    expect([...census.named].sort()).toEqual(['1', '2']);
    expect(census.role.get('1')).toBe('Document');
  });

  test('a structure tree that points at itself does not hang', () => {
    // The tree comes from a file, and a file can contain an element that is its
    // own ancestor. Without the guard this recurses until the stack gives out.
    const objs = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /StructTreeRoot /K 4 0 R >>',
    ]);
    expect(() => validate(objs)).not.toThrow();
    expect(mcidCensus(objs).named.size).toBe(0);
  });

  test('a pdf this tool rendered passes its own checks', async () => {
    // The point of reusing the render's own checks rather than writing a second
    // set: a file letterpress produced must never come back from validate
    // saying something the render did not say.
    const r = await render(browser, {
      html: '<html lang="en"><body><h1>A</h1><p>text</p><ul><li>x</li></ul></body></html>',
    });
    const found = validate(r.pdf);
    expect(codes(found)).toEqual([]);
    expect(found.ok).toBe(true);
  }, 60_000);
});
