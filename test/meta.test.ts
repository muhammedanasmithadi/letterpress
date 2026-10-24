import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import {
  addMetadata,
  buildXmp,
  pdfString,
  readDocInfo,
  readXmp,
  readXmpPacket,
  setDocTitle,
  xmlText,
} from '../src/meta.ts';
import { render } from '../src/render.ts';
import {
  assemblePdf,
  encryptedFixture,
  expectSoundLengths,
  expectSoundXref,
  sameBytes,
} from './fixtures.ts';

const LATIN1 = 'latin1' as BufferEncoding;

function pdfFixture(infoExtra = ''): Buffer {
  return assemblePdf(
    [
      '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Type /MarkInfo /Marked true >> /Lang (en) >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
      `<< /Title (Fixture) /Producer (Skia/PDF m154) /CreationDate (D:20260101120000+00'00') ` +
        `/ModDate (D:20260101120000+00'00')${infoExtra} >>`,
    ],
    {
      endobj: '\nendobj\n',
      trailer: (size: number, xrefAt: number) =>
        `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    },
  );
}

function rootOf(text: string): number {
  const trailer = /trailer([\s\S]*?)startxref/.exec(text)![1]!;
  return Number(/\/Root (\d+) 0 R/.exec(trailer)![1]);
}

function dictionaries(
  text: string,
): Array<{ obj: string; body: string; balanced: boolean; depthZero: number }> {
  const out: Array<{ obj: string; body: string; balanced: boolean; depthZero: number }> = [];
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    let depth = 0;
    let depthZero = -1;

    let inString = false;
    for (let i = 0; i < body.length - 1; i++) {
      const ch = body[i]!;
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === ')') inString = false;
        continue;
      }
      if (ch === '(') {
        inString = true;
        continue;
      }
      const pair = body.slice(i, i + 2);
      if (pair === '<<') {
        depth++;
        i++;
      } else if (pair === '>>') {
        depth--;
        if (depth === 0) depthZero = i;
        i++;
      }
    }
    out.push({ obj: m[1]!, body, balanced: depth === 0, depthZero });
  }
  return out;
}

describe('pdfString', () => {
  test('printable ascii needs no escaping at all', () => {
    expect(pdfString('Ahammed Sahad')).toBe('Ahammed Sahad');
    expect(pdfString('curriculum vitae')).toBe('curriculum vitae');
  });

  test('the delimiter and the escape character are escaped', () => {
    expect(pdfString('a(b)c')).toBe('a\\(b\\)c');
    expect(pdfString('back\\slash')).toBe('back\\\\slash');
  });

  test('a value that would close the string early cannot', () => {
    expect(pdfString(') /Root 9 0 R (')).toBe('\\) /Root 9 0 R \\(');
  });

  test('non-ascii becomes a hex string in utf-16be with a byte order mark', () => {
    expect(pdfString('東')).toBe('<FEFF6771>');
  });

  test('the hex replaces the parentheses rather than sitting inside them', () => {
    const encoded = pdfString('東京');
    expect(encoded.startsWith('<')).toBe(true);
    expect(encoded.endsWith('>')).toBe(true);
    expect(encoded.slice(1, -1).startsWith('FEFF')).toBe(true);
  });

  test('a character outside the basic plane keeps its surrogate pair', () => {
    expect(pdfString('\u{1f600}')).toBe('<FEFFD83DDE00>');
  });
});

describe('xmlText', () => {
  test('the five entities are escaped', () => {
    expect(xmlText(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  test('a value that would close an element or the packet is escaped', () => {
    expect(xmlText('</rdf:li></dc:creator></rdf:RDF>')).toBe(
      '&lt;/rdf:li&gt;&lt;/dc:creator&gt;&lt;/rdf:RDF&gt;',
    );
    expect(xmlText(']]>')).toBe(']]&gt;');
  });

  test('a control character is dropped, since XML has no way to carry it', () => {
    expect(xmlText('a\u0000\u0007b')).toBe('ab');
  });

  test('tab, newline and carriage return survive', () => {
    expect(xmlText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });
});

describe('buildXmp', () => {
  test('every field comes from the dictionary it is given', () => {
    const xmp = buildXmp({
      title: 'A Resume',
      author: 'Ahammed Sahad',
      subject: 'Curriculum vitae',
      keywords: 'cv, resume',
      creator: 'Chromium',
      producer: 'Skia/PDF',
      created: "D:20260101120000+00'00'",
      modified: "D:20260101135959+00'00'",
    });
    expect(xmp).toContain('<rdf:li xml:lang="x-default">A Resume</rdf:li>');
    expect(xmp).toContain('<rdf:li>Ahammed Sahad</rdf:li>');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Curriculum vitae</rdf:li>');
    expect(xmp).toContain('<xmp:CreatorTool>Chromium</xmp:CreatorTool>');
    expect(xmp).toContain('<pdf:Producer>Skia/PDF</pdf:Producer>');
    expect(xmp).toContain('<xmp:CreateDate>2026-01-01T12:00:00</xmp:CreateDate>');
    expect(xmp).toContain('<xmp:ModifyDate>2026-01-01T13:59:59</xmp:ModifyDate>');
  });

  test('a title is a language alternative and an author is a list', () => {
    const xmp = buildXmp({ title: 'T', author: 'A' });
    expect(xmp).toContain('<dc:title><rdf:Alt><rdf:li');
    expect(xmp).toContain('<dc:creator><rdf:Bag><rdf:li>A</rdf:li></rdf:Bag>');
  });

  test('a field that is absent is left out rather than written empty', () => {
    const xmp = buildXmp({ title: 'Only a title' });
    expect(xmp).toContain('dc:title');
    expect(xmp).not.toContain('dc:creator');
    expect(xmp).not.toContain('dc:description');
    expect(xmp).not.toContain('CreateDate');
  });

  test('the begin marker carries a real byte order mark', () => {
    const bytes = Buffer.from(buildXmp({ title: 'T' }), 'utf8');
    expect(bytes.subarray(0, 30).toString('latin1')).toContain('\xef\xbb\xbf');
  });

  test('every element the packet opens, it also closes', () => {
    const xmp = buildXmp({ title: 'A & B <c>', author: 'X > Y', created: 'D:20260101120000' });
    const body = xmp.replace(/<\?xpacket[^?]*\?>/g, '');
    let depth = 0;
    for (const m of body.matchAll(/<\/?([A-Za-z_][\w:.-]*)[^>]*?(\/)?>/g)) {
      if (m[0].startsWith('</')) depth--;
      else if (!m[2]) depth++;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  test('a name carrying markup cannot add an element', () => {
    const xmp = buildXmp({ title: '</dc:title><dc:subject>injected' });

    expect(xmp.match(/<dc:title>/g)).toHaveLength(1);
    expect(xmp).not.toContain('<dc:subject>injected');
    expect(xmp).toContain('&lt;/dc:title&gt;');
  });

  test('the packet names the pdfua revision it validates against', () => {
    const xmp = buildXmp({ title: 'T' });

    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xmp).toContain('pdfuaid:part="1"');
    expect(xmp).toContain('pdfuaid:rev="2020"');
    expect(xmp.match(/pdfuaid:part=/g)).toHaveLength(1);
  });

  test('a user value cannot add a pdfuaid description', () => {
    const xmp = buildXmp({
      title:
        '</rdf:Description><rdf:Description rdf:about="" xmlns:pdfuaid="x" pdfuaid:part="999"/>',
    });

    expect(xmp.match(/<rdf:Description rdf:about="" xmlns:pdfuaid=/g)).toHaveLength(1);
    expect(xmp).not.toContain('pdfuaid:part="999"');
  });
});

describe('readDocInfo', () => {
  test('reads the values chromium wrote', () => {
    const info = readDocInfo(pdfFixture());
    expect(info.title).toBe('Fixture');
    expect(info.producer).toBe('Skia/PDF m154');
    expect(info.created).toBe("D:20260101120000+00'00'");
    expect(info.author).toBeUndefined();
  });

  test('reads a hex string back to the same text', () => {
    const info = readDocInfo(pdfFixture(' /Author <FEFF6771> '));
    expect(info.author).toBe('東');
  });

  test('a pdf with no information dictionary reads as empty', () => {
    expect(readDocInfo(Buffer.from('%PDF-1.4\n'))).toEqual({});
    expect(readDocInfo(Buffer.alloc(0))).toEqual({});
  });
});

describe('addMetadata', () => {
  test('the author lands in the information dictionary', () => {
    const out = addMetadata(pdfFixture(), { author: 'Ahammed Sahad' });
    expect(readDocInfo(out).author).toBe('Ahammed Sahad');
  });

  test('the packet is attached to the catalog', () => {
    const out = addMetadata(pdfFixture(), { author: 'Ahammed Sahad' });
    expect(readXmp(out)).toEqual({ present: true, creator: 'Ahammed Sahad' });
  });

  test('the reference goes into the catalog and not into a nested dictionary', () => {
    const out = addMetadata(pdfFixture(), { author: 'A' });
    const text = Buffer.from(out).toString(LATIN1);
    const catalog = dictionaries(text).find((d) => d.body.includes('/Type /Catalog'))!;
    const ref = /\/Metadata (\d+) 0 R/.exec(catalog.body)!;
    expect(ref).not.toBeNull();

    expect(ref!.index).toBeLessThan(catalog.depthZero);
    expect(catalog.body).not.toContain('/Marked true/Metadata');
  });

  test('every dictionary in the file is still balanced', () => {
    for (const info of [
      { author: 'A' },
      { subject: 'S' },
      { keywords: 'K' },
      { author: 'A', subject: 'S', keywords: 'K' },
    ]) {
      const text = Buffer.from(addMetadata(pdfFixture(), info)).toString(LATIN1);

      const found = dictionaries(text);
      expect(found.length).toBeGreaterThan(0);
      for (const d of found) expect(d.balanced).toBe(true);
    }
  });

  test('a minimal packet is written even when nothing is declared', () => {
    const input = pdfFixture();
    const out = addMetadata(input, {});
    expect(sameBytes(out, input)).toBe(false);
    expect(readXmp(out).present).toBe(true);
    expect(readDocInfo(out).author).toBeUndefined();
    expect(readXmpPacket(out)).not.toContain('dc:creator');
    expect(readXmpPacket(addMetadata(input, { author: '  ' }))).not.toContain('dc:creator');
    expect(readXmpPacket(addMetadata(input, { subject: '' }))).not.toContain('dc:description');
  });

  test('a document that states no author gets no invented one', () => {
    const out = addMetadata(pdfFixture(), {});
    expect(readDocInfo(out).author).toBeUndefined();
    expect(readXmp(out)).toEqual({ present: true, creator: undefined });
  });

  test('an existing author is replaced rather than duplicated', () => {
    const out = addMetadata(pdfFixture(' /Author (Previous Name) '), { author: 'New Name' });
    const text = Buffer.from(out).toString(LATIN1);
    expect(text.match(/\/Author /g)).toHaveLength(1);
    expect(readDocInfo(out).author).toBe('New Name');
  });

  test('a non-ascii author round-trips', () => {
    const name = 'Аhammed ظ Lanzón 東京';
    const out = addMetadata(pdfFixture(), { author: name });
    expect(readDocInfo(out).author).toBe(name);
    expect(readXmp(out).creator).toBe(name);
  });

  test('a hostile author cannot break out of the dictionary or the packet', () => {
    const hostile = `A ) >> /Root 9 0 R (evil) ( \\101 & <script> ]]>`;
    const out = addMetadata(pdfFixture(), { author: hostile });
    const text = Buffer.from(out).toString(LATIN1);

    expect(readDocInfo(out).author).toBe(hostile);
    for (const d of dictionaries(text)) expect(d.balanced).toBe(true);

    expect(rootOf(text)).toBeTypeOf('number');
    expect(dictionaries(text).find((d) => d.obj === String(rootOf(text)))!.body).toContain(
      '/Type /Catalog',
    );

    const trailer = /trailer([\s\S]*?)startxref/.exec(text)![1]!;
    expect(trailer.match(/\/Root /g)).toHaveLength(1);

    const info = dictionaries(text).find((d) => d.body.includes('/Title (Fixture)'))!;
    expect(info.body).toContain('\\) >> /Root 9 0 R \\(');
    expect(info.body).not.toContain(') >> /Root 9 0 R (');
  });

  test('the packet survives a name that would close an element', () => {
    const out = addMetadata(pdfFixture(), {
      author: '</rdf:li></dc:creator></rdf:RDF></x:xmpmeta>',
    });
    expect(readXmp(out).creator).toContain('</rdf:li>');
    const text = readXmpPacket(out);

    expect(text.match(/<x:xmpmeta/g)).toHaveLength(1);
  });

  test('input that is not a linear pdf is returned untouched', () => {
    for (const junk of [Buffer.alloc(0), Buffer.from('nope'), Buffer.from('%PDF-1.7\n')]) {
      expect(sameBytes(addMetadata(junk, { author: 'A' }), junk)).toBe(true);
    }
  });

  test('the file is still structurally sound afterwards', () => {
    const text = Buffer.from(addMetadata(pdfFixture(), { author: 'Ahammed Sahad' })).toString(
      LATIN1,
    );
    expectSoundXref(text);
  });

  test("the packet stream's /Length matches its payload", () => {
    const text = Buffer.from(addMetadata(pdfFixture(), { author: 'A' })).toString(LATIN1);
    expect(expectSoundLengths(text)).toBe(1);
  });
});

describe('rendered output', () => {
  let browser: Browser;
  let profile: string;
  let dir: string;

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'letterpress-meta-'));
    dir = await mkdtemp(join(tmpdir(), 'letterpress-meta-doc-'));
    browser = await Browser.launch({ profile });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('an author the document declares reaches the dictionary', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta name="author" content="Ahammed Sahad"><title>T</title><p>x</p>`,
    });
    expect(readDocInfo(r.pdf).author).toBe('Ahammed Sahad');
    expect(readXmp(r.pdf)).toEqual({ present: true, creator: 'Ahammed Sahad' });
  });

  test('a document declaring nothing still carries an XMP packet', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>Body.</p>`,
    });
    const packet = readXmpPacket(r.pdf);
    expect(packet, 'no XMP packet without declared metadata').toBeDefined();
    expect(packet).toContain('<xmp:CreatorTool>');
    expect(packet).toContain('<xmp:CreateDate>');
    expect(packet).not.toContain('dc:creator');
    expect(packet).not.toContain('dc:description');
    const text = Buffer.from(r.pdf).toString(LATIN1);
    expect(text).toMatch(/\/Metadata \d+ 0 R/);
  });

  test('the packet is generated from the dictionary, so the two agree', async () => {
    const r = await render(browser, {
      html:
        `<!doctype html><meta name="author" content="Ahammed Sahad">` +
        `<meta name="subject" content="CV"><title>The Title</title><p>x</p>`,
    });
    const info = readDocInfo(r.pdf);
    const xmp = readXmp(r.pdf);
    expect(xmp.creator).toBe(info.author);
    expect(info.subject).toBe('CV');
    expect(info.title).toBe('The Title');
  });

  test('the flag overrides the document', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta name="author" content="From Document"><p>x</p>`,
      author: 'From Flag',
    });
    expect(readDocInfo(r.pdf).author).toBe('From Flag');
  });

  test('a document that declares nothing gets no author, but still gets a packet', async () => {
    const r = await render(browser, { html: `<!doctype html><title>T</title><p>x</p>` });
    expect(readDocInfo(r.pdf).author).toBeUndefined();
    expect(readXmp(r.pdf)).toEqual({ present: true, creator: undefined });
  });

  test('the finding says where the author came from', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta name="author" content="Ahammed Sahad"><p>x</p>`,
    });
    const finding = r.findings.find((f) => f.code === 'metadata-authored');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('Ahammed Sahad');

    const viaFlag = await render(browser, {
      html: `<!doctype html><meta name="author" content="Ahammed Sahad"><p>x</p>`,
      author: 'Override',
    });
    expect(viaFlag.findings.find((f) => f.code === 'metadata-authored')).toBeUndefined();
  });

  test('the page content is unchanged by any of this', async () => {
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>Heading</h1><p>body text</p>`;
    const plain = await render(browser, { html });
    const withMeta = await render(browser, { html, author: 'Ahammed Sahad', subject: 'CV' });

    const contentOf = (pdf: Uint8Array) =>
      [
        ...Buffer.from(pdf)
          .toString(LATIN1)
          .matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g),
      ]
        .filter((m) => !m[2]!.includes('/Subtype /XML'))
        .map(
          (m) => `${m[1]}:${(m[2]!.match(/stream\r?\n([\s\S]*?)\nendstream/)?.[1] ?? '').length}`,
        )
        .join(',');
    expect(contentOf(withMeta.pdf)).toBe(contentOf(plain.pdf));
    expect(withMeta.info.pages).toBe(plain.info.pages);
    expect(withMeta.info.mediaBoxes).toEqual(plain.info.mediaBoxes);
  });

  test('a document whose own metadata names a hostile author still yields a valid file', async () => {
    const r = await render(browser, {
      html: `<!doctype html><meta name="author" content=") >> /Root 9 0 R (x"><p>x</p>`,
    });
    expect(readDocInfo(r.pdf).author).toContain('/Root 9 0 R');
    expect(r.info.pages).toBe(1);

    const text = Buffer.from(r.pdf).toString(LATIN1);
    expect(dictionaries(text).find((d) => d.obj === String(rootOf(text)))!.body).toContain(
      '/Type /Catalog',
    );
  });

  test('the authored file survives a real reader', async () => {
    const html = join(dir, 'meta.html');
    await writeFile(
      html,
      `<!doctype html><meta charset="utf-8">
      <meta name="author" content="Ahammed Sahad"><meta name="subject" content="Curriculum vitae">
      <title>Metadata Fixture</title><p>text</p>`,
      'utf8',
    );
    const r = await render(browser, { path: html, author: 'Ahammed Sahad' });
    const text = Buffer.from(r.pdf).toString(LATIN1);

    expect(text.match(/\/Metadata \d+ 0 R/g)).toHaveLength(1);
    expect(readXmpPacket(r.pdf).match(/<x:xmpmeta/g)).toHaveLength(1);
    expect(r.info.pages).toBe(1);
  });
});

describe('no keys are planted in an encrypted file', () => {
  test('no metadata packet is added to it', () => {
    const pdf = encryptedFixture();
    expect(Buffer.from(addMetadata(pdf, { author: 'A' })).equals(Buffer.from(pdf))).toBe(true);
  });

  test('no title is written into its ciphertext Info', () => {
    const pdf = encryptedFixture();
    expect(Buffer.from(setDocTitle(pdf, 'Fuzz')).equals(Buffer.from(pdf))).toBe(true);
  });
});
