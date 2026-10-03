import { rm } from "node:fs/promises";
import { Browser, type Tab } from "./browser.ts";
import { declaredPageSize, inspect, type PdfInfo } from "./pdf.ts";

/** Paper sizes in inches, as CDP expects. */
export const FORMATS = {
  a3: [11.69, 16.54],
  a4: [8.27, 11.7],
  a5: [5.83, 8.27],
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
 * Warn when the caller's paper contradicts what the document declares. The
 * request wins, so staying quiet here would mean a silent disagreement.
 */
function pageSizeFinding(html: string, fmt: Format, landscape: boolean): Finding | null {
  const declared = declaredPageSize(html);
  if (!declared) return null;

  const [w, h] = FORMATS[fmt];
  const target = landscape ? [h, w] : [w, h];
  const named = declared.match(/\b(a3|a4|a5|letter|legal|tabloid)\b/)?.[1]?.toLowerCase();
  const dims = declared.match(/([\d.]+)\s*(mm|cm|in|px|pt)/gi)?.map(toInches) ?? [];

  let agrees: boolean;
  if (named) {
    agrees = named === fmt;
  } else if (dims.length >= 2) {
    agrees = (close(dims[0], target[0]) && close(dims[1], target[1])) ||
             (close(dims[0], target[1]) && close(dims[1], target[0]));
  } else {
    return null;
  }
  if (agrees) return null;

  return {
    code: "page-size-override",
    severity: "warn",
    message: `request asked for ${fmt}${landscape ? " landscape" : ""}, but the document declares @page size: ${declared.replace(/\s+/g, " ").toLowerCase()}. The request wins and the document's own size is ignored.`,
  };
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
    if (req.format && src.html) {
      const f = pageSizeFinding(src.html, req.format, req.landscape ?? false);
      if (f) findings.push(f);
    }

    tab = await browser.newTab();
    const deadline = setTimeout(() => {
      // Closing the tab aborts an in-flight printToPDF. Otherwise the command
      // sits until its own timeout and leaves the renderer wedged.
      void browser.closeTab(tab!).catch(() => {});
    }, timeoutMs);

    try {
      await tab.send("Page.enable");
      await tab.send("Runtime.enable");
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

      const loaded = tab.once("Page.loadEventFired");
      await tab.send("Page.navigate", { url: src.url });
      await Promise.race([
        loaded.promise,
        Bun.sleep(timeoutMs).then(() => { throw new Error(`navigation did not finish within ${timeoutMs}ms`); }),
      ]);
      loaded.cancel();

      // Fonts must resolve before printToPDF, or glyphs fall back part way
      // through the document and the PDF mixes typefaces.
      await tab.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => true)",
        awaitPromise: true,
        returnByValue: true,
      }, timeoutMs);
      if (req.settleMs) await Bun.sleep(req.settleMs);

      const paper = req.format ? FORMATS[req.format] : undefined;
      const margin = req.margin ? toInches(req.margin) : undefined;
      const res = await tab.send("Page.printToPDF", {
        printBackground: req.printBackground ?? true,
        // With no explicit format the document owns its paper, which is the path
        // that honours @page size and margin exactly.
        preferCSSPageSize: !req.format,
        ...(paper ? { paperWidth: paper[0], paperHeight: paper[1] } : {}),
        ...(req.format
          ? { scale: 1, marginTop: margin ?? 0, marginBottom: margin ?? 0, marginLeft: margin ?? 0, marginRight: margin ?? 0 }
          : {}),
        landscape: req.landscape ?? false,
        // CDP header and footer templates reserve space inside the page box and
        // silently repaginate, so page numbers belong in CSS @page margin boxes.
        displayHeaderFooter: false,
        generateDocumentOutline: true,
        generateTaggedPDF: true,
        transferMode: "ReturnAsBase64",
      }, timeoutMs);

      const pdf = new Uint8Array(Buffer.from(res.data, "base64"));
      const info = inspect(pdf);

      for (const url of blocked) {
        findings.push({
          code: "network-blocked",
          severity: "warn",
          url,
          message: `blocked a remote request to ${url}. Pass allowNetwork to permit it, or inline the asset.`,
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