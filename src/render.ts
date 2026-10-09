import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { Browser, type Tab } from "./browser.ts";
import { fixFontDescriptors, unresolvedFontMetrics } from "./fontdesc.ts";
import { addMetadata } from "./meta.ts";
import { fixToUnicode } from "./tounicode.ts";
import { LINK_DESC_JS, fixLinkDescs, parseLinkDescs } from "./linkdesc.ts";
import { repairOrKeep } from "./verify.ts";
import { audit } from "./lint.ts";
import { declaredPageMargin, declaredPageSize, inspect, pageRules, type PdfInfo } from "./pdf.ts";

/**
 * Paper sizes in inches, as CDP expects. Metric sizes are exact conversions of
 * the millimetre dimensions, so `--format a4` and `@page { size: a4 }` produce
 * the same MediaBox instead of differing by a third of a millimetre.
 */
export const FORMATS = {
  a3: [11.6929, 16.5354],
  a4: [8.2677, 11.6929],
  a5: [5.8268, 8.2677],
  legal: [8.5, 14],
  letter: [8.5, 11],
  tabloid: [11, 17],
} as const;

export type Format = keyof typeof FORMATS;

/** Resolve a caller-supplied format name, rejecting anything not in the table. */
export function parseFormat(value: unknown): Format | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`format must be a string, got ${typeof value}`);
  const name = value.trim().toLowerCase();
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so "toString" and
  // "__proto__" both passed the check and then reached FORMATS[name] as a
  // function, which crashed the render instead of naming the bad input.
  if (!Object.hasOwn(FORMATS, name)) {
    throw new Error(
      `unknown format "${value}". try: ${Object.keys(FORMATS).join(", ")}`,
    );
  }
  return name as Format;
}

export type Finding = {
  code: string;
  severity: "error" | "warn" | "info";
  message: string;
  url?: string;
};

export type RenderRequest = {
  html?: string;
  path?: string;
  url?: string;
  format?: Format;
  landscape?: boolean;
  /** CSS length, e.g. "15mm". Only consulted when format is set. */
  margin?: string;
  /** Default false: remote http(s) requests are blocked and reported. */
  allowNetwork?: boolean;
  printBackground?: boolean;
  settleMs?: number;
  timeoutMs?: number;
  /**
   * Cap on the effective resolution of raster images, in pixels per inch.
   * Chromium prints images at their full stored resolution: a 4000px photo at
   * 180mm lands at 565ppi and produces a PDF larger than the source file. 300
   * is the print convention. 0 disables downsampling.
   */
  maxImagePpi?: number;
  /**
   * Document author, written to the PDF's information dictionary and to an XMP
   * packet generated from it. Overrides a `<meta name="author">` the document
   * declares. Omitted means nothing is written rather than something guessed.
   */
  author?: string;
  /** Subject, same treatment as author. Overrides the document's own meta tag. */
  subject?: string;
  /** Keywords, same treatment as author. Overrides the document's own meta tag. */
  keywords?: string;
  /**
   * Extra JavaScript evaluated in the page after fonts resolve and before the
   * print. Used by the image cap; exposed for callers who need to settle a
   * document that only mutates on interaction.
   */
  beforePrint?: string;
  /**
   * Render only these 1-based pages, e.g. "3-5". Verified to select exactly
   * those pages while leaving `counter(pages)` correct: pages "1-2" of a
   * 3-page document still prints "page 2 of 3".
   *
   * Note that `info.pages` then reports how many pages were emitted, not the
   * document's length, so a viewer must not present it as a total.
   */
  pageRanges?: string;
  /**
   * Drain the PDF from the CDP stream instead of a single base64 JSON string.
   * Worth it for large documents: a 400-page render encodes to about 22MB of
   * base64, which is one enormous allocation and one enormous JSON parse.
   */
  transfer?: "base64" | "stream";
  /**
   * Inject the document with Page.setDocumentContent and skip the work server.
   * Only safe when the document references no relative assets, because
   * setDocumentContent gives the page no origin to resolve them against: an
   * `<img src="logo.png">` resolves to naturalWidth 0. The request is honoured
   * automatically when a relative-reference scan comes back clean, and ignored
   * otherwise, so this is a hint rather than a contract.
   */
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

/**
 * Parse a CSS length into inches. CSS uses 96 pixels per inch.
 *
 * Every absolute unit is here, and a leading minus: a negative margin is valid
 * CSS, and the regex without one rejected it as unparseable. The two units it
 * was missing are q (a quarter millimetre) and pc (picas).
 *
 * Relative units are refused with the reason rather than a bare rejection. em,
 * rem, ex and ch resolve against a font size, and vw and vh against a viewport,
 * so neither is knowable before the page has been laid out. printToPDF wants
 * inches. Guessing would be worse than saying so.
 */
const ABSOLUTE_UNITS: Record<string, number> = {
  px: 96, in: 1, cm: 2.54, mm: 25.4, q: 101.6, pt: 72, pc: 6,
};

const RELATIVE_UNITS = ["em", "rem", "ex", "ch", "vw", "vh", "vmin", "vmax", "%", "lh", "rlh", "cap", "ic"];

export function toInches(len: string): number {
  const raw = len.trim();
  const m = raw.match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m) throw new Error(`margin "${len}" is not a css length: use a number with a unit, such as 15mm, 1in, 2cm, 40pt, or a bare 0.`);
  const unit = (m[2] || "px").toLowerCase();
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
  // CSS allows a bare zero and nothing else. "20" was being read as 20px, which
  // is a margin nobody asked for, and it disagreed with the server, which
  // refuses a bare number.
  if (!m[2] && value !== 0) {
    throw new Error(
      `margin "${len}" needs a unit: a bare number is not a css length, only a bare 0 is. ` +
      `use px, pt, mm, cm or in.`,
    );
  }
  return value / ABSOLUTE_UNITS[unit];
}

export function fileUrl(path: string): string {
  const abs = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  return "file://" + abs.split("/").map(encodeURIComponent).join("/");
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.05;

/**
 * Report every place the request and the document disagree.
 *
 * Chromium honours the document's own @page whenever preferCSSPageSize is on,
 * which is the default so that @page is authoritative. The consequence is that
 * --landscape and --margin are silently dropped for any document that declares
 * a page size. Silence there is the worst outcome available: the caller asked
 * for landscape and received portrait.
 */
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
        code: "page-size-override",
        severity: "info",
        message: `request asked for ${req.format}${req.landscape ? " landscape" : ""}, but the document declares @page size: ${declared}. The request wins: the declaration is stripped from the document and the paper is set from the flag.`,
      });
    }
  }

  if (declared && req.landscape) {
    const landscapeDeclared = /\blandscape\b/.test(declared) ||
      (() => {
        const d = declared.match(/([\d.]+)\s*(mm|cm|in)/gi)?.map(toInches) ?? [];
        return d.length >= 2 && d[0] > d[1];
      })();
    if (!landscapeDeclared) {
      // Either --format is also present, in which case the request wins and
      // landscape is applied as transposed paper, or it is not, in which case
      // the document's own orientation stands and the caller needs to know.
      findings.push(req.format
        ? {
            code: "orientation-overridden",
            severity: "info",
            message: `the document declares @page size: ${declared}, which is portrait. --format with --landscape takes precedence, so the paper has been transposed rather than the document's own page size used.`,
          }
        : {
            code: "orientation-ignored",
            severity: "error",
            message: `--landscape had no effect: the document declares @page size: ${declared}, and a document's own @page wins, so the PDF is portrait. For landscape, either add --format a4 (which takes precedence and transposes the paper), or write "@page { size: a4 landscape }" in the stylesheet.`,
          });
    }
  }

  if (declaredMargin && req.margin) {
    findings.push({
      code: "margin-ignored",
      severity: "warn",
      message: `--margin ${req.margin} was ignored: the document declares @page margin: ${declaredMargin}, and a document's own @page wins. Change the margin in the stylesheet, or drop the @page margin rule.`,
    });
  }

  return findings;
}

/**
 * Redraw any image whose effective resolution exceeds the cap into a canvas at
 * the capped size, and point the element at the result.
 *
 * Done in the page because that is where the decoded bitmap and the laid-out
 * size both exist. Resizing the element instead would only change the display
 * size, not the pixels Chromium embeds.
 */
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

  const res = await tab.send("Runtime.evaluate", { expression, returnByValue: true }, timeoutMs);
  const raw = res?.result?.value;
  if (raw == null) return [];
  let entries: Array<{ from: number; to: number; ppi: number; url: string }>;
  try { entries = JSON.parse(raw); } catch { return []; }
  if (!entries.length) return [];

  // A file:// or cross-origin image taints the canvas, so toDataURL throws and
  // the whole expression returns nothing. Retry one image at a time with the
  // CORS attribute set, and keep whatever succeeds.
  if (entries.length && raw === undefined) {
    const singles: typeof entries = [];
    for (const img of await tab.send("Runtime.evaluate", {
      expression: "Array.from(document.images).map(i => i.currentSrc || i.src).join('\\u0000')",
      returnByValue: true,
    }).then((r: any) => String(r?.result?.value ?? "").split("\u0000"))) {
      const one = await tab.send("Runtime.evaluate", {
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
      }, timeoutMs).catch(() => null);
      const v = one?.result?.value;
      if (v && v !== "null") { try { singles.push(JSON.parse(v)); } catch { /* skip this image */ } }
    }
    entries = singles;
  }

  if (!entries.length) return [];

  // Swap the src, then wait for the replacement bitmap to decode.
  await tab.send("Runtime.evaluate", {
    expression: `(() => {
      const swap = ${JSON.stringify(entries.map((e) => e.url))};
      let i = 0;
      for (const img of document.images) { if (swap[i]) img.src = swap[i++]; }
      return true;
    })()`,
    returnByValue: true,
  }, timeoutMs);
  await tab.send("Runtime.evaluate", {
    expression: "Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)",
    awaitPromise: true, returnByValue: true,
  }, timeoutMs);

  return entries.map(({ from, to, ppi }) => ({ from, to, ppi }));
}

/**
 * Copy the images a document references into the work directory so they can be
 * served over loopback alongside it.
 *
 * Paths are resolved relative to the source document and must land inside the
 * directory the caller named; an HTML file that references ../../etc/passwd as
 * an image must not become a way to read outside the workspace.
 */
/**
 * Copy the assets a document references into the work directory, mirroring their
 * relative paths so the served document resolves them with no rewriting at all.
 *
 * An earlier version flattened every filename and then rewrote the document text
 * to match. Both halves were wrong: flattening made `sub/hide.css` and
 * `sub_hide.css` collide into one file, and rewriting the whole document changed
 * occurrences of a filename inside prose and inside scripts. Mirroring removes
 * both problems rather than working around them.
 */
export async function stageAssets(html: string, source: string, dir: string): Promise<void> {
  if (!html || /^https?:/i.test(source)) return;
  const base = source.startsWith("/") ? dirname(source) : process.cwd();
  const written = new Set<string>();

  const consider = async (ref: string) => {
    const clean = ref.trim().split(/[?#]/)[0];
    if (!clean) return;
    if (/^(?:https?:|data:|blob:|file:|#|mailto:|\/\/)/i.test(clean)) return;
    const from = isAbsolute(clean) ? clean : resolve(base, clean);
    // An HTML file that references ../../etc/passwd as an image must not become
    // a way to read outside the document's own directory.
    if (!from.startsWith(base + "/") && from !== base) return;

    const rel = normalize(clean).replace(/^(\.\.(\/|$))+/, "");
    if (!rel || rel.startsWith("..")) return;
    const target = join(dir, rel);
    if (!target.startsWith(dir + "/") || written.has(target)) return;

    let bytes: Buffer;
    try { bytes = Buffer.from(await Bun.file(from).arrayBuffer()); } catch { return; }
    if (!bytes.length) return;
    await Bun.write(target, bytes);
    written.add(target);
  };

  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) await consider(m[1]);
  for (const m of html.matchAll(/(?:src|href)\s*=\s*([^\s>]+)/gi)) await consider(m[1].replace(/["']/g, ""));
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of m[1].split(",")) await consider(candidate.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) await consider(m[1]);
  for (const m of html.matchAll(/@import\s+["']([^"']+)["']/gi)) await consider(m[1]);
}

/**
 * True when the document references a file the browser would have to resolve
 * against a base URL: a relative src or href, and not a scheme or a fragment.
 *
 * Such a document cannot be printed through Page.setDocumentContent, which
 * serves the HTML with no origin, so this gates the fast path.
 */
export function hasRelativeAssets(html: string): boolean {
  // Quoted attributes, unquoted attributes, srcset, and CSS url() which covers
  // background-image, @import and @font-face src. Missing any of these meant a
  // document silently lost its image: the scan said "nothing relative here", the
  // fast path was taken, and Page.setDocumentContent resolved the reference
  // against about:blank where nothing exists.
  if (/(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|file:|#|mailto:|\/\/)[^"']/i.test(html)) return true;
  if (/(?:src|href)\s*=\s*(?!["'])(?!https?:|data:|blob:|file:|#|mailto:|\/\/)[^\s>]+/i.test(html)) return true;
  if (/\bsrcset\s*=/i.test(html)) return true;
  return /url\(\s*(?!["']?(?:https?:|data:|blob:|file:|#|\/\/))\s*["']?[^)'"\s]/i.test(html);
}

/**
 * Read a CDP stream handle to completion.
 *
 * IO.read does not set eof on a read that exhausts the buffer, so a document
 * smaller than the chunk size comes back with eof false and a short payload.
 * The only safe test is to keep reading until eof or until a read yields nothing.
 */
export async function drainStream(
  tab: Tab,
  handle: string,
  { chunkSize = 262_144, timeoutMs }: { chunkSize?: number; timeoutMs: number },
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (let guard = 0; guard < 100_000; guard++) {
    const chunk = await tab.send("IO.read", { handle, size: chunkSize }, timeoutMs);
    if (!chunk.data) break;
    parts.push(Buffer.from(chunk.data, "base64"));
    if (chunk.eof) break;
  }
  await tab.send("IO.close", { handle }).catch(() => {});
  return new Uint8Array(Buffer.concat(parts));
}

let workDirCounter = 0;

/**
 * Reject input that is not HTML, before it reaches Chromium.
 *
 * Chromium will happily print a JPEG: it decodes the bytes as a broken document
 * and lays the binary out as text, producing a full page of mojibake that pdftotext
 * recovers verbatim. Measured: a 200x150 JPEG rendered to one A4 page of
 * "PNG IHDR..." text, exit 0, with a summary line that reads like success. A typo'd
 * extension produced a confidently reported broken document.
 *
 * The sniff is deliberately narrow. It looks for a byte signature, not for the
 * absence of "<", because plenty of valid documents open with a comment, a doctype
 * with leading whitespace, or nothing at all.
 */
function looksBinary(html: string): string | undefined {
  const head = html.slice(0, 1024);
  // A NUL byte is the classic marker, and no text encoding of HTML contains one.
  if (head.includes("\u0000")) return "it contains a null byte";
  // Signatures that mean the bytes are a different format entirely.
  const signatures: [RegExp, string][] = [
    [/^\s*%PDF-/, "it is a PDF"],
    [/^\s*[\u0080-\u00ff]{0,4}\xff[\u00d8\u00e0]/, "it is a JPEG"],
    [/^\s*\x89PNG\r?\n/, "it is a PNG"],
    [/^\s*GIF8[79]a/, "it is a GIF"],
    [/^\s*\x1f\x8b/, "it is gzip"],
    [/^\s*PK\x03\x04/, "it is a zip"],
    [/^\s*RIFF.{4}WEBP/, "it is a WebP"],
    [/^\s*BM/, "it is a BMP"],
    [/^\s*\x00\x00\x01\x00/, "it is an icon"],
  ];
  for (const [re, what] of signatures) if (re.test(head)) return what;
  return undefined;
}

async function resolveSource(req: RenderRequest, dir: string): Promise<{ html: string; url: string; source: string }> {
  // Validate before anything else. An unrecognised format used to reach
  // FORMATS[x] and throw a TypeError from deep inside the precedence check,
  // which is a crash, not a diagnosis.
  req.format = parseFormat(req.format);
  if (req.html != null) {
    // Chromium will not print a string, and about:blank gives the document no
    // origin for relative assets, so the HTML becomes a real file. The work
    // server below is what actually loads it.
    await Bun.write(join(dir, "input.html"), req.html);
    return { html: req.html, url: `${dir}/input.html`, source: "html" };
  }
  if (req.path) {
    const abs = req.path.startsWith("/") ? req.path : `${process.cwd()}/${req.path}`;
    // Copy the source into the work directory so it is served, not opened from
    // its original location: relative assets resolve against the served copy.
    const html = await Bun.file(abs).text();
    await Bun.write(join(dir, "input.html"), html);
    return { html, url: abs, source: abs };
  }
  if (req.url) return { html: "", url: req.url, source: req.url };
  throw new Error("render needs one of: html, path, url");
}

/**
 * Serve the work directory over loopback so the document and its images share
 * an origin.
 *
 * This is not a convenience. A file:// image taints the canvas, so toDataURL
 * throws and image downsampling becomes impossible; a document loaded over
 * http://127.0.0.1 can draw that same image and read it back. It also means
 * relative asset paths resolve, and it keeps Chromium's own file access out of
 * the picture. Bound to loopback with a random port and stopped with the render.
 */
async function serveWorkDir(dir: string): Promise<{ origin: string; stop: () => void }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 10,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const name = path === "/" ? "input.html" : decodeURIComponent(path.slice(1));
      // Confine to the work directory: a request must not be able to walk out.
      const resolved = join(dir, name);
      if (!resolved.startsWith(dir)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(resolved);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => { server.stop(true); },
  };
}

/**
 * Make two runs of the same input byte-identical when SOURCE_DATE_EPOCH is set.
 *
 * Chromium varies two things between runs: /CreationDate, and the document
 * /Title, which it takes from the page URL. The work server runs on a random
 * port, so the title differs even with a fixed clock. Both are rewritten here
 * rather than suppressed, because the title carries provenance a reader may
 * want.
 *
 * Nothing changes when the variable is absent, so ordinary output keeps the
 * timestamp and title Chromium produced.
 */
function stampPdf(pdf: Uint8Array, fallbackTitle: string): Uint8Array {
  const text = new TextDecoder("latin1").decode(pdf);
  const out = new Uint8Array(pdf);
  const edits: Array<[number, number, string]> = [];

  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) {
    const date = new Date(Number(epoch) * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const pdfDate = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    for (const m of text.matchAll(/D:\d{14}[+\-Z][\d'Z]{0,5}/g)) {
      if (m.index !== undefined) edits.push([m.index, m[0].length, pdfDate]);
    }
    // The XMP packet carries the same two timestamps in ISO 8601, and pinning
    // only the PDF form left the document disagreeing with itself: the
    // information dictionary said the pinned epoch while `xmp:CreateDate` said
    // the wall clock, so two renders a second apart still differed byte for byte
    // and SOURCE_DATE_EPOCH did not make the output reproducible.
    //
    // Measured: with the epoch set, a pair of renders a second apart differed at
    // `<xmp:CreateDate>2026-10-05T08:38:49` against `...:50`. Both are 19
    // characters, so the fixed-width edit that keeps every offset valid still
    // holds.
    const iso = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
      `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    for (const m of text.matchAll(/<(xmp:(?:CreateDate|ModifyDate))>[^<]{0,40}<\/\1>/g)) {
      if (m.index === undefined) continue;
      const open = m[0].indexOf(">") + 1;
      // The value runs from just after the opening tag to the start of the
      // closing one. Deriving that as `length - open - lastIndexOf` gives zero,
      // because the closing tag is at the end: the edit then had a zero-length
      // slot and silently wrote nothing, which is why the packet kept the wall
      // clock while the dictionary was correctly pinned.
      const closeAt = m[0].lastIndexOf("</");
      edits.push([m.index + open, closeAt - open, iso]);
    }
  }

  // Chromium titles the document from the page URL, and which URL depends on how
  // it was loaded: the work server's loopback address with a random port,
  // "about:blank" when setDocumentContent installed it, or the remote address.
  // A document with no <title> therefore came out titled
  // "127.0.0.1:40263/input.html", with a different random port every run. That
  // only got rewritten when SOURCE_DATE_EPOCH was set, so it was normal output.
  // It is fixed unconditionally now; a document that declares its own title is
  // left alone because it does not match.
  const volatileTitle = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\S*|^about:blank$/i;
  for (const m of text.matchAll(/\/Title \(((?:[^()\\]|\\.)*)\)/g)) {
    if (m.index === undefined) continue;
    const title = m[1];
    if (!volatileTitle.test(title)) continue;
    edits.push([m.index + "/Title (".length, title.length, fallbackTitle]);
  }

  // Patch from the end so earlier offsets stay valid.
  for (const [at, length, value] of edits.sort((a, b) => b[0] - a[0])) {
    // Truncated to the slot. A longer replacement used to be written past the
    // end of the title and into the rest of the file, which is exactly the
    // corruption the fixed-width design exists to prevent. The old constant was
    // short enough never to reach it, so nothing caught it.
    const fit = value.slice(0, length);
    for (let i = 0; i < fit.length; i++) out[at + i] = fit.charCodeAt(i);
    // Pad with spaces when the replacement is shorter: lengths must not change
    // or every byte offset after it would shift and corrupt the file.
    for (let i = fit.length; i < length; i++) out[at + i] = 0x20;
  }
  return out;
}

export async function render(browser: Browser, req: RenderRequest): Promise<RenderResult> {
  const started = Bun.nanoseconds();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = process.env.TMPDIR ?? "/tmp";
  const dir = `${tmp}/letterpress-${process.pid}-${workDirCounter++}`;
  const findings: Finding[] = [];
  const blocked: string[] = [];
  // Subresources that failed to load. A missing stylesheet does not stop the
  // render, but it does mean the document is not what its author intended, so
  // it is reported rather than swallowed.
  const failedSubresources: { kind: string; url: string }[] = [];
  let tab: Tab | undefined;
  let server: { origin: string; stop: () => void } | undefined;

  // A document fetched over the network is served by someone else, so a missing
  // file is their problem to report. Verified after the load, when there is
  // something to check, and only for a non-loopback origin.
  const isRemote = /^https?:/i.test(req.url ?? "");

  try {
    const src = await resolveSource(req, dir);
    // Not `if (src.html)`: an empty string is falsy, so the empty-input check
    // below sat inside a branch that an empty document never entered. That is
    // exactly the case it existed to catch.
    if (src.html != null) {
      const binary = looksBinary(src.html);
      if (binary) {
        throw new Error(
          `this input is not HTML: ${binary}. letterpress prints html, so a document with the wrong ` +
          `file extension produces a page of binary noise rather than an error. check the path.`,
        );
      }
      // An empty document renders as a real blank page, which is indistinguishable
      // from success by exit code, page count or the summary line. A truncated
      // pipe or a curl that returned nothing looked like a working document.
      //
      // Local input only. A URL that fails to load also resolves to empty html,
      // but it has its own diagnosis further down, and this message blames a
      // 0-byte file, which is not what went wrong.
      if (!req.url && !src.html.trim()) {
        throw new Error(
          "the input is empty. a 0-byte file renders as one blank page and reports success; " +
          "check that the file has content, or that the command producing it wrote to stdout.",
        );
      }
      findings.push(...precedenceFindings(src.html, req));
    }

    // Copy any local image the document references into the work directory, then
    // serve the lot over loopback. Same-origin is what makes the canvas
    // readable, and a file:// image cannot be downsampled at all.
    //
    // Skipped when the document references nothing relative: there is then no
    // origin to solve, and Page.setDocumentContent prints without writing a
    // file or opening a socket.
    const relative = hasRelativeAssets(src.html ?? "");
    const fastPath = !isRemote && src.html != null && req.preferFastPath !== false &&
      !relative && !req.maxImagePpi;

    if (!isRemote && !fastPath) {
      await stageAssets(src.html, src.source, dir);
      server = await serveWorkDir(dir);
    }

    // Chromium ignores paperWidth, paperHeight and landscape together while
    // preferCSSPageSize is on. Honouring --format against a document that
    // declares @page size therefore means removing the declaration first, and
    // keeping the @page margin so the document still controls its own gutters.
    const override = req.format && src.html && declaredPageSize(src.html)
      ? src.html.replace(
          /(@page[^{]*\{)([^}]*)(\})/gi,
          (_whole, open: string, body: string, close: string) =>
            open + body.replace(/(^|;)\s*\bsize\s*:[^;}]*/gi, "$1").replace(/;;+/g, ";") + close,
        )
      : null;

    let srcUrl: string;
    if (fastPath) srcUrl = "about:blank";
    else srcUrl = isRemote ? src.url : `${server!.origin}/input.html`;
    if (override && !fastPath) {
      await Bun.write(join(dir, "override.html"), override);
      srcUrl = `${server!.origin}/override.html`;
    }

    tab = await browser.newTab();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      // Closing the tab aborts an in-flight printToPDF. Otherwise the command
      // sits until its own timeout and leaves the renderer wedged. It also
      // closes the socket, so the error it produces has to be replaced with
      // the reason the deadline actually fired.
      void browser.closeTab(tab!).catch(() => {});
    }, timeoutMs);

    try {
      await tab.send("Page.enable");
      await tab.send("Runtime.enable");
      await tab.send("Network.enable");
      // Intercept http(s) only, so the document itself still loads while every
      // remote asset is both blocked and recorded. Loopback is exempt: the
      // document and its staged images are served from 127.0.0.1, and treating
      // our own origin as remote blocks the document's images.
      // Exempt our own work server, and nothing else on loopback. Exempting all
      // of loopback would let a document probe any local service: verified, a
      // listener on 127.0.0.1 received the document's GET, query, method and
      // body, with only the response unreadable. That is a blind SSRF handed to
      // whoever can supply the HTML, and it is the document's own assets that
      // need the exemption.
      const loopback = server
        ? new RegExp(`^${server.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i")
        : /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;
      await tab.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
      tab.on("Fetch.requestPaused", (p) => {
        const url = String(p.request?.url ?? "");
        if (loopback.test(url)) {
          void tab!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
          return;
        }
        const proceed = req.allowNetwork
          ? tab!.send("Fetch.continueRequest", { requestId: p.requestId })
          : (blocked.length < MAX_BLOCKED_REPORTED && blocked.push(url),
             tab!.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }));
        void proceed.catch(() => {});
      });

      // A 404 or a DNS failure still "loads": Chromium renders its own error
      // page, which would otherwise be printed and reported as a success.
      // Only meaningful for a document fetched over the network. The local work
      // server answers 404 for a missing staged asset, which says nothing about
      // whether the document itself loaded.
      let mainStatus: number | undefined;
      let netError: string | undefined;
      if (isRemote) {
        tab.on("Network.responseReceived", (p) => {
          if (p.type === "Document" && !mainStatus) mainStatus = p.response?.status;
        });
      }
      // Only a failed *document* load means we have nothing to print. A 404
      // stylesheet or an unreachable font produces the same event for a
      // subresource, and treating that as a load failure refused to render
      // perfectly good documents over one missing asset.
      // A 404 is not a loading failure. The work server answers 404 for an asset
      // that is not on disk, chromium treats that as a normal response, and the
      // document renders with a hole in it. Status has to be watched as well as
      // the failure event, or a missing image is silent.
      tab.on("Network.responseReceived", (p) => {
        const status = p.response?.status ?? 0;
        // Chromium asks for /favicon.ico on every document whether or not one
        // is declared, and the work server has none. It cannot affect print
        // output, so reporting it would bury the real failures in noise.
        const isFavicon = /\/favicon\.ico(\?|$)/.test(p.response?.url ?? "");
        if (status >= 400 && p.type && p.type !== "Document" && !isFavicon) {
          failedSubresources.push({ kind: p.type, url: `${status} ${p.response?.url ?? ""}` });
        }
      });
      tab.on("Network.loadingFailed", (p) => {
        if (p.type === "Document" && !netError && !p.blockedReason) netError = p.errorText;
        else if (!p.blockedReason) {
          // Images are included. A missing image still "renders": Chromium draws
          // its own broken-image placeholder and the pdf carries that glyph
          // instead of the picture, which is worse than an obvious failure
          // because nothing in the output says anything went wrong.
          failedSubresources.push({ kind: p.type ?? "unknown", url: p.errorText ?? "" });
        }
      });

      const loaded = tab.once("Page.loadEventFired");
      if (fastPath) {
        // No navigation at all: the document is installed straight into the tab.
        // Page.enable has already run above, which setDocumentContent requires.
        const frameId = (await tab.send("Page.getFrameTree")).frameTree.frame.id;
        await tab.send("Page.setDocumentContent", { frameId, html: override ?? src.html! });
      } else {
        await tab.send("Page.navigate", { url: srcUrl }).catch((e: Error) => {
          if (/ERR_/.test(e.message)) netError ??= e.message;
        });
        await Promise.race([
          loaded.promise,
          Bun.sleep(timeoutMs).then(() => { throw new Error(`__deadline__`); }),
        ]).catch((e: Error) => {
          throw new Error(e.message === "__deadline__" && timedOut
            ? `navigation did not finish within ${timeoutMs}ms`
            : e.message);
        });
        loaded.cancel();
      }

      if (netError) {
        throw new Error(`could not load ${src.source}: ${netError}`);
      }
      if (mainStatus !== undefined && (mainStatus < 200 || mainStatus >= 300)) {
        throw new Error(`${src.source} returned HTTP ${mainStatus}; refusing to print the error page`);
      }

      // Fonts must resolve before printToPDF, or glyphs fall back part way
      // through the document and the PDF mixes typefaces.
      await tab.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => true)",
        awaitPromise: true,
        returnByValue: true,
      }, timeoutMs);
      if (req.settleMs) await Bun.sleep(req.settleMs);
      if (req.beforePrint) {
        await tab.send("Runtime.evaluate", {
          expression: req.beforePrint, awaitPromise: true, returnByValue: true,
        }, timeoutMs);
      }

      // An author the document states, read from the live page rather than the
      // source string: the source is not always what is loaded, since a template
      // fills it and setDocumentContent installs it.
      const stated = await tab.send("Runtime.evaluate", {
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
      }, timeoutMs);
      let docMeta: { author?: string; subject?: string; keywords?: string } = {};
      try {
        docMeta = JSON.parse((stated as { result?: { value?: string } }).result?.value ?? "{}");
      } catch {
        // A document with no meta tags, or an unparseable one. Neither is an error.
      }
      // The flag wins over the document: it is the more specific statement of the
      // same fact, and a caller supplying one on the command line expects it used.
      const author = req.author?.trim() || docMeta.author || "";

      // Downsample before measuring, so the findings describe the PDF that was
      // actually produced rather than the page as authored.
      const capped = req.maxImagePpi ? await capImageResolution(tab, req.maxImagePpi, timeoutMs) : [];
      for (const c of capped) {
        findings.push({
          code: "image-downsampled",
          severity: "info",
          message: `image downsampled from ${c.from}px to ${c.to}px wide, ${c.ppi}ppi down to ${req.maxImagePpi}ppi, to keep the PDF a reasonable size.`,
        });
      }

      findings.push(...await audit(tab, timeoutMs));

      // The description of every link, read from the live document: Chromium writes a
      // link annotation with no /Contents at all, and clause 7.18.5 fails every link
      // because of it. Read from the live document before printing.
      const linkDescRaw = await tab.send("Runtime.evaluate", {
        expression: LINK_DESC_JS, returnByValue: true, awaitPromise: false,
      }, timeoutMs).then((r: { result?: { value?: unknown } }) => r.result?.value).catch(() => undefined);
      const linkDescs = parseLinkDescs(linkDescRaw);

      // Does the document actually declare its own paper? A local file can be
      // read before navigating, but a remote URL cannot, and Chromium's default
      // is US Letter, so an undeclared remote page would print on Letter paper
      // while every local document defaults to A4 by convention.
      let declaresPaper = src.html ? declaredPageSize(src.html) !== null : false;
      if (!req.format && !declaresPaper && req.url) {
        const probe = await tab.send("Runtime.evaluate", {
          expression: `(() => {
            for (const sheet of document.styleSheets) {
              let rules; try { rules = sheet.cssRules } catch { continue }
              for (const r of rules || []) if (/@page/i.test(r.cssText || "") && /\\bsize\\s*:/i.test(r.cssText || "")) return true;
            }
            return false;
          })()`,
          returnByValue: true,
        }).catch(() => null);
        declaresPaper = probe?.result?.value === true;
      }

      // The document's own @page is authoritative, which is what makes
      // "@page { size: A4 }" produce an exactly 594.96 x 841.92pt page.
      //
      // Chromium ignores paperWidth, paperHeight and landscape together whenever
      // preferCSSPageSize is on, so a --format cannot override a declared @page
      // by asking nicely. To make the request win, the declaration has to go:
      // the size is stripped from the document and the paper comes from CDP.
      const docOverridesPaper = declaresPaper;
      const preferCss = docOverridesPaper && !req.format;
      const paper = req.format ? FORMATS[req.format] : preferCss ? undefined : FORMATS.a4;
      const margin = req.margin ? toInches(req.margin) : undefined;
      if (margin !== undefined && margin < 0) {
        // Checked here because printToPDF's own refusal comes back as "left
        // margin is negative", which names neither the flag nor the value.
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
      const useStream = req.transfer === "stream";
      try {
        res = await tab.send("Page.printToPDF", {
        printBackground: req.printBackground ?? true,
        preferCSSPageSize: preferCss,
        ...(paperWidth !== undefined ? { paperWidth, paperHeight } : {}),
        ...(paper && !preferCss
          ? { scale: 1, marginTop: margin ?? 0, marginBottom: margin ?? 0, marginLeft: margin ?? 0, marginRight: margin ?? 0 }
          : {}),
        // Only pass landscape when the paper is not ours to choose. With
        // preferCSSPageSize on, CDP ignores it and the document keeps its own
        // orientation, which is why --landscape silently did nothing before.
        landscape: req.landscape && preferCss,
        // CDP header and footer templates reserve space inside the page box and
        // silently repaginate, so page numbers belong in CSS @page margin boxes.
        displayHeaderFooter: false,
        generateDocumentOutline: true,
        generateTaggedPDF: true,
        ...(req.pageRanges ? { pageRanges: req.pageRanges } : {}),
        transferMode: useStream ? "ReturnAsStream" : "ReturnAsBase64",
      }, timeoutMs);
      } catch (e) {
        if (timedOut) {
          throw new Error(`printing exceeded the ${timeoutMs}ms deadline. A very large document needs a higher --timeout; if it dies at a few thousand pages the browser ran out of memory.`);
        }
        throw e;
      }

      // The stream handle arrives alongside an empty data field, so the payload
      // has to be read back through IO before anything can inspect it.
      const raw = useStream && res.stream
        ? await drainStream(tab, res.stream, { timeoutMs })
        : new Uint8Array(Buffer.from(res.data, "base64"));
      // A document that declares no <title> should be titled after the file it
      // came from, not after the loopback port that served it.
      //
      // "document" and not "document.html" for the same reason: the slot can be
      // as short as the eleven characters of "about:blank", the title chromium
      // writes on the fast path, and a longer name is truncated mid-word.
      const pdfTitle = req.path
        ? basename(req.path)
        : req.url
          ? new URL(req.url).hostname
          : "document";
      // Every repair goes through the gate, which keeps the result only if the
      // file is still whole and its content streams are byte-identical to what
      // Chromium emitted. No repair in this layer may move a glyph, so a changed
      // content payload means one of them has done something it had no business
      // doing — which is exactly how a TJ merge misplaced 192 of 2,613 glyphs and
      // every structural check still passed.
      //
      // Each is gated separately rather than chained, because a chain that fails
      // halfway would leave a partially repaired file with no way to say which
      // step broke it. The input is passed in rather than closed over: `pdf` is
      // declared further down, so reading it here is a temporal dead zone error.
      const gated = (
        input: Uint8Array,
        label: string,
        repair: (pdf: Uint8Array) => Uint8Array,
      ): Uint8Array => {
        const attempt = repairOrKeep(input, repair);
        if (attempt.failures.length) {
          findings.push({
            code: "repair-rejected",
            severity: "warn",
            message: `the ${label} fix was discarded because it did not leave a valid pdf: ` +
              `${attempt.failures.join("; ")}. the file is chromium's own output, unmodified.`,
          });
        }
        return attempt.pdf;
      };

      let described = gated(raw, "ToUnicode", fixToUnicode);
      described = gated(described, "font descriptor", fixFontDescriptors);
      if (linkDescs) {
        described = gated(described, "link description", (p) => fixLinkDescs(p, linkDescs!));
      }
      described = gated(described, "metadata", (p) => addMetadata(p, {
        author,
        // A description is the subject in Dublin Core, which is where the subject
        // is read from. A document that states both gets the explicit subject,
        // since that is the narrower claim.
        subject: req.subject?.trim() || docMeta.subject || "",
        keywords: req.keywords?.trim() || docMeta.keywords || "",
      }));
      const pdf = stampPdf(described, pdfTitle);
      // An author the document declared but that no flag supplied. Worth saying:
      // Chromium drops every meta tag on the way into the PDF, so without this
      // the fact exists in the source and nowhere in the output.
      if (docMeta.author && !req.author?.trim()) {
        findings.push({
          code: "metadata-authored",
          severity: "info",
          message: `wrote "${docMeta.author}" as the pdf author, from the document's own meta tag. pass --author to override it.`,
        });
      }
      if (docMeta.subject?.trim()) {
        findings.push({
          code: "metadata-subject",
          severity: "info",
          message: `wrote "${docMeta.subject}" as the pdf subject, from the document's own meta tag.`,
        });
      }
      const info = inspect(pdf);

      for (const url of blocked) {
        findings.push({
          code: "network-blocked",
          severity: "warn",
          url,
          message: `blocked a remote request to ${url}. Pass --allow-network to permit it, or inline the asset.`,
        });
      }
      if (failedSubresources.length) {
        const kinds = [...new Set(failedSubresources.map((f) => f.kind))];
        const images = failedSubresources.filter((f) => f.kind === "Image").length;
        // Name the assets. A count without a path sends the reader to the
        // document to hunt for it, which is the work this finding should have
        // saved them.
        const listed = [...new Set(failedSubresources.map((f) => f.url))]
          .slice(0, 5)
          .map((u) => `  ${u}`)
          .join("\n");
        findings.push({
          code: "subresource-failed",
          severity: "warn",
          url: failedSubresources[0].url,
          message:
            `${failedSubresources.length} ${failedSubresources.length === 1 ? "subresource" : "subresources"} (${kinds.join(", ")}) failed to load, so the document is missing ${failedSubresources.length === 1 ? "it" : "them"}.\n${listed}` +
            (images ? `\n${images} ${images === 1 ? "is an image" : "are images"}: where a picture should be, the pdf carries chromium's broken-image placeholder.` : "") +
            `\nthe pdf was still produced, but it will not look like the source. url(), @import and @font-face src are staged from disk only when the document is a file.`,
        });
      }
      if (req.url && !req.allowNetwork) {
        findings.push({
          code: "url-render-blocked",
          severity: "error",
          message: `rendering a remote URL blocks its own subresources and usually the document itself. Set allowNetwork to render ${req.url}.`,
        });
      }
      // Reported rather than corrected. Chromium emits a Type 3 font when it
      // cannot embed a face, and a Type 3 font's glyphs are drawing procedures
      // with no font program to read a cap height out of. Every other descriptor
      // was corrected from its own embedded font, so anything still negative here
      // has nothing behind it to derive from.
      const unresolved = unresolvedFontMetrics(pdf);
      if (unresolved.length) {
        const named = [...new Set(unresolved.map((u) => u.fontName))].slice(0, 3);
        findings.push({
          code: "font-metrics",
          severity: "warn",
          message:
            `${unresolved.length} font descriptor${unresolved.length === 1 ? " still carries" : "s still carry"} a negative cap height (${unresolved.map((u) => `${u.fontName} ${u.capHeight}`).slice(0, 3).join(", ")}). ` +
            `The PDF specification calls a negative CapHeight an error a viewer may refuse to render text over. ` +
            `Chromium emitted ${unresolved.length === 1 ? "this face" : "these faces"} as Type 3 fonts, whose glyphs are drawing procedures with no embedded font to read the metric from, so the value cannot be derived and was left as produced. ` +
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