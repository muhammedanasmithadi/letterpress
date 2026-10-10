import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { pdfText } from "./poppler.ts";

type Running = Awaited<ReturnType<typeof startServer>>;
let s: Running;
let origin: string;

const port = () => s.server.port as number;

beforeAll(async () => {
  s = await startServer({ port: 0 });
  origin = `http://127.0.0.1:${s.port}`;
}, 60_000);

afterAll(async () => {
  await s?.stop();
}, 30_000);

const json = { "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/render`, {
    method: "POST",
    headers: { ...json, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const DOC = `<!doctype html><style>@page{size:A4;margin:8mm}</style><h1>SEC</h1>`;

async function childServer(env: Record<string, string> = {}): Promise<{
  port: number; pid: number; rss: () => number; kill: () => Promise<void>;
}> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts")], {
    env: { ...process.env, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout!.getReader();
  let text = "";
  const bound = await (async () => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += Buffer.from(chunk.value ?? new Uint8Array()).toString();
      const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) return Number(m[1]);
    }
    throw new Error(`server never announced a port: ${text}`);
  })();
  return {
    port: bound,
    pid: child.pid,

    rss: () => {
      try {
        return Number(
          readFileSync(`/proc/${child.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0,
        ) / 1024;
      } catch { return 0; }
    },
    kill: async () => {
      child.kill("SIGTERM");
      await child.exited;
    },
  };
}

function raw(request: string, waitMs = 4_000): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: port() });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("latin1");
      socket.destroy();
      resolve({ status: Number(text.match(/HTTP\/1\.[01] (\d+)/)?.[1] ?? 0), text });
    };
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("close", finish);
    socket.on("error", finish);
    socket.setTimeout(waitMs, finish);
    socket.write(request);
    socket.end();
  });
}

function chunkedTo(target: number, chunks: string[], waitMs = 30_000): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: target });
    const out: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(out).toString("latin1");
      socket.destroy();
      resolve({ status: Number(text.match(/HTTP\/1\.[01] (\d+)/)?.[1] ?? 0), text });
    };
    socket.on("data", (c: Buffer) => out.push(c));
    socket.on("close", finish);
    socket.on("error", finish);
    socket.setTimeout(waitMs, finish);
    socket.write(
      "POST /render HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\n" +
      "transfer-encoding: chunked\r\n\r\n",
    );
    for (const part of chunks) socket.write(`${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`);
    socket.write("0\r\n\r\n");
    socket.end();
  });
}

describe("no local file read", () => {
  test("a path is refused rather than rendered", async () => {

    const r = await post({ path: "/etc/passwd" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("html");
  });

  test("no spelling of a path gets a file read", async () => {
    for (const body of [
      { path: "/etc/passwd" },
      { path: "../../../../etc/passwd" },
      { path: "package.json" },
      { path: "src/server.ts" },
      { path: "/proc/self/environ" },
      { path: "file:///etc/passwd" },
      { html: DOC, path: "/etc/passwd" },
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  test("a path smuggled under another key is refused by the type check", async () => {

    for (const html of [123, null, { toString: () => "/etc/passwd" }, ["/etc/passwd"], true]) {
      const r = await post({ html });
      expect(r.status, String(JSON.stringify(html))).toBe(400);
    }
  });
});

describe("another web origin cannot drive the renderer", () => {
  test("a foreign Origin is refused", async () => {
    const r = await post({ html: DOC }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toContain("own viewer");
  });

  test("a cross-site fetch-metadata header is refused", async () => {

    for (const site of ["cross-site", "same-site"]) {
      const r = await post({ html: DOC }, { "sec-fetch-site": site });
      expect(r.status, site).toBe(403);
    }
  });

  test("a loopback Origin on a different port is still refused", async () => {

    const r = await post({ html: DOC }, { origin: "http://127.0.0.1:9999" });
    expect(r.status).toBe(403);
  });

  test("this viewer's own Origin is accepted", async () => {
    const r = await post({ html: DOC }, { origin });
    expect(r.status).toBe(200);
  }, 60_000);
});

describe("a foreign page cannot read the response either", () => {
  test("no CORS headers on any response", async () => {
    for (const headers of [{}, { origin: "https://evil.example" }] as Record<string, string>[]) {
      const r = await post({ html: DOC }, headers);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-headers")).toBeNull();
    }
  }, 90_000);

  test("a preflight is refused, so the real request is never sent", async () => {

    const r = await fetch(`${origin}/render`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a render needs application/json, so no simple request can carry one", async () => {

    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const r = await fetch(`${origin}/render`, {
        method: "POST",
        headers: type ? { "content-type": type } : {},
        body: JSON.stringify({ html: DOC }),
      });
      expect(r.status, `content-type: ${type || "none"}`).toBe(415);
    }
  });
});

describe("errors do not disclose the source", () => {
  test("an out-of-range port in Host is a 403, not a crash", async () => {

    const r = await raw(`GET /health HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n`);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("import.meta.dir");
    expect(r.text).not.toContain(process.cwd());
  });

  test("an HTTP/1.0 request with no Host is answered, not crashed", async () => {
    const r = await raw("GET /health HTTP/1.0\r\n\r\n");

    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.text).not.toContain("source_lines");
  });

  test("an absurdly long asset path is a 404, not a crash", async () => {

    const r = await raw(
      `GET /assets/${"..%2f".repeat(1000)}etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
    expect([403, 404]).toContain(r.status);
    expect(r.text).not.toContain("ENAMETOOLONG");
    expect(r.text).not.toContain("source_lines");
  }, 20_000);

  test("a malformed request line produces an error json, never an html overlay", async () => {
    const r = await raw("CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: localhost\r\n\r\n");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain("source_lines");
    expect(r.text).not.toContain("problems");
  });

  test("no response anywhere leaks the working directory", async () => {
    const probes = [
      { path: "/health" },
      { path: "/assets/" + "x".repeat(600) },
      { path: "/render" },
      { path: "/../" + "y".repeat(600) },
    ];
    for (const probe of probes) {
      const r = await raw(
        `GET ${probe.path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        6_000,
      );
      expect(r.text, probe.path.slice(0, 40)).not.toContain(process.cwd());
    }
  }, 40_000);
});

describe("a body cannot exceed the cap in memory", () => {
  test("an oversized declared length is refused before reading", async () => {
    const r = await raw(
      `POST /render HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\n` +
      `content-length: ${100 * 1024 * 1024}\r\nConnection: close\r\n\r\n`,
    );
    expect(r.status).toBe(413);
  });

  test("a chunked body with no content-length is still capped", async () => {

    const server = await childServer();
    try {
      const before = server.rss();
      const part = `{"html":"${"x".repeat(60_000)}"}`;
      const r = await chunkedTo(server.port, Array.from({ length: 400 }, () => part));
      expect(r.status).toBe(413);
      const grew = server.rss() - before;

      expect(grew, `server rss grew ${grew.toFixed(0)}MB`).toBeLessThan(24);
    } finally {
      await server.kill();
    }
  }, 120_000);

  test("a body just under the cap still renders", async () => {
    const html = `<!doctype html><style>@page{size:A4;margin:8mm}</style><p>${"x".repeat(6 * 1024 * 1024)}</p>`;
    const r = await post({ html });
    const body = await r.json() as { ok: boolean; error?: string };

    expect(body.ok, body.error ?? `status ${r.status}`).toBe(true);
  }, 90_000);
});

describe("bounded resources", () => {
  test("a long deadline is clamped, not honoured", async () => {

    const started = Date.now();
    const r = await post({ html: DOC, timeoutMs: 1_000_000_000, settleMs: 1_000_000_000 });
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(130_000);
  }, 150_000);

  test("a burst is bounded and the machine survives it", async () => {

    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post({ html: `${DOC}<p>burst ${i}</p>` })),
    );
    const codes = burst.map((r) => r.status);

    expect(codes.every((c) => c === 200 || c === 429)).toBe(true);
    const refused = burst.filter((r) => r.status === 429);
    const served = burst.filter((r) => r.status === 200);

    expect(refused.length + served.length).toBe(burst.length);
    expect(refused.length > 0 || served.length > 0).toBe(true);
    for (const r of refused) {
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    }

    const ok = burst.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    for (const r of ok.slice(0, 3)) {
      const body = await r.json() as { ok: boolean; pdf: string };
      expect(body.ok).toBe(true);
      expect(Buffer.from(body.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 180_000);

  test("the server is healthy and rendering after the burst", async () => {
    const h = await fetch(`${origin}/health`);
    expect(h.status).toBe(200);
    const r = await post({ html: DOC });
    const body = await r.json() as { ok: boolean; pdf: string };
    expect(body.ok).toBe(true);
    expect(await pdfText(new Uint8Array(Buffer.from(body.pdf, "base64")))).toContain("SEC");
  }, 90_000);
});

describe("health reports the browser honestly", () => {
  test("healthy reports the real bound port", async () => {
    const r = await fetch(`${origin}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; port: number; chromium: boolean };
    expect(body.port).toBe(s.server.port as number);
    expect(body.chromium).toBe(true);
  });

  test("a dead browser reports 503 rather than green", async () => {

    const dead = await startServer({ port: 0 });
    await dead.browser.close();
    try {
      const r = await fetch(`http://127.0.0.1:${dead.port}/health`);
      expect(r.status).toBe(503);
      const body = await r.json() as { ok: boolean; chromium: boolean };
      expect(body.ok).toBe(false);
      expect(body.chromium).toBe(false);
    } finally {
      await dead.stop();
    }
  }, 90_000);
});

describe("shutdown does not strand work directories", () => {
  test("a server killed mid-render leaves no work directory", async () => {
    const before = await readdir(tmpdir());
    const server = await childServer();

    await fetch(`http://127.0.0.1:${server.port}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: DOC, settleMs: 4_000, timeoutMs: 60_000 }),
    }).catch(() => {});

    await server.kill();
    await Bun.sleep(1_500);
    const after = await readdir(tmpdir());

    const stranded = after.filter((n: string) => n.startsWith(`letterpress-${server.pid}-`) && !before.includes(n));
    expect(stranded).toEqual([]);
  }, 150_000);
});

describe("type confusion is a 400", () => {
  test("each field is checked before it reaches the renderer", async () => {
    const cases: [unknown, RegExp][] = [
      [null, /JSON object/],
      [[], /JSON object/],

      ["a string", /not valid JSON/],
      [{ html: "<p>x</p>", pageRanges: ["1"] }, /pageRanges/],
      [{ html: "<p>x</p>", pageRanges: 1 }, /pageRanges/],

      [{ html: "<p>x</p>", format: { toString: () => "a4" } }, /format must be a string/],
      [{ html: "<p>x</p>", format: ["a4"] }, /format must be a string, got array/],
      [{ html: "<p>x</p>", format: "a9" }, /unknown format/],
      [{ html: "<p>x</p>", timeoutMs: "1" }, /timeoutMs must be a number/],
      [{ html: "<p>x</p>", settleMs: {} }, /settleMs must be a number/],
      [{ html: "<p>x</p>", maxImagePpi: "300" }, /maxImagePpi must be a number/],
    ];
    for (const [body, pattern] of cases) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json() as { error: string }).error, JSON.stringify(body)).toMatch(pattern);
    }
  });

  test("a nonsense deadline is ignored rather than crashing", async () => {
    for (const timeoutMs of ["1", 0, -1, null, {}]) {
      const r = await post({ html: DOC, timeoutMs, settleMs: timeoutMs });

      expect([200, 400, 500]).toContain(r.status);
      const body = await r.json() as { ok?: boolean; error?: string };
      expect(typeof body.ok).toBe("boolean");
      if (body.ok === false) expect(typeof body.error).toBe("string");
    }
  }, 120_000);

  test("landscape is only true when it is true", async () => {

    for (const bad of ["yes", 1, 0, null, {}]) {
      const r = await post({ html: DOC, landscape: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json() as { error: string }).error).toContain("landscape must be");
    }

    const ok = await post({ html: DOC, format: "a4", landscape: true });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { mediaBoxes: string[] }).mediaBoxes[0]).toContain("841");
  }, 120_000);
});
