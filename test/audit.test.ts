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
  expect(r.info.mediaBoxes[0]).toMatch(/594\.9\d+ 841\.9\d+/);
}, 30_000);

test('--format a4 and @page size a4 are the same sheet, not nearly', async () => {
  const viaFlag = await render(browser, { html: '<!doctype html><p>x</p>', format: 'a4' });
  const viaCss = await render(browser, {
    html: '<!doctype html><style>@page{size:a4;margin:0}</style><p>x</p>',
  });
  const size = (box: string) =>
    box
      .match(/([\d.]+)\s+([\d.]+)\s*\]/)!
      .slice(1)
      .map(Number);
  expect(size(viaFlag.info.mediaBoxes[0]!)).toEqual(size(viaCss.info.mediaBoxes[0]!));

  expect(viaFlag.info.mediaBoxes[0]).toBe(viaCss.info.mediaBoxes[0]);
}, 30_000);

test('--landscape under a portrait @page transposes the document own declaration', async () => {
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:A4;margin:10mm}</style><p>x</p>',
    landscape: true,
  });
  expect(codes(r.findings)).not.toContain('orientation-ignored');
  expect(codes(r.findings)).toContain('orientation-overridden');
  expect(r.findings.find((f) => f.code === 'orientation-overridden')!.severity).toBe('info');

  const { w, h } = boxSize(r.info.mediaBoxes[0]!);
  expect(w).toBeGreaterThan(h);
  expect(w).toBeCloseTo(841.89, 1);
});

test('--landscape under a declaration with no paper to rotate is still an error', async () => {
  const r = await render(browser, {
    html: '<!doctype html><style>@page{size:auto}</style><p>x</p>',
    landscape: true,
  });
  expect(codes(r.findings)).toContain('orientation-ignored');
  expect(r.findings.find((f) => f.code === 'orientation-ignored')!.severity).toBe('error');
}, 30_000);

test('a declaration already in landscape is left alone', async () => {
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
  const html = `<!doctype html><style>
@page{size:A4;margin:15mm}
/* content: leader('.') */
.q::after{content: "a string( of text"} .w::before{content: 'running( late)'}
</style><h1>T</h1><p class="q">Body</p>`;
  const r = await render(browser, { html });
  expect(r.findings.map((x) => x.code)).not.toContain('unsupported-paged-media');
}, 30_000);

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
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm;@top-right{content:counter(page) ' / ' counter(pages);font:9pt sans-serif}}
body{margin:0;font-family:'Noto Naskh Arabic',serif} div{height:250mm}
</style></head><body><div>صفحة أولى.</div><div>صفحة ثانية.</div></body></html>`;
  const r = await render(browser, { html });
  const f = r.findings.find((x) => x.code === 'rtl-page-counter')!;
  expect(f).toBeTruthy();
  expect(f.message).toContain('@top-right');
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
  const html = `<!doctype html><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{font-family:'Noto Naskh Arabic',serif}
</style></head><body><p>a&nbsp;b</p></body></html>`;
  const r = await render(browser, { html });
  const joined = r.findings.map((x) => x.message).join(' ');
  expect(joined).not.toContain('U+00A0');
  expect(joined).not.toContain('invisible formatting characters');
}, 30_000);

test('format characters that print as nothing are not reported as boxes', async () => {
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
  const r = await render(browser, {
    html: `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>
@page{size:A4;margin:15mm} body{direction:rtl;font-family:'Noto Naskh Arabic',serif}
</style></head><body><p><bdi dir="ltr">التاريخ 2026-10-03</bdi></p>
<p><span dir="ltr">التاريخ 2026-10-03</span></p></body></html>`,
  });
  expect(codes(r.findings)).not.toContain('rtl-digit-run');
}, 40_000);

test('dir="auto" still infers from the content', async () => {
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
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  try {
    const r = await render(browser, {
      html: `<!doctype html><style>@page{size:A4;margin:10mm}</style><p>stamped</p>`,
      author: 'Someone',
    });
    const text = new TextDecoder('latin1').decode(r.pdf);

    const dates = [...text.matchAll(/\((D:[^)]*)\)/g)].map((m) => m[1]!);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates)
      expect({ date: d, ok: /^D:20231114\d{6}Z *$/.test(d) }).toEqual({
        date: d,
        ok: true,
      });

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

    const normDoc = (s: string) => s.replace(/D:\d{14}(?:[+-]\d{2}'?\d{2}'?|Z)/g, 'D:STAMP');
    const normXmp = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'ISO-STAMP');
    const stripMeta = (s: string) =>
      s.replace(/\/Type \/Metadata[\s\S]*?endstream/, '/Type /Metadata…endstream');
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

async function cappedRender(path: string) {
  const r = await render(browser, { path, maxImagePpi: 120 });
  expect(r.findings.map((f) => f.code)).toContain('image-downsampled');
  expect(r.info.imageObjects).toBe(1);
  return r;
}

test('a hidden image does not take the replacement meant for another', async () => {
  await withImageDoc(
    'letterpress-img2-',
    { 'backdrop.png': widePng(1200, 900), 'photo.png': widePng(1200, 900) },
    '<!doctype html><style>@page{size:A4;margin:10mm} img{width:180mm}' +
      '.screen-only{display:none}</style>' +
      '<img class="screen-only" src="backdrop.png"><img src="photo.png">',
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
  const tab = await browser.newTab();
  await tab.send('Page.enable');
  await tab.send('Inspector.enable');
  let crashed = false;
  tab.on('Inspector.targetCrashed', () => {
    crashed = true;
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(crashed).toBe(false);

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
    expect(await one(`<img src="${PNG}" alt="" role="presentation">`)).not.toContain('empty-alt');
    expect(await one(`<img src="${PNG}" alt="" role="presentation">`)).not.toContain('missing-alt');
  }, 90_000);

  test('a figure without a figcaption is reported', async () => {
    expect(await one(`<figure><img src="${PNG}" alt="x"></figure>`)).toContain(
      'figure-uncaptioned',
    );
    expect(
      await one(`<figure><img src="${PNG}" alt="x"><figcaption>c</figcaption></figure>`),
    ).not.toContain('figure-uncaptioned');
  }, 90_000);

  test('content wider than the sheet is reported, and only that', async () => {
    expect(await one('<p>filler text</p>')).not.toContain('content-overflows-page');
    expect(await one(`<figure><figcaption>c</figcaption></figure>`)).not.toContain(
      'content-overflows-page',
    );
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
    expect(none.findings.find((f) => f.code === 'lang-undeclared')!.message).toContain('/Lang (');

    const declared = await render(browser, {
      html: `<html lang="fr">${sheet}<body><p>bonjour</p></body></html>`,
    });
    expect(codes(declared)).not.toContain('lang-undeclared');
  }, 90_000);

  test('a script that throws is reported, and a clean one is not', async () => {
    const threw = await one('<script>undefinedThing()</script><p>x</p>');
    expect(threw).toContain('js-error');
    expect(await one('<p>quiet</p>')).not.toContain('js-error');
  }, 90_000);

  test('a missing asset is not a script error', async () => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<body><img src="gone.png" alt="x"><p>t</p></body></html>`,
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).not.toContain('js-error');
    expect(codes).toContain('subresource-failed');
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
    expect(await one(`#a{font-family:"${installed}",Georgia}`)).not.toContain('font-fallback');
  }, 90_000);

  test('a family it does not have is, and the substitute is named', async () => {
    const r = await render(browser, {
      html: `<html lang="en">${sheet}<style>#a{font-family:"No Such Face Anywhere"}</style><body><p id="a">x</p></body></html>`,
    });
    const found = r.findings.find((f) => f.code === 'font-fallback');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('warn');
    expect(found!.message).toContain('drawn in ');
  }, 60_000);

  test('a generic keyword is not a family that can be missing', async () => {
    for (const keyword of ['serif', 'sans-serif', 'monospace', 'system-ui']) {
      expect(await one(`#a{font-family:${keyword}}`), keyword).not.toContain('font-fallback');
    }
  }, 120_000);

  test('an @font-face that loaded is not a fallback, even under an alias', async () => {
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
