import { describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The render-pool limits are read from the environment when server.ts is first imported,
// so a test that needs a pool of one has to be a process of its own. Same reason the
// numbers here are set through the child's environment rather than through options.
const QUEUE_PROBE = `
process.env.HTML2PDF_MAX_RENDERS = "1";
process.env.HTML2PDF_MAX_QUEUE = "4";
const { startServer } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'server.ts'))});
const s = await startServer();
const url = "http://127.0.0.1:" + s.port + "/render";
// Big enough that a render takes far longer than the few milliseconds between the two
// posts, so the second one is certainly still waiting when stop() runs.
const html = '<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>R</h1>' +
  Array.from({ length: 300 }, (_, i) => "<p>Paragraph " + i + " with enough words to take a little while.</p>").join("") +
  "</style></body>";
const post = (tag) => {
  const t0 = Date.now();
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ html, author: tag }) })
    .then(async (r) => ({ tag, status: r.status, retry: r.headers.get("retry-after"), ms: Date.now() - t0, body: (await r.text()).slice(0, 140) }))
    .catch((e) => ({ tag, status: "threw", retry: null, ms: Date.now() - t0, body: String(e && e.message) }));
};
// Fired together: the pool holds one render, so one of these is given the slot and the
// other waits. Which is which is not deterministic and not asserted.
const both = [post("a"), post("b")];
await Bun.sleep(250);
await s.stop();
console.log(JSON.stringify({ results: await Promise.all(both) }));
process.exit(0);
`;

describe('shutting down with a render still queued', () => {
  // stop() used to resolve the queue waiters *after* the drain, which granted each of
  // them a slot: the render started, and then had its socket closed while the browser
  // shut down underneath it. The client saw "The socket connection was closed
  // unexpectedly" -- a transport failure, with no status code and no explanation.
  test('a queued render is told the server is stopping, not dropped', async () => {
    const script = join(import.meta.dir, '..', '.queue-probe.tmp.ts');
    await writeFile(script, QUEUE_PROBE, 'utf8');
    try {
      const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).not.toContain('threw');
      expect(code, `probe failed: ${stderr}`).toBe(0);

      const { results } = JSON.parse(stdout) as {
        results: Array<{ status: unknown; retry: string | null; ms: number; body: string }>;
      };
      expect(results.length).toBe(2);

      const served = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 503);
      // A pool of one and two requests at once: exactly one ran, exactly one was told.
      expect(served.length, JSON.stringify(results)).toBe(1);
      expect(refused.length, JSON.stringify(results)).toBe(1);
      expect(results.filter((r) => r.status === 'threw')).toEqual([]);

      expect(refused[0]!.retry).toBe('5');
      expect(refused[0]!.body).toContain('shutting down');
    } finally {
      await rm(script, { force: true }).catch(() => {});
    }
  }, 120_000);
});
