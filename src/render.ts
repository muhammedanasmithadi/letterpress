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
import { applyImageReplacements, measureImages } from './pageside.ts';
import { stripRedundantSpans } from './spans.ts';
import { repairOrKeep, verify } from './verify.ts';
import { audit } from './lint.ts';
import {
  declaredPageMargin,
  declaredPageOrientation,
  declaredPageSize,
  inspect,
  stripPageSize,
  toInches,
  transposePageSize,
  type PdfInfo,
} from './pdf.ts';

// Re-exported so the existing import path keeps working: the conversion and the
// page-declaration readers live in pdf.ts now, where the PDF-side tests and the
// HTML-side callers can share one copy.
export { declaredPageOrientation, toInches } from './pdf.ts';

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

  /**
   * A function run in the page once the document is laid out and settled, whose return
   * value comes back on the result as `probe`.
   *
   * A function rather than an expression string because a string is invisible to `tsc`, and
   * an identifier that resolves on this side and not in the page is a runtime failure in the
   * browser rather than a build failure here.
   *
   * Pass the function itself, not a wrapper around it. The body is shipped as source and
   * runs in the page, where the enclosing module does not exist: `pageProbe: wideGaps` works
   * and `pageProbe: () => wideGaps()` is a `ReferenceError`, because `wideGaps` is a name in
   * the caller's file and not in the browser. That was the second version of this, and the
   * first. A probe that throws is reported as `page-probe-failed` rather than returning
   * nothing, because nothing downstream can otherwise tell a probe that failed from a probe
   * that found nothing.
   */
  pageProbe?: () => unknown;

  /** Keep every /ActualText span, at the cost of selection in a reader. */
  keepLigatureSpans?: boolean;

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
  /** Whatever `pageProbe` returned, or undefined when none was given. */
  probe?: unknown;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BLOCKED_REPORTED = 20;

const close = (a: number, b: number) => Math.abs(a - b) < 0.05;

/**
 * The document as it must be rewritten before printing, or null for none.
 *
 * Two rewrites, chosen by what the request asked for. A format takes the paper
 * outright, so the declaration is stripped and the flag's paper wins.
 * Landscape without a format must keep the document's own paper and margin, so
 * the declaration is transposed in place and only its orientation changes --
 * Chromium discards its `landscape` parameter whenever `preferCSSPageSize` is
 * set, so asking it to rotate a page it defers to does nothing at all.
 *
 * The transpose asks the same question the finding above asks, so the paper in
 * the output and the finding beside it cannot disagree.
 */
function pageOverride(html: string | null | undefined, req: RenderRequest): string | null {
  if (html == null || declaredPageSize(html) === null) return null;
  if (req.format) return stripPageSize(html);
  if (!req.landscape || declaredPageOrientation(html) !== 'portrait') return null;
  return transposePageSize(html);
}

function precedenceFindings(html: string, req: RenderRequest): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredPageSize(html);
  const declaredMargin = declaredPageMargin(html);

  if (declared && req.format) {
    const [w = NaN, h = NaN] = FORMATS[req.format];
    const named = declared.match(/\b(a3|a4|a5|letter|legal|tabloid)\b/)?.[1]?.toLowerCase();
    const dims = declared.match(/([\d.]+)\s*(mm|cm|in|px|pt)/gi)?.map(toInches) ?? [];
    const [d0 = NaN, d1 = NaN] = dims;
    const target: [number, number] = req.landscape ? [h, w] : [w, h];
    const agrees = named
      ? named === req.format && !req.landscape
      : dims.length >= 2 &&
        ((close(d0, target[0]) && close(d1, target[1])) ||
          (close(d0, target[1]) && close(d1, target[0])));
    if (!agrees) {
      findings.push({
        code: 'page-size-override',
        severity: 'info',
        message: `request asked for ${req.format}${req.landscape ? ' landscape' : ''}, but the document declares @page size: ${declared}. The request wins: the declaration is stripped from the document and the paper is set from the flag.`,
      });
    }
  }

  if (declared && req.landscape) {
    const orientation = declaredPageOrientation(html);
    if (orientation === 'portrait') {
      // A declared portrait page and a landscape request have to be settled
      // one way or the other. The request wins, because a flag that reports
      // itself ignored is a flag that silently does nothing: measured, this
      // sent `landscape: true` to a printToPDF call that discards the
      // parameter whenever preferCSSPageSize is set, so the sheet came back
      // portrait with only this finding between the request and the paper.
      //
      // Which mechanism applies depends on whether a format was asked for.
      // With one, the paper comes from the flag and the declaration is
      // stripped. Without one, the declaration keeps the document's own size
      // and margin and only its orientation is transposed -- the smallest
      // change that satisfies the request.
      const transposed = !req.format && transposePageSize(html) !== null;
      if (transposed) {
        findings.push({
          code: 'orientation-overridden',
          severity: 'info',
          message: `the document declares @page size: ${declared}, which is portrait, so the declaration has been transposed to landscape. The paper and margin are the document's own. Write "@page { size: ${declared} landscape }" to make that permanent.`,
        });
      } else if (req.format) {
        findings.push({
          code: 'orientation-overridden',
          severity: 'info',
          message: `the document declares @page size: ${declared}, which is portrait. --format with --landscape takes precedence, so the paper has been transposed rather than the document's own page size used.`,
        });
      } else {
        findings.push({
          code: 'orientation-ignored',
          severity: 'error',
          message: `--landscape had no effect: the document declares @page size: ${declared}, and that declaration cannot be transposed into a landscape spelling, so the PDF is portrait. Name a paper the engine can rotate, either with --format a4 or by writing "@page { size: ${declared} landscape }" in the stylesheet.`,
        });
      }
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
): Promise<Array<{ at: number; from: number; to: number; ppi: number }>> {
  const res = await tab.send(
    'Runtime.evaluate',
    {
      expression: `(${measureImages})(${JSON.stringify(maxPpi)})`,
      returnByValue: true,
    },
    timeoutMs,
  );
  const raw = res?.result?.value;
  if (raw == null) return [];
  let entries: Array<{ at: number; from: number; to: number; ppi: number; url: string }>;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!entries.length) return [];

  await tab.send(
    'Runtime.evaluate',
    {
      expression: `(${applyImageReplacements})(${JSON.stringify(
        entries.map((e) => ({ at: e.at, url: e.url })),
      )})`,
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

  return entries.map(({ at, from, to, ppi }) => ({ at, from, to, ppi }));
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
    if (NOT_A_LOCAL_FILE.test(clean)) return;
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
    // The same list `hasRelativeAssets` reads, deliberately: that function decides whether
    // this one runs at all, and two lists is how a document ends up printed unstyled.
    for (const ref of refsIn(text)) consider(ref, from);
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

// Every place a document can name a local file.
//
// `stageAssets` copies what these find, and `hasRelativeAssets` decides from the same list
// whether `stageAssets` needs to run at all -- if it does not, the document is rendered from
// `about:blank` with no server and no staged files. The two lists were written separately
// and the second missed `@import` and module imports, so a document whose only local
// reference was an imported stylesheet was rendered from nothing and printed unstyled, with
// no finding and no error. One list, so the question cannot be asked two ways again.
const REF_PATTERNS: ReadonlyArray<{ re: RegExp; candidates?: true }> = [
  { re: /(?:src|href)\s*=\s*["']([^"']+)["']/gi },
  { re: /(?:src|href)\s*=\s*([^\s>]+)/gi },
  // `srcset` holds a comma-separated list, and each entry's first token is the URL.
  { re: /\bsrcset\s*=\s*["']([^"']+)["']/gi, candidates: true },
  { re: /url\(\s*["']?([^"')]+)["']?\s*\)/gi },
  { re: /@import\s+["']([^"']+)["']/gi },
  { re: /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g },
  { re: /\bimport\s*["']([^"']+)["']/g },
  { re: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g },
];

/** A reference the document did not have to be shipped with: nothing on disk to stage. */
const NOT_A_LOCAL_FILE = /^(?:https?:|data:|blob:|file:|#|mailto:|\/\/)/i;

function* refsIn(text: string): Generator<string> {
  for (const { re, candidates } of REF_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? '').replace(/["']/g, '');
      if (candidates) {
        for (const entry of raw.split(',')) yield entry.trim().split(/\s+/)[0] ?? '';
      } else {
        yield raw;
      }
    }
  }
}

/**
 * The finding for a file that will not pass the structural check, or null when it will.
 *
 * A pure function of the bytes on purpose. It was inline at the end of the pipeline first,
 * and testing it needed `mock.module` on the verify module -- which is global in Bun, so the
 * test that proved this path works broke every test that ran after it. A decision that is a
 * function of its argument does not need the module registry to reach.
 */
export function finalCheckFinding(pdf: Uint8Array): Finding | null {
  const finalCheck = verify(pdf);
  if (finalCheck.ok) return null;
  return {
    code: 'output-unverified',
    severity: 'error',
    message:
      `the file returned by this call did not pass the structural check: ` +
      `${finalCheck.failures.join('; ')}. every repair upstream is gated on the same ` +
      `check, so this is the merge or the stamp producing something it should not have.`,
  };
}

export function hasRelativeAssets(html: string): boolean {
  for (const ref of refsIn(html)) {
    const clean = ref.trim().split(/[?#]/)[0];
    if (clean && !NOT_A_LOCAL_FILE.test(clean)) return true;
  }
  return false;
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

    const raw = await Bun.file(abs).arrayBuffer();
    const asLatin1 = Buffer.from(raw).toString('latin1');
    const binary = looksBinary(asLatin1);
    if (binary) {
      throw new Error(
        `this input is not HTML: ${binary}. letterpress prints html, so a document with the wrong ` +
          `file extension produces a page of binary noise rather than an error. check the path.`,
      );
    }
    const html = new TextDecoder('utf-8').decode(raw);
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

function stampPdf(pdf: Uint8Array): Uint8Array {
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
    // The whole date, not a prefix of it.
    //
    // `[\d'Z]{0,5}` allowed five characters after the offset sign and Chromium writes six
    // -- `+00'00'` -- so the match stopped one character short of the closing quote. The
    // replacement preserved the matched length, so the byte the pattern never reached kept
    // its old value: `D:20261011135334+00'00'` stamped to `D:20231114221320Z     '`, with
    // the stale apostrophe still sitting in the file. Every reproducible build has it,
    // because Chromium always writes the six-character form.
    //
    // A conforming reader stops at the `Z` and never sees the fragment, which is why no test
    // caught it: the file was valid and the finding was true as far as anyone could tell.
    for (const m of text.matchAll(/D:\d{14}(?:[+\-]\d{2}'?\d{2}'?|Z)/g)) {
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

  // Applied back to front, and every replacement is padded or truncated to the length it
  // replaces, so no offset after it can move and the file length never changes.
  for (const [at, length, value] of edits.sort((a, b) => b[0] - a[0])) {
    const fit = value.slice(0, length);
    for (let i = 0; i < fit.length; i++) out[at + i] = fit.charCodeAt(i);

    for (let i = fit.length; i < length; i++) out[at + i] = 0x20;
  }
  return out;
}

/**
 * Empty input is a request defect, not a render failure: the HTTP layer
 * answers it 400 with this message, while render() itself still throws it
 * for callers without validation (the CLI). One string, two doors.
 */
export const EMPTY_INPUT_MESSAGE =
  'the input is empty. a 0-byte file renders as one blank page and reports success; ' +
  'check that the file has content, or that the command producing it wrote to stdout.';

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
        throw new Error(EMPTY_INPUT_MESSAGE);
      }
      findings.push(...precedenceFindings(src.html, req));
    }

    let outsideRoot: RefusedRef[] = [];
    const relative = hasRelativeAssets(src.html ?? '');
    // Computed before fastPath because that decision depends on it. The fast
    // path hands Chromium the source as `about:blank`, so it has nowhere to
    // put a rewritten document; a request that needs one and quietly does not
    // get it renders the wrong paper with nothing said, which is the failure
    // the rewrite exists to remove.
    const override = pageOverride(src.html, req);
    const fastPath =
      !isRemote &&
      src.html != null &&
      req.preferFastPath !== false &&
      !relative &&
      !req.maxImagePpi &&
      override === null;

    if (!isRemote && !fastPath) {
      outsideRoot = await stageAssets(src.html, src.source, dir, req.root);
      server = await serveWorkDir(dir);
    }

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

      // A probe runs after the document is settled and before the print, so it sees the same
      // layout the PDF is made from. Its result is handed back untouched; if it throws in
      // the page, that is the caller's problem to notice rather than a silent empty result,
      // which is what an expression string returned last time.
      let probe: unknown;
      if (req.pageProbe) {
        const answer = await tab
          .send(
            'Runtime.evaluate',
            { expression: `(${req.pageProbe})()`, returnByValue: true },
            timeoutMs,
          )
          .catch((e: unknown) => ({ exceptionDetails: { text: String(e) } }));
        // Reported, never swallowed. The first version of this returned `undefined` on
        // failure, which is indistinguishable from a probe that legitimately found nothing:
        // `wideGaps` called a helper that does not exist in the page, the probe came back
        // empty, and the tool printed its old sentence as though the document had no wide
        // gaps. It had eight. A probe that cannot run must say so.
        const thrown = (
          answer as {
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          } | null
        )?.exceptionDetails;
        if (thrown) {
          // `exceptionDetails.text` is the word "Uncaught". The message that says which
          // name was missing is on the exception itself, and that is the whole diagnosis.
          const detail =
            thrown.exception?.description?.split('\n')[0]?.trim() || thrown.text || 'no detail';
          findings.push({
            code: 'page-probe-failed',
            severity: 'warn',
            message:
              `the page probe threw in the browser: ${detail}. it returned nothing, so ` +
              `nothing downstream can tell a probe that failed from a probe that found ` +
              `nothing. this is a gap in the tool, not a finding about the document.`,
          });
        } else {
          probe = (answer as { result?: { value?: unknown } } | null)?.result?.value;
        }
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
              `${attempt.failures.join('; ')}. the file is what the previous stage ` +
              `produced, with this fix not applied.`,
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
          // Recorded like every other rejection. Nothing reads `figure-role` out of the set
          // today, but the set reads as a complete record of what was discarded and a reader
          // would otherwise assume a rejected fix was an accepted one.
          rejected.add('figure-role');
          findings.push({
            code: 'repair-rejected',
            severity: 'warn',
            message:
              `the figure-role fix was discarded because it did not leave a valid pdf: ` +
              `${attempt.failures.join('; ')}. the file is what the previous stage ` +
              `produced, with this fix not applied.`,
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

      // Chromium wraps every ligature in a marked-content span carrying /ActualText, and a
      // reader ends a text item at each one whatever the spacing says. One page of ordinary
      // prose comes back as sixty text items where the geometry alone gives seven, and
      // dragging a selection across it draws sixty highlight boxes, seventeen of them for
      // gaps that are not there.
      //
      // Only spans whose text the font's /ToUnicode already resolves to are removed, so
      // nothing is lost: where the two disagree the span is the only copy and it stays.
      // Measured in Firefox: sixty items and seventeen whitespace items as rendered, seven
      // and none after. Extracted text is unchanged character for character.
      if (req.keepLigatureSpans !== true) {
        const stripped = stripRedundantSpans(described);
        const spans = stripped.stats;
        // Whether the repair actually changed the file, asked of the bytes rather than of
        // the repair's own count of what it did. The first version routed this through
        // `repairOrKeep`, which refuses any repair that rewrites a content stream -- correct
        // for a metadata repair, and exactly wrong here, because removing a span is a content
        // stream rewrite by definition. The gate returned the input, the bytes never changed,
        // and the finding said "removed 36 of 36" anyway: a confident claim about a repair
        // that had been refused, with no `repair-rejected` to say so, because the finding was
        // pushed from the stats before anyone asked whether the output was used.
        //
        // The final `verify()` below covers the result. This repair does what mergeTextRuns
        // does and for the same reason is not gated against Chromium's own bytes.
        const changed =
          spans.stripped > 0 &&
          (stripped.pdf.length !== described.length ||
            !stripped.pdf.every((v, i) => v === described[i]));
        if (changed) described = stripped.pdf;

        if (spans.seen > 0) {
          findings.push({
            code: 'ligature-spans',
            severity: 'info',
            message: changed
              ? `removed ${spans.stripped} of ${spans.seen} marked-content spans carrying ` +
                `/ActualText, each of which ended a text item at every ligature. each was ` +
                `removed only because /ToUnicode already gave the same characters, so the ` +
                `extracted text is unchanged.${spans.kept ? ` ${spans.kept} kept, being the only place their text appears.` : ''}`
              : spans.stripped > 0
                ? `found ${spans.stripped} removable /ActualText spans and the file came back ` +
                  `unchanged, so nothing was removed. this is a bug in letterpress, not a ` +
                  `finding about the document.`
                : `left all ${spans.seen} /ActualText spans in place: /ToUnicode does not ` +
                  `resolve them to the same text, so each is the only copy of it.`,
          });
        }
      }

      // The title stamp is a byte-for-byte rewrite of the file rather than a change to one
      // object, and it was the only stage after the merge that nothing checked. It goes
      // through the same gate as the others so that a bad rewrite is a finding rather than
      // the caller's problem.
      const stamped = repairOrKeep(described, stampPdf);
      if (stamped.failures.length) {
        rejected.add('stamp');
        findings.push({
          code: 'repair-rejected',
          severity: 'warn',
          message:
            `the title stamp was discarded because it did not leave a valid pdf: ` +
            `${stamped.failures.join('; ')}. the file is what the previous stage produced, ` +
            `with this fix not applied.`,
        });
      }
      const pdf = stamped.pdf;

      // The last structural check, on the bytes actually being returned.
      //
      // `mergeTextRuns` rewrites content streams on purpose, so it cannot be checked against
      // Chromium's own output -- that comparison is what `repairOrKeep` does for every other
      // repair and is exactly wrong here. This runs standalone instead: header, xref,
      // trailer, object count and `%%EOF`, with no notion of what the file should contain.
      //
      // It cannot tell a correct page from a wrong one. It catches the file that will not
      // open, which is the failure a caller cannot detect and the one no finding so far
      // would have described.
      const failedFinal = finalCheckFinding(pdf);
      if (failedFinal) findings.push(failedFinal);

      // What a browser will do with a selection over this page. Firefox's PDF.js keeps a
      // word gap inside the current text item only between 0.102 and 0.6 em; outside that
      // it ends the item and the gap becomes a highlight of its own, which is why a
      // justified paragraph selects as a row of separate boxes. Nothing in the file can
      // change the gap, so it is reported rather than repaired.
      const flow = textFlow(pdf);
      if (
        flow &&
        ((flow.breaks > 0 &&
          (flow.tooWide > 0 || flow.jump > 0 || flow.tooThin > 0 || flow.backwards > 0)) ||
          flow.spans > 0 ||
          flow.unreadable > 0)
      ) {
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
        if (flow.backwards > 0) {
          why.push(
            `${flow.backwards} moves back inside a line, which ends a text item -- ` +
              `right-to-left text does this by design`,
          );
        }
        if (flow.unreadable > 0) {
          // Type 3 subsets and simple fonts carry their advances in /Widths, not /W. Their
          // glyphs are counted and skipped rather than guessed, and no gap is measured to or
          // from one, so the numbers above are the readable part of the document.
          why.push(
            `${flow.unreadable} glyphs in fonts with no readable advance, so no gap around them was measured`,
          );
        }
        if (flow.spans > 0) {
          // A reader ends a text item at every marked-content span whatever the geometry
          // says, so each one is a highlight box the geometry cannot account for. On a page
          // of ordinary prose that is eighteen of them.
          //
          // Not all of them are ligatures. Chromium emits these around ligatures, and the
          // first version of this message said "ligature spans" about every one of them,
          // which is wrong on a real document: a resume whose punctuation glyphs have no
          // /ToUnicode mapping carries eighteen spans wrapping `+`, `-`, `(` and `:`, and
          // those are exactly the ones that have to be kept, because the span is the only
          // place the character appears. The count is of spans. It is named that way.
          why.push(
            `${flow.spans} marked-content spans carrying /ActualText, each a place a ` +
              `browser may end a text item regardless of spacing. chromium emits them ` +
              `around ligatures, but not every span is one`,
          );
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
      // Guarded the way the author branch above is. `--subject "Q3 report"` beats the
      // document's own meta tag, and the gate may have rejected the whole metadata repair,
      // so without this the finding names a value that is not in the file.
      if (docMeta.subject?.trim() && !req.subject?.trim() && !rejected.has('metadata')) {
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
          url: failedSubresources[0]?.url,
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
        // The cause is named per face from what unresolvedFontMetrics measured, not from
        // what this path usually is. A Type 3's glyphs are drawing procedures with no
        // embedded font to read the metric from, so the value cannot be derived; a face
        // of any other subtype with no embedded program is one Chromium did not embed,
        // for which the same holds. Saying "Type 3" for both would be a confident claim
        // about something nobody checked.
        const named = unresolved.map((u) =>
          u.subtype === 'Type3'
            ? `${u.fontName} ${u.capHeight} (Type 3, whose glyphs are drawing procedures with no embedded font to read the metric from)`
            : `${u.fontName} ${u.capHeight} (${u.subtype}, emitted without an embedded font program)`,
        );
        findings.push({
          code: 'font-metrics',
          severity: 'warn',
          message:
            `${unresolved.length} font descriptor${unresolved.length === 1 ? ' still carries' : 's still carry'} a negative cap height ` +
            `(${named.slice(0, 3).join(', ')}). ` +
            `The PDF specification calls a negative CapHeight an error a viewer may refuse to render text over. ` +
            `There is nothing to derive the metric from, so the value was left as produced. ` +
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
        probe,
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
