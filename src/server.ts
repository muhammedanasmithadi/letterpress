import type { Server } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from './browser.ts';
import { FORMATS, render, type Format } from './render.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;

const MAX_CONCURRENT_RENDERS = Number(process.env.HTML2PDF_MAX_RENDERS ?? 4);

const MAX_QUEUED_RENDERS = Number(process.env.HTML2PDF_MAX_QUEUE ?? 16);

const MAX_TIMEOUT_MS = 120_000;
const MAX_SETTLE_MS = 30_000;

const MAX_PAGES = Number(process.env.HTML2PDF_MAX_PAGES ?? 6000);

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

function originAllowed(request: Request, ownOrigin: string): boolean {
  const origin = request.headers.get('origin');

  if (origin !== null && origin !== ownOrigin) return false;

  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;
  return true;
}

function hostAllowed(host: string | null): boolean {
  if (host === null) return true;
  if (!LOOPBACK_HOST.test(host)) return false;

  const bracketed = /^\[[0-9a-f:]+\](?::(\d{1,5}))?$/i.exec(host);
  if (bracketed) return !bracketed[1] || Number(bracketed[1]) <= 65535;
  const colon = host.lastIndexOf(':');
  if (colon === -1) return true;
  const port = host.slice(colon + 1);
  return /^\d{1,5}$/.test(port) && Number(port) <= 65535;
}

function badRequest(message: string) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

function typed(value: unknown): string | number | boolean | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

async function readCapped(
  request: Request,
  cap: number,
): Promise<{ text: string } | { tooBig: number } | { broken: string }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > cap) return { tooBig: declared };

  if (!request.body) return { text: '' };
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
  return { text: Buffer.concat(parts).toString('utf8') };
}

export async function startServer(opts: ServerOptions = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-server-'));
  const browser = await Browser.launch({ profile, extraArgs: opts.browserArgs });
  opts.onReady?.(browser);

  const viewerDir = join(import.meta.dir, '..', 'viewer');

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
    hostname: '127.0.0.1',
    port: opts.port ?? 8787,
    idleTimeout: 30,

    async fetch(request: Request): Promise<Response> {
      if (!hostAllowed(request.headers.get('host'))) {
        return Response.json(
          { ok: false, error: 'this server only answers requests addressed to loopback' },
          { status: 403 },
        );
      }
      if (!originAllowed(request, `http://127.0.0.1:${server.port}`)) {
        return Response.json(
          { ok: false, error: 'this server only answers its own viewer, not other web pages' },
          { status: 403 },
        );
      }

      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return badRequest('could not parse the request url');
      }

      try {
        if (url.pathname === '/health') {
          const alive = await browser.alive();
          return Response.json(
            { ok: alive, port: server.port, chromium: alive },
            { status: alive ? 200 : 503 },
          );
        }

        if (url.pathname === '/' || url.pathname === '/index.html') {
          const file = Bun.file(join(viewerDir, 'index.html'));
          if (!(await file.exists())) {
            return new Response('viewer not built yet', { status: 404 });
          }
          return new Response(file, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            },
          });
        }

        if (url.pathname.startsWith('/assets/')) {
          const name = url.pathname.slice('/assets/'.length);
          const target = join(viewerDir, name);

          if (!target.startsWith(viewerDir + '/')) {
            return new Response('forbidden', { status: 403 });
          }

          if (name.length > 512 || name.includes('\0')) {
            return new Response('not found', { status: 404 });
          }
          const file = Bun.file(target);
          if (!(await file.exists())) return new Response('not found', { status: 404 });

          const ext = target.slice(target.lastIndexOf('.'));
          const type =
            ext === '.html'
              ? 'text/html; charset=utf-8'
              : ext === '.js' || ext === '.mjs'
                ? 'text/javascript; charset=utf-8'
                : ext === '.css'
                  ? 'text/css; charset=utf-8'
                  : ext === '.json'
                    ? 'application/json'
                    : undefined;
          return new Response(
            file,
            type
              ? { headers: { 'content-type': type, 'cache-control': 'no-store' } }
              : { headers: { 'cache-control': 'no-store' } },
          );
        }

        if (url.pathname !== '/render' || request.method !== 'POST') {
          return new Response('not found', { status: 404 });
        }

        const type = (request.headers.get('content-type') ?? '').split(';')[0].trim();
        if (type !== 'application/json') {
          return Response.json(
            {
              ok: false,
              error: `send content-type: application/json, not "${type || 'nothing'}"`,
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
            { status: 429, headers: { 'retry-after': '2' } },
          );
        }

        const read = await readCapped(request, MAX_BODY_BYTES);
        if ('tooBig' in read) {
          return Response.json(
            {
              ok: false,
              error: `document is ${(read.tooBig / 1048576).toFixed(1)}MB, over the ${MAX_BODY_BYTES / 1048576}MB limit`,
            },
            { status: 413 },
          );
        }
        if ('broken' in read) return badRequest(`body stream ended early: ${read.broken}`);

        let body: RenderBody;
        try {
          body = JSON.parse(read.text);
        } catch (e) {
          return badRequest(`body is not valid JSON: ${(e as Error).message}`);
        }

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return badRequest('body must be a JSON object');
        }

        if (body.path !== undefined) {
          return badRequest('path is not accepted. send the html.');
        }
        if (typeof body.html !== 'string') {
          return badRequest('send html as a string');
        }

        if (body.format !== undefined && typeof body.format !== 'string') {
          return badRequest(
            `format must be a string, got ${Array.isArray(body.format) ? 'array' : typeof body.format}`,
          );
        }
        const format = typed(body.format);
        if (format !== undefined && !Object.hasOwn(FORMATS, String(format).toLowerCase())) {
          return badRequest(`unknown format "${format}". try: ${Object.keys(FORMATS).join(', ')}`);
        }
        if (body.pageRanges !== undefined && typeof body.pageRanges !== 'string') {
          return badRequest('pageRanges must be a string like "1-3"');
        }

        if (body.margin !== undefined) {
          if (typeof body.margin !== 'string') {
            return badRequest('margin must be a string like "15mm"');
          }
          const m = body.margin.trim();

          const isLength = /^0(?:\.0+)?$/.test(m) || /^-?\d*\.?\d+(mm|cm|in|pt|px|pc|q)$/.test(m);
          if (m && !isLength) {
            return badRequest(
              `margin "${body.margin}" is not an absolute css length. use mm, cm, in, pt, pc, ` +
                `px or a bare 0, such as 15mm or 1in. relative units like em and vw depend on layout ` +
                `and cannot be resolved before the page is printed.`,
            );
          }
          if (!Object.hasOwn(FORMATS, String(format ?? '').toLowerCase())) {
            return badRequest(
              "margin only applies alongside format, because a document's own @page margin wins otherwise. " +
                'send format too, or drop the margin.',
            );
          }
        }
        for (const key of ['printBackground', 'allowNetwork', 'landscape'] as const) {
          if (body[key] !== undefined && typeof body[key] !== 'boolean') {
            return badRequest(`${key} must be true or false`);
          }
        }
        for (const key of ['maxImagePpi', 'settleMs', 'timeoutMs'] as const) {
          if (body[key] === undefined || body[key] === null) continue;
          if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
            return badRequest(`${key} must be a number`);
          }
        }

        if (
          body.responseFormat !== undefined &&
          body.responseFormat !== null &&
          body.responseFormat !== 'json' &&
          body.responseFormat !== 'pdf'
        ) {
          return badRequest(
            `responseFormat must be "json" or "pdf", got "${String(body.responseFormat)}"`,
          );
        }

        const clamp = (value: unknown, max: number, fallback: number) => {
          const n = typed(value);
          if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
          return Math.min(Math.max(n, 0), max);
        };

        const slot = acquire();
        if (!slot) {
          return Response.json(
            {
              ok: false,
              error: `the render queue filled up while this request was being read. retry shortly.`,
            },
            { status: 429, headers: { 'retry-after': '2' } },
          );
        }

        await slot;

        const work = (async () => {
          try {
            const result = await render(browser, {
              html: body.html!,
              format: format as Format | undefined,
              landscape: body.landscape === true,
              margin: typeof body.margin === 'string' ? body.margin.trim() || undefined : undefined,

              printBackground: body.printBackground !== false,

              allowNetwork: body.allowNetwork === true,

              author: typeof body.author === 'string' ? body.author.trim() || undefined : undefined,
              subject:
                typeof body.subject === 'string' ? body.subject.trim() || undefined : undefined,
              keywords:
                typeof body.keywords === 'string' ? body.keywords.trim() || undefined : undefined,
              pageRanges: body.pageRanges,
              maxImagePpi: clamp(body.maxImagePpi, 1200, undefined as unknown as number),
              settleMs: clamp(body.settleMs, MAX_SETTLE_MS, undefined as unknown as number),
              timeoutMs: clamp(body.timeoutMs, MAX_TIMEOUT_MS, undefined as unknown as number),

              transfer: 'stream',
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

            if (body.responseFormat === 'pdf') {
              const headers = new Headers({
                'content-type': 'application/pdf',
                'content-length': String(result.pdf.byteLength),
                'x-letterpress-pages': String(result.info.pages),
                'x-letterpress-ms': String(result.ms),
                'x-letterpress-tagged': String(result.info.tagged),
                'x-letterpress-findings': String(result.findings.length),
              });

              return new Response(result.pdf as unknown as BodyInit, { status: 200, headers });
            }

            return Response.json({
              ok: true,
              pdf: Buffer.from(result.pdf).toString('base64'),
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
    if (!process.platform.toUpperCase().startsWith('LINUX')) return;
    try {
      const { readdir, readFile } = await import('node:fs/promises');
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
          if (!cmdline.includes(profile)) continue;

          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      await Bun.sleep(700);
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
          if (!cmdline.includes(profile)) continue;
          process.kill(Number(entry), 'SIGKILL');
        } catch {}
      }
    } catch {}
  }

  const stop = async () => {
    if (inFlight.size) {
      await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(4_000)]);
    }

    for (const waiter of waiters.splice(0)) waiter();
    server.stop(true);
    await browser.close();
    await reapChromium();
    await rm(profile, { recursive: true, force: true }).catch(() => {});

    const { readdir } = await import('node:fs/promises');
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

  const running = await startServer({
    port,
    browserArgs: process.env.HTML2PDF_WEBMCP ? ['--enable-blink-features=WebMCP'] : [],
  });
  process.stdout.write(`letterpress viewer on http://127.0.0.1:${running.port}\n`);

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
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
