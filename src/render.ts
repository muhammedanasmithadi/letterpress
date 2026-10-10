import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpath, rm } from 'node:fs/promises';
import { Browser, type Tab } from './browser.ts';
import { fixFontDescriptors, unresolvedFontMetrics } from './fontdesc.ts';
import { addMetadata, isVolatileTitle, readDocInfo, setDocTitle } from './meta.ts';
import { fixToUnicode } from './tounicode.ts';
import { LINK_DESC_JS, fixLinkDescs, parseLinkDescs } from './linkdesc.ts';
import { fixRedundantFigures, redundantFigureCount } from './figrole.ts';
import { textFlow } from './selection.ts';
import { mergeTextRuns } from './tjmerge.ts';
import { repairOrKeep } from './verify.ts';
import { audit } from './lint.ts';
import { declaredPageMargin, declaredPageSize, inspect, type PdfInfo } from './pdf.ts';

export const FORMATS = {
  a3: [11.6929, 16.5354],
  a4: [8.2677, 11.6929],
  a5: [5.8268, 8.2677],
  legal: [8.5, 14],
  letter: [8.5, 11],
  tabloid: [11, 17],
} as const;

export type Format = keyof typeof FORMATS;

export function parseFormat(value: unknown): Format | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`format must be a string, got ${typeof value}`);
  const name = value.trim().toLowerCase();

  if (!Object.hasOwn(FORMATS, name)) {
    throw new Error(`unknown format "${value}". try: ${Object.keys(FORMATS).join(', ')}`);
  }
  return name as Format;
}

export type Finding = {
  code: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  url?: string;
};

export type RenderRequest = {
  html?: string;
  path?: string;
  url?: string;
  format?: Format;
  landscape?: boolean;

  margin?: string;

  allowNetwork?: boolean;

  root?: string;
  printBackground?: boolean;
  settleMs?: number;
  timeoutMs?: number;

  maxImagePpi?: number;

  author?: string;

  subject?: string;

  keywords?: string;

  beforePrint?: string;

  pageRanges?: string;

  transfer?: 'base64' | 'stream';

  preferFastPath?: boolean;
};

export type RenderResult = {
  pdf: Uint8Array;
  info: PdfInfo;
  findings: Finding[];
  blocked: string[];
  ms: number;
  source: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BLOCKED_REPORTED = 20;

const ABSOLUTE_UNITS: Record<string, number> = {
  px: 96,
  in: 1,
  cm: 2.54,
  mm: 25.4,
  q: 101.6,
  pt: 72,
  pc: 6,
};

const RELATIVE_UNITS = [
  'em',
  'rem',
  'ex',
  'ch',
  'vw',
  'vh',
  'vmin',
  'vmax',
  '%',
  'lh',
  'rlh',
  'cap',
  'ic',
];

export function toInches(len: string): number {
  const raw = len.trim();
  const m = raw.match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m)
    throw new Error(
      `margin "${len}" is not a css length: use a number with a unit, such as 15mm, 1in, 2cm, 40pt, or a bare 0.`,
    );
  const unit = (m[2] || 'px').toLowerCase();
  if (RELATIVE_UNITS.includes(unit)) {
    throw new Error(
      `margin unit "${unit}" is relative, so its size is only known after layout: ` +
        `"${unit}" resolves against a font size or a viewport, and printToPDF takes inches. ` +
        `use an absolute unit: mm, cm, in, pt, pc, px, or a bare 0.`,
    );
  }
  if (!Object.hasOwn(ABSOLUTE_UNITS, unit)) {
    throw new Error(`unsupported margin unit "${unit}". use mm, cm, in, pt, pc, px, or a bare 0.`);
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`margin "${len}" is not a number.`);
  }

  if (!m[2] && value !== 0) {
    throw new Error(
      `margin "${len}" needs a unit: a bare number is not a css length, only a bare 0 is. ` +
        `use px, pt, mm, cm or in.`,
    );
  }
  return value / ABSOLUTE_UNITS[unit];
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.05;

function precedenceFindings(html: string, req: RenderRequest): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredPageSize(html);
  const declaredMargin = declaredPageMargin(html);

  if (declared && req.format) {
    const [w, h] = FORMATS[req.format];
    const named = declared.match(/\b(a3|a4|a5|letter|legal|tabloid)\b/)?.[1]?.toLowerCase();
    const dims = declared.match(/([\d.]+)\s*(mm|cm|in|px|pt)/gi)?.map(toInches) ?? [];
    const target = req.landscape ? [h, w] : [w, h];
    const agrees = named
      ? named === req.format && !req.landscape
      : dims.length >= 2 &&
        ((close(dims[0], target[0]) && close(dims[1], target[1])) ||
          (close(dims[0], target[1]) && close(dims[1], target[0])));
    if (!agrees) {
      findings.push({
        code: 'page-size-override',
        severity: 'info',
        message: `request asked for ${req.format}${req.landscape ? ' landscape' : ''}, but the document declares @page size: ${declared}. The request wins: the declaration is stripped from the document and the paper is set from the flag.`,
      });
    }
  }

  if (declared && req.landscape) {
    const landscapeDeclared =
      /\blandscape\b/.test(declared) ||
      (() => {
        const d = declared.match(/([\d.]+)\s*(mm|cm|in)/gi)?.map(toInches) ?? [];
        return d.length >= 2 && d[0] > d[1];
      })();
    if (!landscapeDeclared) {
      findings.push(
        req.format
          ? {
              code: 'orientation-overridden',
              severity: 'info',
              message: `the document declares @page size: ${declared}, which is portrait. --format with --landscape takes precedence, so the paper has been transposed rather than the document's own page size used.`,
            }
          : {
              code: 'orientation-ignored',
              severity: 'error',
              message: `--landscape had no effect: the document declares @page size: ${declared}, and a document's own @page wins, so the PDF is portrait. For landscape, either add --format a4 (which takes precedence and transposes the paper), or write "@page { size: a4 landscape }" in the stylesheet.`,
            },
      );
    }
  }

  if (declaredMargin && req.margin) {
    findings.push({
      code: 'margin-ignored',
      severity: 'warn',
      message: `--margin ${req.margin} was ignored: the document declares @page margin: ${declaredMargin}, and a document's own @page wins. Change the margin in the stylesheet, or drop the @page margin rule.`,
    });
  }

  return findings;
}

async function capImageResolution(
  tab: Tab,
  maxPpi: number,
  timeoutMs: number,
): Promise<{ from: number; to: number; ppi: number }[]> {
  const expression = `(() => {
    const MAX = ${maxPpi};
    const report = [];
    for (const img of document.images) {
      if (!img.naturalWidth) continue;
      const wIn = img.getBoundingClientRect().width / 96;
      if (!wIn) continue;
      const ppi = img.naturalWidth / wIn;
      if (ppi <= MAX) continue;
      const targetW = Math.max(1, Math.round(wIn * MAX));
      const scale = targetW / img.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      report.push({ from: img.naturalWidth, to: canvas.width, ppi: Math.round(ppi), url: canvas.toDataURL("image/jpeg", 0.9) });
    }
    return JSON.stringify(report);
  })()`;

  const res = await tab.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  const raw = res?.result?.value;
  if (raw == null) return [];
  let entries: Array<{ from: number; to: number; ppi: number; url: string }>;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!entries.length) return [];

  if (entries.length && raw === undefined) {
    const singles: typeof entries = [];
    for (const img of await tab
      .send('Runtime.evaluate', {
        expression: "Array.from(document.images).map(i => i.currentSrc || i.src).join('\\u0000')",
        returnByValue: true,
      })
      .then((r: any) => String(r?.result?.value ?? '').split('\u0000'))) {
      const one = await tab
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
          const MAX = ${maxPpi};
          const img = document.images.find(i => (i.currentSrc || i.src) === ${JSON.stringify(img)});
          if (!img || !img.naturalWidth) return "null";
          const wIn = img.getBoundingClientRect().width / 96;
          const ppi = img.naturalWidth / wIn;
          if (!wIn || ppi <= MAX) return "null";
          const targetW = Math.max(1, Math.round(wIn * MAX));
          const c = document.createElement("canvas");
          c.width = targetW;
          c.height = Math.max(1, Math.round(img.naturalHeight * (targetW / img.naturalWidth)));
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, c.width, c.height);
          return JSON.stringify({ from: img.naturalWidth, to: c.width, ppi: Math.round(ppi), url: c.toDataURL("image/jpeg", 0.9) });
        })()`,
            returnByValue: true,
          },
          timeoutMs,
        )
        .catch(() => null);
      const v = one?.result?.value;
      if (v && v !== 'null') {
        try {
          singles.push(JSON.parse(v));
        } catch {}
      }
    }
    entries = singles;
  }

  if (!entries.length) return [];

  await tab.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
      const swap = ${JSON.stringify(entries.map((e) => e.url))};
      let i = 0;
      for (const img of document.images) { if (swap[i]) img.src = swap[i++]; }
      return true;
    })()`,
      returnByValue: true,
    },
    timeoutMs,
  );
  await tab.send(
    'Runtime.evaluate',
    {
      expression:
        'Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)',
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  );

  return entries.map(({ from, to, ppi }) => ({ from, to, ppi }));
}

function isTeardownAbort(errorText: string | undefined): boolean {
  return /ERR_ABORTED/.test(errorText ?? '');
}

const SERVED_DOCUMENT = 'input.html';
const OVERRIDE_DOCUMENT = 'override.html';

export function confinedTo(dir: string, name: string): boolean {
  return join(dir, name).startsWith(dir + '/');
}

export type RefusalReason = 'outside-root' | 'document';

export type RefusedRef = { ref: string; abs: string; why: RefusalReason };

function absRoot(root: string): string {
  return resolve(root.startsWith('/') ? root : `${process.cwd()}/${root}`);
}

function clampedUrlPath(rel: string): string {
  const out: string[] = [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export async function stageAssets(
  html: string,
  source: string,
  dir: string,
  rootArg?: string,
): Promise<RefusedRef[]> {
  if (!html || /^https?:/i.test(source)) return [];

  const base = source.startsWith('/') ? dirname(source) : process.cwd();
  const root = rootArg ? absRoot(rootArg) : base;

  const rootReal = await realpath(root).catch(() => root);
  const insideRoot = (p: string) => p === rootReal || p.startsWith(rootReal + '/');

  const lexicallyInside = (p: string) => p === root || p.startsWith(root + '/');
  const written = new Set<string>();

  const queue: Array<{ ref: string; from: string; outside: boolean }> = [];

  const refused: Array<{ ref: string; abs: string; why: RefusalReason }> = [];

  const seen = new Set<string>();

  const consider = (ref: string, from: string) => {
    const clean = ref.trim().split(/[?#]/)[0];
    if (!clean) return;
    if (/^(?:https?:|data:|blob:|file:|#|mailto:|\/\/)/i.test(clean)) return;
    const abs = isAbsolute(clean) ? clean : resolve(from, clean);

    if (seen.has(abs)) return;
    seen.add(abs);

    const urlPath = clampedUrlPath(relative(base, abs));
    if (!urlPath) return;
    const target = join(dir, urlPath);
    if (!target.startsWith(dir + '/') || written.has(target)) return;

    if (urlPath === SERVED_DOCUMENT || urlPath === OVERRIDE_DOCUMENT) {
      if (refused.length < 8) refused.push({ ref: clean, abs, why: 'document' });
      return;
    }
    written.add(target);

    queue.push({ ref: clean, from: abs, outside: !lexicallyInside(abs) });
  };

  const scan = (text: string, from: string) => {
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) consider(m[1]!, from);
    for (const m of text.matchAll(/(?:src|href)\s*=\s*([^\s>]+)/gi))
      consider(m[1]!.replace(/["']/g, ''), from);
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const candidate of m[1]!.split(',')) consider(candidate.trim().split(/\s+/)[0]!, from);
    }
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) consider(m[1]!, from);
    for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) consider(m[1]!, from);

    for (const m of text.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g))
      consider(m[1]!, from);
    for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) consider(m[1]!, from);
    for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) consider(m[1]!, from);
  };

  scan(html, base);

  while (queue.length) {
    const { ref, from, outside } = queue.shift()!;

    const real = await realpath(from).catch(() => null);

    if (real && !insideRoot(real)) {
      if (refused.length < 8 && !refused.some((r) => r.abs === real))
        refused.push({ ref, abs: real, why: 'outside-root' });
      continue;
    }
    if (!real) {
      if (outside && refused.length < 8 && !refused.some((r) => r.abs === from)) {
        refused.push({ ref, abs: from, why: 'outside-root' });
      }
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await Bun.file(real).arrayBuffer());
    } catch {
      continue;
    }
    if (!bytes.length) continue;
    const target = join(dir, clampedUrlPath(relative(base, from)));
    try {
      await Bun.write(target, bytes);
    } catch {
      continue;
    }

    if (/\.(?:css|mjs|js)$/i.test(from)) {
      try {
        scan(new TextDecoder('latin1').decode(bytes), dirname(real));
      } catch {}
    }
  }

  return refused;
}

export function hasRelativeAssets(html: string): boolean {
  if (/(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|file:|#|mailto:|\/\/)[^"']/i.test(html))
    return true;
  if (/(?:src|href)\s*=\s*(?!["'])(?!https?:|data:|blob:|file:|#|mailto:|\/\/)[^\s>]+/i.test(html))
    return true;
  if (/\bsrcset\s*=/i.test(html)) return true;
  return /url\(\s*(?!["']?(?:https?:|data:|blob:|file:|#|\/\/))\s*["']?[^)'"\s]/i.test(html);
}

export async function drainStream(
  tab: Tab,
  handle: string,
  { chunkSize = 262_144, timeoutMs }: { chunkSize?: number; timeoutMs: number },
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (let guard = 0; guard < 100_000; guard++) {
    const chunk = await tab.send('IO.read', { handle, size: chunkSize }, timeoutMs);
    if (!chunk.data) break;
    parts.push(Buffer.from(chunk.data, 'base64'));
    if (chunk.eof) break;
  }
  await tab.send('IO.close', { handle }).catch(() => {});
  return new Uint8Array(Buffer.concat(parts));
}

let workDirCounter = 0;

function looksBinary(html: string): string | undefined {
  const head = html.slice(0, 1024);

  if (head.includes('\u0000')) return 'it contains a null byte';

  const signatures: [RegExp, string][] = [
    [/^\s*%PDF-/, 'it is a PDF'],
    [/^\s*[\u0080-\u00ff]{0,4}\xff[\u00d8\u00e0]/, 'it is a JPEG'],
    [/^\s*\x89PNG\r?\n/, 'it is a PNG'],
    [/^\s*GIF8[79]a/, 'it is a GIF'],
    [/^\s*\x1f\x8b/, 'it is gzip'],
    [/^\s*PK\x03\x04/, 'it is a zip'],
    [/^\s*RIFF.{4}WEBP/, 'it is a WebP'],
    [/^\s*BM/, 'it is a BMP'],
    [/^\s*\x00\x00\x01\x00/, 'it is an icon'],
  ];
  for (const [re, what] of signatures) if (re.test(head)) return what;
  return undefined;
}

async function resolveSource(
  req: RenderRequest,
  dir: string,
): Promise<{ html: string; url: string; source: string }> {
  req.format = parseFormat(req.format);
  if (req.html != null) {
    await Bun.write(join(dir, SERVED_DOCUMENT), req.html);
    return { html: req.html, url: `${dir}/input.html`, source: 'html' };
  }
  if (req.path) {
    const abs = req.path.startsWith('/') ? req.path : `${process.cwd()}/${req.path}`;

    const html = await Bun.file(abs).text();
    await Bun.write(join(dir, SERVED_DOCUMENT), html);
    return { html, url: abs, source: abs };
  }
  if (req.url) return { html: '', url: req.url, source: req.url };
  throw new Error('render needs one of: html, path, url');
}

async function serveWorkDir(dir: string): Promise<{ origin: string; stop: () => void }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 10,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const name = path === '/' ? SERVED_DOCUMENT : decodeURIComponent(path.slice(1));

      const resolved = join(dir, name);
      if (!confinedTo(dir, name)) return new Response('forbidden', { status: 403 });
      const file = Bun.file(resolved);
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
}

function stampPdf(pdf: Uint8Array, fallbackTitle: string): Uint8Array {
  const text = new TextDecoder('latin1').decode(pdf);
  const out = new Uint8Array(pdf);
  const edits: Array<[number, number, string]> = [];

  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) {
    const date = new Date(Number(epoch) * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const pdfDate =
      `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    for (const m of text.matchAll(/D:\d{14}[+\-Z][\d'Z]{0,5}/g)) {
      if (m.index !== undefined) edits.push([m.index, m[0].length, pdfDate]);
    }

    const iso =
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
      `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    for (const m of text.matchAll(/<(xmp:(?:CreateDate|ModifyDate))>[^<]{0,40}<\/\1>/g)) {
      if (m.index === undefined) continue;
      const open = m[0].indexOf('>') + 1;

      const closeAt = m[0].lastIndexOf('</');
      edits.push([m.index + open, closeAt - open, iso]);
    }
  }

  void fallbackTitle;

  for (const [at, length, value] of edits.sort((a, b) => b[0] - a[0])) {
    const fit = value.slice(0, length);
    for (let i = 0; i < fit.length; i++) out[at + i] = fit.charCodeAt(i);

    for (let i = fit.length; i < length; i++) out[at + i] = 0x20;
  }
  return out;
}

export async function render(browser: Browser, req: RenderRequest): Promise<RenderResult> {
  const started = Bun.nanoseconds();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = process.env.TMPDIR ?? '/tmp';
  const dir = `${tmp}/letterpress-${process.pid}-${workDirCounter++}`;
  const findings: Finding[] = [];
  const blocked: string[] = [];

  const failedSubresources: { kind: string; url: string }[] = [];
  let tab: Tab | undefined;
  let server: { origin: string; stop: () => void } | undefined;

  const isRemote = /^https?:/i.test(req.url ?? '');

  try {
    const src = await resolveSource(req, dir);

    if (src.html != null) {
      const binary = looksBinary(src.html);
      if (binary) {
        throw new Error(
          `this input is not HTML: ${binary}. letterpress prints html, so a document with the wrong ` +
            `file extension produces a page of binary noise rather than an error. check the path.`,
        );
      }

      if (!req.url && !src.html.trim()) {
        throw new Error(
          'the input is empty. a 0-byte file renders as one blank page and reports success; ' +
            'check that the file has content, or that the command producing it wrote to stdout.',
        );
      }
      findings.push(...precedenceFindings(src.html, req));
    }

    let outsideRoot: RefusedRef[] = [];
    const relative = hasRelativeAssets(src.html ?? '');
    const fastPath =
      !isRemote &&
      src.html != null &&
      req.preferFastPath !== false &&
      !relative &&
      !req.maxImagePpi;

    if (!isRemote && !fastPath) {
      outsideRoot = await stageAssets(src.html, src.source, dir, req.root);
      server = await serveWorkDir(dir);
    }

    const override =
      req.format && src.html && declaredPageSize(src.html)
        ? src.html.replace(
            /(@page[^{]*\{)([^}]*)(\})/gi,
            (_whole, open: string, body: string, close: string) =>
              open + body.replace(/(^|;)\s*\bsize\s*:[^;}]*/gi, '$1').replace(/;;+/g, ';') + close,
          )
        : null;

    let srcUrl: string;
    if (fastPath) srcUrl = 'about:blank';
    else srcUrl = isRemote ? src.url : `${server!.origin}/input.html`;
    if (override && !fastPath) {
      await Bun.write(join(dir, OVERRIDE_DOCUMENT), override);
      srcUrl = `${server!.origin}/override.html`;
    }

    tab = await browser.newTab();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;

      void browser.closeTab(tab!).catch(() => {});
    }, timeoutMs);

    try {
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
      await tab.send('Network.enable');

      const loopback = server
        ? new RegExp(`^${server.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i')
        : /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;
      await tab.send('Fetch.enable', {
        patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
      });
      tab.on('Fetch.requestPaused', (p) => {
        const url = String(p.request?.url ?? '');
        if (loopback.test(url)) {
          void tab!.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
          return;
        }
        const proceed = req.allowNetwork
          ? tab!.send('Fetch.continueRequest', { requestId: p.requestId })
          : (blocked.length < MAX_BLOCKED_REPORTED && blocked.push(url),
            tab!.send('Fetch.failRequest', {
              requestId: p.requestId,
              errorReason: 'BlockedByClient',
            }));
        void proceed.catch(() => {});
      });

      let mainStatus: number | undefined;
      let netError: string | undefined;
      if (isRemote) {
        tab.on('Network.responseReceived', (p) => {
          if (p.type === 'Document' && !mainStatus) mainStatus = p.response?.status;
        });
      }

      tab.on('Network.responseReceived', (p) => {
        const status = p.response?.status ?? 0;

        const isFavicon = /\/favicon\.ico(\?|$)/.test(p.response?.url ?? '');
        if (status >= 400 && p.type && p.type !== 'Document' && !isFavicon) {
          failedSubresources.push({ kind: p.type, url: `${status} ${p.response?.url ?? ''}` });
        }
      });

      const requestUrls = new Map<string, string>();
      tab.on('Network.requestWillBeSent', (p) => {
        if (p.requestId && p.request?.url) requestUrls.set(p.requestId, p.request.url);
      });
      tab.on('Network.loadingFailed', (p) => {
        const url = p.requestId ? requestUrls.get(p.requestId) : undefined;
        const isMainDocument = p.type === 'Document' && url !== undefined && url === srcUrl;
        if (isMainDocument && !netError && !p.blockedReason) netError = p.errorText;
        else if (p.type === 'Document' && !p.blockedReason) {
          failedSubresources.push({ kind: 'Subframe', url: url ?? p.errorText ?? '' });
        } else if (!p.blockedReason && !isTeardownAbort(p.errorText)) {
          failedSubresources.push({ kind: p.type ?? 'unknown', url: p.errorText ?? '' });
        }
      });

      const loaded = tab.once('Page.loadEventFired');
      if (fastPath) {
        const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
        await tab.send('Page.setDocumentContent', { frameId, html: override ?? src.html! });
      } else {
        await tab.send('Page.navigate', { url: srcUrl }).catch((e: Error) => {
          if (/ERR_/.test(e.message)) netError ??= e.message;
        });
        await Promise.race([
          loaded.promise,
          Bun.sleep(timeoutMs).then(() => {
            throw new Error(`__deadline__`);
          }),
        ]).catch((e: Error) => {
          throw new Error(
            e.message === '__deadline__' && timedOut
              ? `navigation did not finish within ${timeoutMs}ms`
              : e.message,
          );
        });
        loaded.cancel();
      }

      if (netError) {
        throw new Error(`could not load ${src.source}: ${netError}`);
      }
      if (mainStatus !== undefined && (mainStatus < 200 || mainStatus >= 300)) {
        throw new Error(
          `${src.source} returned HTTP ${mainStatus}; refusing to print the error page`,
        );
      }

      await tab.send(
        'Runtime.evaluate',
        {
          expression: 'document.fonts.ready.then(() => true)',
          awaitPromise: true,
          returnByValue: true,
        },
        timeoutMs,
      );
      if (req.settleMs) await Bun.sleep(req.settleMs);
      if (req.beforePrint) {
        await tab.send(
          'Runtime.evaluate',
          {
            expression: req.beforePrint,
            awaitPromise: true,
            returnByValue: true,
          },
          timeoutMs,
        );
      }

      const stated = await tab.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
          const pick = (names) => {
            for (const name of names) {
              const el = document.querySelector('meta[name="' + name + '"]') ||
                document.querySelector('meta[property="' + name + '"]');
              const value = el && (el.getAttribute("content") || "").trim();
              if (value) return value;
            }
            return "";
          };
          return JSON.stringify({
            author: pick(["author", "DC.creator", "dc.creator", "article:author", "biblio_author"]),
            subject: pick(["subject", "DC.subject", "dc.subject", "description", "DC.description"]),
            keywords: pick(["keywords", "DC.subject", "citation_keywords"]),
          });
        })()`,
          returnByValue: true,
        },
        timeoutMs,
      );
      let docMeta: { author?: string; subject?: string; keywords?: string } = {};
      try {
        docMeta = JSON.parse((stated as { result?: { value?: string } }).result?.value ?? '{}');
      } catch {}

      const author = req.author?.trim() || docMeta.author || '';

      const capped = req.maxImagePpi
        ? await capImageResolution(tab, req.maxImagePpi, timeoutMs)
        : [];
      for (const c of capped) {
        findings.push({
          code: 'image-downsampled',
          severity: 'info',
          message: `image downsampled from ${c.from}px to ${c.to}px wide, ${c.ppi}ppi down to ${req.maxImagePpi}ppi, to keep the PDF a reasonable size.`,
        });
      }

      findings.push(...(await audit(tab, timeoutMs)));

      const linkDescRaw = await tab
        .send(
          'Runtime.evaluate',
          {
            expression: LINK_DESC_JS,
            returnByValue: true,
            awaitPromise: false,
          },
          timeoutMs,
        )
        .then((r: { result?: { value?: unknown } }) => r.result?.value)
        .catch(() => undefined);
      const linkDescs = parseLinkDescs(linkDescRaw);

      let declaresPaper = src.html ? declaredPageSize(src.html) !== null : false;
      if (!req.format && !declaresPaper && req.url) {
        const probe = await tab
          .send('Runtime.evaluate', {
            expression: `(() => {
            for (const sheet of document.styleSheets) {
              let rules; try { rules = sheet.cssRules } catch { continue }
              for (const r of rules || []) if (/@page/i.test(r.cssText || "") && /\\bsize\\s*:/i.test(r.cssText || "")) return true;
            }
            return false;
          })()`,
            returnByValue: true,
          })
          .catch(() => null);
        declaresPaper = probe?.result?.value === true;
      }

      const docOverridesPaper = declaresPaper;
      const preferCss = docOverridesPaper && !req.format;
      const paper = req.format ? FORMATS[req.format] : preferCss ? undefined : FORMATS.a4;
      const margin = req.margin ? toInches(req.margin) : undefined;
      if (margin !== undefined && margin < 0) {
        throw new Error(
          `margin ${req.margin} is negative, and printToPDF refuses a negative page margin on all ` +
            `four sides. a negative margin bleeds content off the sheet, which is what @page margin does ` +
            `in a stylesheet if you need it.`,
        );
      }
      const transposed = !!req.landscape && !!paper && !preferCss;
      const paperWidth = transposed ? paper![1] : paper?.[0];
      const paperHeight = transposed ? paper![0] : paper?.[1];

      let res: any;
      const useStream = req.transfer === 'stream';
      try {
        res = await tab.send(
          'Page.printToPDF',
          {
            printBackground: req.printBackground ?? true,
            preferCSSPageSize: preferCss,
            ...(paperWidth !== undefined ? { paperWidth, paperHeight } : {}),
            ...(paper && !preferCss
              ? {
                  scale: 1,
                  marginTop: margin ?? 0,
                  marginBottom: margin ?? 0,
                  marginLeft: margin ?? 0,
                  marginRight: margin ?? 0,
                }
              : {}),

            landscape: req.landscape && preferCss,

            displayHeaderFooter: false,
            generateDocumentOutline: true,
            generateTaggedPDF: true,
            ...(req.pageRanges ? { pageRanges: req.pageRanges } : {}),
            transferMode: useStream ? 'ReturnAsStream' : 'ReturnAsBase64',
          },
          timeoutMs,
        );
      } catch (e) {
        if (timedOut) {
          throw new Error(
            `printing exceeded the ${timeoutMs}ms deadline. A very large document needs a higher --timeout; if it dies at a few thousand pages the browser ran out of memory.`,
          );
        }
        throw e;
      }

      const raw =
        useStream && res.stream
          ? await drainStream(tab, res.stream, { timeoutMs })
          : new Uint8Array(Buffer.from(res.data, 'base64'));

      const pdfTitle = req.path
        ? basename(req.path)
        : req.url
          ? new URL(req.url).hostname
          : 'document';

      const rejected = new Set<string>();
      const gated = (
        input: Uint8Array,
        label: string,
        repair: (pdf: Uint8Array) => Uint8Array,
      ): Uint8Array => {
        const attempt = repairOrKeep(input, repair);
        if (attempt.failures.length) {
          rejected.add(label);
          findings.push({
            code: 'repair-rejected',
            severity: 'warn',
            message:
              `the ${label} fix was discarded because it did not leave a valid pdf: ` +
              `${attempt.failures.join('; ')}. the file is chromium's own output, unmodified.`,
          });
        }
        return attempt.pdf;
      };

      let described = gated(raw, 'ToUnicode', fixToUnicode);
      described = gated(described, 'font descriptor', fixFontDescriptors);
      if (linkDescs) {
        described = gated(described, 'link description', (p) => fixLinkDescs(p, linkDescs!));
      }

      const redundant = redundantFigureCount(described);
      if (redundant > 0) {
        const attempt = repairOrKeep(described, fixRedundantFigures);
        if (attempt.failures.length) {
          findings.push({
            code: 'repair-rejected',
            severity: 'warn',
            message:
              `the figure-role fix was discarded because it did not leave a valid pdf: ` +
              `${attempt.failures.join('; ')}. the file is chromium's own output, unmodified.`,
          });
        } else {
          described = attempt.pdf;
          findings.push({
            code: 'figure-role-corrected',
            severity: 'info',
            message:
              `${redundant} figure ${redundant === 1 ? 'element' : 'elements'} ` +
              `tagged as a grouping rather than a figure, because chromium tags both the ` +
              `figure element and the image inside it as a figure and describes only the ` +
              `image. each image keeps its own description.`,
          });
        }
      }

      const currentTitle = readDocInfo(described).title ?? '';
      if (currentTitle && isVolatileTitle(currentTitle) && currentTitle !== pdfTitle) {
        described = gated(described, 'document title', (p) => setDocTitle(p, pdfTitle));
      }

      described = gated(described, 'metadata', (p) =>
        addMetadata(p, {
          author,

          subject: req.subject?.trim() || docMeta.subject || '',
          keywords: req.keywords?.trim() || docMeta.keywords || '',
        }),
      );
      // The only stage that rewrites a content stream, and the only one outside the gate.
      // It proves itself by replaying the original and the rewritten stream and comparing
      // every glyph position; if any glyph moves, or a block is not the simple shape it
      // handles, the input is returned untouched.
      const { pdf: merged, stats: runs } = mergeTextRuns(described);
      if (runs.blocks > 0) {
        // Reported even when nothing merged. A document whose text Chromium writes in a
        // shape this does not handle is a fact about the output, and staying quiet about
        // it is how a transform looks like it works.
        findings.push({
          code: 'text-runs-merged',
          severity: 'info',
          message:
            runs.merged > 0
              ? `folded ${runs.merged} of ${runs.blocks} text blocks into TJ arrays, ` +
                `${described.byteLength - merged.byteLength} bytes smaller, glyph positions verified unchanged` +
                `${runs.refused ? `; ${runs.refused} left alone as not simple enough to rewrite` : ''}.`
              : `left all ${runs.blocks} text blocks alone: none is the shape this rewrites.`,
        });
      }
      described = merged;
      const pdf = stampPdf(described, pdfTitle);

      // What a browser will do with a selection over this page. Firefox's PDF.js keeps a
      // word gap inside the current text item only between 0.102 and 0.6 em; outside that
      // it ends the item and the gap becomes a highlight of its own, which is why a
      // justified paragraph selects as a row of separate boxes. Nothing in the file can
      // change the gap, so it is reported rather than repaired.
      const flow = textFlow(pdf);
      if (flow && flow.breaks > 0 && (flow.tooWide > 0 || flow.jump > 0 || flow.tooThin > 0)) {
        // A gap past 0.6 em ends a text item, but a stretched word space and a jump to the
        // next column have nothing to do with each other and are fixed by different CSS.
        const why: string[] = [];
        if (flow.tooWide > 0) {
          why.push(
            `${flow.tooWide} word spaces stretched past it, the widest to ` +
              `${flow.widest.toFixed(2)} em -- text-align:justify on a short measure is the usual cause`,
          );
        }
        if (flow.jump > 0) {
          why.push(
            `${flow.jump} gaps of more than ${3} em, which are jumps between blocks, ` +
              `columns or cells rather than between words -- table cell padding and column gaps cause these`,
          );
        }
        if (flow.tooThin > 0) {
          why.push(`${flow.tooThin} word spaces squeezed below it, which letter-spacing causes`);
        }
        // A stream this could not read takes its glyphs out of every count above while the
        // counts still read as a document total, so say how much of the document the numbers
        // come from rather than letting "at least" go unsaid.
        const from =
          flow.read < flow.streams
            ? ` Measured on ${flow.read} of ${flow.streams} text streams; the rest were not readable.`
            : '';
        findings.push({
          code: 'selection-fragmented',
          severity: 'warn',
          message:
            `a browser ends a text item at any gap over 0.6 em and draws one highlight ` +
            `box per item, so selection breaks here: ${why.join('; ')}.${from}`,
        });
      }

      if (docMeta.author && !req.author?.trim() && !rejected.has('metadata')) {
        findings.push({
          code: 'metadata-authored',
          severity: 'info',
          message: `wrote "${docMeta.author}" as the pdf author, from the document's own meta tag. pass --author to override it.`,
        });
      }
      if (docMeta.subject?.trim()) {
        findings.push({
          code: 'metadata-subject',
          severity: 'info',
          message: `wrote "${docMeta.subject}" as the pdf subject, from the document's own meta tag.`,
        });
      }
      const info = inspect(pdf);

      for (const url of blocked) {
        findings.push({
          code: 'network-blocked',
          severity: 'warn',
          url,
          message: `blocked a remote request to ${url}. Pass --allow-network to permit it, or inline the asset.`,
        });
      }
      const outside = outsideRoot.filter((o) => o.why === 'outside-root');
      const overDocument = outsideRoot.filter((o) => o.why === 'document');
      if (overDocument.length) {
        findings.push({
          code: 'asset-overwrites-document',
          severity: 'warn',
          url: overDocument[0]!.abs,
          message:
            `${overDocument.length} referenced ${overDocument.length === 1 ? 'path is' : 'paths are'} ` +
            `named after the document itself and ${overDocument.length === 1 ? 'was' : 'were'} not staged: ` +
            `${overDocument.map((o) => o.ref).join(', ')}.\n` +
            `staging one would replace the page being printed with a different one, so the ` +
            `render would show a document nobody asked for. rename the file it points at.`,
        });
      }
      if (outside.length) {
        const listed = outside.map((o) => `  ${o.ref} -> ${o.abs}`).join('\n');
        findings.push({
          code: 'asset-outside-root',
          severity: 'warn',
          url: outside[0]!.abs,
          message:
            `${outside.length} referenced ${outside.length === 1 ? 'path is' : 'paths are'} outside ` +
            `${req.root ? `the root you named (${absRoot(req.root)})` : "the document's own directory"}, ` +
            `so ${outside.length === 1 ? 'it was' : 'they were'} not read:\n${listed}\n` +
            `pass --root naming a directory that contains ` +
            `${outside.length === 1 ? 'it' : 'them'} to allow it.`,
        });
      }
      if (failedSubresources.length) {
        const kinds = [...new Set(failedSubresources.map((f) => f.kind))];
        const images = failedSubresources.filter((f) => f.kind === 'Image').length;

        const listed = [...new Set(failedSubresources.map((f) => f.url))]
          .slice(0, 5)
          .map((u) => `  ${u}`)
          .join('\n');
        findings.push({
          code: 'subresource-failed',
          severity: 'warn',
          url: failedSubresources[0].url,
          message:
            `${failedSubresources.length} ${failedSubresources.length === 1 ? 'subresource' : 'subresources'} (${kinds.join(', ')}) failed to load, so the document is missing ${failedSubresources.length === 1 ? 'it' : 'them'}.\n${listed}` +
            (images
              ? `\n${images} ${images === 1 ? 'is an image' : 'are images'}: where a picture should be, the pdf carries chromium's broken-image placeholder.`
              : '') +
            `\nthe pdf was still produced, but it will not look like the source. url(), @import and @font-face src are staged from disk only when the document is a file.`,
        });
      }
      if (req.url && !req.allowNetwork) {
        findings.push({
          code: 'url-render-blocked',
          severity: 'error',
          message: `rendering a remote URL blocks its own subresources and usually the document itself. Set allowNetwork to render ${req.url}.`,
        });
      }

      const unresolved = unresolvedFontMetrics(pdf);
      if (unresolved.length) {
        findings.push({
          code: 'font-metrics',
          severity: 'warn',
          message:
            `${unresolved.length} font descriptor${unresolved.length === 1 ? ' still carries' : 's still carry'} a negative cap height (${unresolved
              .map((u) => `${u.fontName} ${u.capHeight}`)
              .slice(0, 3)
              .join(', ')}). ` +
            `The PDF specification calls a negative CapHeight an error a viewer may refuse to render text over. ` +
            `Chromium emitted ${unresolved.length === 1 ? 'this face' : 'these faces'} as Type 3 fonts, whose glyphs are drawing procedures with no embedded font to read the metric from, so the value cannot be derived and was left as produced. ` +
            `Embedding the font as a file rather than relying on a system face usually removes it.`,
        });
      }

      return {
        pdf,
        info,
        findings,
        blocked,
        ms: Math.round((Bun.nanoseconds() - started) / 1e6),
        source: src.source,
      };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    if (tab) await browser.closeTab(tab).catch(() => {});
    server?.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
