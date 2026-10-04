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
 * Chromium with the user's fonts. Loopback binding is the primary control; the
 * Host check is what stops a page on another origin from reaching it by
 * resolving an attacker-controlled name to 127.0.0.1, which is DNS rebinding.
 * Neither is a defence against a local process, and neither is meant to be.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;

export type ServerOptions = {
  port?: number;
  /** Extra launch arguments for the browser, e.g. the WebMCP feature flag. */
  browserArgs?: string[];
  /** Called before serving starts, with the running browser. */
  onReady?: (browser: Browser) => void;
};

export type RenderBody = {
  html?: string;
  path?: string;
  format?: string;
  landscape?: boolean;
  pageRanges?: string;
  maxImagePpi?: number;
  settleMs?: number;
  timeoutMs?: number;
};

function hostAllowed(host: string | null): boolean {
  // No Host header at all means a non-browser client, which is fine: the loopback
  // bind is what limits it. Only a browser-supplied Host can be rebound.
  if (host === null) return true;
  return LOOPBACK_HOST.test(host);
}

function badRequest(message: string) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export async function startServer(opts: ServerOptions = {}) {
  const profile = await mkdtemp(join(tmpdir(), "html2pdf-server-"));
  const browser = await Browser.launch({ profile, extraArgs: opts.browserArgs });
  opts.onReady?.(browser);

  const viewerDir = join(import.meta.dir, "..", "viewer");

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
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        // The bound port, not the requested one: port 0 means "any free port",
        // and reporting 0 back would be a lie a client cannot use.
        return Response.json({ ok: true, port: server.port, chromium: true });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const file = Bun.file(join(viewerDir, "index.html"));
        if (!(await file.exists())) {
          return new Response("viewer not built yet", { status: 404 });
        }
        return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // Static assets for the viewer, confined to the viewer directory.
      if (url.pathname.startsWith("/assets/")) {
        const name = url.pathname.slice("/assets/".length);
        const target = join(viewerDir, name);
        // A crafted path must not escape the viewer directory.
        if (!target.startsWith(viewerDir)) return new Response("forbidden", { status: 403 });
        const file = Bun.file(target);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file);
      }

      if (url.pathname !== "/render" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) {
        return Response.json({
          ok: false,
          error: `document is ${(declared / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
        }, { status: 413 });
      }

      let body: RenderBody;
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return Response.json({
          ok: false,
          error: `document is ${(text.length / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
        }, { status: 413 });
      }
      try {
        body = JSON.parse(text);
      } catch (e) {
        return badRequest(`body is not valid JSON: ${(e as Error).message}`);
      }

      if (body.html == null && body.path == null) {
        return badRequest("send html or path");
      }
      if (body.format && !(body.format in FORMATS)) {
        return badRequest(`unknown format "${body.format}". try: ${Object.keys(FORMATS).join(", ")}`);
      }

      try {
        const result = await render(browser, {
          ...(body.html != null ? { html: body.html } : { path: body.path }),
          format: body.format as Format | undefined,
          landscape: body.landscape ?? false,
          pageRanges: body.pageRanges,
          maxImagePpi: body.maxImagePpi,
          settleMs: body.settleMs,
          timeoutMs: body.timeoutMs,
          // A preview has no business fetching remote assets, and the CLI's
          // default is the same. Callers that want it must ask.
          allowNetwork: false,
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
    server.stop(true);
    await browser.close();
    await reapChromium();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
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
  process.stdout.write(`html2pdf viewer on http://127.0.0.1:${running.port}\n`);

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