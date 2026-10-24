"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const QUEUE_PROBE = `
process.env.HTML2PDF_MAX_RENDERS = "1";
process.env.HTML2PDF_MAX_QUEUE = "4";
const { startServer } = await import(${JSON.stringify((0, node_path_1.join)(import.meta.dir, '..', 'src', 'server.ts'))});
// Port 0, not the default: the probe runs alongside anything else on this machine --
// including a server started for a human -- and the default port belongs to whoever
// got there first. startServer reports the port it actually bound.
const s = await startServer({ port: 0 });
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
(0, bun_test_1.describe)('shutting down with a render still queued', () => {
    (0, bun_test_1.test)('a queued render is told the server is stopping, not dropped', async () => {
        const script = (0, node_path_1.join)(import.meta.dir, '..', '.queue-probe.tmp.ts');
        await (0, promises_1.writeFile)(script, QUEUE_PROBE, 'utf8');
        try {
            const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
            const [code, stdout, stderr] = await Promise.all([
                proc.exited,
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]);
            (0, bun_test_1.expect)(stderr).not.toContain('threw');
            (0, bun_test_1.expect)(code, `probe failed: ${stderr}`).toBe(0);
            const { results } = JSON.parse(stdout);
            (0, bun_test_1.expect)(results.length).toBe(2);
            const served = results.filter((r) => r.status === 200);
            const refused = results.filter((r) => r.status === 503);
            (0, bun_test_1.expect)(served.length, JSON.stringify(results)).toBe(1);
            (0, bun_test_1.expect)(refused.length, JSON.stringify(results)).toBe(1);
            (0, bun_test_1.expect)(results.filter((r) => r.status === 'threw')).toEqual([]);
            (0, bun_test_1.expect)(refused[0].retry).toBe('5');
            (0, bun_test_1.expect)(refused[0].body).toContain('shutting down');
        }
        finally {
            await (0, promises_1.rm)(script, { force: true }).catch(() => { });
        }
    }, 120_000);
});
//# sourceMappingURL=shutdown.test.js.map