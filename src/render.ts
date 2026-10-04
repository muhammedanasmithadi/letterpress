import { dirname, isAbsolute, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { Browser, type Tab } from "./browser.ts";
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

/** Parse a CSS length into inches. CSS uses 96 pixels per inch. */
export function toInches(len: string): number {
  const m = len.trim().match(/^([\d.]+)\s*(mm|cm|in|px|pt)?$/i);
  if (!m) throw new Error(`unsupported margin: ${len}`);
  const perInch: Record<string, number> = { px: 96, in: 1, cm: 2.54, mm: 25.4, pt: 72 };
  const unit = (m[2] ?? "px").toLowerCase();
  if (!(unit in perInch)) throw new Error(`unsupported margin unit: ${unit}`);
  return Number(m[1]) / perInch[unit];
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
async function stageAssets(html: string, source: string, dir: string): Promise<void> {
  if (!html || /^https?:/i.test(source)) return;
  const base = source.startsWith("/") ? dirname(source) : process.cwd();
  const seen = new Map<string, string>();

  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1];
    if (/^(?:https?:|data:|blob:|#|mailto:)/i.test(ref)) continue;
    const clean = ref.split(/[?#]/)[0];
    if (!clean || seen.has(clean)) continue;

    const from = isAbsolute(clean) ? clean : resolve(base, clean);
    let bytes: Buffer;
    try { bytes = await Bun.file(from).arrayBuffer().then((b) => Buffer.from(b)); }
    catch { continue; }
    if (!bytes.length) continue;

    // Flatten the name so a document cannot write outside the work directory.
    const flat = clean.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "asset";
    const target = join(dir, flat);
    if (!target.startsWith(dir)) continue;
    await Bun.write(target, bytes);
    seen.set(clean, flat);
  }

  if (!seen.size) return;
  // Rewrite the document to the staged copies.
  let out = html;
  for (const [from, to] of seen) {
    out = out.split(`"${from}"`).join(`"/${to}"`).split(`'${from}'`).join(`'/${to}'`);
  }
  await Bun.write(join(dir, "input.html"), out);
}

/**
 * True when the document references a file the browser would have to resolve
 * against a base URL: a relative src or href, and not a scheme or a fragment.
 *
 * Such a document cannot be printed through Page.setDocumentContent, which
 * serves the HTML with no origin, so this gates the fast path.
 */
export function hasRelativeAssets(html: string): boolean {
  return /(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|file:|#|mailto:|\/\/)[^"']/i.test(html);
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

async function resolveSource(req: RenderRequest, dir: string): Promise<{ html: string; url: string; source: string }> {
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
function stampPdf(pdf: Uint8Array): Uint8Array {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (!epoch || !/^\d+$/.test(epoch)) return pdf;
  const date = new Date(Number(epoch) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const pdfDate = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

  const text = new TextDecoder("latin1").decode(pdf);
  const out = new Uint8Array(pdf);
  const edits: Array<[number, number, string]> = [];

  for (const m of text.matchAll(/D:\d{14}[+\-Z][\d'Z]{0,5}/g)) {
    if (m.index !== undefined) edits.push([m.index, m[0].length, pdfDate]);
  }
  // The title Chromium writes is the URL without its scheme, e.g.
  // "127.0.0.1:38947/input.html", so match that shape rather than a full URL.
  // Chromium titles the document from the page URL. Which URL depends on how the
  // document was loaded: the work server's loopback address, "about:blank" when
  // setDocumentContent installed it, or the remote address. All three vary
  // between runs, so all three are replaced with one stable value.
  const volatileTitle = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\S*|^about:blank$/i;
  for (const m of text.matchAll(/\/Title \(((?:[^()\\]|\\.)*)\)/g)) {
    if (m.index === undefined) continue;
    const title = m[1];
    if (!volatileTitle.test(title)) continue;
    edits.push([m.index + "/Title (".length, title.length, "document.html"]);
  }

  // Patch from the end so earlier offsets stay valid.
  for (const [at, length, value] of edits.sort((a, b) => b[0] - a[0])) {
    for (let i = 0; i < value.length; i++) out[at + i] = value.charCodeAt(i);
    // Pad with spaces when the replacement is shorter: lengths must not change
    // or every byte offset after it would shift and corrupt the file.
    for (let i = value.length; i < length; i++) out[at + i] = 0x20;
  }
  return out;
}

export async function render(browser: Browser, req: RenderRequest): Promise<RenderResult> {
  const started = Bun.nanoseconds();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = process.env.TMPDIR ?? "/tmp";
  const dir = `${tmp}/html2pdf-${process.pid}-${workDirCounter++}`;
  const findings: Finding[] = [];
  const blocked: string[] = [];
  let tab: Tab | undefined;
  let server: { origin: string; stop: () => void } | undefined;

  // A document fetched over the network is served by someone else, so a missing
  // file is their problem to report. Verified after the load, when there is
  // something to check, and only for a non-loopback origin.
  const isRemote = /^https?:/i.test(req.url ?? "");

  try {
    const src = await resolveSource(req, dir);
    if (src.html) findings.push(...precedenceFindings(src.html, req));

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
      const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;
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
      tab.on("Network.loadingFailed", (p) => {
        if (!netError && p.type !== "Image" && !p.blockedReason) netError = p.errorText;
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
      const pdf = stampPdf(raw);
      const info = inspect(pdf);

      for (const url of blocked) {
        findings.push({
          code: "network-blocked",
          severity: "warn",
          url,
          message: `blocked a remote request to ${url}. Pass --allow-network to permit it, or inline the asset.`,
        });
      }
      if (req.url && !req.allowNetwork) {
        findings.push({
          code: "url-render-blocked",
          severity: "error",
          message: `rendering a remote URL blocks its own subresources and usually the document itself. Set allowNetwork to render ${req.url}.`,
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