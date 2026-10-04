import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { pdfInfo, pdfText } from "./poppler.ts";

type Running = Awaited<ReturnType<typeof startServer>>;
let s: Running;
let origin: string;

beforeAll(async () => {
  // Port 0 asks the OS for a free port, and the returned port is the real one.
  // Reading it back from the startServer result rather than assuming 8787 keeps
  // concurrent test files from colliding.
  s = await startServer({ port: 0 });
  origin = `http://127.0.0.1:${s.port}`;
}, 60_000);

afterAll(async () => {
  await s?.stop();
}, 20_000);

const DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 10mm; @bottom-center { content: "page " counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { font-family: sans-serif }
</style></head><body><h1>Server fixture</h1><p>Rendered over HTTP.</p></body></html>`;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("health", () => {
  test("reports readiness without rendering", async () => {
    const r = await fetch(`${origin}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; port: number };
    expect(body.ok).toBe(true);
    // Bun types the bound port as optional even though a bound server always has one.
    expect(body.port).toBe(s.server.port as number);
  });
});

describe("render", () => {
  test("returns a real pdf that poppler can read", async () => {
    const r = await post({ html: DOC });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      ok: boolean; pdf: string; pages: number; bytes: number; ms: number;
      mediaBoxes: string[]; tagged: boolean; findings: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.tagged).toBe(true);
    expect(body.mediaBoxes[0]).toContain("594.95996");
    expect(body.findings).toEqual([]);

    const pdf = Buffer.from(body.pdf, "base64");
    expect(pdf.byteLength).toBe(body.bytes);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    // Assert on the decoded document, not on the response being 200.
    expect((await pdfInfo(new Uint8Array(pdf))).pages).toBe(1);
    expect(await pdfText(new Uint8Array(pdf))).toContain("Rendered over HTTP");
  }, 60_000);

  test("honours a format and reports the conflict with @page", async () => {
    const r = await post({ html: DOC, format: "letter" });
    const body = await r.json() as { mediaBoxes: string[]; findings: Array<{ code: string }> };
    expect(body.mediaBoxes[0]).toMatch(/612/);
    expect(body.findings.map((f) => f.code)).toContain("page-size-override");
  }, 60_000);

  test("pageRanges is marked partial so the count is not read as a total", async () => {
    const many = `<!doctype html><style>@page{size:A4;margin:6mm}
body{margin:0}.s{break-before:page;height:275mm;font-size:30pt}</style>
${Array.from({ length: 6 }, (_, i) => `<div class="s">PAGE_${i + 1}</div>`).join("")}`;

    const full = await (await post({ html: many })).json() as { pages: number; partial: boolean };
    expect(full.pages).toBe(6);
    expect(full.partial).toBe(false);

    const part = await (await post({ html: many, pageRanges: "2-3" })).json() as {
      pages: number; partial: boolean; pdf: string;
    };
    expect(part.pages).toBe(2);
    expect(part.partial).toBe(true);
    const text = await pdfText(new Uint8Array(Buffer.from(part.pdf, "base64")));
    expect(text).toContain("PAGE_2");
    expect(text).toContain("PAGE_3");
    expect(text).not.toContain("PAGE_1");
  }, 90_000);

  test("rejects a body with neither html nor path", async () => {
    const r = await post({ format: "a4" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("send html or path");
  });

  test("rejects an unknown format rather than guessing", async () => {
    const r = await post({ html: DOC, format: "a9" });
    expect(r.status).toBe(400);
    const { error } = await r.json() as { error: string };
    expect(error).toContain("unknown format");
    expect(error).toContain("a4");
  });

  test("rejects malformed json", async () => {
    const r = await post("{not json");
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("not valid JSON");
  });

  test("refuses an oversized document with 413", async () => {
    const huge = `<!doctype html><p>${"x".repeat(9 * 1024 * 1024)}</p>`;
    const r = await post(huge);
    expect(r.status).toBe(413);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/over the 8MB limit/);
  }, 60_000);

  test("a render failure is a 500 with a readable message, not a crash", async () => {
    const r = await post({ path: "/tmp/definitely-not-here.html" });
    expect(r.status).toBe(500);
    const { error } = await r.json() as { error: string };
    // A missing file is reported by name rather than swallowed.
    expect(error).toContain("definitely-not-here.html");
  }, 60_000);

  test("the server is still healthy after a failure", async () => {
    const r = await fetch(`${origin}/health`);
    expect((await r.json() as { ok: boolean }).ok).toBe(true);
    const again = await post({ html: DOC });
    expect((await again.json() as { ok: boolean }).ok).toBe(true);
  }, 60_000);
});

describe("loopback boundary", () => {
  test("refuses a request whose Host is not loopback", async () => {
    // This is the DNS rebinding case: the socket goes to 127.0.0.1 but the
    // browser-supplied Host names somewhere else.
    const r = await post({ html: DOC }, { host: "attacker.example" });
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toContain("loopback");
  });

  test("accepts every loopback spelling", async () => {
    for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "[::1]"]) {
      const r = await post({ html: DOC }, { host });
      expect(r.status, `Host: ${host}`).toBe(200);
    }
  }, 90_000);

  test("sends no CORS headers, so another origin cannot read responses", async () => {
    const r = await post({ html: DOC }, { origin: "https://evil.example" });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("access-control-allow-headers")).toBeNull();
  }, 60_000);
});

describe("routing", () => {
  test("unknown paths are 404", async () => {
    expect((await fetch(`${origin}/nope`)).status).toBe(404);
  });

  test("GET on /render is 404, not a render", async () => {
    expect((await fetch(`${origin}/render`)).status).toBe(404);
  });

  test("asset paths cannot escape the viewer directory", async () => {
    const r = await fetch(`${origin}/assets/..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(r.status);
    if (r.status === 200) throw new Error("traversal succeeded");
  });
});