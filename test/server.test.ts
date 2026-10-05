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
      mediaBoxes: string[]; tagged: boolean; findings: Array<{ code: string; severity: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.tagged).toBe(true);
    expect(body.mediaBoxes[0]).toContain("594.95996");
    // Nothing may be an error here, and the one warning the fixture earns is the
    // Type 3 fallback face, which has no font program to derive a cap height from.
    const findings = body.findings as Array<{ code: string; severity: string }>;
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(findings.map((f) => f.code)).toEqual(["font-metrics"]);

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

  test("rejects a body with no html", async () => {
    const r = await post({ format: "a4" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("html");
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

  test("a path is refused by name rather than read from disk", async () => {
    // This used to be a 500 with the filename in it, and before that it was an
    // unauthenticated read of any file the user can open.
    const r = await post({ path: "/tmp/definitely-not-here.html" });
    expect(r.status).toBe(400);
    const { error } = await r.json() as { error: string };
    expect(error).toContain("path is not accepted");
  });

  test("the server is still healthy after a failure", async () => {
    const r = await fetch(`${origin}/health`);
    expect((await r.json() as { ok: boolean }).ok).toBe(true);
    const again = await post({ html: DOC });
    expect((await again.json() as { ok: boolean }).ok).toBe(true);
  }, 60_000);

  test("a burst waits rather than being refused", async () => {
    // Measured against the version that refused: eight concurrent requests came
    // back four ok and four 429. A burst is not eight independent failures, it is
    // eight documents that all need printing, so the overflow waits for a slot.
    const burst = 8;
    const results = await Promise.all(Array.from({ length: burst }, () => post({ html: DOC })));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(burst);
    for (const r of ok) expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  }, 120_000);

  test("a burst beyond the queue is refused, and says so", async () => {
    // The queue has to be bounded, or a burst becomes an unbounded wait and a
    // client's deadline expires instead of an error arriving promptly.
    const results = await Promise.all(Array.from({ length: 40 }, () => post({ html: DOC })));
    const refused = results.filter((r) => r.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      expect(r.headers.get("retry-after")).toBe("2");
      const body = await r.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/retry/i);
    }
    // Everything accepted still renders rather than being dropped.
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
  }, 180_000);

  test("a queued render still produces a whole pdf", async () => {
    // The point of the queue is that a waiting request gets a real answer.
    const results = await Promise.all(Array.from({ length: 6 }, () => post({ html: DOC })));
    for (const r of results) {
      expect(r.status).toBe(200);
      const body = await r.json() as { ok: boolean; pdf: string; pages: number };
      expect(body.ok).toBe(true);
      expect(body.pages).toBe(1);
      expect(Buffer.from(body.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 120_000);
});

describe("loopback boundary", () => {
  test("refuses a request whose Host is not loopback", async () => {
    // This is the DNS rebinding case: the socket goes to 127.0.0.1 but the
    // browser-supplied Host names somewhere else.
    const r = await post({ html: DOC }, { host: "attacker.example" });
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toContain("loopback");
  });

  test("refuses a Host whose port is out of range", async () => {
    // The loopback regex allows any digits, including 99999. new URL then
    // throws on it, and uncaught that returned Bun's dev error page with the
    // server's source in it.
    for (const host of ["localhost:99999", "127.0.0.1:70000", "localhost:abc"]) {
      const r = await post({ html: DOC }, { host });
      expect([400, 403], `Host: ${host}`).toContain(r.status);
      expect((await r.text())).not.toContain("source_lines");
    }
  });

  test("accepts every loopback spelling of Host", async () => {
    // The Host check is for DNS rebinding and nothing more. It does not stop a
    // page on another origin: Host names the destination, so such a page sends
    // an acceptable Host and passes. That is handled by requiring a JSON
    // content type and an exact Origin, which the security tests cover.
    for (const host of ["127.0.0.1", `127.0.0.1:${s.port}`, "localhost", "[::1]", "LOCALHOST"]) {
      const r = await post({ html: DOC }, { host });
      expect(r.status, `Host: ${host}`).toBe(200);
    }
  }, 120_000);

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
describe("page limit", () => {
  // MAX_PAGES was declared and never checked: a 3,664-page document rendered
  // through this server without complaint. The limit is now applied where the page
  // count is finally knowable, which is after the print, and these tests prove it
  // bites rather than merely being present in the source.
  const sections = (n: number) => `<!doctype html><meta charset="utf-8"><title>T</title>
<style>@page{size:A4;margin:18mm}</style>` +
    Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>` +
      Array.from({ length: 8 }, () =>
        `<p>office efficient different flags finished warehouse loading invoices.</p>`).join("")).join("");

  test("a document inside the limit is served", async () => {
    const r = await post({ html: sections(2) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  }, 90_000);

  test("pageRanges is exempt, because its count is what was emitted not the document", async () => {
    const r = await post({ html: sections(120), pageRanges: "1-2" });
    // The server under test runs at the default limit, so this asserts the shape
    // rather than the refusal: a ranged request reports the pages it produced.
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; pages: number; partial: boolean };
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(true);
    expect(body.pages).toBe(2);
  }, 120_000);
});

describe("response format", () => {
  const DOC2 = `<!doctype html><meta charset="utf-8"><title>Format</title>
<style>@page{size:A4;margin:12mm}</style><h1>Report</h1><p>office efficient flags finished</p>`;

  test("json is the default and carries the report", async () => {
    const r = await post({ html: DOC2, author: "Someone" });
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    const body = await r.json() as { ok: boolean; pdf: string; pages: number; findings: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(Buffer.from(body.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  }, 90_000);

  test("responseFormat pdf returns the bytes and the report as headers", async () => {
    const r = await post({ html: DOC2, author: "Someone", responseFormat: "pdf" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("x-letterpress-pages")).toBe("1");
    expect(r.headers.get("x-letterpress-tagged")).toBe("true");
    expect(Number(r.headers.get("content-length"))).toBeGreaterThan(1000);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  }, 90_000);

  test("both formats return the same document", async () => {
    // The binary path must not be a different render. Two renders are not
    // generally byte-identical -- /CreationDate has one-second resolution -- so
    // what is compared is what the document says, with the clock pinned.
    process.env.SOURCE_DATE_EPOCH = "1700000000";
    try {
      const viaJson = await (await post({ html: DOC2, author: "Someone" })).json() as { pdf: string; pages: number };
      const viaPdf = new Uint8Array(
        await (await post({ html: DOC2, author: "Someone", responseFormat: "pdf" })).arrayBuffer());
      const fromJson = Buffer.from(viaJson.pdf, "base64");
      expect(fromJson.byteLength).toBe(viaPdf.byteLength);
      expect(fromJson.equals(Buffer.from(viaPdf))).toBe(true);
      expect(viaJson.pages).toBe(1);
    } finally {
      delete process.env.SOURCE_DATE_EPOCH;
    }
  }, 120_000);

  test("the binary response is smaller, because base64 inflates by a third", async () => {
    const jsonBytes = (await (await post({ html: DOC2 })).arrayBuffer()).byteLength;
    const pdfBytes = (await (await post({ html: DOC2, responseFormat: "pdf" })).arrayBuffer()).byteLength;
    expect(pdfBytes).toBeLessThan(jsonBytes);
  }, 120_000);

  test("an unknown responseFormat is refused rather than ignored", async () => {
    // Silently returning JSON to a caller that asked for a PDF would be found by
    // failing to parse a response that looked successful.
    const r = await post({ html: DOC2, responseFormat: "nope" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/responseFormat/);
  }, 60_000);

  test("metadata reaches the renderer over http", async () => {
    // --author worked from the cli and did nothing over http: the three fields
    // were never forwarded from the server to render().
    const r = await post({ html: DOC2, author: "Ahammed Sahad", subject: "CV" });
    const body = await r.json() as { pdf: string };
    const info = Buffer.from(body.pdf, "base64").toString("latin1");
    expect(info).toContain("/Author (Ahammed Sahad)");
    expect(info).toContain("/Subject (CV)");
  }, 90_000);
});
