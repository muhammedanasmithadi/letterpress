import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { addMetadata, readDocInfo } from '../src/meta.ts';
import { fixFontDescriptors, unresolvedFontMetrics } from '../src/fontdesc.ts';
import { fixToUnicode, unresolvedLigatures } from '../src/tounicode.ts';
import { contentPayloads, repairOrKeep, verify } from '../src/verify.ts';
import { join as joinParts, split } from '../src/pdfparts.ts';
import { pdfInfo } from './poppler.ts';

const LATIN1 = 'latin1' as BufferEncoding;

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function fixture(): Buffer {
  const parts = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R >>',
    '<< /Title (Fixture) /Producer (Skia/PDF m154) >>',
  ];
  const streams = [
    'BT /F1 12 Tf 10 100 Td (page one) Tj ET',
    'BT /F1 12 Tf 10 100 Td (page two) Tj ET',
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', LATIN1)];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    offsets.push(length);
    const b = Buffer.from(`${i + 1} 0 obj\n${parts[i]}\nendobj\n`, LATIN1);
    chunks.push(b);
    length += b.length;
  }
  for (let i = 0; i < streams.length; i++) {
    offsets.push(length);
    const b = Buffer.from(
      `${6 + i} 0 obj\n<< /Length ${streams[i]!.length} >>\nstream\n${streams[i]}\nendstream\nendobj\n`,
      LATIN1,
    );
    chunks.push(b);
    length += b.length;
  }
  const xrefAt = length;
  const n = parts.length + streams.length + 1;
  const table = [`xref\n0 ${n}\n0000000000 65535 f \n`];
  for (let k = 1; k < n; k++) {
    table.push(`${String(offsets[k - 1] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(Buffer.from(table.join(''), LATIN1));
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${n} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      LATIN1,
    ),
  );
  return Buffer.concat(chunks);
}

function movesGlyphs(pdf: Uint8Array): Uint8Array {
  const text = Buffer.from(pdf).toString(LATIN1);
  return Buffer.from(text.replace('(page one)', '(page ONE)'), LATIN1);
}

function breaksXref(pdf: Uint8Array): Uint8Array {
  const text = Buffer.from(pdf).toString(LATIN1);
  const bad = text.replace(/startxref\n(\d+)/, (_m, at: string) => `startxref\n${Number(at) + 7}`);

  return Buffer.from(
    bad.replace(
      /\n(\d{10}) 00000 n \n/,
      (_m, off: string) => `\n${String(Number(off) + 3).padStart(10, '0')} 00000 n \n`,
    ),
    LATIN1,
  );
}

describe('verify', () => {
  test('a whole file passes', () => {
    const r = verify(fixture());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('two startxref lines are refused', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const two = Buffer.from(text.replace(/startxref/, '\nstartxref\n0'), LATIN1);
    const r = verify(two);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/startxref/);
  });

  test('a startxref pointing at the wrong place is refused', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const at = text.search(/startxref\n(\d+)/);
    const broken = Buffer.from(
      text.slice(0, at) + text.slice(at).replace(/startxref\n\d+/, 'startxref\n999999'),
      LATIN1,
    );
    const r = verify(broken);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/does not point/);
  });

  test('a reference to an object that does not exist is refused', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const broken = Buffer.from(text.replace('/Contents 6 0 R', '/Contents 99 0 R'), LATIN1);
    const r = verify(broken);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/does not exist/);
  });

  test('a stream whose /Length disagrees with its payload is refused', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const broken = Buffer.from(text.replace('/Length 39', '/Length 99'), LATIN1);
    const r = verify(broken);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/Length/);
  });

  test('a file that is not a linear pdf fails rather than passing silently', () => {
    const r = verify(Buffer.from('not a pdf at all'));
    expect(r.ok).toBe(false);
  });

  test('a reference inside a literal string is not a reference', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const withAlt = Buffer.from(
      text.replace('/Contents 6 0 R', '/Alt (see object 999 0 R) /Contents 6 0 R'),
      LATIN1,
    );

    expect(verify(withAlt).failures.join(' ')).not.toMatch(/does not exist/);
    expect(verify(Buffer.from(fixture())).failures).toEqual([]);
  });

  test('a reference inside a stream payload is not a reference', () => {
    const payload = Buffer.from('<x>see object 999 0 R</x>', LATIN1);
    const text = Buffer.from(fixture()).toString(LATIN1);
    const added = `9 0 obj
<< /Length ${payload.length} >>
stream
${payload.toString(LATIN1)}
endstream
endobj
`;
    const r = verify(Buffer.from(text.replace('trailer', added + 'trailer'), LATIN1));
    expect(r.failures.join(' ')).not.toMatch(/does not exist/);
  });

  test('a genuine dangling reference is still refused with the scan narrowed', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const broken = Buffer.from(text.replace('/Contents 6 0 R', '/Contents 99 0 R'), LATIN1);
    expect(verify(broken).ok).toBe(false);
  });

  test('/Length is read past a string carrying the word stream', () => {
    const text = Buffer.from(fixture()).toString(LATIN1);
    const hidden = Buffer.from(
      text.replace('/Length 39', '/Producer (upstream) /Length 39'),
      LATIN1,
    );
    expect(verify(hidden).ok).toBe(false);
  });
});

describe('content survived', () => {
  test("contentPayloads finds every page's stream", () => {
    expect(contentPayloads(fixture())).toHaveLength(2);
  });

  test('a repair that moves a glyph is caught, and structure cannot', () => {
    const original = fixture();
    const moved = movesGlyphs(original);

    const structureOnly = verify(moved);
    expect(structureOnly.ok).toBe(true);

    const withOriginal = verify(moved, original);
    expect(withOriginal.ok).toBe(false);
    expect(withOriginal.failures.join(' ')).toMatch(/content stream 1 was rewritten/);
  });

  test('a repair that changes nothing outside the content stream passes', () => {
    const original = fixture();
    const described = fixFontDescriptors(addMetadata(original, { author: 'A Person' }));
    const r = verify(described, original);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('a page pointing at a different stream is caught', () => {
    const original = fixture();
    const text = Buffer.from(original).toString(LATIN1);

    const swapped = Buffer.from(
      text
        .replace('/Contents 6 0 R', '/Contents \x00 R')
        .replace('/Contents 7 0 R', '/Contents 6 0 R')
        .replace('/Contents \x00 R', '/Contents 7 0 R'),
      LATIN1,
    );
    expect(verify(swapped).ok).toBe(true);
    expect(verify(swapped, original).ok).toBe(false);
  });
});

describe('repairOrKeep', () => {
  test('a repair that is already a no-op is not treated as applied', () => {
    const original = fixture();
    const r = repairOrKeep(original, (p) => p);
    expect(r.applied).toBe(false);
    expect(r.failures).toEqual([]);
    expect(r.pdf).toBe(original);
  });

  test('a good repair is kept', () => {
    const original = fixture();
    const r = repairOrKeep(original, (p) => addMetadata(p, { author: 'A Person' }));
    expect(r.applied).toBe(true);
    expect(readDocInfo(r.pdf).author).toBe('A Person');
  });

  test('a repair that moves a glyph is discarded and the original kept', () => {
    const original = fixture();
    const r = repairOrKeep(original, movesGlyphs);
    expect(r.applied).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(same(r.pdf, original)).toBe(true);
  });

  test('a repair that throws is discarded rather than propagated', () => {
    const original = fixture();
    const r = repairOrKeep(original, () => {
      throw new Error('boom');
    });
    expect(r.applied).toBe(false);
    expect(r.failures.join(' ')).toMatch(/threw/);
    expect(same(r.pdf, original)).toBe(true);
  });

  test('a repair that breaks the file is discarded', () => {
    const original = fixture();

    const broken = breaksXref(original);
    expect(same(broken, original), 'the corruption helper changed nothing').toBe(false);
    expect(verify(broken).ok, 'the corrupted file should not verify').toBe(false);

    const r = repairOrKeep(original, (p) => breaksXref(p));
    expect(r.applied).toBe(false);
    expect(same(r.pdf, original)).toBe(true);

    expect(r.failures.join(' ')).toMatch(/xref|startxref/i);
  });

  test('truncating the file is caught', () => {
    const original = fixture();
    const r = repairOrKeep(original, (p) => p.subarray(0, Math.floor(p.length / 2)));
    expect(r.applied).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });
});

describe('the gate in the render path', () => {
  let browser: Browser;
  let profile: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'letterpress-gate-'));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  test('an ordinary render is verified and reported intact', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><h1>H</h1><p>office efficient flags finished</p>`,
      author: 'A Person',
    });

    expect(r.findings.filter((f) => f.code === 'repair-rejected')).toEqual([]);
    expect(readDocInfo(r.pdf).author).toBe('A Person');
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    expect(verify(r.pdf).ok).toBe(true);
  });

  test('the shipped file always passes its own checks', async () => {
    for (const html of [
      `<p>plain</p>`,
      `<p style="font-family:serif">office efficient finished</p>`,
      `<p style="font-family:monospace">office</p>`,
      `<p>你好世界</p>`,
      `<p></p>`,
    ]) {
      const r = await render(browser, { html: `<!doctype html><meta charset="utf-8">${html}` });
      const v = verify(r.pdf);
      expect(v.failures).toEqual([]);
    }
  });

  test('every repair is a function of its input, on a real render', async () => {
    for (const style of ['', 'font-family:serif', 'font-weight:700', 'font-style:italic']) {
      const r = await render(browser, {
        html: `<!doctype html><meta charset="utf-8"><p style="${style}">office efficient different flags finished</p>`,
      });
      expect(unresolvedLigatures(r.pdf)).toEqual([]);
      expect(same(fixToUnicode(r.pdf), r.pdf)).toBe(true);
      expect(same(fixFontDescriptors(r.pdf), r.pdf)).toBe(true);
    }
  }, 120_000);

  test('the repairs still do their work', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style><p>office efficient</p>`,
      author: 'Someone',
    });
    expect(readDocInfo(r.pdf).author).toBe('Someone');
    expect(unresolvedLigatures(r.pdf)).toEqual([]);
    const text = Buffer.from(r.pdf).toString(LATIN1);
    expect(text).not.toMatch(/\/CapHeight -/);
  });

  describe('split and join round-trip a real render', () => {
    const DOC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Round trip</title>
<style>@page { size: A4; margin: 15mm }
body { font-family: 'Noto Serif', serif }
code { font-family: 'Noto Sans Mono', monospace }
td { border: 0.5pt solid #999 }</style></head><body>
<h1>Heading</h1><p>Some prose with a <a href="https://example.com/">link</a> in it.</p>
<table>${Array.from({ length: 30 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>value ${i}</td></tr>`).join('')}</table>
</body></html>`;

    test('every object and the trailer survive unchanged, and the result still reads', async () => {
      const r = await render(browser, { html: DOC, author: 'round trip' });
      const parts = split(Buffer.from(r.pdf));
      const rejoined = joinParts(parts.head, parts.objs, parts.trailer);

      const before = new Map(parts.objs.map((o) => [o.num, o.bytes]));
      const after = split(rejoined);
      expect(after?.objs.length).toBe(parts.objs.length);
      for (const o of after?.objs ?? []) {
        expect(before.get(o.num)?.equals(o.bytes)).toBe(true);
      }
      expect(parts.trailer.equals(after?.trailer ?? Buffer.alloc(0))).toBe(true);

      expect(verify(rejoined).ok).toBe(true);
      expect((await pdfInfo(rejoined)).pages).toBe((await pdfInfo(Buffer.from(r.pdf))).pages);
    }, 120_000);
  });
});
