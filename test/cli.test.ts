import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfInfo, pdfText } from "./poppler.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let dir: string;
let doc: string;

const DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm; @bottom-center { content: counter(page) " of " counter(pages); font: 9pt sans-serif } }
body { font-family: sans-serif }
td { border: 0.5pt solid #999; padding: 2pt }
</style></head><body><h1>CLI fixture</h1><p>Rendered from a file.</p>
<table>${Array.from({ length: 24 }, (_, i) => `<tr><td>Row ${i + 1}</td></tr>`).join("")}</table>
</body></html>`;

async function run(args: string[], stdin?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "letterpress-cli-test-"));
  doc = join(dir, "fixture.html");
  await writeFile(doc, DOC, "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("renders a file and reports where it went", async () => {
  const out = join(dir, "one.pdf");
  const r = await run([doc, "-o", out]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/one\.pdf\s+2 pages\s+[\d.]+ KB\s+\d+ms/);
  const bytes = await Bun.file(out).arrayBuffer();
  expect(bytes.byteLength).toBeGreaterThan(1000);

  const info = await pdfInfo(new Uint8Array(bytes));
  expect(info.pages).toBe(2);
  expect(info.pageSize).toContain("594.96");
}, 60_000);

test("json output is machine readable", async () => {
  const out = join(dir, "two.pdf");
  const r = await run([doc, "-o", out, "--json"]);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.path).toBe(out);
  expect(parsed.pages).toBe(2);
  expect(parsed.bytes).toBeGreaterThan(1000);
  expect(typeof parsed.ms).toBe("number");
  expect(parsed.imageObjects).toBe(0);
  expect(Array.isArray(parsed.findings)).toBe(true);
}, 60_000);

test("derives the output name from the input", async () => {
  const r = await run([doc], undefined);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/fixture\.pdf/);
  expect(await Bun.file(join(process.cwd(), "fixture.pdf")).exists()).toBe(true);
  await rm(join(process.cwd(), "fixture.pdf"), { force: true });
}, 60_000);

test("reads HTML from stdin", async () => {
  const out = join(dir, "piped.pdf");
  const r = await run(["-", "-o", out, "--json"], "<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>From stdin</h1>");
  // The exit code alone is not enough to debug this. It failed once in nine runs
  // with a bare assertion failure, which says nothing about why.
  expect(r.code, `exit ${r.code}\nstdout: ${r.stdout.slice(0, 400)}\nstderr: ${r.stderr.slice(0, 600)}`).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.source).toBe("html");
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  expect(await pdfText(bytes)).toContain("From stdin");
}, 60_000);

test("a format override is applied and reported", async () => {
  const out = join(dir, "letter.pdf");
  const r = await run([doc, "-o", out, "--format", "letter", "--json"]);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.findings.some((f: any) => f.code === "page-size-override")).toBe(true);
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  expect((await pdfInfo(bytes)).pageSize).toMatch(/612/);
}, 60_000);

test("blocked remote assets surface as warnings but still render", async () => {
  const remote = join(dir, "remote.html");
  await writeFile(remote, `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:10mm}</style>
<link rel="stylesheet" href="https://example.invalid/x.css"><p>Kept.</p>`, "utf8");
  const out = join(dir, "remote.pdf");
  const r = await run([remote, "-o", out, "--json"]);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.blocked.some((u: string) => u.includes("example.invalid"))).toBe(true);
  expect(r.stderr).toContain("blocked a remote request");
}, 60_000);

test("bad usage exits 2 without launching a browser", async () => {
  for (const args of [["--format", "nope", "x.html"], ["--out"], ["--margin", "5mm", "x.html"], [], ["--bogus"]]) {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage");
  }
}, 30_000);

test("a missing input fails with a readable message and exit 1", async () => {
  const r = await run([join(dir, "does-not-exist.html")]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/render failed:/);
}, 60_000);

test("help exits 0 and documents the formats", async () => {
  const r = await run(["--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("a3 a4 a5 legal letter tabloid");
}, 30_000);