import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Browser } from "./browser.ts";
import { FORMATS, render, type Format } from "./render.ts";

/**
 * A loopback HTTP front end for the renderer, so a browser page can preview the
 * exact bytes the CLI would write.
 *
 * This endpoint runs whatever HTML it is given, including its scripts, in a
 * Chromium with the user's fonts. Read the threat model honestly, because an
 * earlier version of this comment got it wrong:
 *
 * The Host check does NOT stop a page on another origin. Host names the
 * destination, so a page on https://evil.example posting to
 * http://127.0.0.1:8787/render sends `Host: 127.0.0.1:8787` and passes. That was
 * measured in a real browser: the render ran, held open for the settleMs asked
 * for, and the response came back opaque. Blind, but not harmless.
 *
 * What actually stops a foreign web origin is requiring a JSON content type.
 * `application/json` is not CORS-safelisted, so the browser must preflight, and
 * the preflight gets no CORS headers back and fails. The Origin and
 * Sec-Fetch-Site checks below say the same thing in a form that does not depend
 * on the preflight. The Host check is kept for DNS rebinding, which is a real
 * attack it does stop, and is not credited with more than that.
 *
 * None of this defends against a local process, and none of it is meant to.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;

/** Renders allowed at once. Measured: 30 concurrent renders peaked at 4.7GB. */
const MAX_CONCURRENT_RENDERS = Number(process.env.HTML2PDF_MAX_RENDERS ?? 4);
/**
 * Requests allowed to wait for a slot. Bounds the wait rather than the memory:
 * a queued request holds only its parsed body, not a tab.
 */
const MAX_QUEUED_RENDERS = Number(process.env.HTML2PDF_MAX_QUEUE ?? 16);
/** A render deadline is a resource hold. 10 minutes is already absurd. */
const MAX_TIMEOUT_MS = 120_000;
const MAX_SETTLE_MS = 30_000;
const MAX_PAGES = 2000;

export type ServerOptions = {
  port?: number;
  /** Extra launch arguments for the browser, e.g. the WebMCP feature flag. */
  browserArgs?: string[];
  /** Called before serving starts, with the running browser. */
  onReady?: (browser: Browser) => void;
};

export type RenderBody = {
  html?: string;
  /** Rejected if present. It was a local file read; see the note at the check. */
  path?: unknown;
  format?: string;
  landscape?: boolean;
  /** CSS length, e.g. "15mm". Consulted only alongside format. */
  margin?: string;
  /** The viewer's "Background" checkbox, which is printBackground inverted. */
  printBackground?: boolean;
  allowNetwork?: boolean;
  pageRanges?: string;
  maxImagePpi?: number;
  settleMs?: number;
  timeoutMs?: number;
};

/**
 * A browser client must be same-origin. Verified in a real browser: without
 * this, a page on another origin reaches /render and the response comes back
 * opaque, so it cannot read the pdf but can make the server do the work.
 */
function originAllowed(request: Request, ownOrigin: string): boolean {
  const origin = request.headers.get("origin");
  // No Origin at all is curl or Bun.fetch, not a page. Those are bound by the
  // loopback listen, which is the only control they respect anyway.
  if (origin !== null && origin !== ownOrigin) return false;
  // Sec-Fetch-Site is set by every current browser and cannot be forged by a
  // page. A "cross-site" or "same-site" render means the request came from
  // somewhere other than this viewer.
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  return true;
}

function hostAllowed(host: string | null): boolean {
  if (host === null) return true;
  if (!LOOPBACK_HOST.test(host)) return false;
  // The regex allows any digits after the colon, including 99999. new URL then
  // throws on the invalid port, and an uncaught throw in the handler returns
  // Bun's dev error page with the source of this file in it. Refuse it here.
  //
  // The colon is optional, so the port must be sliced only when there is one.
  // Slicing unconditionally turned a bare "localhost" into the port "localhost"
  // and rejected every such request with 403.
  // Bracketed IPv6 first: "[::1]:8787" has colons of its own, and slicing at the
  // last one blindly gives ":1]" for the bare "[::1]", which is not a port.
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

/** Only string|number|boolean are accepted, and never an object's methods. */
function typed(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** Read a body without buffering past the cap, so a chunked upload cannot OOM us. */
async function readCapped(
  request: Request,
  cap: number,
): Promise<{ text: string } | { tooBig: number } | { broken: string }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > cap) return { tooBig: declared };

  // request.text() reads the whole thing into memory first, which is how a
  // 300MB chunked upload with no Content-Length reached 261MB of RSS before any
  // size check ran. Counting as the bytes arrive makes the cap a real bound.
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
    // A truncated stream arrives here, not as a short string.
    return { broken: e instanceof Error ? e.message : String(e) };
  }
  return { text: Buffer.concat(parts).toString("utf8") };
}

export async function startServer(opts: ServerOptions = {}) {
  const profile = await mkdtemp(join(tmpdir(), "letterpress-server-"));
  const browser = await Browser.launch({ profile, extraArgs: opts.browserArgs });
  opts.onReady?.(browser);

  const viewerDir = join(import.meta.dir, "..", "viewer");
  // A render holds a tab, a work directory and a work server. Thirty at once
  // measured 4.7GB of chromium, so concurrency is bounded.
  //
  // Bounding concurrency is not the same as refusing. Measured at eight
  // concurrent requests against the bounded version: four rendered and four came
  // back 429. A burst is not eight independent failures, it is eight documents
  // that all need printing, and turning half of them into errors costs the caller
  // a retry that would otherwise not have been needed. So overflow waits in a
  // FIFO queue of bounded depth, and only a queue that is itself full is refused.
  //
  // The queue is what makes the wait safe rather than unbounded: at the measured
  // drain rate of about 6 renders a second, sixteen queued clear in under three
  // seconds, which is inside any client's deadline.
  let active = 0;
  let queued = 0;
  const waiters: Array<() => void> = [];

  /** Take a concurrency slot, or queue for one. Returns null when the queue is full. */
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

  /** Give a slot back, handing it straight to the next waiter if there is one. */
  const release = () => {
    active--;
    waiters.shift()?.();
  };

  const inFlight = new Set<Promise<unknown>>();

  // Annotated because the /health branch reads server.port, which would make the
  // initializer reference itself through fetch.
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 8787,
    idleTimeout: 30,

    async fetch(request: Request): Promise<Response> {
      if (!hostAllowed(request.headers.get("host"))) {
        return Response.json(
          { ok: false, error: "this server only answers requests addressed to loopback" },
          { status: 403 },
        );
      }
      if (!originAllowed(request, `http://127.0.0.1:${server.port}`)) {
        return Response.json(
          { ok: false, error: "this server only answers its own viewer, not other web pages" },
          { status: 403 },
        );
      }
      // Every route below can throw: a malformed request line reaches new URL,
      // and a 4000-character asset path reaches Bun.file. An uncaught throw in a
      // fetch handler returns Bun's development error page, which contains this
      // file's source and the server's absolute path. One JSON error instead.
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return badRequest("could not parse the request url");
      }

      try {
        if (url.pathname === "/health") {
          // The bound port, not the requested one: port 0 means "any free port",
          // and reporting 0 back would be a lie a client cannot use.
          //
          // chromium is asked, not asserted. The literal true it replaced kept
          // reporting healthy through a browser crash while every render failed,
          // which is the worst shape a health check can have: green, and useless.
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
            // no-store, because the shell is served from disk with no version
            // in its url. Chromium then heuristically cached it and served a
            // stale copy: an element added to index.html was absent from the
            // dom after a reload, which looks exactly like the markup being
            // wrong. Verified while QAing the first shell.
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }

        // Static assets for the viewer, confined to the viewer directory.
        if (url.pathname.startsWith("/assets/")) {
          const name = url.pathname.slice("/assets/".length);
          const target = join(viewerDir, name);
          // A crafted path must not escape the viewer directory. The separator
          // matters: a prefix check without it would accept viewer-x for viewer.
          if (!target.startsWith(viewerDir + "/")) {
            return new Response("forbidden", { status: 403 });
          }
          // A path long enough to exceed the kernel's limit throws ENAMETOOLONG
          // out of exists(), which is what leaked source before.
          if (name.length > 512 || name.includes("\0")) {
            return new Response("not found", { status: 404 });
          }
          const file = Bun.file(target);
          if (!(await file.exists())) return new Response("not found", { status: 404 });
          // Serve html as text/html and js as text/javascript rather than letting
          // the browser sniff, so a staged asset cannot be coaxed into running
          // as a different type than it is.
          const ext = target.slice(target.lastIndexOf("."));
          const type = ext === ".html" ? "text/html; charset=utf-8"
            : ext === ".js" || ext === ".mjs" ? "text/javascript; charset=utf-8"
            : ext === ".css" ? "text/css; charset=utf-8"
            : ext === ".json" ? "application/json"
            : undefined;
          return new Response(file, type
            ? { headers: { "content-type": type, "cache-control": "no-store" } }
            : { headers: { "cache-control": "no-store" } });
        }

        if (url.pathname !== "/render" || request.method !== "POST") {
          return new Response("not found", { status: 404 });
        }

        // Requiring an unsafelisted content type is what actually keeps a foreign
        // web origin out, because the browser must preflight and the preflight
        // gets no CORS headers back. Verified: without it a page on another
        // origin rendered successfully and read back an opaque response.
        const type = (request.headers.get("content-type") ?? "").split(";")[0].trim();
        if (type !== "application/json") {
          return Response.json({
            ok: false,
            error: `send content-type: application/json, not "${type || "nothing"}"`,
          }, { status: 415 });
        }

        // Refuse before reading the body when the queue is already full: an 8MB body is
        // not worth receiving for a request that will be turned away. Below that
        // the request waits for a slot instead, which is the whole point.
        if (active >= MAX_CONCURRENT_RENDERS && queued >= MAX_QUEUED_RENDERS) {
          return Response.json({
            ok: false,
            error: `${MAX_CONCURRENT_RENDERS} renders are running and ${MAX_QUEUED_RENDERS} are queued, which is the limit. retry shortly.`,
          }, { status: 429, headers: { "retry-after": "2" } });
        }

        const read = await readCapped(request, MAX_BODY_BYTES);
        if ("tooBig" in read) {
          return Response.json({
            ok: false,
            error: `document is ${(read.tooBig / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
          }, { status: 413 });
        }
        if ("broken" in read) return badRequest(`body stream ended early: ${read.broken}`);

        let body: RenderBody;
        try {
          body = JSON.parse(read.text);
        } catch (e) {
          return badRequest(`body is not valid JSON: ${(e as Error).message}`);
        }
        // null parses fine, and then every property read below throws.
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return badRequest("body must be a JSON object");
        }

        if (body.path !== undefined) {
          return badRequest("path is not accepted. send the html.");
        }
        if (typeof body.html !== "string") {
          // Deliberately no `path`. The earlier version accepted one, which made
          // this an unauthenticated read of any file the user can open: posting
          // {"path":"/etc/passwd"} returned a pdf whose text layer was the file,
          // and {"path":"/proc/self/environ"} returned the server's own
          // environment. The viewer sends html and has no use for a path.
          return badRequest("send html as a string");
        }
        if (body.html.length > MAX_BODY_BYTES) {
          return Response.json({
            ok: false,
            error: `document is ${(body.html.length / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
          }, { status: 413 });
        }
        // Object.hasOwn, not `in`: "toString" satisfies `in` on the prototype
        // chain and would reach the renderer as a valid format.
        // Present but not a string is a mistake worth naming. Silently dropping
        // it would render at a size the caller did not ask for, which is the
        // failure this endpoint should never have.
        if (body.format !== undefined && typeof body.format !== "string") {
          return badRequest(`format must be a string, got ${Array.isArray(body.format) ? "array" : typeof body.format}`);
        }
        const format = typed(body.format);
        if (format !== undefined && !Object.hasOwn(FORMATS, String(format).toLowerCase())) {
          return badRequest(`unknown format "${format}". try: ${Object.keys(FORMATS).join(", ")}`);
        }
        if (body.pageRanges !== undefined && typeof body.pageRanges !== "string") {
          return badRequest("pageRanges must be a string like \"1-3\"");
        }
        // A margin that is not a CSS length is a typo, and the CLI names the
        // mistake rather than letting it reach the renderer, which reports
        // "unsupported margin" and a 500.
        if (body.margin !== undefined) {
          if (typeof body.margin !== "string") {
            return badRequest("margin must be a string like \"15mm\"");
          }
          const m = body.margin.trim();
          // Checked here as well as in the renderer, so a bad value is a 400
          // with a usable message instead of a 500 from deep inside the print
          // call. The unit set matches toInches exactly: every absolute unit,
          // no relative ones, because those cannot be resolved before layout.
          // A bare 0 needs no unit.
          const isLength = /^0(?:\.0+)?$/.test(m) ||
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
        for (const key of ["printBackground", "allowNetwork", "landscape"] as const) {
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
        // Clamped, because a deadline is a resource hold. An earlier version
        // accepted timeoutMs: 1000000000 and pinned a tab, a work directory and a
        // work server for the full duration, from any client that could reach it.
        const clamp = (value: unknown, max: number, fallback: number) => {
          const n = typed(value);
          if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
          return Math.min(Math.max(n, 0), max);
        };

        const slot = acquire();
        if (!slot) {
          // The queue filled while the body was being read, which is the only way
          // to arrive here having passed the check above.
          return Response.json({
            ok: false,
            error: `the render queue filled up while this request was being read. retry shortly.`,
          }, { status: 429, headers: { "retry-after": "2" } });
        }
        // Only now does the request hold a slot: waiting for one must not count
        // against the concurrency cap, or a queue would deadlock itself.
        await slot;

        const work = (async () => {
          try {
            const result = await render(browser, {
              html: body.html!,
              format: format as Format | undefined,
              landscape: body.landscape === true,
              margin: typeof body.margin === "string" ? body.margin.trim() || undefined : undefined,
              // The viewer's checkbox is "Background", checked by default, which
              // is the inverse of the CLI's --no-background flag.
              printBackground: body.printBackground !== false,
              // Off unless the caller asks. A preview has no business fetching
              // remote assets silently, and the CLI's default is the same.
              allowNetwork: body.allowNetwork === true,
              pageRanges: body.pageRanges,
              maxImagePpi: clamp(body.maxImagePpi, 1200, undefined as unknown as number),
              settleMs: clamp(body.settleMs, MAX_SETTLE_MS, undefined as unknown as number),
              timeoutMs: clamp(body.timeoutMs, MAX_TIMEOUT_MS, undefined as unknown as number),
            });
            return Response.json({
              ok: true,
              pdf: Buffer.from(result.pdf).toString("base64"),
              pages: result.info.pages,
              bytes: result.pdf.byteLength,
              ms: result.ms,
              mediaBoxes: result.info.mediaBoxes,
              tagged: result.info.tagged,
              findings: result.findings,
              // When pageRanges is used, pages is the count emitted, not the
              // document length. Say so, or a client will present it as a total.
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

        // Tracked so shutdown can wait for it. An untracked render in flight when
        // the server stops leaves its work directory behind, which is how two
        // /tmp/letterpress-* directories outlived the process that made them.
        inFlight.add(work);
        try {
          return await work;
        } finally {
          inFlight.delete(work);
        }
      } catch (e) {
        // Nothing below throws on purpose, but a mistake here must not return
        // Bun's error page with this file's source in it.
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    },
  });

  // Chromium's zygote and crashpad outlive Browser.close: close() signals the
  // browser over CDP and the parent exits, but the children get reparented to
  // init and keep running. Measured on this machine, two servers left 14
  // processes and over 200MB behind, which is the leak this whole project
  // spent time learning to avoid. Reap by profile: only our own processes match.
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
          // The browser process must die before its children, or a supervisor
          // could restart them.
          process.kill(pid, "SIGTERM");
        } catch {
          /* the process exited while we were looking at it */
        }
      }
      await Bun.sleep(700);
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
          if (!cmdline.includes(profile)) continue;
          process.kill(Number(entry), "SIGKILL");
        } catch { /* gone */ }
      }
    } catch {
      // /proc is not always available. Browser.close already ran; a leftover
      // process is better than a failed shutdown.
    }
  }

  const stop = async () => {
    // Let renders finish before the browser goes. Tearing the browser down
    // mid-render is what strands work directories: render() removes its own in a
    // finally, but a render killed by a dying socket never reaches it, and two
    // /tmp/letterpress-* directories were measured surviving the process that made
    // them. A bounded wait, because a render on an infinite loop will not end.
    if (inFlight.size) {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        Bun.sleep(4_000),
      ]);
    }
    // Anything still queued will never get a slot now, so release it rather than
    // leaving those requests waiting on a promise nothing will resolve. Without
    // this a shutdown with queued requests hangs until every client's deadline.
    for (const waiter of waiters.splice(0)) waiter();
    server.stop(true);
    await browser.close();
    await reapChromium();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    // Anything a render still owns, now that nothing is writing to it. render()
    // names its work directories letterpress-<pid>-<n>, so the pid makes this exact
    // rather than a guess: the profile is letterpress-server-* and another
    // process's directories carry its own pid.
    const { readdir } = await import("node:fs/promises");
    const ours = `letterpress-${process.pid}-`;
    for (const entry of await readdir(tmpdir()).catch(() => [] as string[])) {
      if (!entry.startsWith(ours)) continue;
      await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => {});
    }
  };

  return { server, browser, stop, port: server.port };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  // Keep a handle on stop(): the signal handler has to run the full teardown,
  // which means the browser, the profile reap, and the temp directory.
  const running = await startServer({
    port,
    browserArgs: process.env.HTML2PDF_WEBMCP ? ["--enable-blink-features=WebMCP"] : [],
  });
  process.stdout.write(`letterpress viewer on http://127.0.0.1:${running.port}\n`);

  // process.exit on a signal leaves ten Chromium processes orphaned, holding
  // about a gigabyte, because the zygote and crashpad children get reparented
  // to init. Teardown has to run first, with a deadline in case it hangs.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      const forced = setTimeout(() => process.exit(1), 6_000);
      running.stop()
        .catch(() => {})
        .finally(() => {
          clearTimeout(forced);
          process.exit(0);
        });
    });
  }
}