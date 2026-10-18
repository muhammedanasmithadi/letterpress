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
  injectPageRule,
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
 * Every paper decision ends up in an `@page` rule, because that is the only
 * channel that yields the sheet a browser would have chosen: Chromium
 * quantizes `printToPDF`'s inch parameters (measured: A4 asked for as 8.2677in
 * returns 595.92pt, and `size: a4` returns 594.96pt), and it ignores
 * `preferCSSPageSize` outright when no rule exists, falling back to Letter. So
 * the paper is written where the browser can honour it exactly.
 *
 * Which rewrite depends on what was asked for:
 *
 * - a format takes the paper outright, so the document's sizes are stripped and
 *   the flag's size and margin are appended;
 * - landscape without a format keeps the document's own paper and margin, and
 *   only the declared orientation is transposed;
 * - no format and no declared page gets the A4 default written down, which is
 *   the same sheet the old default sent and now arrives exact;
 * - a document that declares its own page, with nothing asked of it, is left
 *   byte-identical.
 *
 * Only reachable with source markup in hand: a remote document is navigated to,
 * not rewritten, so its paper still travels the old way.
 */
function pageOverride(html: string | null | undefined, req: RenderRequest): string | null {
  if (html == null) return null;
  const declared = declaredPageSize(html);

  if (req.format) {
    const size = `${req.format}${req.landscape ? ' landscape' : ''}`;
    return injectPageRule(stripPageSize(html), `size:${size};margin:${req.margin ?? '0'}`);
  }

  if (declared === null) {
    // Nothing declared, so the engine is choosing. A4 is what the old default
    // asked for in inches; written as a keyword it is exact.
    const size = req.landscape ? 'a4 landscape' : 'a4';
    return injectPageRule(html, `size:${size};margin:${req.margin ?? '0'}`);
  }

  // Declared, and the only thing asked for is an orientation it does not have.
  if (req.landscape && declaredPageOrientation(html) === 'portrait') {
    return transposePageSize(html);
  }
  return null;
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

/**
 * Copy the assets a document references into the work directory, so the page can
 * load them from one origin.
 *
 * Two phases, because they answer different questions. Planning asks what the
 * markup names -- following `@import` and `url()` through the stylesheets it
 * pulls in -- and refuses anything that is not a file the engine may read.
 * Staging then copies each one, resolving symlinks first and refusing again if
 * the real path lands outside the root. Both phases can refuse, and they refuse
 * for different reasons: a document named for the page itself is refused while
 * planning, and a symlink out of the tree is refused while staging.
 *
 * The two phases are separate functions because the planning half is where the
 * branching is, and it was measured as one function with the staging half
 * inside it.
 */
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
 * Copy the assets a document references into the work directory, so the page can
 * load them from one origin.
 *
 * Walking and copying cannot be two phases: a stylesheet is only read once it
 * has been copied, so every `url()` and `@import` inside it is discovered after
 * the first pass has already started. They share one queue and one set of
 * refusals, and the two halves are separate functions because the branching
 * belongs to both.
 */
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

  const state: AssetState = {
    base,
    root,
    dir,
    seen: new Set<string>(),
    written: new Set<string>(),
    queue: [],
    refused: [],
  };

  scanAssets(state, html, base);

  while (state.queue.length) {
    const next = state.queue.shift()!;
    await stageOne(state, next, insideRoot);
  }

  return state.refused;
}

/** One referenced path, and whether it was written outside the document's own tree. */
type AssetPlan = { ref: string; from: string; outside: boolean };

type AssetState = {
  base: string;
  root: string;
  dir: string;
  seen: Set<string>;
  written: Set<string>;
  queue: AssetPlan[];
  refused: RefusedRef[];
};

/**
 * Whether a path is inside a root, compared as written rather than resolved.
 *
 * Deliberately not the real path: a `../` that lexically leaves the root is
 * refused before anything is read, which is the check that cannot be defeated
 * by a path the engine has not resolved yet.
 */
function lexicallyInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/');
}

/**
 * Consider one referenced path: refuse what must not be staged, queue the rest.
 *
 * The refusals are capped at eight. A generated page can name ten thousand of
 * them, and the finding that reports them does not read better for the length.
 */
function considerAsset(state: AssetState, ref: string, from: string): void {
  const clean = ref.trim().split(/[?#]/)[0];
  if (!clean) return;
  if (NOT_A_LOCAL_FILE.test(clean)) return;
  const abs = isAbsolute(clean) ? clean : resolve(from, clean);
  if (state.seen.has(abs)) return;
  state.seen.add(abs);

  const urlPath = clampedUrlPath(relative(state.base, abs));
  if (!urlPath) return;
  const target = join(state.dir, urlPath);
  if (!target.startsWith(state.dir + '/') || state.written.has(target)) return;

  // The document may not be replaced by one of its own assets: staging a file
  // named after the page would print a different document than the one asked
  // for, with nothing to say so.
  if (urlPath === SERVED_DOCUMENT || urlPath === OVERRIDE_DOCUMENT) {
    if (state.refused.length < 8) state.refused.push({ ref: clean, abs, why: 'document' });
    return;
  }
  state.written.add(target);

  state.queue.push({ ref: clean, from: abs, outside: !lexicallyInside(abs, state.root) });
}

/**
 * The same list `hasRelativeAssets` reads, deliberately: that function decides
 * whether this one runs at all, and two lists is how a document ends up printed
 * unstyled.
 */
function scanAssets(state: AssetState, text: string, from: string): void {
  for (const ref of refsIn(text)) considerAsset(state, ref, from);
}

/**
 * Copy one referenced file, or refuse it, and queue whatever it references.
 *
 * The real path is read before anything is written, so a symlink pointing out of
 * the root is caught rather than followed. A file that cannot be read is
 * skipped without a finding: the document will report the asset as missing,
 * which is the same fact said by the thing that can see it.
 */
async function stageOne(state: AssetState, next: AssetPlan, insideRoot: InsideRoot): Promise<void> {
  const { ref, from, outside } = next;
  const real = await realpath(from).catch(() => null);

  if (real && !insideRoot(real)) {
    if (state.refused.length < 8 && !state.refused.some((r) => r.abs === real)) {
      state.refused.push({ ref, abs: real, why: 'outside-root' });
    }
    return;
  }
  if (!real) {
    // A path inside the root that does not exist is the document's own
    // business; one naming something outside it is the engine's.
    if (outside && state.refused.length < 8 && !state.refused.some((r) => r.abs === from)) {
      state.refused.push({ ref, abs: from, why: 'outside-root' });
    }
    return;
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await Bun.file(real).arrayBuffer());
  } catch {
    return;
  }
  if (!bytes.length) return;
  const target = join(state.dir, clampedUrlPath(relative(state.base, from)));
  try {
    await Bun.write(target, bytes);
  } catch {
    return;
  }

  if (/\.(?:css|mjs|js)$/i.test(from)) {
    try {
      scanAssets(state, new TextDecoder('latin1').decode(bytes), dirname(real));
    } catch {}
  }
}

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
    const prepared = await prepareSource(req, dir, isRemote, findings);
    const { src, srcUrl, fastPath, override } = prepared;
    const outsideRoot = prepared.outsideRoot;
    server = prepared.server;

    tab = await browser.newTab();
    // A box, not a boolean: the print call that needs to know whether the
    // deadline passed lives in another function now, and a value copied into it
    // would always be the false it was when it was passed.
    const timedOutRef = { timedOut: false };
    const deadline = setTimeout(() => {
      timedOutRef.timedOut = true;

      void browser.closeTab(tab!).catch(() => {});
    }, timeoutMs);

    try {
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
      await tab.send('Network.enable');
      // A modal dialog blocks the renderer until something answers it. Measured
      // with a page that calls `alert()`: nothing answered, the render sat out
      // the full deadline, and the failure surfaced as `cdp socket closed` --
      // an error naming the transport rather than the document. And a tab that
      // dies outright used to cost the same full deadline before anyone noticed.
      // Both now say so at once.
      const alive = watchTab(tab);
      const net = await watchNetwork(tab, {
        loopback: loopbackPattern(server),
        allowNetwork: req.allowNetwork === true,
        isRemote,
        srcUrl,
        blocked,
        failedSubresources,
      });

      await loadDocument({
        tab,
        net,
        fastPath,
        override,
        html: src.html,
        srcUrl,
        source: src.source,
        timeoutMs,
        timedOutRef,
      });

      const page = await readPage(tab, req, timeoutMs, findings);
      const { probe, docMeta, linkDescs } = page;

      const declaresPaper = await probeDeclaresPaper(tab, src.html, req, timeoutMs);

      const { raw } = await printPdf(tab, req, override, declaresPaper, timeoutMs, timedOutRef);

      const pdfTitle = pdfTitleFor(req);

      const { pdf, rejected } = repairDocument({
        raw,
        linkDescs,
        pdfTitle,
        meta: pdfMeta(req, docMeta),
        keepLigatureSpans: req.keepLigatureSpans === true,
        findings,
      });

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

      const fragmented = selectionFinding(pdf);
      if (fragmented) findings.push(fragmented);

      const info = inspect(pdf);

      if (!alive.alive()) {
        throw new Error(
          `the browser tab crashed while printing, most likely out of memory on a very large ` +
            `document. the deadline would have said only that ${timeoutMs}ms passed.`,
        );
      }

      findings.push(
        ...metadataFindings(docMeta, req, rejected),
        ...assetFindings(outsideRoot, req),
        ...networkFindings(blocked, failedSubresources, req),
        ...fontMetricFindings(pdf),
        ...dialogFindings(alive.dialogs()),
      );

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

/**
 * The findings that describe what the document asked for rather than what the
 * file ended up containing: its own meta tags, the assets it referenced, the
 * requests that were cut, and the faces that came back unreadable.
 *
 * Each is a function of bytes or of a list gathered earlier, with no browser in
 * reach. They were inline in `render`, which made the one function that owns a
 * tab, a clock and a temp directory also the place where prose about refused
 * paths was written.
 */
/**
 * Every repair the finished file gets, in order, and the findings describing what
 * each one did.
 *
 * These were inline in `render`, which made the function that owns a tab, a clock
 * and a temp directory also the place where prose about glyph shapes lived. The
 * pipeline itself has a shape worth reading on its own: most stages go through
 * `repairOrKeep`, which refuses any rewrite that does not leave a valid file and
 * records the refusal, and the two that rewrite content streams on purpose --
 * `mergeTextRuns` and `stripRedundantSpans` -- prove themselves against the
 * geometry instead, because comparing them to Chromium's own bytes would be
 * comparing a file to itself.
 *
 * `findings` and the returned `rejected` set travel together because a later
 * stage asks whether an earlier one was refused.
 */
type RepairInput = {
  raw: Uint8Array;
  linkDescs: ReturnType<typeof parseLinkDescs>;
  pdfTitle: string;
  meta: { author: string; subject: string; keywords: string };
  keepLigatureSpans: boolean;
  findings: Finding[];
};

type RepairResult = { pdf: Uint8Array; rejected: Set<string> };

function repairDocument(input: RepairInput): RepairResult {
  const { raw, linkDescs, pdfTitle, meta, keepLigatureSpans, findings } = input;
  const rejected = new Set<string>();

  let described = gated(raw, 'ToUnicode', fixToUnicode, rejected, findings);
  described = gated(described, 'font descriptor', fixFontDescriptors, rejected, findings);
  if (linkDescs) {
    described = gated(
      described,
      'link description',
      (p) => fixLinkDescs(p, linkDescs),
      rejected,
      findings,
    );
  }

  described = repairFigures(described, rejected, findings);
  described = repairTitle(described, pdfTitle, rejected, findings);
  described = gated(described, 'metadata', (p) => addMetadata(p, meta), rejected, findings);

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
            `${refusedRuns(runs.refused)}.`
          : `left all ${runs.blocks} text blocks alone: none is the shape this rewrites.`,
    });
  }
  described = merged;

  if (!keepLigatureSpans) {
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
    // The final `verify()` covers the result. This repair does what mergeTextRuns does
    // and for the same reason is not gated against Chromium's own bytes.
    const changed =
      spans.stripped > 0 &&
      (stripped.pdf.length !== described.length ||
        !stripped.pdf.every((v, i) => v === described[i]));
    if (changed) described = stripped.pdf;
    if (spans.seen > 0) findings.push(ligatureSpanFinding(spans, changed));
  }

  // The title stamp is a byte-for-byte rewrite of the file rather than a change to one
  // object, and it was the only stage after the merge that nothing checked. It goes
  // through the same gate as the others so that a bad rewrite is a finding rather than
  // the caller's problem.
  const stamped = repairOrKeep(described, stampPdf);
  if (stamped.failures.length) {
    rejected.add('stamp');
    findings.push(rejectedRepair('title stamp', stamped.failures));
  }

  return { pdf: stamped.pdf, rejected };
}

/**
 * The paper decision and the print call, together.
 *
 * They belong together because the decision is only ever expressed through the
 * call: whether the sheet arrives as CSS or as inches decides the whole shape of
 * the parameters. Splitting them put a block of `const`s in one function and
 * their only use in another.
 *
 * `timedOutRef` is a box rather than a value because the deadline is set by the
 * caller and this function can only observe it.
 */
async function printPdf(
  tab: Tab,
  req: RenderRequest,
  override: string | null,
  declaresPaper: boolean,
  timeoutMs: number,
  timedOutRef: { timedOut: boolean },
): Promise<{ raw: Uint8Array; useStream: boolean }> {
  const { preferCss, paperWidth, paperHeight, margin } = paperParams(req, override, declaresPaper);

  let res: any;
  const useStream = req.transfer === 'stream';
  try {
    res = await tab.send(
      'Page.printToPDF',
      {
        printBackground: req.printBackground ?? true,
        preferCSSPageSize: preferCss,
        ...(paperWidth !== undefined
          ? {
              paperWidth,
              paperHeight,
              scale: 1,
              marginTop: margin ?? 0,
              marginBottom: margin ?? 0,
              marginLeft: margin ?? 0,
              marginRight: margin ?? 0,
            }
          : {}),
        displayHeaderFooter: false,
        generateDocumentOutline: true,
        generateTaggedPDF: true,
        ...(req.pageRanges ? { pageRanges: req.pageRanges } : {}),
        transferMode: useStream ? 'ReturnAsStream' : 'ReturnAsBase64',
      },
      timeoutMs,
    );
  } catch (e) {
    if (timedOutRef.timedOut) {
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
  return { raw, useStream };
}

/**
 * The sheet, as printToPDF is finally told about it.
 *
 * The paper is in CSS whenever the engine wrote a rule for it, and otherwise
 * whenever the document declares one. Everything else -- a remote document,
 * which is navigated to rather than rewritten -- still goes through the inch
 * parameters, the one path left that Chromium quantizes.
 *
 * The negative margin is refused here rather than passed on: printToPDF rejects
 * it on all four sides, and the message belongs with the arithmetic that read
 * the value.
 */
function paperParams(
  req: RenderRequest,
  override: string | null,
  declaresPaper: boolean,
): { preferCss: boolean; paperWidth?: number; paperHeight?: number; margin?: number } {
  const preferCss = override !== null || (declaresPaper && !req.format);
  const margin = req.margin ? toInches(req.margin) : undefined;
  if (margin !== undefined && margin < 0) {
    throw new Error(
      `margin ${req.margin} is negative, and printToPDF refuses a negative page margin on all ` +
        `four sides. a negative margin bleeds content off the sheet, which is what @page margin does ` +
        `in a stylesheet if you need it.`,
    );
  }
  if (preferCss) return { preferCss, margin };

  // Remote fallback only. Transposing by hand is what Chromium's own `landscape`
  // parameter would have done, and that parameter is not sent: it is discarded
  // whenever preferCSSPageSize is set, and combining it with explicit dimensions
  // asks for a rotation twice.
  const paper = req.format ? FORMATS[req.format] : FORMATS.a4;
  const transposed = !!req.landscape;
  return {
    preferCss,
    margin,
    paperWidth: transposed ? paper[1] : paper[0],
    paperHeight: transposed ? paper[0] : paper[1],
  };
}

/** Loopback is always allowed: the engine's own work server answers on it. */
const LOOPBACK_ONLY = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * The origin the engine may talk to without it counting as the document asking
 * the network for something. The work server when there is one, loopback
 * otherwise: the fast path has no server of its own and still serves assets
 * from the document's own directory.
 */
function loopbackPattern(server: { origin: string } | undefined): RegExp {
  if (!server) return LOOPBACK_ONLY;
  return new RegExp(`^${server.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i');
}

/**
 * Whether the source can go to the frame as markup.
 *
 * Four things rule it out, and each rules out a different optimization: a
 * remote page has no markup to send, an image cap needs the page-side probe to
 * run against a real origin, relative assets need the work server to resolve
 * them, and `preferFastPath: false` is the caller asking for the other route.
 */
function canUseFastPath(
  req: RenderRequest,
  html: string | undefined,
  isRemote: boolean,
  relative: boolean,
): boolean {
  if (isRemote || html == null) return false;
  if (req.preferFastPath === false) return false;
  if (relative || req.maxImagePpi) return false;
  return true;
}

/**
 * What the pdf's document information will say.
 *
 * A flag beats the document's own meta tag, and an absent one falls through to
 * it. Read once here so the author, the subject and the keywords cannot end up
 * disagreeing about which source won.
 */
function pdfMeta(
  req: RenderRequest,
  docMeta: { author?: string; subject?: string; keywords?: string },
): { author: string; subject: string; keywords: string } {
  return {
    author: req.author?.trim() || docMeta.author || '',
    subject: req.subject?.trim() || docMeta.subject || '',
    keywords: req.keywords?.trim() || docMeta.keywords || '',
  };
}

/**
 * Function types get names for a second reason beyond readability: lizard's
 * TypeScript reader mis-measures a signature written across several lines, so a
 * parameter list split over five lines made `stageOne` measure as five lines
 * long and the gate stopped seeing it. One line, named types.
 */
type Repair = (pdf: Uint8Array) => Uint8Array;
type InsideRoot = (p: string) => boolean;

type LoadRequest = {
  tab: Tab;
  net: NetworkWatch;
  fastPath: boolean;
  override: string | null;
  html: string | undefined;
  srcUrl: string;
  source: string;
  timeoutMs: number;
  timedOutRef: { timedOut: boolean };
};

/**
 * A document that asked for a decision mid-render.
 *
 * Reported because it changes what the PDF means. A page that blocks on
 * `confirm()` and is then refused is a page whose script did not finish: whatever
 * the rest of the run then produced is whatever ran next, and the caller has no
 * way to know from the file alone that anything was interrupted.
 */
function dialogFindings(dialogs: number): Finding[] {
  if (!dialogs) return [];
  return [
    {
      code: 'dialog-dismissed',
      severity: 'warn',
      message:
        `the document opened ${dialogs} modal dialog${dialogs === 1 ? '' : 's'} ` +
        `(alert, confirm or prompt) and this renderer refused ${dialogs === 1 ? 'it' : 'them'}, ` +
        `because a print job has no user to answer. a script blocked on a decision ` +
        `never finished, so the pages after that point are whatever ran next.`,
    },
  ];
}

type NetworkWatch = {
  /** The status of the main document, once one has answered. */
  mainStatus(): number | undefined;
  /** Why the main document failed to load, if it did. */
  netError(): string | undefined;
  /** Record a failure the navigation itself reported, before any event fired. */
  noteNavigationError(message: string): void;
};

/**
 * Watch what the page asks the network for, and decide what it is allowed.
 *
 * Four subscriptions and a policy, which is more branching than belongs in the
 * middle of a function that is also holding a clock and a temp directory. The
 * main document is the only request whose failure matters enough to stop the
 * render; everything else is collected and reported afterwards, because a
 * missing image is a finding and a missing document is an error.
 *
 * Loopback is never blocked. Remote requests are, unless the caller allowed
 * them, and the first few are named so the reader knows which.
 */
/**
 * Answer anything that would otherwise stop the renderer, and notice when the
 * tab dies.
 *
 * Two subscriptions, both for the same reason: a page can wedge the print
 * pipeline in a way that produces no error event at all, and the only symptom
 * is that the deadline arrives with nothing to show for it.
 *
 * A document calling `alert()` -- which needs no permission and no user gesture
 * -- blocks the renderer until a dialog is handled. Nothing printed and nothing
 * was logged; the render simply ran out of time and the tab was torn down, which
 * closed the socket and produced `cdp socket closed`. That is an error naming
 * the transport rather than the document, and it is the one failure a caller
 * cannot act on. Refusing the dialog is also the right answer rather than the
 * polite one: a print job has no user to click the button.
 *
 * `Inspector.targetCrashed` covers the other silence. A tab killed by the
 * out-of-memory killer on a very large document reports nothing on the print
 * path, so the deadline was the only signal, and paying it in full says less
 * than the event does.
 */
type TabWatch = {
  /** False once the tab has crashed, so the caller can stop waiting for it. */
  alive(): boolean;
  /** How many modal dialogs the document opened and this renderer refused. */
  dialogs(): number;
};

function watchTab(tab: Tab): TabWatch {
  let crashed = false;
  let dialogs = 0;

  tab.on('Page.javascriptDialogOpening', () => {
    dialogs++;
    void tab.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  });
  void tab
    .send('Inspector.enable')
    .then(() => {
      tab.on('Inspector.targetCrashed', () => {
        crashed = true;
      });
    })
    .catch(() => {
      // Without the domain the deadline still applies. Nothing is lost but the
      // early signal, so this is not worth failing a render over.
    });

  return { alive: () => !crashed, dialogs: () => dialogs };
}

async function watchNetwork(
  tab: Tab,
  opts: {
    loopback: RegExp;
    allowNetwork: boolean;
    isRemote: boolean;
    srcUrl: string;
    blocked: string[];
    failedSubresources: { kind: string; url: string }[];
  },
): Promise<NetworkWatch> {
  const { loopback, allowNetwork, isRemote, srcUrl, blocked, failedSubresources } = opts;
  let mainStatus: number | undefined;
  let netError: string | undefined;

  await tab.send('Fetch.enable', {
    patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
  });
  tab.on('Fetch.requestPaused', (p) => {
    const url = String(p.request?.url ?? '');
    if (loopback.test(url)) {
      void tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      return;
    }
    const proceed = allowNetwork
      ? tab.send('Fetch.continueRequest', { requestId: p.requestId })
      : (blocked.length < MAX_BLOCKED_REPORTED && blocked.push(url),
        tab.send('Fetch.failRequest', {
          requestId: p.requestId,
          errorReason: 'BlockedByClient',
        }));
    void proceed.catch(() => {});
  });

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

  // The failure event carries no URL, only the request id, so the mapping has
  // to come from the request that started it.
  const requestUrls = new Map<string, string>();
  tab.on('Network.requestWillBeSent', (p) => {
    if (p.requestId && p.request?.url) requestUrls.set(p.requestId, p.request.url);
  });
  // A named function rather than an inline arrow: this is the branch that decides
  // whether a failed request stops the render or becomes a finding, and the
  // complexity gate counted the inline version as a breach of its own.
  // Early returns rather than a chain of `else if`, because the chain needed
  // three overlapping conditions to express and measured as a complexity
  // breach. Same four outcomes, in the order they are decided:
  //
  //   blocked by us      -> nothing; the finding says so already
  //   the main document  -> the render stops, once
  //   another document   -> a subframe that did not load
  //   anything else      -> a subresource, unless the tab was closing
  const recordFailure = (p: {
    requestId?: string;
    type?: string;
    blockedReason?: string;
    errorText?: string;
  }) => {
    if (p.blockedReason) return;
    const url = p.requestId ? requestUrls.get(p.requestId) : undefined;
    if (p.type === 'Document') {
      // `url === srcUrl` alone: srcUrl is always a string, so a missing url can
      // never equal it, and the original spelled out both halves of that.
      if (url === srcUrl && !netError) {
        netError = p.errorText;
        return;
      }
      failedSubresources.push({ kind: 'Subframe', url: url ?? p.errorText ?? '' });
      return;
    }
    if (isTeardownAbort(p.errorText)) return;
    failedSubresources.push({ kind: p.type ?? 'unknown', url: p.errorText ?? '' });
  };
  tab.on('Network.loadingFailed', recordFailure);

  return {
    mainStatus: () => mainStatus,
    netError: () => netError,
    // `Page.navigate` can fail before the failure event arrives, and its message
    // is the better one: it names the protocol error rather than a resource type.
    noteNavigationError: (message: string) => {
      netError ??= message;
    },
  };
}

/**
 * Everything read out of the page before it is printed: settle the fonts, run
 * the caller's own script, take the probe's answer, read the document's own meta
 * tags, cap the images and collect the findings.
 *
 * It is one function because the order is the contract. Fonts settle first so a
 * probe measures the layout the PDF is made from; the probe runs before the
 * image cap so it sees the same layout again; the meta tags are read before the
 * repairs that write them, so `--author` can be compared against what the
 * document said.
 *
 * `findings` is passed in rather than returned because these are diagnostics
 * about the render, not about the page: they belong in the one ordered list the
 * caller is building.
 */
async function readPage(
  tab: Tab,
  req: RenderRequest,
  timeoutMs: number,
  findings: Finding[],
): Promise<{
  probe: unknown;
  docMeta: { author?: string; subject?: string; keywords?: string };
  linkDescs: ReturnType<typeof parseLinkDescs>;
}> {
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
      { expression: req.beforePrint, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
  }

  const probe = await runPageProbe(tab, req, timeoutMs, findings);
  const docMeta = await readDocMeta(tab, timeoutMs);

  const capped = req.maxImagePpi ? await capImageResolution(tab, req.maxImagePpi, timeoutMs) : [];
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
      { expression: LINK_DESC_JS, returnByValue: true, awaitPromise: false },
      timeoutMs,
    )
    .then((r: { result?: { value?: unknown } }) => r.result?.value)
    .catch(() => undefined);

  return { probe, docMeta, linkDescs: parseLinkDescs(linkDescRaw) };
}

/**
 * A probe runs after the document is settled and before the print, so it sees
 * the same layout the PDF is made from. Its result is handed back untouched; if
 * it throws in the page, that is the caller's problem to notice rather than a
 * silent empty result, which is what an expression string returned last time.
 *
 * Reported, never swallowed. The first version returned `undefined` on failure,
 * which is indistinguishable from a probe that legitimately found nothing:
 * `wideGaps` called a helper that does not exist in the page, the probe came
 * back empty, and the tool printed its old sentence as though the document had
 * no wide gaps. It had eight. A probe that cannot run must say so.
 */
async function runPageProbe(
  tab: Tab,
  req: RenderRequest,
  timeoutMs: number,
  findings: Finding[],
): Promise<unknown> {
  if (!req.pageProbe) return undefined;
  const answer = await tab
    .send(
      'Runtime.evaluate',
      { expression: `(${req.pageProbe})()`, returnByValue: true },
      timeoutMs,
    )
    .catch((e: unknown) => ({ exceptionDetails: { text: String(e) } }));
  const thrown = (
    answer as {
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    } | null
  )?.exceptionDetails;
  if (!thrown) return (answer as { result?: { value?: unknown } } | null)?.result?.value;

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
  return undefined;
}

/**
 * The document's own meta tags, which are the default values for the pdf's.
 *
 * Read in the page because a `<meta name=...>` can be written by a script, and
 * a document that fills one in at load time means it. A malformed answer is
 * treated as no answer: the caller supplies the fallback either way.
 */
async function readDocMeta(
  tab: Tab,
  timeoutMs: number,
): Promise<{ author?: string; subject?: string; keywords?: string }> {
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
  try {
    return JSON.parse((stated as { result?: { value?: string } }).result?.value ?? '{}');
  } catch {
    return {};
  }
}

type PreparedSource = {
  src: Awaited<ReturnType<typeof resolveSource>>;
  srcUrl: string;
  fastPath: boolean;
  override: string | null;
  outsideRoot: RefusedRef[];
  server?: { origin: string; stop: () => void };
};

/**
 * Read the input, refuse what cannot be printed, decide how the browser will see
 * it, and start the work server if it needs one.
 *
 * The three decisions here are the ones that shape everything after: whether
 * there is markup to rewrite, whether the fast path can carry it, and where the
 * page will come from. They belong together because each one constrains the
 * next -- an override forces the slow path only if the rewrite cannot travel in
 * the document itself, and it cannot travel at all for a remote page.
 */
async function prepareSource(
  req: RenderRequest,
  dir: string,
  isRemote: boolean,
  findings: Finding[],
): Promise<PreparedSource> {
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

  const relative = hasRelativeAssets(src.html ?? '');
  // The fast path hands Chromium the source through setDocumentContent, which
  // takes the rewrite as readily as the original, so an override costs it
  // nothing: no temp directory, no static file server. A rewrite that forced
  // the slow path would have been a real price for an exact sheet.
  //
  // Remote sources carry `html: ''` as a sentinel, which reads exactly like "a
  // document that declares no page" and would be rewritten into an @page rule
  // for markup that is never loaded -- the document is navigated to, not
  // served. So the decision is made here, where being remote is knowable.
  const override = isRemote ? null : pageOverride(src.html, req);
  const fastPath = canUseFastPath(req, src.html, isRemote, relative);

  let outsideRoot: RefusedRef[] = [];
  let server: { origin: string; stop: () => void } | undefined;
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

  return { src, srcUrl, fastPath, override, outsideRoot, server };
}

/**
 * What a browser will do with a selection over this page, as one finding or none.
 *
 * Firefox's PDF.js keeps a word gap inside the current text item only between
 * 0.102 and 0.6 em; outside that it ends the item and the gap becomes a
 * highlight of its own, which is why a justified paragraph selects as a row of
 * separate boxes. Nothing in the file can change the gap, so it is reported
 * rather than repaired.
 *
 * The reasons are collected in one place and joined, because they have
 * different causes and different fixes: a gap past 0.6 em, a stretched word
 * space and a jump to the next column are three problems that happen to share a
 * symptom, and a reader who is told only that selection breaks will look in the
 * wrong place.
 */
function selectionFinding(pdf: Uint8Array): Finding | null {
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
    const why = selectionReasons(flow);
    // A stream this could not read takes its glyphs out of every count above while the
    // counts still read as a document total, so say how much of the document the numbers
    // come from rather than letting "at least" go unsaid.
    const from =
      flow.read < flow.streams
        ? ` Measured on ${flow.read} of ${flow.streams} text streams; the rest were not readable.`
        : '';
    return {
      code: 'selection-fragmented',
      severity: 'warn',
      message:
        `a browser ends a text item at any gap over 0.6 em and draws one highlight ` +
        `box per item, so selection breaks here: ${why.join('; ')}.${from}`,
    };
  }
  return null;
}

/**
 * Put the document in front of the browser and refuse to print it if it did not
 * arrive.
 *
 * Two ways in, because there are two ways to have a document. The fast path
 * hands the markup straight to the frame, which needs no origin and no server;
 * everything else navigates to a URL and waits for the load event, because a
 * page with remote assets will not finish without them.
 *
 * The refusals live here rather than at the call site because they are about
 * this step: a navigation that failed, and a server that answered with an error
 * page. Printing either would produce a PDF of a Chromium error message and
 * report it as a clean render.
 */
async function loadDocument(opts: LoadRequest): Promise<void> {
  const { fastPath } = opts;
  if (fastPath) await loadIntoFrame(opts);
  else await loadByNavigation(opts);
  refuseUnloaded(opts);
}

/**
 * The fast path: hand the markup straight to the frame.
 *
 * No origin and no server, which is why it exists -- but only documents with no
 * remote assets and no image cap qualify, and `canUseFastPath` is what decides
 * that.
 */
async function loadIntoFrame(opts: LoadRequest): Promise<void> {
  const { tab, override, html } = opts;
  const frameId = (await tab.send('Page.getFrameTree')).frameTree.frame.id;
  await tab.send('Page.setDocumentContent', { frameId, html: override ?? html! });
}

/**
 * Everything else: navigate to a URL and wait for the load event.
 *
 * The wait is a race against the caller's deadline, and the deadline's own
 * message is the one worth giving -- "navigation did not finish within 30000ms"
 * says more than whatever Chromium threw on the way out.
 */
async function loadByNavigation(opts: LoadRequest): Promise<void> {
  const { tab, net, srcUrl, timeoutMs, timedOutRef } = opts;
  const loaded = tab.once('Page.loadEventFired');
  await tab.send('Page.navigate', { url: srcUrl }).catch((e: Error) => {
    if (/ERR_/.test(e.message)) net.noteNavigationError(e.message);
  });
  await Promise.race([
    loaded.promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`__deadline__`);
    }),
  ]).catch((e: Error) => {
    throw new Error(
      e.message === '__deadline__' && timedOutRef.timedOut
        ? `navigation did not finish within ${timeoutMs}ms`
        : e.message,
    );
  });
  loaded.cancel();
}

/**
 * Refuse to print a document that did not arrive.
 *
 * Both cases are about this step rather than the page's content: a navigation
 * that failed, and a server that answered with an error page. Printing either
 * would produce a PDF of a Chromium error message and report it as a clean
 * render.
 */
function refuseUnloaded(opts: LoadRequest): void {
  const { net, source } = opts;
  const netErr = net.netError();
  if (netErr) {
    throw new Error(`could not load ${source}: ${netErr}`);
  }
  const status = net.mainStatus();
  if (status !== undefined && (status < 200 || status >= 300)) {
    throw new Error(`${source} returned HTTP ${status}; refusing to print the error page`);
  }
}

/**
 * Whether the loaded document declares a page size of its own.
 *
 * The static read of the markup is the answer whenever there is markup. It is
 * not the answer for a remote document, or for one that writes its `@page` rule
 * from a script, so the live document is asked as well -- and only when the
 * request has not already said what the paper is, because a flag settles it
 * without asking anyone.
 */
async function probeDeclaresPaper(
  tab: Tab,
  html: string | undefined,
  req: RenderRequest,
  timeoutMs: number,
): Promise<boolean> {
  if (html) return declaredPageSize(html) !== null;
  if (req.format || !req.url) return false;
  const probe = await tab
    .send('Runtime.evaluate', { expression: PAGE_SIZE_PROBE, returnByValue: true }, timeoutMs)
    .catch(() => null);
  return probe?.result?.value === true;
}

/** Walks the live stylesheets for an `@page` rule that carries a size. */
const PAGE_SIZE_PROBE = `(() => {
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules || []) if (/@page/i.test(r.cssText || "") && /\\bsize\\s*:/i.test(r.cssText || "")) return true;
  }
  return false;
})()`;

/** The name the pdf will carry: the file it came from, else its host. */
function pdfTitleFor(req: RenderRequest): string {
  if (req.path) return basename(req.path);
  if (req.url) return new URL(req.url).hostname;
  return 'document';
}

/**
 * Why selection fragments on this page, in the order a reader would look for
 * them.
 *
 * A gap past 0.6 em ends a text item, but a stretched word space and a jump to
 * the next column have nothing to do with each other and are fixed by different
 * CSS. Told only that "selection breaks", a reader checks the wrong one first.
 */
function selectionReasons(flow: NonNullable<ReturnType<typeof textFlow>>): string[] {
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
  return why;
}

/**
 * Run one repair and record the refusal if it did not leave a valid file.
 *
 * Every stage of the pipeline goes through this except the two that rewrite
 * content streams on purpose, which prove themselves against the geometry
 * instead. A repair that breaks the file is discarded and named: a silent
 * fallback is how a transform comes to look like it works when it does not.
 */
function gated(
  bytes: Uint8Array,
  label: string,
  repair: Repair,
  rejected: Set<string>,
  findings: Finding[],
): Uint8Array {
  const attempt = repairOrKeep(bytes, repair);
  if (attempt.failures.length) {
    rejected.add(label);
    findings.push(rejectedRepair(label, attempt.failures));
  }
  return attempt.pdf;
}

function rejectedRepair(label: string, failures: string[]): Finding {
  const named = label === 'title stamp' ? 'title stamp' : `${label} fix`;
  return {
    code: 'repair-rejected',
    severity: 'warn',
    message:
      `the ${named} was discarded because it did not leave a valid pdf: ` +
      `${failures.join('; ')}. the file is what the previous stage produced, ` +
      `with this fix not applied.`,
  };
}

/**
 * Chromium tags both a `figure` element and the image inside it as a figure and
 * describes only the image, so a grouping is described as a picture of nothing.
 * Each image keeps its own description.
 */
function repairFigures(
  described: Uint8Array,
  rejected: Set<string>,
  findings: Finding[],
): Uint8Array {
  const redundant = redundantFigureCount(described);
  if (redundant === 0) return described;
  const attempt = repairOrKeep(described, fixRedundantFigures);
  if (attempt.failures.length) {
    // Recorded like every other rejection. Nothing reads `figure-role` out of the set
    // today, but the set reads as a complete record of what was discarded and a reader
    // would otherwise assume a rejected fix was an accepted one.
    rejected.add('figure-role');
    findings.push(rejectedRepair('figure-role', attempt.failures));
    return described;
  }
  findings.push({
    code: 'figure-role-corrected',
    severity: 'info',
    message:
      `${redundant} figure ${redundant === 1 ? 'element' : 'elements'} ` +
      `tagged as a grouping rather than a figure, because chromium tags both the ` +
      `figure element and the image inside it as a figure and describes only the ` +
      `image. each image keeps its own description.`,
  });
  return attempt.pdf;
}

/** A document titled after its own file gets the file's name stamped in. */
function repairTitle(
  described: Uint8Array,
  pdfTitle: string,
  rejected: Set<string>,
  findings: Finding[],
): Uint8Array {
  const current = readDocInfo(described).title ?? '';
  if (!current || !isVolatileTitle(current) || current === pdfTitle) return described;
  const attempt = repairOrKeep(described, (p) => setDocTitle(p, pdfTitle));
  if (attempt.failures.length) {
    rejected.add('document title');
    findings.push(rejectedRepair('document title', attempt.failures));
    return described;
  }
  return attempt.pdf;
}

function ligatureSpanFinding(
  spans: { seen: number; stripped: number; kept: number },
  changed: boolean,
): Finding {
  return {
    code: 'ligature-spans',
    severity: 'info',
    message: changed
      ? `removed ${spans.stripped} of ${spans.seen} marked-content spans carrying ` +
        `/ActualText, each of which ended a text item at every ligature. each was ` +
        `removed only because /ToUnicode already gave the same characters, so the ` +
        `extracted text is unchanged.${keptSpans(spans.kept)}`
      : spans.stripped > 0
        ? `found ${spans.stripped} removable /ActualText spans and the file came back ` +
          `unchanged, so nothing was removed. this is a bug in letterpress, not a ` +
          `finding about the document.`
        : `left all ${spans.seen} /ActualText spans in place: /ToUnicode does not ` +
          `resolve them to the same text, so each is the only copy of it.`,
  };
}

/**
 * The tail of a message, kept out of the template that carries it.
 *
 * These were `${cond ? `nested template` : ''}` inside another template, which is
 * valid TypeScript and unreadable besides: a parser counting braces by hand
 * loses step at the inner backtick and reports the enclosing function as ending
 * a hundred lines early. The complexity gate measured this file that way and
 * called a 647-line function 504 lines, so the shape was worth changing for the
 * gate as well as for the reader.
 */
function refusedRuns(refused: number): string {
  return refused ? `; ${refused} left alone as not simple enough to rewrite` : '';
}

function keptSpans(kept: number): string {
  return kept ? ` ${kept} kept, being the only place their text appears.` : '';
}

function namedRoot(root: string | undefined): string {
  return root ? `the root you named (${absRoot(root)})` : "the document's own directory";
}

function metadataFindings(
  docMeta: { author?: string; subject?: string },
  req: RenderRequest,
  rejected: Set<string>,
): Finding[] {
  const out: Finding[] = [];
  if (docMeta.author && !req.author?.trim() && !rejected.has('metadata')) {
    out.push({
      code: 'metadata-authored',
      severity: 'info',
      message: `wrote "${docMeta.author}" as the pdf author, from the document's own meta tag. pass --author to override it.`,
    });
  }
  // Guarded the way the author branch above is. `--subject "Q3 report"` beats the
  // document's own meta tag, and the gate may have rejected the whole metadata repair,
  // so without this the finding names a value that is not in the file.
  if (docMeta.subject?.trim() && !req.subject?.trim() && !rejected.has('metadata')) {
    out.push({
      code: 'metadata-subject',
      severity: 'info',
      message: `wrote "${docMeta.subject}" as the pdf subject, from the document's own meta tag.`,
    });
  }
  return out;
}

function assetFindings(outsideRoot: RefusedRef[], req: RenderRequest): Finding[] {
  const out: Finding[] = [];
  const outside = outsideRoot.filter((o) => o.why === 'outside-root');
  const overDocument = outsideRoot.filter((o) => o.why === 'document');
  if (overDocument.length) {
    out.push({
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
    out.push({
      code: 'asset-outside-root',
      severity: 'warn',
      url: outside[0]!.abs,
      message:
        `${outside.length} referenced ${outside.length === 1 ? 'path is' : 'paths are'} outside ` +
        `${namedRoot(req.root)}, ` +
        `so ${outside.length === 1 ? 'it was' : 'they were'} not read:\n${listed}\n` +
        `pass --root naming a directory that contains ` +
        `${outside.length === 1 ? 'it' : 'them'} to allow it.`,
    });
  }
  return out;
}

function networkFindings(
  blocked: string[],
  failedSubresources: { kind: string; url: string }[],
  req: RenderRequest,
): Finding[] {
  const out: Finding[] = [];
  for (const url of blocked) {
    out.push({
      code: 'network-blocked',
      severity: 'warn',
      url,
      message: `blocked a remote request to ${url}. Pass --allow-network to permit it, or inline the asset.`,
    });
  }
  if (failedSubresources.length) {
    const kinds = [...new Set(failedSubresources.map((f) => f.kind))];
    const images = failedSubresources.filter((f) => f.kind === 'Image').length;

    const listed = [...new Set(failedSubresources.map((f) => f.url))]
      .slice(0, 5)
      .map((u) => `  ${u}`)
      .join('\n');
    out.push({
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
    out.push({
      code: 'url-render-blocked',
      severity: 'error',
      message: `rendering a remote URL blocks its own subresources and usually the document itself. Set allowNetwork to render ${req.url}.`,
    });
  }
  return out;
}

function fontMetricFindings(pdf: Uint8Array): Finding[] {
  const unresolved = unresolvedFontMetrics(pdf);
  if (!unresolved.length) return [];
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
  return [
    {
      code: 'font-metrics',
      severity: 'warn',
      message:
        `${unresolved.length} font descriptor${unresolved.length === 1 ? ' still carries' : 's still carry'} a negative cap height ` +
        `(${named.slice(0, 3).join(', ')}). ` +
        `The PDF specification calls a negative CapHeight an error a viewer may refuse to render text over. ` +
        `There is nothing to derive the metric from, so the value was left as produced. ` +
        `Embedding the font as a file rather than relying on a system face usually removes it.`,
    },
  ];
}
