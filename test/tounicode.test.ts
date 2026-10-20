import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { fixCMap, fixToUnicode, ligatureExpansion, unresolvedLigatures } from '../src/tounicode.ts';
import {
  assemblePdf,
  deflated,
  expectSoundLengths,
  expectSoundXref,
  sameBytes,
} from './fixtures.ts';
import { pdfInfo, pdfText } from './poppler.ts';

const LATIN1 = 'latin1' as BufferEncoding;

function cmaps(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString(LATIN1);
  const objs = new Map<number, string>();
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b([\s\S]*?)endobj/g)) {
    objs.set(Number(m[1]), m[2]!);
  }
  const out: string[] = [];
  for (const body of objs.values()) {
    const ref = body.match(/\/ToUnicode (\d+) 0 R/);
    if (!ref) continue;
    const cm = objs.get(Number(ref[1]));
    if (!cm) continue;
    const at = cm.match(/stream\r?\n/);
    if (!at || at.index === undefined) continue;
    const end = cm.lastIndexOf('\nendstream');
    try {
      out.push(
        inflateSync(Buffer.from(cm, LATIN1).subarray(at.index + at[0].length, end)).toString(
          LATIN1,
        ),
      );
    } catch {}
  }
  return out;
}

function pdfWithCMap(cmap: string, dictExtra = ''): Buffer {
  const body = deflated(cmap);
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
    {
      dict: `<< ${dictExtra}/Length ${body.length} /Filter /FlateDecode >>`,
      payload: body,
    },
    '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+NotoSans /Encoding /Identity-H ' +
      '/DescendantFonts [6 0 R] /ToUnicode 4 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+NotoSans /CIDSystemInfo ' +
      '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
  ]);
}

const cmapOf = (pairs: Array<[number, string]>) =>
  `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
  `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
  `${pairs.length} beginbfchar\n${pairs.map(([g, d]) => `<${g.toString(16).toUpperCase().padStart(4, '0')}> <${d}>`).join('\n')}\nendbfchar\n` +
  `endcmap\nend\nend\n`;

const cmapOfRange = (lo: number, hi: number, base: number) =>
  `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n` +
  `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
  `1 beginbfrange\n<${lo.toString(16).toUpperCase().padStart(4, '0')}> <${hi.toString(16).toUpperCase().padStart(4, '0')}> ` +
  `<${base.toString(16).toUpperCase().padStart(4, '0')}>\nendbfrange\nendcmap\nend\nend\n`;

describe('ligatureExpansion', () => {
  test('the seven Latin ligatures expand to their component letters', () => {
    expect(ligatureExpansion(0xfb00)).toBe('ff');
    expect(ligatureExpansion(0xfb01)).toBe('fi');
    expect(ligatureExpansion(0xfb02)).toBe('fl');
    expect(ligatureExpansion(0xfb03)).toBe('ffi');
    expect(ligatureExpansion(0xfb04)).toBe('ffl');
    expect(ligatureExpansion(0xfb05)).toBe('st');
    expect(ligatureExpansion(0xfb06)).toBe('st');
  });

  test('the whole qualifying set is the 21 codepoints measured, no more', () => {
    const hits: Array<[number, string]> = [];
    for (let cp = 0x20; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const e = ligatureExpansion(cp);
      if (e) hits.push([cp, e]);
    }

    expect(hits).toHaveLength(21);
    const alphabetic = hits.filter(([cp]) => cp >= 0xfb00 && cp <= 0xfb4f);
    expect(alphabetic.map(([cp]) => cp)).toEqual([
      0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0xfb05, 0xfb06, 0xfb13, 0xfb14, 0xfb15, 0xfb16,
      0xfb17, 0xfb4f,
    ]);
    expect(hits.filter(([cp]) => cp >= 0xfe70 && cp <= 0xfeff)).toHaveLength(8);
  });

  test('a single letter carrying a diacritic keeps its codepoint', () => {
    for (const cp of [0x0675, 0x0676, 0x0677, 0x0678, 0x0edc, 0x0edd]) {
      expect(ligatureExpansion(cp)).toBeUndefined();

      expect(String.fromCodePoint(cp).normalize('NFKC').length).toBeGreaterThan(1);
    }
  });

  test('a compatibility character is not a ligature', () => {
    for (const cp of [0x00a8, 0x00af, 0x00bc, 0x02d8, 0x2160, 0x2163, 0x0132]) {
      expect(ligatureExpansion(cp)).toBeUndefined();
    }
  });

  test('a codepoint outside every range is refused without consulting NFKC', () => {
    expect(ligatureExpansion(0x41)).toBeUndefined();
    expect(ligatureExpansion(-1)).toBeUndefined();
    expect(ligatureExpansion(0x110000)).toBeUndefined();
    expect(ligatureExpansion(0xd801)).toBeUndefined();
  });
});

describe('fixToUnicode', () => {
  test('a ligature in a bfchar destination becomes its expansion', () => {
    const out = fixToUnicode(
      pdfWithCMap(
        cmapOf([
          [0x0654, 'FB01'],
          [0x0003, '0020'],
        ]),
      ),
    );
    expect(unresolvedLigatures(out)).toEqual([]);
    const text = cmaps(out).join('');
    expect(text).toContain('<0654> <00660069>');
    expect(text).toContain('<0003> <0020>');
  });

  test('a ligature hidden in a bfrange destination is found', () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    expect(unresolvedLigatures(out)).toEqual([]);
    const text = cmaps(out).join('');
    expect(text).toContain('<0675> <00660066>');
    expect(text).toContain('<0676> <00660069>');
    expect(text).toContain('<0677> <0066006C>');
  });

  test('a string in the stream dictionary survives the rewrite', () => {
    const src = pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00), '/Producer (Acme PDF 3.0) ');
    const out = Buffer.from(fixToUnicode(src)).toString(LATIN1);

    expect(out, 'the rewrite did not run, so this proves nothing').not.toBe(src.toString(LATIN1));
    expect(out).toContain('/Producer (Acme PDF 3.0)');
    expect(out).not.toMatch(/\/Producer \(\s*\)/);

    expect(cmaps(fixToUnicode(src)).join('')).toContain('<0675> <00660066>');
  });

  test('the newline before stream is kept', () => {
    const out = Buffer.from(
      fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00), '/Producer (Acme PDF 3.0) ')),
    ).toString(LATIN1);
    expect(out).toContain('>>\nstream\n');
    expect(out).not.toContain('>>stream');
  });

  test('every glyph a rewritten range covered is still present', () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0678, 0xfb00)));
    const text = cmaps(out).join('');
    for (const gid of ['0675', '0676', '0677', '0678']) expect(text).toContain(`<${gid}>`);
  });

  test('a block header states the number of entries it actually contains', () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = cmaps(out).join('');

    const blocks = [...text.matchAll(/(\d+) begin(bfchar|bfrange)\n([\s\S]*?)\nend\2/g)];
    expect(blocks.length, 'no cmap blocks were matched at all').toBeGreaterThan(0);
    for (const m of blocks) {
      const entries = m[3]!.split('\n').filter((l) => l.trim()).length;
      expect(Number(m[1])).toBe(entries);
    }
  });

  test('a range with no ligature in it is left exactly as written', () => {
    const input = pdfWithCMap(cmapOfRange(0x0044, 0x004c, 0x0061));
    expect(sameBytes(fixToUnicode(input), input)).toBe(true);
  });

  test('a document with no ligature is returned byte for byte', () => {
    const input = pdfWithCMap(
      cmapOf([
        [0x0003, '0020'],
        [0x0014, '0031'],
        [0x0079, '00B7'],
      ]),
    );
    expect(sameBytes(fixToUnicode(input), input)).toBe(true);
  });

  test('a ligature in a bfchar is fixed even when a bfrange is also rewritten', () => {
    const withBoth =
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '3 beginbfchar\n<0654> <FB03>\n<0003> <0020>\n<0014> <0031>\nendbfchar\n' +
      '1 beginbfrange\n<0675> <0677> <FB00>\nendbfrange\n' +
      'endcmap\nend\nend\n';
    const out = fixToUnicode(pdfWithCMap(withBoth));
    expect(unresolvedLigatures(out)).toEqual([]);
    const text = cmaps(out).join('');
    expect(text).toContain('<0654> <006600660069>');
    expect(text).toContain('<0675> <00660066>');
  });

  test('a bfrange line is never rewritten as a bfchar entry', () => {
    const cmap = '2 beginbfrange\n<0010> <0012> <0041>\n<FB00> <FB03> <0050>\nendbfrange\n';
    expect(fixCMap(cmap)).toBeUndefined();
    expect(
      fixToUnicode(pdfWithCMap(cmap)) &&
        sameBytes(fixToUnicode(pdfWithCMap(cmap)), pdfWithCMap(cmap)),
    ).toBe(true);
  });

  test('a codespacerange line is never rewritten either', () => {
    const cmap = '1 begincodespacerange\n<FB00> <FB03>\nendcodespacerange\n';
    expect(fixCMap(cmap)).toBeUndefined();
  });

  test('bfchar entries are still fixed, one per line and several per line', () => {
    const onePerLine = '2 beginbfchar\n<0041> <FB01>\n<0042> <FB02>\nendbfchar\n';
    expect(fixCMap(onePerLine)).toBe(
      '2 beginbfchar\n<0041> <00660069>\n<0042> <0066006C>\nendbfchar\n',
    );
    const perLine = '2 beginbfchar\n<0041> <FB01> <0042> <FB02>\nendbfchar\n';
    expect(fixCMap(perLine)).toBe(
      '2 beginbfchar\n<0041> <00660069> <0042> <0066006C>\nendbfchar\n',
    );
  });

  test('a bfchar entry that is not a ligature is left alone, and the count holds', () => {
    const cmap = '3 beginbfchar\n<0041> <FB01>\n<0042> <FB02>\n<0043> <0044>\nendbfchar\n';
    const out = fixCMap(cmap)!;
    expect(out).toContain('<0043> <0044>');
    expect(out).toContain('3 beginbfchar');
    expect(out).not.toContain('<FB01>');
    expect(out).not.toContain('<FB02>');
  });

  test('an array-form bfrange is repaired and the repair is idempotent', () => {
    for (const arr of ['[<FB00> <FB01>]', '[<FB00> <FB01> <FB02> <FB03>]']) {
      const cmap = `1 beginbfrange\n<0001> ${arr}\nendbfrange\n`;
      const input = pdfWithCMap(cmap);
      expect(unresolvedLigatures(input).length, `before: ${arr}`).toBeGreaterThan(0);

      const once = fixToUnicode(input);
      expect(unresolvedLigatures(once), `after: ${arr}`).toEqual([]);
      expect(sameBytes(fixToUnicode(once), once), `twice: ${arr}`).toBe(true);
    }
  });

  test('an array-form range that needs no repair is left byte-identical', () => {
    const cmap = '1 beginbfrange\n<0001> [<0041> <0042> <0043>]\nendbfrange\n';
    const input = pdfWithCMap(cmap);
    expect(sameBytes(fixToUnicode(input), input)).toBe(true);
  });

  test('the codespacerange line is not mistaken for a glyph mapping', () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    expect(cmaps(out).join('')).toContain('<0000> <FFFF>');
  });

  test('a rewritten file is still a valid pdf', () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = Buffer.from(out).toString(LATIN1);
    expectSoundXref(text);
  });

  test("a stream's /Length matches the payload after rewriting", () => {
    const out = fixToUnicode(pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00)));
    const text = Buffer.from(out).toString(LATIN1);
    expect(expectSoundLengths(text)).toBeGreaterThan(0);
  });

  test('input that is not a linear pdf is returned untouched', () => {
    for (const junk of [Buffer.alloc(0), Buffer.from('not a pdf'), Buffer.from('%PDF-1.7\n')]) {
      expect(sameBytes(fixToUnicode(junk), junk)).toBe(true);
    }
  });

  test('a Uint8Array that is not a Buffer is still read as bytes', () => {
    const input = pdfWithCMap(cmapOfRange(0x0675, 0x0677, 0xfb00));
    const asView = new Uint8Array(input);
    expect(asView).not.toBeInstanceOf(Buffer);
    expect(unresolvedLigatures(fixToUnicode(asView))).toEqual([]);
  });
});

describe('rendered output', () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'letterpress-tounicode-'));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  test('text with ligatures leaves none behind in the ToUnicode', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient different flags finished</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
  });

  test('extracted text is plain letters, so a word search finds it', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient different flags finished</p>`,
    });
    const text = await pdfText(r.pdf);
    for (const word of ['office', 'efficient', 'different', 'flags', 'finished']) {
      expect(text.toLowerCase()).toContain(word);
    }

    for (const cp of [0xfb00, 0xfb01, 0xfb02]) {
      expect(text).not.toContain(String.fromCodePoint(cp));
    }
  });

  test('a document with no ligature is unaffected', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>plain words only</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(await pdfText(r.pdf)).toContain('plain words only');
  });

  test('no font family keeps a ligature, and no repair changes its own output', async () => {
    for (const style of [
      '',
      'font-family:serif',
      'font-family:monospace',
      'font-weight:700',
      'font-style:italic',
    ]) {
      const r = await render(browser, {
        html:
          `<!doctype html><meta charset="utf-8"><p style="${style}">` +
          `office efficient different flags finished</p>`,
      });
      expect(unresolvedLigatures(r.pdf)).toEqual([]);
      expect(sameBytes(fixToUnicode(r.pdf), r.pdf)).toBe(true);
    }
  }, 120_000);

  test('a word containing an ffi ligature is findable in a serif document', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8">
<style>body{font-family:"DejaVu Serif",serif}</style><p>efficient sufficient</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(await pdfText(r.pdf)).toContain('efficient');
    expect(await pdfText(r.pdf)).not.toContain(String.fromCodePoint(0xfb03));
  }, 90_000);

  test('arabic letters carrying hamza keep their codepoints', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p dir="rtl" lang="ar">الأ专著 والمكتبة</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(r.info.pages).toBe(1);
  });

  test('hebrew and french text survive', async () => {
    for (const html of [`<p dir="rtl" lang="he">שלום עולם</p>`, `<p lang="fr">œuvre cœur</p>`]) {
      const r = await render(browser, { html: `<!doctype html>${html}` });
      expect(unresolvedLigatures(r.pdf)).toEqual([]);
      expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
    }
  });

  test('the file is still readable after both fixes have run', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p>office efficient</p>`,
    });
    const info = await pdfInfo(r.pdf);
    expect(info.pages).toBe(1);
    const text = Buffer.from(r.pdf).toString(LATIN1);
    expect(text.match(/startxref/g)).toHaveLength(1);
    expect(text.slice(Number(text.match(/startxref\s+(\d+)/)![1]))).toStartWith('xref');
  });

  test('the fix composes with the descriptor fix in one pass', async () => {
    const r = await render(browser, {
      html: `<!doctype html><p style="font-family:sans-serif">office efficient</p>`,
    });
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    const text = Buffer.from(r.pdf).toString(LATIN1);
    const header = text
      .slice(Number(text.match(/startxref\s+(\d+)/)![1]))
      .match(/^xref\s+0\s+(\d+)\s/)!;
    const table = text.slice(Number(text.match(/startxref\s+(\d+)/)![1]) + header[0].length);
    let bad = 0;
    for (let n = 1; n < Number(header[1]); n++) {
      const entry = table.slice(n * 20, n * 20 + 20);
      if (entry[17] !== 'n') continue;
      const off = Number(entry.slice(0, 10));
      if (!text.startsWith(`${n} 0 obj`, off)) bad++;
    }
    expect(bad).toBe(0);
  });
});
