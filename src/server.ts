import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { FORMATS, render, type Format } from "./render.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;

/**
 * A limit from the environment, or the default when it is absent or unusable.
 *
 * `Number('abc')` is NaN, and every comparison against NaN is false. So a typo did not
 * disable one limit loudly -- it disabled it silently: `active < NaN` is never true, the
 * queue grew without bound, and neither the 429 nor the page-limit message ever appeared.
 * The page limit was the worst, because the 413 body still quoted "the 6000-page limit"
 * while no such limit was being enforced.
 */
const warnToStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export function limitFromEnv(
  name: string,
  fallback: number,
  min = 1,
  warn: (message: string) => void = warnToStderr,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    // Loudly, because the alternative is a limit that is not there and a message saying it
    // is. Falling back silently is what this function exists to stop.
    warn(
      `letterpress: ${name}=${JSON.stringify(raw)} is not a number of at least ${min}; ` +
        `using ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(value);
}

const MAX_CONCURRENT_RENDERS = limitFromEnv("HTML2PDF_MAX_RENDERS", 4);

const MAX_QUEUED_RENDERS = limitFromEnv("HTML2PDF_MAX_QUEUE", 16);

const MAX_TIMEOUT_MS = 120_000;
const MAX_SETTLE_MS = 30_000;

const MAX_PAGES = limitFromEnv("HTML2PDF_MAX_PAGES", 6000);

export type ServerOptions = {
  port?: number;

  browserArgs?: string[];

  onReady?: (browser: Browser) => void;
};

export type RenderBody = {
  html?: string;

  path?: unknown;
  format?: string;
  landscape?: boolean;

  margin?: string;

  printBackground?: boolean;
  allowNetwork?: boolean;
  pageRanges?: string;
  maxImagePpi?: number;
  settleMs?: number;
  timeoutMs?: number;

  responseFormat?: string;

  author?: string;
  subject?: string;
  keywords?: string;
};

function originAllowed(request: Request, port: number): boolean {
  const origin = request.headers.get("origin");

  if (origin !== null) {
    // Any loopback spelling the server answers on, at the port it is listening on.
    // Comparing against one fixed spelling meant a viewer opened at http://localhost:PORT
    // -- which hostAllowed accepts on purpose, and which server.test.ts asserts returns
    // 200 -- was refused by its own POST, with a message about "other web pages".
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:") return false;
    if (!hostAllowed(parsed.host)) return false;
    if (parsed.port !== String(port)) return false;
  }

  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  return true;
}

function hostAllowed(host: string | null): boolean {
  if (host === null) return true;
  if (!LOOPBACK_HOST.test(host)) return false;

  const bracketed = /^\[[0-9a-f:]+\](?::(\d{1,5}))?$/i.exec(host);
  if (bracketed) return !bracketed[1] || Number(bracketed[1]) <= 65535;
  const colon = host.lastIndexOf(":");
  if (colon === -1) return true;
  const port = host.slice(colon + 1);
  return /^\d{1,5}$/.test(port) && Number(port) <= 65535;
}

function badRequest(message: string) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

function typed(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

async function readCapped(
  request: Request,
  cap: number,
): Promise<{ text: string } | { tooBig: number } | { broken: string }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  // Trusted only to reject early. A header is the caller's claim, and quoting it back as
  // though it were the size is how a ten-byte body with `Content-Length: 99999999999`
  // answered "document is 95367.4MB, over the 8MB limit". Below, the rejection is by
  // measurement and reports the measured total.
  if (Number.isFinite(declared) && declared > cap) return { tooBig: declared };

  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return { tooBig: total };
      }
      parts.push(value);
    }
  } catch (e) {
    return { broken: e instanceof Error ? e.message : String(e) };
  }
  return { text: Buffer.concat(parts).toString("utf8") };
}

export async function startServer(opts: ServerOptions = {}) {
  const profile = await mkdtemp(join(tmpdir(), "letterpress-server-"));
  const browser = await Browser.launch({
    profile,
    extraArgs: opts.browserArgs,
  });
  opts.onReady?.(browser);

  const viewerDir = join(import.meta.dir, "..", "viewer");

  let active = 0;
  let queued = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> | null => {
    if (active < MAX_CONCURRENT_RENDERS) {
      active++;
      return Promise.resolve();
    }
    if (queued >= MAX_QUEUED_RENDERS) return null;
    queued++;
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        queued--;
        active++;
        resolve();
      });
    });
  };

  const release = () => {
    active--;
    waiters.shift()?.();
  };

  const inFlight = new Set<Promise<unknown>>();

  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 8787,
    idleTimeout: 30,

    async fetch(request: Request): Promise<Response> {
      if (!hostAllowed(request.headers.get("host"))) {
        return Response.json(
          {
            ok: false,
            error: "this server only answers requests addressed to loopback",
          },
          { status: 403 },
        );
      }
      if (!originAllowed(request, server.port ?? 0)) {
        return Response.json(
          {
            ok: false,
            error:
              "this server only answers its own viewer, not other web pages",
          },
          { status: 403 },
        );
      }

      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return badRequest("could not parse the request url");
      }

      try {
        if (url.pathname === "/health") {
          const alive = await browser.alive();
          return Response.json(
            { ok: alive, port: server.port, chromium: alive },
            { status: alive ? 200 : 503 },
          );
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = Bun.file(join(viewerDir, "index.html"));
          if (!(await file.exists())) {
            return new Response("viewer not built yet", { status: 404 });
          }
          return new Response(file, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }

        if (url.pathname.startsWith("/assets/")) {
          const name = url.pathname.slice("/assets/".length);
          const target = join(viewerDir, name);

          if (!target.startsWith(viewerDir + "/")) {
            return new Response("forbidden", { status: 403 });
          }

          if (name.length > 512 || name.includes("\0")) {
            return new Response("not found", { status: 404 });
          }
          const file = Bun.file(target);
          if (!(await file.exists()))
            return new Response("not found", { status: 404 });

          const ext = target.slice(target.lastIndexOf("."));
          const type =
            ext === ".html"
              ? "text/html; charset=utf-8"
              : ext === ".js" || ext === ".mjs"
                ? "text/javascript; charset=utf-8"
                : ext === ".css"
                  ? "text/css; charset=utf-8"
                  : ext === ".json"
                    ? "application/json"
                    : undefined;
          return new Response(
            file,
            type
              ? {
                  headers: {
                    "content-type": type,
                    "cache-control": "no-store",
                  },
                }
              : { headers: { "cache-control": "no-store" } },
          );
        }

        if (url.pathname !== "/render" || request.method !== "POST") {
          return new Response("not found", { status: 404 });
        }

        const type =
          (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ??
          "";
        if (type !== "application/json") {
          return Response.json(
            {
              ok: false,
              error: `send content-type: application/json, not "${type || "nothing"}"`,
            },
            { status: 415 },
          );
        }

        if (active >= MAX_CONCURRENT_RENDERS && queued >= MAX_QUEUED_RENDERS) {
          return Response.json(
            {
              ok: false,
              error: `${MAX_CONCURRENT_RENDERS} renders are running and ${MAX_QUEUED_RENDERS} are queued, which is the limit. retry shortly.`,
            },
            { status: 429, headers: { "retry-after": "2" } },
          );
        }

        const read = await readCapped(request, MAX_BODY_BYTES);
        if ("tooBig" in read) {
          return Response.json(
            {
              ok: false,
              error: `document is ${(read.tooBig / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
            },
            { status: 413 },
          );
        }
        if ("broken" in read)
          return badRequest(`body stream ended early: ${read.broken}`);

        let body: RenderBody;
        try {
          body = JSON.parse(read.text);
        } catch (e) {
          return badRequest(`body is not valid JSON: ${(e as Error).message}`);
        }

        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return badRequest("body must be a JSON object");
        }

        if (body.path !== undefined) {
          return badRequest("path is not accepted. send the html.");
        }
        if (typeof body.html !== "string") {
          return badRequest("send html as a string");
        }

        if (body.format !== undefined && typeof body.format !== "string") {
          return badRequest(
            `format must be a string, got ${Array.isArray(body.format) ? "array" : typeof body.format}`,
          );
        }
        const format = typed(body.format);
        if (
          format !== undefined &&
          !Object.hasOwn(FORMATS, String(format).toLowerCase())
        ) {
          return badRequest(
            `unknown format "${format}". try: ${Object.keys(FORMATS).join(", ")}`,
          );
        }
        if (
          body.pageRanges !== undefined &&
          typeof body.pageRanges !== "string"
        ) {
          return badRequest('pageRanges must be a string like "1-3"');
        }

        if (body.margin !== undefined) {
          if (typeof body.margin !== "string") {
            return badRequest('margin must be a string like "15mm"');
          }
          const m = body.margin.trim();

          const isLength =
            /^0(?:\.0+)?$/.test(m) ||
            /^-?\d*\.?\d+(mm|cm|in|pt|px|pc|q)$/.test(m);
          if (m && !isLength) {
            return badRequest(
              `margin "${body.margin}" is not an absolute css length. use mm, cm, in, pt, pc, ` +
                `px or a bare 0, such as 15mm or 1in. relative units like em and vw depend on layout ` +
                `and cannot be resolved before the page is printed.`,
            );
          }
          if (!Object.hasOwn(FORMATS, String(format ?? "").toLowerCase())) {
            return badRequest(
              "margin only applies alongside format, because a document's own @page margin wins otherwise. " +
                "send format too, or drop the margin.",
            );
          }
        }
        for (const key of [
          "printBackground",
          "allowNetwork",
          "landscape",
        ] as const) {
          if (body[key] !== undefined && typeof body[key] !== "boolean") {
            return badRequest(`${key} must be true or false`);
          }
        }
        for (const key of ["maxImagePpi", "settleMs", "timeoutMs"] as const) {
          if (body[key] === undefined || body[key] === null) continue;
          if (typeof body[key] !== "number" || !Number.isFinite(body[key])) {
            return badRequest(`${key} must be a number`);
          }
        }

        if (
          body.responseFormat !== undefined &&
          body.responseFormat !== null &&
          body.responseFormat !== "json" &&
          body.responseFormat !== "pdf"
        ) {
          return badRequest(
            `responseFormat must be "json" or "pdf", got "${String(body.responseFormat)}"`,
          );
        }

        // Clamped to at least 1ms. `timeoutMs: 0` is a number, so it passed the numeric
        // check, and `render` reads it with `?? DEFAULT`, which keeps the 0. The deadline then
        // expired on the next tick and the caller got a 500 about a cdp socket. The CLI
        // refuses the same input with a usage error, so the two disagreed as well.
        const clamp = (
          value: unknown,
          max: number,
          fallback: number,
        ): number => {
          const n = typed(value);
          if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
          return Math.min(Math.max(n, 0), max);
        };

        // A deadline below a millisecond is not a deadline. `timeoutMs: 0` is a number, so
        // it passed the numeric check, and `render` reads it with `?? DEFAULT`, which keeps
        // the 0. The deadline expired on the next tick and the caller got a 500 about a cdp
        // socket, while the CLI refused the same input with a usage error. Clamping to 1ms
        // would be no better -- still a deadline that cannot be met -- so a value that small
        // falls back to the default rather than pretending otherwise.
        const deadline = (value: unknown): number | undefined => {
          const n = typed(value);
          if (typeof n !== "number" || !Number.isFinite(n) || n < 1)
            return undefined;
          return Math.min(n, MAX_TIMEOUT_MS);
        };

        for (const key of ["author", "subject", "keywords"] as const) {
          if (
            body[key] !== undefined &&
            body[key] !== null &&
            typeof body[key] !== "string"
          ) {
            return badRequest(`${key} must be a string`);
          }
        }

        const slot = acquire();
        if (!slot) {
          return Response.json(
            {
              ok: false,
              error: `the render queue filled up while this request was being read. retry shortly.`,
            },
            { status: 429, headers: { "retry-after": "2" } },
          );
        }

        await slot;

        const work = (async () => {
          try {
            const result = await render(browser, {
              html: body.html!,
              format: format as Format | undefined,
              landscape: body.landscape === true,
              margin:
                typeof body.margin === "string"
                  ? body.margin.trim() || undefined
                  : undefined,

              printBackground: body.printBackground !== false,

              allowNetwork: body.allowNetwork === true,

              author:
                typeof body.author === "string"
                  ? body.author.trim() || undefined
                  : undefined,
              subject:
                typeof body.subject === "string"
                  ? body.subject.trim() || undefined
                  : undefined,
              keywords:
                typeof body.keywords === "string"
                  ? body.keywords.trim() || undefined
                  : undefined,
              pageRanges: body.pageRanges,
              maxImagePpi: clamp(
                body.maxImagePpi,
                1200,
                undefined as unknown as number,
              ),
              settleMs: clamp(
                body.settleMs,
                MAX_SETTLE_MS,
                undefined as unknown as number,
              ),
              // A deadline of 0 expires on the next tick and turns into a 500 about a cdp
              // socket, so the floor here is 1ms rather than 0.
              timeoutMs: deadline(body.timeoutMs),

              transfer: "stream",
            });

            if (result.info.pages > MAX_PAGES && !body.pageRanges) {
              return Response.json(
                {
                  ok: false,
                  error:
                    `this document is ${result.info.pages} pages, over the ${MAX_PAGES}-page limit. ` +
                    `split it, or render it with the cli, which has no page limit.`,
                  pages: result.info.pages,
                  limit: MAX_PAGES,
                },
                { status: 413 },
              );
            }

            if (body.responseFormat === "pdf") {
              const headers = new Headers({
                "content-type": "application/pdf",
                "content-length": String(result.pdf.byteLength),
                "x-letterpress-pages": String(result.info.pages),
                "x-letterpress-ms": String(result.ms),
                "x-letterpress-tagged": String(result.info.tagged),
                "x-letterpress-findings": String(result.findings.length),
              });

              return new Response(result.pdf as unknown as BodyInit, {
                status: 200,
                headers,
              });
            }

            return Response.json({
              ok: true,
              pdf: Buffer.from(result.pdf).toString("base64"),
              pages: result.info.pages,
              bytes: result.pdf.byteLength,
              ms: result.ms,
              mediaBoxes: result.info.mediaBoxes,
              tagged: result.info.tagged,
              findings: result.findings,

              partial: Boolean(body.pageRanges),
            });
          } catch (e) {
            return Response.json(
              { ok: false, error: e instanceof Error ? e.message : String(e) },
              { status: 500 },
            );
          } finally {
            release();
          }
        })();

        inFlight.add(work);
        try {
          return await work;
        } finally {
          inFlight.delete(work);
        }
      } catch (e) {
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    },
  });

  async function reapChromium() {
    if (!process.platform.toUpperCase().startsWith("LINUX")) return;
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
          if (!cmdline.includes(profile)) continue;

          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await Bun.sleep(700);
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
          if (!cmdline.includes(profile)) continue;
          process.kill(Number(entry), "SIGKILL");
        } catch {}
      }
    } catch {}
  }

  const stop = async () => {
    if (inFlight.size) {
      await Promise.race([Promise.allSettled(inFlight), Bun.sleep(4_000)]);
    }

    for (const waiter of waiters.splice(0)) waiter();
    server.stop(true);
    await browser.close();
    await reapChromium();
    await rm(profile, { recursive: true, force: true }).catch(() => {});

    const { readdir } = await import("node:fs/promises");
    const ours = `letterpress-${process.pid}-`;
    for (const entry of await readdir(tmpdir()).catch(() => [] as string[])) {
      if (!entry.startsWith(ours)) continue;
      await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  };

  return { server, browser, stop, port: server.port };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);

  const running = await startServer({
    port,
    browserArgs: process.env.HTML2PDF_WEBMCP
      ? ["--enable-blink-features=WebMCP"]
      : [],
  });
  process.stdout.write(
    `letterpress viewer on http://127.0.0.1:${running.port}\n`,
  );

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      const forced = setTimeout(() => process.exit(1), 6_000);
      running
        .stop()
        .catch(() => {})
        .finally(() => {
          clearTimeout(forced);
          process.exit(0);
        });
    });
  }
}
