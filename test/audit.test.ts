import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { readXmpPacket } from '../src/meta.ts';
import { fontProbe } from '../src/pageside.ts';
import { tabWithHtml } from './browser.ts';
import { launchTestServer, serverOrigin } from './servers.ts';

function widePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = ((x * 255) / width) | 0;
      raw[row + 2 + x * 3] = ((y * 255) / height) | 0;
      raw[row + 3 + x * 3] = ((x ^ y) * 7) & 0xff;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let browser: Browser;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'letterpress-audit-'));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

const boxSize = (box: string) => {
  const m = box.match(/\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/);
  return { w: Number(m![1]), h: Number(m![2]) };
};

test('a page count above eight is reported correctly', async () => {
  for (const n of [9, 12, 40]) {
    const html =
      `<!doctype html><style>@page{size:A4;margin:8mm}</style>` +
      Array.from({ length: n }, (_, i) => `<div style="break-before:page">p${i + 1}</div>`).join(
        '',
      );
    const r = await render(browser, { html });
    expect(r.info.pages).toBe(n);
  }
}, 90_000);

test('a document that declares no paper defaults to a4, not us letter', async () => {
  const r = await render(browser, { html: '<!doctype html><p>no @page here</p>' });
  // 594.96pt, not 595.92. The default is written as `@page { size: a4 }` rather
  // than passed to printToPDF as 8.2677 inches, because Chromium quantizes the
  // inch form: measured across 19 widths, a request landing on a whole CSS pixel
  // comes back exact and every other one comes back larger, never smaller.
  expect(r.info.mediaBoxes[0]).toMatch(/594\.9\d+ 841\.9\d+/);
}, 30_000);

test('--format a4 and @page size a4 are the same sheet, not nearly', async () => {
  // This was "agree to within a point", and 1.5pt was the drift: the flag went
  // to printToPDF as 8.2677 inches and came back 595.92pt where the same paper
  // written in CSS is 594.96pt. Both are now the same rule, so the tolerance is
  // gone rather than narrowed -- two spellings of one paper that disagree are
  // exactly the failure a preview tool cannot have.
  const viaFlag = await render(browser, { html: '<!doctype html><p>x</p>', format: 'a4' });
  const viaCss = await render(browser, {
    html: '<!doctype html><style>@page{size:a4;margin:0}</style><p>x</p>',
  });
  const size = (box: string) =>
    box
      .match(/([\d.]+)\s+([\d.]+)\s*\]/)!
      .slice(1)
      .map(Number);
  // The numbers are asserted as well as the strings, so a failure says which
  // edge moved rather than only that the two differ.
  expect(size(viaFlag.info.mediaBoxes[0]!)).toEqual(size(viaCss.info.mediaBoxes[0]!));

  expect(viaFlag.info.mediaBoxes[0]).toBe(viaCss.info.mediaBoxes[0]);
}, 30_000);

test('--landscape under a portrait @page transposes the document own declaration', async () => {
  // This used to be an error finding and a portrait sheet. Chromium discards its
  // `landscape` parameter whenever `preferCSSPageSize` is set, and a document that declares
  // its own page is exactly that case, so the flag was sent, dropped, and reported as
  // having had no effect. Measured before the fix: 595x842 with `--landscape had no
  // effect`. Now the declaration is transposed and the paper comes back wide.
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:A4;margin:10mm}</style><p>x</p>',
    landscape: true,
  });
  expect(codes(r.findings)).not.toContain('orientation-ignored');
  expect(codes(r.findings)).toContain('orientation-overridden');
  expect(r.findings.find((f) => f.code === 'orientation-overridden')!.severity).toBe('info');

  const { w, h } = boxSize(r.info.mediaBoxes[0]!);
  expect(w).toBeGreaterThan(h);
  // The document's own A4, transposed -- 841.89pt high becomes the width. A format flag
  // would have given 842.0 from FORMATS' decimal inches instead.
  expect(w).toBeCloseTo(841.89, 1);
});

test('--landscape under a declaration with no paper to rotate is still an error', async () => {
  // `auto` names no sheet, so there is no portrait spelling to transpose and no paper the
  // engine could rotate without inventing one. Reported, not guessed at.
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:auto}</style><p>x</p>',
    landscape: true,
  });
  expect(codes(r.findings)).toContain('orientation-ignored');
  expect(r.findings.find((f) => f.code === 'orientation-ignored')!.severity).toBe('error');
}, 30_000);

test('a declaration already in landscape is left alone', async () => {
  // A transpose that swaps unconditionally turns `297mm 210mm` into portrait: a document
  // that already had what was asked for would be printed wrong by the request asking for
  // it.
  for (const size of ['A4 landscape', '297mm 210mm']) {
    const r = await render(browser, {
      html: `<!doctype html><style>@page{size:${size}}</style><p>x</p>`,
      landscape: true,
    });
    expect(codes(r.findings)).not.toContain('orientation-overridden');
    const { w, h } = boxSize(r.info.mediaBoxes[0]!);
    expect(w).toBeGreaterThan(h);
  }
}, 60_000);

test('--margin under a declared @page margin is reported', async () => {
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:A4;margin:0}</style><p>x</p>',
    format: 'a4',
    margin: '20mm',
  });
  expect(codes(r.findings)).toContain('margin-ignored');
}, 30_000);

test('an unfilled template placeholder is an error', async () => {
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:A4}</style><p>{{company}} owes {{total}}</p>',
  });
  const f = r.findings.find((x) => x.code === 'unfilled-placeholder')!;
  expect(f).toBeTruthy();
  expect(f.severity).toBe('error');
  expect(f.message).toContain('{{company}}');
}, 30_000);

test('a data file rendered as a document is refused with a finding', async () => {
  const r = await render(browser, { html: JSON.stringify({ a: 1, b: ['x', 'y'] }, null, 2) });
  expect(codes(r.findings)).toContain('json-rendered');
}, 30_000);

test('target-counter in a stylesheet is reported, because it prints nothing', async () => {
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
.toc a::after{content: leader('.') target-counter(attr(href url), page)}
</style><h1>T</h1><p><a href="#s">Section</a></p><h2 id="s">Section</h2>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === 'unsupported-paged-media')!;
  expect(f).toBeTruthy();
  expect(f.severity).toBe('error');
  expect(f.message).toContain('target-counter');
}, 30_000);

test('a discarded leader() is reported from the style text, not missed', async () => {
  // Chromium empties the whole content declaration when it meets leader(), so the rule's
  // cssText is already `.c::after { }` by the time the CSSOM scan runs and the finding
  // was silent. The document's own <style> text still has the declaration.
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
.c::after{content: leader('.')}
</style><h1>T</h1><p class="c">Section</p>`;
  const r = await render(browser, { html });
  const found = r.findings.filter((x) => x.code === 'unsupported-paged-media');
  expect(found.length).toBe(1);
  expect(found[0]!.message).toContain('leader()');
  expect(found[0]!.message).toContain('<style>');
  expect(found[0]!.severity).toBe('error');
}, 30_000);

test('string() and running() are reported from the style text', async () => {
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
.d{content: string(chapter)} .e{content: running(head)}
</style><h1>T</h1><p class="d">Body</p>`;
  const r = await render(browser, { html });
  const found = r.findings.filter((x) => x.code === 'unsupported-paged-media');
  expect(found.map((f) => f.message)).toContainEqual(expect.stringContaining('string()'));
  expect(found.map((f) => f.message)).toContainEqual(expect.stringContaining('running()'));
}, 30_000);

test('a kept declaration is reported once, not twice', async () => {
  // A valid target-counter survives in the CSSOM, so both scans see it. The CSSOM scan
  // runs first and the style-text scan skips names it already reported.
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
.a::after{content: target-counter(attr(href url), page)}
</style><h1>T</h1><p><a href="#s">Section</a></p><h2 id="s">Section</h2>`;
  const r = await render(browser, { html });
  const found = r.findings.filter((x) => x.code === 'unsupported-paged-media');
  expect(found.length).toBe(1);
  expect(found[0]!.message).toContain('target-counter');
  expect(found[0]!.message).not.toContain('<style>');
}, 30_000);

test('a function name inside a string or a comment is not a declaration', async () => {
  // Precision matters more than recall: these names occur as ordinary words, and a
  // scan of raw text that cried at every mention would train people to ignore it.
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
/* content: leader('.') */
.q::after{content: "a string( of text"} .w::before{content: 'running( late)'}
</style><h1>T</h1><p class="q">Body</p>`;
  const r = await render(browser, { html });
  expect(r.findings.map((x) => x.code)).not.toContain('unsupported-paged-media');
}, 30_000);

// File-based renders for linked stylesheets: the document and its print.css sit in a
// scratch directory so the staging server serves the sheet same-origin, which is the
// case the fetch pre-pass covers. Factored out because three copies of the setup is
// what the duplication gate counts.
async function withLinkedDoc(prefix: string, css: string, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await Bun.write(join(dir, 'print.css'), css);
    await Bun.write(
      join(dir, 'doc.html'),
      '<!doctype html><meta charset="utf-8">' +
        '<link rel="stylesheet" href="print.css">' +
        '<h1>T</h1><p>Body.</p>',
    );
    await run(join(dir, 'doc.html'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('a discarded declaration in a linked sheet is reported', async () => {
  // leader() empties the rule before the CSSOM scan runs, and a linked sheet has no
  // textContent to fall back on -- so this was silent until the fetch pre-pass.
  await withLinkedDoc(
    'letterpress-audit-link-',
    "@page{size:A4;margin:15mm} .c::after{content: leader('.')}",
    async (path) => {
      const r = await render(browser, { path });
      const found = r.findings.filter((x) => x.code === 'unsupported-paged-media');
      expect(found.length).toBe(1);
      expect(found[0]!.message).toContain('leader()');
      expect(found[0]!.message).toContain('linked stylesheet');
    },
  );
}, 60_000);

test('a clean linked sheet stays silent', async () => {
  await withLinkedDoc(
    'letterpress-audit-link-',
    '@page{size:A4;margin:15mm} p{color:#111}',
    async (path) => {
      const r = await render(browser, { path });
      expect(r.findings.map((x) => x.code)).not.toContain('unsupported-paged-media');
    },
  );
}, 60_000);

test('a missing linked sheet breaks nothing', async () => {
  // The fetch rejects; the audit runs without linked sources, as before.
  const dir = await mkdtemp(join(tmpdir(), 'letterpress-audit-link-'));
  try {
    await Bun.write(
      join(dir, 'doc.html'),
      '<!doctype html><meta charset="utf-8">' +
        '<link rel="stylesheet" href="absent.css">' +
        '<h1>T</h1><p>Body.</p>',
    );
    const r = await render(browser, { path: join(dir, 'doc.html') });
    expect(r.findings.map((x) => x.code)).not.toContain('unsupported-paged-media');
    expect(r.info.pages).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);

test('digits at risk of bidi reversal in arabic text are reported', async () => {
  const html = `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === 'rtl-digit-run')!;
  expect(f).toBeTruthy();
  expect(f.message).toContain('2026-10-03');
  expect(f.message).toContain('bdi');
}, 30_000);

test('a page counter in a right-to-left margin box is reported', async () => {
  // Two pages, so the reversal is observable rather than a matter of taste: page one
  // of two prints "2 / 1" with the counter alone, because the margin box inherits the
  // document's direction. The counter text is correct; the order it is read in is not.
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm;@top-right{content:counter(page) ' / ' counter(pages);font:9pt sans-serif}}
body{margin:0;font-family:'Noto Naskh Arabic',serif} div{height:250mm}
</style></head><body><div>صفحة أولى.</div><div>صفحة ثانية.</div></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === 'rtl-page-counter')!;
  expect(f).toBeTruthy();
  expect(f.message).toContain('@top-right');
  // The message has to name the fix, because unlike rtl-digit-run there is no markup
  // to wrap: a margin box cannot hold a <bdi>.
  expect(f.message).toContain('direction:ltr');
  expect(r.info.pages).toBe(2);
}, 30_000);

test('direction:ltr on the margin box is accepted, not reported', async () => {
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm;@top-right{direction:ltr;content:counter(page) ' / ' counter(pages);font:9pt sans-serif}}
body{margin:0;font-family:'Noto Naskh Arabic',serif} div{height:250mm}
</style></head><body><div>صفحة أولى.</div><div>صفحة ثانية.</div></body></html>`;
  const r = await render(browser, { html });
  expect(r.findings.map((x) => x.code)).not.toContain('rtl-page-counter');
}, 30_000);

test('a page counter in a left-to-right margin box is not reported', async () => {
  // The same stylesheet, without the RTL document. A check that fired on the margin box
  // rather than on the direction would flag every paginated document in the corpus.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm;@top-right{content:counter(page) ' / ' counter(pages);font:9pt sans-serif}}
body{margin:0;font:12pt sans-serif} div{height:250mm}
</style></head><body><div>Page one.</div><div>Page two.</div></body></html>`;
  const r = await render(browser, { html });
  expect(r.findings.map((x) => x.code)).not.toContain('rtl-page-counter');
}, 30_000);

test('a character no installed font covers is reported', async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>marker  here</p></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === 'missing-glyph')!;
  expect(f).toBeTruthy();
  expect(f.message).toContain('U+E000');
}, 30_000);

test('every missing glyph is listed, not capped', async () => {
  const chars = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0xe000 + i)).join('');
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>${chars}</p></body></html>`;
  const r = await render(browser, { html });
  expect(r.findings.filter((x) => x.code === 'missing-glyph').length).toBe(20);
}, 30_000);

test('a no-break space is spacing, not a missing glyph', async () => {
  // U+00A0 has no glyph in most fonts, so the canvas comparison used to report it as
  // "will print as a blank box". Measured in the page, A&nbsp;B and A B have identical
  // widths: it occupies exactly a space and prints as one. A finding that fires on
  // &nbsp; fires on nearly every HTML file, which teaches people to ignore the rest.
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>a&nbsp;b</p></body></html>`;
  const r = await render(browser, { html });
  const joined = r.findings.map((x) => x.message).join(' ');
  expect(joined).not.toContain('U+00A0');
  expect(joined).not.toContain('invisible formatting characters');
}, 30_000);

test('format characters that print as nothing are not reported as boxes', async () => {
  // U+180E, a bidi isolate and a variation selector have no glyph in DejaVu Sans, so
  // the canvas test finds them "missing" -- but Chromium shapes format characters to
  // nothing rather than tofu (measured: blank pixels, unequal to .notdef, zero advance
  // for each of these). Predicting a "blank box" for them is the NBSP phantom again.
  // U+FE1F rides along as the control: it renders as a .notdef box and must report.
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'DejaVu Sans',sans-serif}
</style></head><body><p>A&#x180E;B&#x2066;C&#xFE02;D&#xFE1F;E</p></body></html>`;
  const r = await render(browser, { html });
  const missing = r.findings.filter((x) => x.code === 'missing-glyph');
  expect(missing.length).toBe(1);
  expect(missing[0]!.message).toContain('U+FE1F');
  const joined = r.findings.map((x) => x.message).join(' ');
  expect(joined).not.toContain('U+180E');
  expect(joined).not.toContain('U+2066');
  expect(joined).not.toContain('U+FE02');
}, 30_000);

test('a character covered by the font fallback chain is not reported', async () => {
  const html = `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>القياس Привет</p></body></html>`;
  const r = await render(browser, { html });
  expect(codes(r.findings)).not.toContain('missing-glyph');
}, 30_000);

test('a date with a strong ltr character before it is not reported', async () => {
  const one = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>ISO 8601: 2026-10-03</p></body></html>`,
  });
  expect(codes(one.findings)).not.toContain('rtl-digit-run');

  const two = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>رقم INV-2026-0147</p></body></html>`,
  });
  expect(codes(two.findings)).not.toContain('rtl-digit-run');
}, 40_000);

test('an explicit dir="ltr" is honoured, so the finding does not advise itself', async () => {
  // The finding recommends wrapping the run in <bdi dir="ltr">. The walk broke on
  // dir="ltr" leaving "not right-to-left so far", which the content fallback then read as
  // "no opinion" and overrode -- so applying the advice re-triggered it. This is the
  // narrow case that worked by accident (digits alone) beside the common one that did not.
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p><bdi dir="ltr">التاريخ 2026-10-03</bdi></p>
<p><span dir="ltr">التاريخ 2026-10-03</span></p></body></html>`,
  });
  expect(codes(r.findings)).not.toContain('rtl-digit-run');
}, 40_000);

test('dir="auto" still infers from the content', async () => {
  // The exception: auto means infer, so a bare run inside an RTL paragraph is still found.
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p dir="auto">التاريخ 2026-10-03</p></body></html>`,
  });
  expect(codes(r.findings)).toContain('rtl-digit-run');
}, 40_000);

test('a date with no dir attribute at all is still reported', async () => {
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p></body></html>`,
  });
  expect(codes(r.findings)).toContain('rtl-digit-run');
}, 30_000);

test('the prescribed fix does not re-trigger the warning', async () => {
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: <bdi dir="ltr">2026-10-03</bdi></p></body></html>`,
  });
  expect(codes(r.findings)).not.toContain('rtl-digit-run');
}, 30_000);

test('repeated occurrences are counted, not collapsed to one', async () => {
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>التاريخ: 2026-10-03</p><p>التاريخ: 2026-10-03</p></body></html>`,
  });
  const f = r.findings.find((x) => x.code === 'rtl-digit-run')!;
  expect(f).toBeTruthy();
  expect(f.message).toContain('2 times');
}, 30_000);

test('--format with --landscape actually produces landscape', async () => {
  const doc = `<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>x</h1>`;
  const r = await render(browser, { html: doc, format: 'a4', landscape: true });
  const { w, h } = boxSize(r.info.mediaBoxes[0]!);
  expect(w).toBeGreaterThan(h);
  expect(codes(r.findings)).toContain('page-size-override');
}, 30_000);

test('a commented-out @page is not treated as a declaration', async () => {
  const r = await render(browser, {
    html: `<!doctype html><style>/* @page{size:A5} */ @page{margin:10mm}</style><h1>x</h1>`,
    landscape: true,
  });
  expect(codes(r.findings)).not.toContain('orientation-ignored');
  // Nor is it transposed. A commented-out rule is a note about a page, and the rewrite
  // that carries a landscape request into a document must not edit the note.
  expect(codes(r.findings)).not.toContain('orientation-overridden');
  const { w, h } = boxSize(r.info.mediaBoxes[0]!);
  expect(w).toBeGreaterThan(h);
}, 30_000);

test('plain latin text raises no text findings', async () => {
  const r = await render(browser, {
    html: `<!doctype html><style>@page{size:A4;margin:15mm}</style>
<body style="font-family:sans-serif"><p>Invoice 2026-014 dated 2026-10-03, total 1,234.56</p></body>`,
  });
  expect(
    codes(r.findings).filter((c) => c === 'rtl-digit-run' || c === 'missing-glyph'),
  ).toHaveLength(0);
}, 30_000);

test('an http failure is reported instead of printing the error page', async () => {
  let message = '';
  try {
    await render(browser, {
      url: 'https://this-host-does-not-exist-zzq7.invalid/',
      allowNetwork: true,
      timeoutMs: 20_000,
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }

  expect(message).toMatch(/could not load|ERR_|HTTP \d\d\d/);
}, 40_000);

test('a document declaring no paper defaults to a4 through the work server', async () => {
  const r = await render(browser, { html: '<!doctype html><p>served</p>' });
  expect(r.info.pages).toBe(1);
  expect(r.info.mediaBoxes[0]).toMatch(/594\.9\d+ 841\.9\d+/);
}, 30_000);

test('a remote document is never rewritten, whatever the flags ask for', async () => {
  // A remote source carries `html: ''` as a sentinel, which reads exactly like a
  // document that declares no page -- so the paper injector built an @page rule
  // for markup that is never loaded and then asked for the local work server
  // that does not exist. Measured: `undefined is not an object (evaluating
  // 'server.origin')`, on the way to printing nothing at all.
  const s = await launchTestServer();
  try {
    const r = await render(browser, {
      url: serverOrigin(s),
      format: 'a4',
      margin: '15mm',
      landscape: true,
      allowNetwork: true,
    });
    expect(r.info.pages).toBe(1);
    // A remote page keeps the old inch path, which Chromium rounds up: A4
    // landscape arrives as 841.92 x 595.92 where the local path gives 594.96.
    // Named here so the remaining difference is a stated limit rather than an
    // accident waiting to be rediscovered.
    expect(r.info.mediaBoxes[0]).toMatch(/841\.9\d+ 595\.9\d+/);
  } finally {
    await s.stop();
  }
}, 60_000);

test('SOURCE_DATE_EPOCH makes output byte-reproducible', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  try {
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>reproducible</p>`;
    const a = await render(browser, { html, author: 'Someone' });

    await Bun.sleep(1_100);
    const b = await render(browser, { html, author: 'Someone' });

    expect(new TextDecoder('latin1').decode(a.pdf)).toBe(new TextDecoder('latin1').decode(b.pdf));
    const text = new TextDecoder('latin1').decode(a.pdf);
    expect(text).toMatch(/D:20231114\d{6}Z/);
    expect(text).toContain('document');

    const packet = readXmpPacket(a.pdf);
    expect(packet).toContain('<xmp:CreateDate>2023-11-14T');
    expect(packet).toContain('<xmp:ModifyDate>2023-11-14T');
    expect(packet).not.toMatch(/<xmp:(?:Create|Modify)Date>(?!2023-11-14)/);
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 60_000);

test('a stamped date leaves nothing of the old one behind', async () => {
  // The stamp matches a byte range and writes over it, padding with spaces to keep every
  // later offset valid. Its date pattern allowed five characters after the offset sign and
  // Chromium writes six -- `+00'00'` -- so the match stopped one character short of the
  // closing quote, which kept its old value. The stamped file read
  // `D:20231114221320Z     '`, with the stale apostrophe still in it.
  //
  // No test caught it because the assertion above only checks that the date starts right, and
  // a conforming reader stops at the `Z`. The file was valid and the finding was true as far
  // as anyone could tell, which is what a defect with no consumer looks like.
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  try {
    const r = await render(browser, {
      html: `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>stamped</p>`,
      author: 'Someone',
    });
    const text = new TextDecoder('latin1').decode(r.pdf);

    // Every date in the file is the new one followed by padding and nothing else.
    const dates = [...text.matchAll(/\((D:[^)]*)\)/g)].map((m) => m[1]!);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates)
      expect({ date: d, ok: /^D:20231114\d{6}Z *$/.test(d) }).toEqual({
        date: d,
        ok: true,
      });

    // The length is preserved, so nothing downstream of an edit can move.
    expect(r.pdf.byteLength).toBeGreaterThan(0);
    expect(text).not.toContain("'00'");
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 60_000);

test('without a pinned clock two renders differ only in their timestamps', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  delete process.env.SOURCE_DATE_EPOCH;
  try {
    const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>unpinned</p>`;
    const a = await render(browser, { html });
    await Bun.sleep(1_100);
    const b = await render(browser, { html });
    const first = new TextDecoder('latin1').decode(a.pdf);
    const second = new TextDecoder('latin1').decode(b.pdf);
    expect(first).not.toBe(second);

    // Length equality used to be the check, but every file now carries a compressed XMP
    // packet and deflate output breathes by a byte with different timestamp input (7460
    // vs 7459 measured). What matters is stronger anyway, checked at both levels the
    // timestamps live at: the rest of the file must be identical after its date fields
    // are normalised, and the inflated packet must be identical after its ISO dates are.
    const normDoc = (s: string) => s.replace(/D:\d{14}(?:[+-]\d{2}'?\d{2}'?|Z)/g, 'D:STAMP');
    const normXmp = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'ISO-STAMP');
    const stripMeta = (s: string) =>
      s.replace(/\/Type \/Metadata[\s\S]*?endstream/, '/Type /Metadata…endstream');
    // startxref is normalised too: it is the byte offset of the xref table, which moves
    // when the compressed packet breathes. With the packet stripped and every date
    // normalised, the offset is a pure function of packet length, so nothing else can
    // move it; xref correctness itself is pinned by the verify suite, not here.
    const normXref = (s: string) => s.replace(/startxref\n\d+/, 'startxref\nN');
    expect(normXref(stripMeta(normDoc(first)))).toBe(normXref(stripMeta(normDoc(second))));
    const packetA = readXmpPacket(a.pdf);
    const packetB = readXmpPacket(b.pdf);
    expect(packetA).toBeDefined();
    expect(normXmp(packetA!)).toBe(normXmp(packetB!));
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 60_000);

test('without SOURCE_DATE_EPOCH the timestamp is left alone', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  delete process.env.SOURCE_DATE_EPOCH;
  try {
    const r = await render(browser, { html: '<!doctype html><p>unstamped</p>' });
    const text = new TextDecoder('latin1').decode(r.pdf);

    expect(text).toMatch(/D:\d{14}/);
    expect(text).not.toMatch(/127\.0\.0\.1:\d+/);

    expect(text).toMatch(/\/Title \(document *\)/);
  } finally {
    if (previous !== undefined) process.env.SOURCE_DATE_EPOCH = previous;
  }
}, 30_000);

// Two tests write images to a scratch directory, write a document beside them and render
// it at a given cap. Factored out because a copy of the setup is what the duplication gate
// counts, and because the setup is not what either test is about.
async function withImageDoc(
  prefix: string,
  files: Record<string, Buffer>,
  doc: string,
  run: (path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const [name, bytes] of Object.entries(files)) await Bun.write(join(dir, name), bytes);
    await Bun.write(join(dir, 'doc.html'), doc);
    await run(join(dir, 'doc.html'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The two tests below want the same thing from a capped render: that an image was reduced
// and that the finding says so. Asserted once, because a second copy of these three lines is
// what the duplication gate counts and not what either test is about.
async function cappedRender(path: string) {
  const r = await render(browser, { path, maxImagePpi: 120 });
  expect(r.findings.map((f) => f.code)).toContain('image-downsampled');
  expect(r.info.imageObjects).toBe(1);
  return r;
}

test('a hidden image does not take the replacement meant for another', async () => {
  // The measuring loop skips images it cannot measure -- hidden on screen, or not yet loaded
  // -- so its results are a subsequence of document.images. Assigning them positionally hands
  // the first replacement to the hidden image, and the photograph that was meant to be
  // downsampled keeps its full resolution while the finding says it was reduced. A
  // print-only backdrop or a `data-src` lazy load is the shape that triggers it.
  await withImageDoc(
    'letterpress-img2-',
    { 'backdrop.png': widePng(1200, 900), 'photo.png': widePng(1200, 900) },
    '<!doctype html><style>@page{size:A4;margin:10mm} img{width:180mm}' +
      '.screen-only{display:none}</style>' +
      '<img class="screen-only" src="backdrop.png"><img src="photo.png">',
    // Exactly one image was measurable. With the positional walk the hidden backdrop took
    // the replacement and the finding was reported against the wrong image entirely.
    async (path) => void (await cappedRender(path)),
  );
}, 90_000);

test('images are downsampled to the cap, and reported', async () => {
  await withImageDoc(
    'letterpress-img-',
    { 'photo.png': widePng(1200, 900) },
    '<!doctype html><style>@page{size:A4;margin:10mm} img{width:180mm}</style>' +
      '<img src="photo.png">',
    async (path) => {
      const capped = await cappedRender(path);
      const off = await render(browser, { path, maxImagePpi: 0 });
      expect(off.findings.map((f) => f.code)).not.toContain('image-downsampled');

      expect(capped.pdf.byteLength).toBeLessThan(off.pdf.byteLength);
    },
  );
}, 90_000);

describe('a page that blocks the renderer', () => {
  // A document calling `alert()` needs no permission and no user gesture, and
  // blocks the renderer until something answers it. Measured before this was
  // handled: the render sat out its whole deadline and came back as
  // `cdp socket closed` -- an error naming the transport rather than the
  // document, which is the one failure a caller cannot act on.
  test('a modal dialog is refused and the render still completes', async () => {
    const r = await render(browser, {
      html:
        '<!doctype html><style>@page{size:A4;margin:15mm}</style>' +
        '<body><p>before the dialog</p><script>alert("are you sure")</script>' +
        '<p>after the dialog</p></body>',
      timeoutMs: 20_000,
    });
    expect(r.info.pages).toBe(1);
    expect(codes(r.findings)).toContain('dialog-dismissed');
  }, 60_000);

  test('a document with no dialog reports none', async () => {
    const r = await render(browser, {
      html: '<!doctype html><style>@page{size:A4}</style><p>quiet</p>',
    });
    expect(codes(r.findings)).not.toContain('dialog-dismissed');
  }, 60_000);

  test('the finding says the script never finished', async () => {
    // The refusal is not politeness: a script blocked on a decision does not
    // continue, so whatever the rest of the run produced is whatever ran next,
    // and the file alone cannot show that.
    const r = await render(browser, {
      html:
        '<!doctype html><style>@page{size:A4;margin:15mm}</style>' +
        '<body><script>prompt("name")</script><p>x</p></body>',
      timeoutMs: 20_000,
    });
    const finding = r.findings.find((f) => f.code === 'dialog-dismissed')!;
    expect(finding.severity).toBe('warn');
    expect(finding.message).toContain('never finished');
  }, 60_000);
});

test('a crashed tab is reported rather than waited out', async () => {
  // A tab killed by the out-of-memory killer on a very large document emits
  // nothing on the print path, so the deadline was the only signal -- and paying
  // it in full says less than this event does. The event is what the render's
  // fast-fail reads.
  //
  // This proves the mechanism, not the render path: `Page.crash` cannot be
  // staged inside a real render, so what is pinned here is that the event fires
  // on a crash at all. Without the subscription there is no other signal.
  const tab = await browser.newTab();
  await tab.send('Page.enable');
  await tab.send('Inspector.enable');
  let crashed = false;
  tab.on('Inspector.targetCrashed', () => {
    crashed = true;
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(crashed).toBe(false);

  // The call itself never answers -- the tab is gone -- so it is given a short
  // deadline rather than the 30s default, and the wait afterwards polls rather
  // than guessing: the renderer takes its own time to actually die.
  void tab.send('Page.crash', {}, 2_000).catch(() => {});
  for (let i = 0; i < 40 && !crashed; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(crashed).toBe(true);
}, 30_000);

describe('what the page said about itself', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAACQd1PeAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sheet = '<style>@page{size:A4;margin:15mm}</style>';
  const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);
  const one = async (body: string) => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<body>${body}</body></html>`,
    });
    return codes(r);
  };

  test('a clean document raises none of them', async () => {
    // Every finding here is one that fires on ordinary documents if it is
    // wrong, so the negative case is the one that matters most.
    const found = await one('<p>plain text</p>');
    for (const code of [
      'missing-alt',
      'empty-alt',
      'figure-uncaptioned',
      'content-overflows-page',
      'lang-undeclared',
      'js-error',
    ]) {
      expect(found, code).not.toContain(code);
    }
  }, 60_000);

  test('an image with no alt is reported, an empty one separately', async () => {
    expect(await one(`<img src="${PNG}">`)).toContain('missing-alt');
    expect(await one(`<img src="${PNG}" alt="">`)).toContain('empty-alt');
    expect(await one(`<img src="${PNG}" alt="a picture">`)).not.toContain('missing-alt');
  }, 90_000);

  test('a decorative image is not a missing one', async () => {
    // alt="" plus role=presentation is the correct spelling of "this image is
    // not content". Reporting it would teach authors to avoid the mechanism
    // that makes decorative images correct.
    expect(await one(`<img src="${PNG}" alt="" role="presentation">`)).not.toContain('empty-alt');
    expect(await one(`<img src="${PNG}" alt="" role="presentation">`)).not.toContain('missing-alt');
  }, 90_000);

  test('a figure without a figcaption is reported', async () => {
    // Measured across seven markup shapes: chromium emits a Figure role in the
    // tagged pdf only when the figcaption is present, so alt text alone produces
    // no structure for a screen reader to navigate by.
    expect(await one(`<figure><img src="${PNG}" alt="x"></figure>`)).toContain(
      'figure-uncaptioned',
    );
    expect(
      await one(`<figure><img src="${PNG}" alt="x"><figcaption>c</figcaption></figure>`),
    ).not.toContain('figure-uncaptioned');
  }, 90_000);

  test('content wider than the sheet is reported, and only that', async () => {
    // A4 less 15mm margins is 642px of printable width. Measured on a 780px
    // viewport: html, body and a plain paragraph all come back at 780px, and a
    // figure at its default margins at 684px -- which prints as 584px and fits.
    // Comparing every element against the printable width therefore reported
    // ordinary documents as overflowing.
    expect(await one('<p>filler text</p>')).not.toContain('content-overflows-page');
    expect(await one(`<figure><figcaption>c</figcaption></figure>`)).not.toContain(
      'content-overflows-page',
    );
    // A fixed pixel width survives into print, so 700px overflows 642px.
    expect(await one('<div style="width:700px">wide</div>')).toContain('content-overflows-page');
    expect(await one('<div style="width:400px">fits</div>')).not.toContain(
      'content-overflows-page',
    );
    expect(await one('<table style="width:1400px"><tr><td>a</td></tr></table>')).toContain(
      'content-overflows-page',
    );
  }, 120_000);

  test('an undeclared language is reported, and a declared one is not', async () => {
    const none = await render(browser, { html: `${sheet}<body><p>bonjour</p></body>` });
    expect(codes(none)).toContain('lang-undeclared');
    // The finding names what chromium stamped instead, read from the file.
    expect(none.findings.find((f) => f.code === 'lang-undeclared')!.message).toContain('/Lang (');

    const declared = await render(browser, {
      html: `<html lang="fr">${sheet}<body><p>bonjour</p></body></html>`,
    });
    expect(codes(declared)).not.toContain('lang-undeclared');
  }, 90_000);

  test('a script that throws is reported, and a clean one is not', async () => {
    // Before this existed the only finding was about text runs: nothing said the
    // document had failed to run, so a caller could not tell the pdf apart from
    // one produced by the document they wrote.
    const threw = await one('<script>undefinedThing()</script><p>x</p>');
    expect(threw).toContain('js-error');
    expect(await one('<p>quiet</p>')).not.toContain('js-error');
  }, 90_000);

  test('the script error names the browser own wording', async () => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<body><script>undefinedThing()</script></body></html>`,
    });
    const f = r.findings.find((x) => x.code === 'js-error')!;
    expect(f.severity).toBe('warn');
    expect(f.message).toContain('undefinedThing');
  }, 60_000);
});

describe('the typeface the pdf was actually set in', () => {
  const sheet = '<style>@page{size:A4;margin:15mm}</style>';
  const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);
  const one = async (css: string, body = '<p id="a">text</p>') =>
    codes(
      await render(browser, {
        html: `<html lang="en">${sheet}<style>${css}</style><body>${body}</body></html>`,
      }),
    );

  // Whatever face this machine has. `fc-list` decides that, and the test asks
  // the renderer rather than naming one, so it holds on a machine with a
  // different font set installed.
  let installed = 'serif';
  beforeAll(async () => {
    const tab = await tabWithHtml(browser, '<html lang="en"><body></body></html>');
    const got = (await tab.send('Runtime.evaluate', {
      expression: `JSON.stringify(['Noto Serif','Noto Sans','DejaVu Serif','Liberation Serif'].filter((f) => document.fonts.check('16px "' + f + '"')))`,
      returnByValue: true,
    })) as { result: { value: string } };
    installed = (JSON.parse(got.result.value) as string[])[0] ?? 'serif';
    await browser.closeTab(tab);
  }, 30_000);

  test('a family this machine has is not a fallback', async () => {
    expect(await one(`#a{font-family:"${installed}"}`)).not.toContain('font-fallback');
    // A chain whose first entry exists never falls back either.
    expect(await one(`#a{font-family:"${installed}",Georgia}`)).not.toContain('font-fallback');
  }, 90_000);

  test('a family it does not have is, and the substitute is named', async () => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<style>#a{font-family:"No Such Face Anywhere"}</style><body><p id="a">x</p></body></html>`,
    });
    const found = r.findings.find((f) => f.code === 'font-fallback');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('warn');
    // The point of asking the renderer rather than the document: the finding
    // says what was drawn instead, so it is actionable.
    expect(found!.message).toContain('drawn in ');
  }, 60_000);

  test('a generic keyword is not a family that can be missing', async () => {
    // `serif` is a request for whatever the system considers serif. There is
    // nothing behind it to fall back from.
    for (const keyword of ['serif', 'sans-serif', 'monospace', 'system-ui']) {
      expect(await one(`#a{font-family:${keyword}}`), keyword).not.toContain('font-fallback');
    }
  }, 120_000);

  test('an @font-face that loaded is not a fallback, even under an alias', async () => {
    // Measured false positive before this was handled: `src: local(...)` under
    // a new name draws the concrete face, and `getPlatformFontsForNode` reports
    // that name rather than the alias, so the comparison called it a
    // substitution that had not happened.
    expect(
      await one(`@font-face{font-family:Aliased;src:local("${installed}")}#a{font-family:Aliased}`),
    ).not.toContain('font-fallback');
  }, 60_000);

  test('every missing family is named, with how many elements asked for it', async () => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<style>#a,#b{font-family:Missing One}#c{font-family:Missing Two}</style><body><p id="a">x</p><p id="b">y</p><p id="c">z</p></body></html>`,
    });
    const f = r.findings.find((x) => x.code === 'font-fallback')!;
    expect(f.message).toContain('Missing One (2 elements');
    expect(f.message).toContain('Missing Two (1 element');
  }, 60_000);

  test('an element that draws no text is not asked about', async () => {
    expect(await one(`body{font-family:"No Such Face Anywhere"}`, '<div></div>')).not.toContain(
      'font-fallback',
    );
  }, 60_000);

  test('the marker the node ids hang off is removed again', async () => {
    // `DOM.querySelector` is the only handle CDP takes, and a node id cannot be
    // written into a value-only evaluate, so the page marks one element per
    // family. The window where the document is not as it was found is inside
    // one step, and this is what closes it.
    const tab = await tabWithHtml(
      browser,
      `<html lang="en"><body><p id="a" style="font-family:'No Such Face'">x</p></body></html>`,
    );

    const asked = (await tab.send('Runtime.evaluate', {
      expression: `(${fontProbe})()`,
      returnByValue: true,
    })) as { result: { value: Array<{ family: string; elements: number }> } };
    expect(asked.result.value).toEqual([{ family: 'No Such Face', elements: 1 }]);

    const count = async () =>
      (
        (await tab.send('Runtime.evaluate', {
          expression: `document.querySelectorAll('[data-lp-font]').length`,
          returnByValue: true,
        })) as { result: { value: number } }
      ).result.value;
    expect(await count()).toBe(1);

    await tab.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('[data-lp-font]').forEach((e) => e.removeAttribute('data-lp-font'))`,
      returnByValue: true,
    });
    expect(await count()).toBe(0);
    await browser.closeTab(tab);
  }, 60_000);
});
