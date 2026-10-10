import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { main } from "../src/cli.ts";
import { render as fillTemplate } from "../src/template.ts";
import { pdfInfo, pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;
let dir: string;

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "letterpress-ux-"));
  dir = await mkdtemp(join(tmpdir(), "letterpress-ux-doc-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 20_000);

const DOC = `<!doctype html><style>@page{size:A4;margin:9mm}</style><h1>Real</h1>`;

describe("input that is not html", () => {

  test("binary files are refused by signature", async () => {

    const files = {
      "photo.jpg": Buffer.from(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64",
      ),
      "logo.png": Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM" +
        "IQAAAABJRU5ErkJggg==", "base64",
      ),
    };
    for (const [name, bytes] of Object.entries(files)) {
      const p = join(dir, name);
      await writeFile(p, bytes);
      let message = "";
      try {
        await render(browser, { path: p });
      } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message, name).toMatch(/not HTML/);
      expect(message, name).toMatch(/wrong file extension/);
    }
  });

  test("a pdf fed as html is refused", async () => {
    const p = join(dir, "already.pdf");
    await writeFile(p, "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
    let message = "";
    try { await render(browser, { path: p }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toMatch(/it is a PDF/);
  });

  test("random binary is refused", async () => {
    const p = join(dir, "blob.dat");

    await writeFile(p, Buffer.from(Array.from({ length: 512 }, (_, i) => i % 7 === 0 ? 0 : 65 + (i % 26))));
    let message = "";
    try { await render(browser, { path: p }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toMatch(/null byte/);
  });

  test("the message tells the user what to do, not just what happened", async () => {
    const p = join(dir, "doc.jpg");
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    let message = "";
    try { await render(browser, { path: p }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toContain("check the path");
  });
});

describe("empty input", () => {
  test("an empty document is an error, not a blank page", async () => {

    for (const html of ["", "   \n\t  "]) {
      let message = "";
      try { await render(browser, { html }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message, JSON.stringify(html)).toMatch(/input is empty/);
    }
  });

  test("the message names both likely causes", async () => {
    let message = "";
    try { await render(browser, { html: "" }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toContain("stdout");
  });

  test("a url that fails to load keeps its own diagnosis", async () => {

    let message = "";
    try {
      await render(browser, {
        url: "https://this-host-does-not-exist-uxq9.invalid/",
        allowNetwork: true,
        timeoutMs: 20_000,
      });
    } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toMatch(/could not load|ERR_|HTTP \d\d\d/);
    expect(message).not.toContain("input is empty");
  }, 40_000);

  test("a real document is unaffected", async () => {
    expect((await render(browser, { html: DOC })).info.pages).toBe(1);
    expect((await render(browser, { html: "<!-- lead comment --><!doctype html><p>x</p>" })).info.pages).toBe(1);
    expect((await render(browser, { html: "   <p>leading whitespace</p>" })).info.pages).toBe(1);
  }, 60_000);
});

describe("numeric flags are validated", () => {
  test("a non-numeric timeout names the flag, not the protocol", async () => {

    const p = join(dir, "t.html");
    await writeFile(p, DOC);
    const r = await cli([p, "--timeout", "abc", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--timeout needs at least 1000ms");
    expect(r.err).toContain('got "abc"');
    expect(r.err).not.toContain("cdp socket");
  }, 20_000);

  test("a timeout below the floor is refused", async () => {
    const p = join(dir, "t.html");
    await writeFile(p, DOC);
    for (const v of ["0", "1", "999", "-1", "1.5", "1e9", ""]) {
      const r = await cli([p, "--timeout", v, "-o", join(dir, "o.pdf")]);
      expect(r.code, `--timeout ${v}`).toBe(2);
      expect(r.err).toContain("--timeout");
    }
  }, 30_000);

  test("a non-numeric settle is refused", async () => {
    const p = join(dir, "t.html");
    await writeFile(p, DOC);

    const r = await cli([p, "--settle", "abc", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--settle needs a whole number");
  }, 20_000);

  test("settle 0 is allowed, because not waiting is a decision", async () => {
    const p = join(dir, "t.html");
    await writeFile(p, DOC);
    const r = await cli([p, "--settle", "0", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(0);
  }, 60_000);

  test("a negative margin is a value, not a missing argument", async () => {
    const p = join(dir, "t.html");
    await writeFile(p, DOC);

    const r = await cli([p, "--format", "a4", "--margin", "-5mm", "-o", join(dir, "o.pdf")]);
    expect(r.err).not.toContain("needs a value");
  }, 60_000);
});

describe("an error finding is not success", () => {
  test("an ignored --landscape exits non-zero", async () => {
    const p = join(dir, "psize.html");
    await writeFile(p, `<!doctype html><style>@page{size:a5;margin:8mm}</style><p>x</p>`);

    const r = await cli([p, "--landscape", "--json", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);

    expect(r.err).toContain("--landscape had no effect");
    expect(r.err).toContain("the pdf was written, but a finding above is an error");

    const parsed = JSON.parse(r.out) as {
      ok: boolean; path: string; findings: Array<{ code: string; severity: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.path).toContain(".pdf");
    expect(parsed.findings.map((f) => f.code)).toContain("orientation-ignored");

    expect(await Bun.file(parsed.path).exists()).toBe(true);
  }, 60_000);

  test("a landscape that works exits 0", async () => {
    const p = join(dir, "psize.html");
    const r = await cli([p, "--format", "a4", "--landscape", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("error:");
  }, 60_000);

  test("a plain render with no findings exits 0", async () => {
    const p = join(dir, "plain.html");
    await writeFile(p, DOC);
    expect((await cli([p, "-o", join(dir, "o.pdf")])).code).toBe(0);
  }, 60_000);
});

describe("a raw token given an array does not print commas", () => {
  test("an array joins with newlines, not commas", () => {

    const tpl = "<table><tbody>{{{rows}}}</tbody></table>";
    const out = fillTemplate(tpl, { rows: ["<tr><td>a</td></tr>", "<tr><td>b</td></tr>"] });
    expect(out).not.toContain(",");
    expect(out).toContain("<tr><td>a</td></tr>");
    expect(out).toContain("<tr><td>b</td></tr>");
  });

  test("a string still passes through unchanged", () => {
    expect(fillTemplate("{{{rows}}}", { rows: "<tr><td>x</td></tr>" })).toBe("<tr><td>x</td></tr>");
  });

  test("commas inside a description are not touched", () => {
    const out = fillTemplate("{{{rows}}}", { rows: ["<tr><td>Sensor, fused silica</td></tr>"] });
    expect(out).toContain("Sensor, fused silica");
  });

  test("a number still renders", () => {
    expect(fillTemplate("{{{rows}}}", { rows: 42 })).toBe("42");
  });
});

describe("the template says what is wrong", () => {
  test("a rejected value is not reported as a missing one", async () => {

    const p = join(dir, "bad.json");
    await writeFile(p, JSON.stringify({
      paper: "A4", accent: "#1f4e79", font: "sans-serif", company: "Northwind",
      company_lines: ["Manchester"], invoice_no: "1", issued: "2026-10-03",
      due: "2026-11-02", bill_to_name: "Halcyon", bill_to_lines: ["Lyon"],
      items: [{ description: "x", qty: 1, unit: 10 }], currency: "GBP",
      note: "n", vat_rate: "twenty",
    }));
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("vat_rate must be a number between 0 and 1");
    expect(r.err).not.toContain("missing values for");
  }, 20_000);

  test("a genuinely missing value still says missing", () => {
    let message = "";
    try { fillTemplate("<p>{{needed}}</p>", {}); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    expect(message).toContain("missing values for");
    expect(message).toContain("needed");
  });
});

describe("invoice data is checked before it is printed", () => {
  const ITEMS = [
    { description: "Replacement sensor window", qty: 4, unit: 96.4 },
    { description: "Vacuum gauge", qty: 2, unit: 512 },
  ];

  const base = {
    paper: "A4", accent: "#1f4e79", font: "sans-serif", company: "Northwind",
    company_lines: ["Manchester"], invoice_no: "2026-014", issued: "2026-10-03",
    due: "2026-11-02", bill_to_name: "Halcyon Labs", bill_to_lines: ["Lyon"],
    items: ITEMS, currency: "GBP", note: "Within 30 days.",
  };
  const write = async (name: string, extra: Record<string, unknown> = {}) => {
    const p = join(dir, `${name}.json`);
    await writeFile(p, JSON.stringify({ ...base, ...extra }));
    return p;
  };

  test("a subtotal that disagrees with the items is refused", async () => {
    const p = await write("wrong_sub", { subtotal: "1" });
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("1,409.60");
  }, 20_000);

  test("a matching total with separators is accepted", async () => {
    const p = await write("match", { subtotal: "1,409.60", vat: "281.92", total: "1,691.52" });
    expect((await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")])).code).toBe(0);
  }, 60_000);

  test("a non-numeric total says so, rather than reporting a mismatch", async () => {

    const p = await write("nan_sub", { subtotal: "abc" });
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a number");
  }, 20_000);

  test("an empty items array is refused", async () => {
    const p = await write("no_items", { items: [] });
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("items is empty");
  }, 20_000);

  test("a vat rate that is not a fraction is refused", async () => {
    for (const vat_rate of [150, "twenty", -0.2, 2]) {
      const p = await write(`vat_${String(vat_rate)}`, { vat_rate });
      const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
      expect(r.code, String(vat_rate)).toBe(1);
      expect(r.err).toContain("between 0 and 1");
    }
  }, 40_000);

  test("pre-built rows cannot bypass the totals check", async () => {

    const p = await write("rows_only", {
      rows: '<tr><td>x</td></tr>',
      subtotal: "1",
      items: undefined,
    });
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rows is pre-built table markup");
    expect(r.err).toContain("items");
  }, 20_000);

  test("a line item with a non-numeric price is refused", async () => {
    const p = await write("bad_unit", { items: [{ description: "x", qty: 1, unit: "free" }] });
    const r = await cli(["-t", "invoice", "-d", p, "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a number");
  }, 20_000);
});

describe("the rendered invoice is what a customer would expect", () => {
  test("totals are computed, formatted and correct", async () => {
    const p = join(dir, "final.json");
    await writeFile(p, JSON.stringify({
      paper: "A4", accent: "#1f4e79", font: "sans-serif", company: "Northwind",
      company_lines: ["Manchester"], invoice_no: "2026-014", issued: "2026-10-03",
      due: "2026-11-02", bill_to_name: "Halcyon Labs", bill_to_lines: ["Lyon"],
      items: [
        { description: "Replacement sensor window", qty: 4, unit: 96.4 },
        { description: "Vacuum gauge", qty: 2, unit: 512 },
      ],
      currency: "GBP", note: "Within 30 days.",
    }));
    const out = join(dir, "final.pdf");
    const r = await cli(["-t", "invoice", "-d", p, "-o", out]);
    expect(r.code, r.err).toBe(0);
    const text = await pdfText(new Uint8Array(await Bun.file(out).arrayBuffer()));
    expect(text).toContain("1,409.60");
    expect(text).toContain("281.92");
    expect(text).toContain("1,691.52");
    expect(text).toContain("20%");
    expect(text).toContain("Replacement sensor window");

    expect(text).not.toMatch(/^\s*,\s*$/m);
  }, 90_000);
});
describe("ctrl-c cancels", () => {
  test("SIGINT ends the run at once, with the conventional exit code", async () => {

    const { readdir, readFile } = await import("node:fs/promises");
    const big = join(dir, "huge.html");
    await writeFile(
      big,
      `<!doctype html><style>@page{size:A4;margin:8mm}</style>${
        Array.from({ length: 60_000 }, (_, i) => `<p>line ${i} of a long document</p>`).join("")
      }`,
    );

    const { readdirSync: readSync } = await import("node:fs");
    const profileDirsBefore = new Set(
      readSync(tmpdir()).filter((n) => n.startsWith("letterpress-cli-") || n.startsWith("letterpress-server-")),
    );
    const before = (await readdir(tmpdir())).length;
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), big,
      "--timeout", "300000", "-o", join(dir, "cancelled.pdf")], {
      stdout: "pipe", stderr: "pipe",
    });

    await Bun.sleep(9_000);

    const chromiumForRun = async () =>
      (await Bun.$`ps -eo args`.text())
        .split("\n").filter((l) => l.includes("letterpress-cli-")).length;
    const alive = await chromiumForRun();
    expect(alive, "chromium should be running before the signal").toBeGreaterThan(2);

    expect(child.killed).toBe(false);
    expect(child.signalCode).toBeNull();

    const sentAt = Date.now();
    child.kill("SIGINT");
    const code = await child.exited;
    const elapsed = Date.now() - sentAt;

    expect(code).toBe(130);
    expect(elapsed, `took ${elapsed}ms after the signal`).toBeLessThan(15_000);

    expect(await Bun.file(join(dir, "cancelled.pdf")).exists()).toBe(false);

    const dirsNow = readSync(tmpdir()).filter(
      (n) => n.startsWith("letterpress-cli-") || n.startsWith("letterpress-server-"),
    );
    expect(
      dirsNow.filter((n: string) => !profileDirsBefore.has(n)),
      "left behind by this run",
    ).toEqual([]);

    let remaining = await chromiumForRun();
    for (let waited = 0; waited < 40_000 && remaining > 0; waited += 500) {
      await Bun.sleep(500);
      remaining = await chromiumForRun();
    }
    expect(remaining, "chromium processes for this run after the signal").toBe(0);
    void before;
  }, 120_000);
});

describe("stdin is bounded by the deadline", () => {
  test("a pipe that never closes is given up on", async () => {

    const fifo = join(dir, "fifo");
    await Bun.$`mkfifo ${fifo}`.quiet();

    const held = Bun.spawn([
      "sh", "-c",
      `exec 3> ${fifo}; printf '<!doctype html><p>partial' >&3; sleep 60`,
    ]);

    let child: { kill: (n?: number | NodeJS.Signals) => void } | undefined;
    let elapsed = 0;
    let err = "";
    try {
      await Bun.sleep(400);
      const { openSync } = await import("node:fs");
      const started = Date.now();
      const spawned = Bun.spawn(
        ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "-", "--timeout", "5000", "-o", join(dir, "s.pdf")],

        { stdin: openSync(fifo, "r"), stdout: "pipe", stderr: "pipe" },
      );
      child = spawned;
      err = await new Response(spawned.stderr).text();
      await spawned.exited;
      elapsed = Date.now() - started;
    } finally {

      child?.kill("SIGKILL");
      held.kill("SIGKILL");
    }

    expect(err).toContain("stdin was still open after 5s");

    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(20_000);
    expect(await Bun.file(join(dir, "s.pdf")).exists()).toBe(false);
  }, 90_000);

  test("a pipe that closes normally is unaffected", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "-", "--timeout", "30000", "-o", join(dir, "ok.pdf")],
      { stdin: Buffer.from(DOC), stdout: "pipe", stderr: "pipe" },
    );
    await child.exited;
    expect(await Bun.file(join(dir, "ok.pdf")).exists()).toBe(true);
    const bytes = new Uint8Array(await Bun.file(join(dir, "ok.pdf")).arrayBuffer());
    expect(await pdfText(bytes)).toContain("Real");
  }, 60_000);

  test("a slow trickle that finishes is still accepted", async () => {
    const child = Bun.spawn(
      ["sh", "-c", `printf '<!doctype html><p>Slow</p>'; sleep 3`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const pump = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "-", "--timeout", "30000", "-o", join(dir, "slow.pdf")],
      { stdin: child.stdout, stdout: "pipe", stderr: "pipe" },
    );
    await pump.exited;
    const bytes = new Uint8Array(await Bun.file(join(dir, "slow.pdf")).arrayBuffer());
    expect(await pdfText(bytes)).toContain("Slow");
  }, 60_000);
});

describe("the pdf title is not a loopback port", () => {
  test("a document with no title is titled after its file", async () => {

    const p = join(dir, "notitle.html");
    await writeFile(p, `<!doctype html><style>@page{size:A4;margin:9mm}</style><h1>No title</h1>`);
    for (const out of ["a.pdf", "b.pdf"]) {
      await cli([p, "-o", join(dir, out)]);
      const info = await pdfInfo(new Uint8Array(await Bun.file(join(dir, out)).arrayBuffer()));

      expect(info.title.trim(), out).toBe("notitle.html");
    }
  }, 150_000);

  test("a document that declares a title keeps it", async () => {
    const p = join(dir, "titled.html");
    await writeFile(p, `<!doctype html><title>My Real Title</title><p>x</p>`);
    await cli([p, "-o", join(dir, "t.pdf")]);
    const info = await pdfInfo(new Uint8Array(await Bun.file(join(dir, "t.pdf")).arrayBuffer()));
    expect(info.title.trim()).toBe("My Real Title");
  }, 60_000);

  test("the title is stable across runs without SOURCE_DATE_EPOCH", async () => {
    const p = join(dir, "stable.html");
    await writeFile(p, `<!doctype html><p>x</p>`);
    const titles = new Set<string>();
    for (const out of ["1.pdf", "2.pdf", "3.pdf"]) {
      await cli([p, "-o", join(dir, out)]);
      const info = await pdfInfo(new Uint8Array(await Bun.file(join(dir, out)).arrayBuffer()));
      titles.add(info.title.trim());
    }
    expect(titles.size).toBe(1);
  }, 120_000);

  test("a long filename does not corrupt the pdf", async () => {

    const name = `${"n".repeat(120)}.html`;
    const p = join(dir, name);
    await writeFile(p, `<!doctype html><p>long</p>`);
    const out = join(dir, "long.pdf");
    expect((await cli([p, "-o", out])).code).toBe(0);
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());

    expect((await pdfInfo(bytes)).pages).toBe(1);
    expect(await pdfText(bytes)).toContain("long");
  }, 60_000);
});
