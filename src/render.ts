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

let workDirCounter = 0;

async function resolveSource(req: RenderRequest, dir: string): Promise<{ html: string; url: string; source: string }> {
  if (req.html != null) {
    // Chromium will not print a string, and about:blank gives the document no
    // origin for relative assets, so the HTML becomes a real file.
    const file = `${dir}/input.html`;
    await Bun.write(file, req.html);
    return { html: req.html, url: fileUrl(file), source: "html" };
  }
  if (req.path) {
    const abs = req.path.startsWith("/") ? req.path : `${process.cwd()}/${req.path}`;
    return { html: await Bun.file(abs).text(), url: fileUrl(abs), source: abs };
  }
  if (req.url) return { html: "", url: req.url, source: req.url };
  throw new Error("render needs one of: html, path, url");
}

export async function render(browser: Browser, req: RenderRequest): Promise<RenderResult> {
  const started = Bun.nanoseconds();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = process.env.TMPDIR ?? "/tmp";
  const dir = `${tmp}/html2pdf-${process.pid}-${workDirCounter++}`;
  const findings: Finding[] = [];
  const blocked: string[] = [];
  let tab: Tab | undefined;

  try {
    const src = await resolveSource(req, dir);
    if (src.html) findings.push(...precedenceFindings(src.html, req));

    // Chromium ignores paperWidth, paperHeight and landscape together while
    // preferCSSPageSize is on. Honouring --format against a document that
    // declares @page size therefore means removing the declaration first, and
    // keeping the @page margin so the document still controls its own gutters.
    let srcUrl = src.url;
    if (req.format && src.html && declaredPageSize(src.html)) {
      const stripped = src.html.replace(
        /(@page[^{]*\{)([^}]*)(\})/gi,
        (_whole, open: string, body: string, close: string) =>
          open + body.replace(/(^|;)\s*\bsize\s*:[^;}]*/gi, "$1").replace(/;;+/g, ";") + close,
      );
      const file = `${dir}/override.html`;
      await Bun.write(file, stripped);
      srcUrl = fileUrl(file);
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
      // Intercept http(s) only, so the file:// document itself still loads while
      // every remote asset is both blocked and recorded.
      await tab.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
      tab.on("Fetch.requestPaused", (p) => {
        const url = String(p.request?.url ?? "");
        const proceed = req.allowNetwork
          ? tab!.send("Fetch.continueRequest", { requestId: p.requestId })
          : (blocked.length < MAX_BLOCKED_REPORTED && blocked.push(url),
             tab!.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }));
        void proceed.catch(() => {});
      });

      // A 404 or a DNS failure still "loads": Chromium renders its own error
      // page, which would otherwise be printed and reported as a success.
      let mainStatus: number | undefined;
      let netError: string | undefined;
      tab.on("Network.responseReceived", (p) => {
        if (p.type === "Document" && !mainStatus) mainStatus = p.response?.status;
      });
      tab.on("Network.loadingFailed", (p) => {
        if (!netError && p.type !== "Image" && !p.blockedReason) netError = p.errorText;
      });

      const loaded = tab.once("Page.loadEventFired");
      await tab.send("Page.navigate", { url: srcUrl }).catch((e: Error) => {
        if (/ERR_/.test(e.message)) netError ??= e.message;
        return {};
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
        transferMode: "ReturnAsBase64",
      }, timeoutMs);
      } catch (e) {
        if (timedOut) {
          throw new Error(`printing exceeded the ${timeoutMs}ms deadline. A very large document needs a higher --timeout; if it dies at a few thousand pages the browser ran out of memory.`);
        }
        throw e;
      }

      const pdf = new Uint8Array(Buffer.from(res.data, "base64"));
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
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}