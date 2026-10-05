/**
 * PDF/UA-1 conformance, checked by veraPDF rather than by us.
 *
 * veraPDF is an independent implementation of the ISO 14289-1 rules, in the same
 * relationship to this project that poppler and ghostscript are: an outside reader
 * that can disagree with us. Every real defect found so far came from one of those
 * three, none from this repository's own tests, and the accessibility work had been
 * argued from mechanism rather than measured until this existed.
 *
 * The profile is not a prose checklist. It is 16 machine-evaluated rules, so
 * "conforms" here means veraPDF's verdict, not our reading of the standard.
 *
 * Usage:
 *   bun tools/pdfua.ts <file.pdf> [more.pdf ...]        text summary
 *   bun tools/pdfua.ts --json <file.pdf>                machine-readable
 *
 * Install veraPDF (free, GPL): https://software.verapdf.org/releases/ then point
 * VERA_PDF at the `verapdf` launcher. It is not vendored: 33MB of Java plus a
 * bundled JRE, used only by this tool.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { $ } from "bun";

const VERA_PDF = process.env.VERA_PDF ?? "/tmp/opencode/vp/verapdf";

export type RuleFailure = {
  clause: string;
  testNumber: string;
  description: string;
  /** veraPDF caps the reported contexts at 100 objects, so this is a lower bound. */
  failingObjects: number;
  contexts: string[];
};

export type Conformance = {
  file: string;
  profile: string;
  conforms: boolean;
  rulesEvaluated: number;
  failures: RuleFailure[];
};

function parse(xml: string, file: string, profile: string): Conformance {
  // The machine-readable report emits a <rule> element only for each *failure*;
  // passes are counted in attributes on <details> (`passedRules="105"`). Counting
  // <rule> elements therefore reports 1 rule evaluated on a file that has 106, and
  // it reported the ISO 32000-2 spec as having 16 rules when it has 123.
  const details = /<details\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const passed = Number(/passedRules="(\d+)"/.exec(details)?.[1] ?? 0);
  const failedCount = Number(/failedRules="(\d+)"/.exec(details)?.[1] ?? 0);

  // veraPDF writes attributes in a fixed order (clause, testNumber, status), so the
  // rules are pulled by element name rather than by matching attribute order --
  // a regex assuming `status` came first matched nothing and reported every file as
  // a pass.
  const rules = [...xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)];
  const failures: RuleFailure[] = [];
  for (const [, attrs, body] of rules) {
    if (!/status="failed"/.test(attrs)) continue;
    const checks = [...body.matchAll(/<check\b([^>]*)>([\s\S]*?)<\/check>/g)].filter(
      ([, a]) => /status="failed"/.test(a),
    );
    failures.push({
      clause: /clause="([^"]*)"/.exec(attrs)?.[1] ?? "?",
      testNumber: /testNumber="([^"]*)"/.exec(attrs)?.[1] ?? "?",
      description: (/<description>([\s\S]*?)<\/description>/.exec(body)?.[1] ?? "").trim(),
      failingObjects: checks.length,
      contexts: checks.map(([, , b]) => (/<context>([\s\S]*?)<\/context>/.exec(b)?.[1] ?? "").trim()),
    });
  }
  return {
    file,
    profile,
    conforms: failedCount === 0,
    rulesEvaluated: passed + failedCount,
    failures,
  };
}

export async function check(file: string, profile = "ua1"): Promise<Conformance> {
  if (!existsSync(VERA_PDF)) {
    throw new Error(
      `veraPDF not found at ${VERA_PDF}. Install it from https://software.verapdf.org/releases/ ` +
      `and set VERA_PDF to the launcher, or this check cannot run.`,
    );
  }
  // --format mrr is the machine-readable report; the default text form prints only
  // "PASS" or "FAIL" and no rule detail, which is useless for finding defects.
  //
  // quiet() captures stdout; nothrow() stops a non-zero exit from throwing. Both are
  // needed. Without quiet, the report is echoed to our own stdout as well as
  // captured; without nothrow, every non-compliant file raises -- which is to say,
  // every file worth looking at, since the exit code *is* the verdict.
  const { stdout } = await $`${VERA_PDF} --format mrr -f ${profile} ${file}`.quiet().nothrow();
  const xml = stdout.toString();
  if (!xml.includes("<report>")) {
    throw new Error(`veraPDF produced no report for ${file}; it may not be a PDF, or it may be encrypted`);
  }
  return parse(xml, file, profile);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args[0] === "--json";
  const files = (asJson ? args.slice(1) : args).filter((a) => a !== "--json");
  const profile = process.env.VERA_PROFILE ?? "ua1";
  if (files.length === 0) {
    console.error("usage: bun tools/pdfua.ts [--json] <file.pdf> ...");
    process.exit(2);
  }

  const results: Conformance[] = [];
  for (const file of files) results.push(await check(file, profile));

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const head = `  ${basename(r.file).padEnd(28)} ${r.conforms ? "PASS" : "FAIL"} ` +
        `(${r.rulesEvaluated} rules, ${r.failures.length} failed)`;
      console.log(head);
      for (const f of r.failures) {
        console.log(`     [${f.clause}] x${f.failingObjects}  ${f.description.slice(0, 92)}`);
        if (f.contexts[0]) console.log(`            first: ${f.contexts[0].slice(0, 96)}`);
      }
    }
  }
  // Non-zero when any file fails, so this can gate a build.
  process.exit(results.every((r) => r.conforms) ? 0 : 1);
}