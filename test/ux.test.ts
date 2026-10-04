import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { render } from "../src/render.ts";
import { main } from "../src/cli.ts";
import { render as fillTemplate } from "../src/template.ts";
import { pdfText } from "./poppler.ts";

let browser: Browser;
let profile: string;
let dir: string;

/** Run the CLI in-process and capture what a user would see. */
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
  profile = await mkdtemp(join(tmpdir(), "html2pdf-ux-"));
  dir = await mkdtemp(join(tmpdir(), "html2pdf-ux-doc-"));
  browser = await Browser.launch({ profile });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 20_000);

const DOC = `<!doctype html><style>@page{size:A4;margin:9mm}</style><h1>Real</h1>`;

describe("input that is not html", () => {
  // Chromium will print a JPEG. It decodes the bytes as a broken document and
  // lays the binary out as text, so a full page of mojibake came back with exit
  // 0 and a summary line that read like success. A typo'd extension produced a
  // confidently reported broken document.
  test("binary files are refused by signature", async () => {
    // A 1x1 JPEG and a 1x1 PNG, byte for byte.
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
    // Deterministic, and guaranteed to contain a null byte.
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
    // 875 bytes, one page, exit 0: a truncated pipe or a curl that returned
    // nothing looked exactly like a working render.
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
    // A failed fetch resolves to empty html too. The empty check has to stay off
    // this path, or it blames a 0-byte file for a DNS failure.
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
    // "render failed: cdp socket closed" told the user nothing, and Bun printed
    // its own NaN warning to stderr alongside it.
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
    // --settle abc silently became NaN, which meant no extra wait at all.
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
    // need() rejects anything starting with "-", so a valid CSS margin reported
    // "option --margin needs a value" for a value that was right there.
    const r = await cli([p, "--format", "a4", "--margin", "-5mm", "-o", join(dir, "o.pdf")]);
    expect(r.err).not.toContain("needs a value");
  }, 60_000);
});

describe("an error finding is not success", () => {
  test("an ignored --landscape exits non-zero", async () => {
    const p = join(dir, "psize.html");
    await writeFile(p, `<!doctype html><style>@page{size:a5;margin:8mm}</style><p>x</p>`);
    // The finding said severity "error" while ok was true and the exit code 0,
    // so a script grepping stderr or reading .ok saw success on a request the
    // tool had just called a failure.
    const r = await cli([p, "--landscape", "--json", "-o", join(dir, "o.pdf")]);
    expect(r.code).toBe(1);
    // The human line leads with "error:" and carries the message; the code is
    // only in the json, which is the right split.
    expect(r.err).toContain("--landscape had no effect");
    expect(r.err).toContain("the pdf was written, but a finding above is an error");
    // Every channel agrees: exit 1, ok false, and the finding is right there.
    const parsed = JSON.parse(r.out) as {
      ok: boolean; path: string; findings: Array<{ code: string; severity: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.path).toContain(".pdf");
    expect(parsed.findings.map((f) => f.code)).toContain("orientation-ignored");
    // The pdf still exists, because it was written before the check.
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
    // String() on a JSON array joins with commas, and that reached the page as a
    // visible "," printed above the table header of a customer-facing invoice.
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
    // "template is missing values for: vat_rate must be a number between 0 and 1"
    // contradicted itself. The message either names the value as missing or
    // describes what is wrong with it. A complete file, so the rate is the only
    // thing wrong with it.
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
  // 4*96.4 + 2*512 = 1409.60, plus 20% vat.
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
    // "abc" stripped of non-digits left "", and Number("") is 0, which produced
    // "abc, but the line items add up to 1,409.60".
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
    // The check only ran when items was present, so a hand-written rows array
    // printed whatever subtotal the file claimed.
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
    // The stray comma that sat above the DESCRIPTION header.
    expect(text).not.toMatch(/^\s*,\s*$/m);
  }, 90_000);
});
describe("ctrl-c cancels", () => {
  test("SIGINT ends the run at once, with the conventional exit code", async () => {
    // Measured before the handler existed: SIGINT was swallowed, the render ran
    // on for another 296 seconds past the deadline the user had given up on,
    // then reported a timeout that had not happened and exited 1. Someone
    // watching a five minute render had no way out.
    const { readdir, readFile } = await import("node:fs/promises");
    const big = join(dir, "huge.html");
    await writeFile(
      big,
      `<!doctype html><style>@page{size:A4;margin:8mm}</style>${
        Array.from({ length: 60_000 }, (_, i) => `<p>line ${i} of a long document</p>`).join("")
      }`,
    );

    const before = (await readdir(tmpdir())).length;
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), big,
      "--timeout", "300000", "-o", join(dir, "cancelled.pdf")], {
      stdout: "pipe", stderr: "pipe",
    });

    // Wait for chromium to come up, so the signal lands mid-render rather than
    // during startup. A fixed settle is enough and keeps this test honest about
    // what it is measuring.
    await Bun.sleep(9_000);
    // Scoped to this run's profile directory. Counting every chromium on the
    // machine measures this test file's own beforeAll browser, which is about
    // eleven processes and has nothing to do with the child.
    const strays = async () =>
      (await Bun.$`ps -eo args`.text())
        .split("\n").filter((l) => l.includes("chromium-browser") && l.includes("html2pdf-cli-")).length;
    const alive = await strays();
    expect(alive, "chromium should be running before the signal").toBeGreaterThan(2);
    // If the render already finished, this test measures nothing at all. A warm
    // chromium turned a 6000-line document round in under nine seconds once.
    expect(child.killed).toBe(false);
    expect(child.signalCode).toBeNull();

    const sentAt = Date.now();
    child.kill("SIGINT");
    const code = await child.exited;
    const elapsed = Date.now() - sentAt;

    // 128 + SIGINT, and nothing like the 296 seconds it used to take.
    expect(code).toBe(130);
    expect(elapsed, `took ${elapsed}ms after the signal`).toBeLessThan(15_000);

    // No partial output: a half-written pdf is worse than none.
    expect(await Bun.file(join(dir, "cancelled.pdf")).exists()).toBe(false);

    // And no orphaned chromium. It was 3 to 7 processes lingering about twenty
    // seconds, which is enough to trip a CI check for stray processes.
    //
    // Counted directly rather than by diffing /tmp, which is shared and would
    // measure every other process on the machine.
    // Polled rather than sampled at a fixed instant: measured standalone the
    // count reaches zero immediately, and under a loaded machine a crashpad
    // handler can still be a second late. What matters is that nothing is
    // orphaned, not that the kernel reaped it within 2000ms.
    let remaining = await strays();
    for (let waited = 0; waited < 15_000 && remaining > 0; waited += 500) {
      await Bun.sleep(500);
      remaining = await strays();
    }
    expect(remaining, "chromium processes for this run after the signal").toBe(0);
    void before;
  }, 120_000);
});
