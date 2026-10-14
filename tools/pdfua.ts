import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { $ } from 'bun';

// veraPDF is not vendored (33MB of Java), so this points at an install: the XDG
// data dir, where `java -jar verapdf-installer.jar -options` puts it, or
// $VERA_PDF for anywhere else. An earlier default aimed at a scratch dir that
// survives no reboot; a wrong path here fails loudly below, by design.
const VERA_PDF =
  process.env.VERA_PDF ?? join(process.env.HOME ?? '~', '.local', 'share', 'verapdf', 'verapdf');

export type RuleFailure = {
  clause: string;
  testNumber: string;
  description: string;

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
  const details = /<details\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const passed = Number(/passedRules="(\d+)"/.exec(details)?.[1] ?? 0);
  const failedCount = Number(/failedRules="(\d+)"/.exec(details)?.[1] ?? 0);

  const rules = [...xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)];
  const failures: RuleFailure[] = [];
  for (const m of rules) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (!/status="failed"/.test(attrs)) continue;
    const checks = [...body.matchAll(/<check\b([^>]*)>([\s\S]*?)<\/check>/g)].filter((c) =>
      /status="failed"/.test(c[1] ?? ''),
    );
    failures.push({
      clause: /clause="([^"]*)"/.exec(attrs)?.[1] ?? '?',
      testNumber: /testNumber="([^"]*)"/.exec(attrs)?.[1] ?? '?',
      description: (/<description>([\s\S]*?)<\/description>/.exec(body)?.[1] ?? '').trim(),
      failingObjects: checks.length,
      contexts: checks.map((c) =>
        (/<context>([\s\S]*?)<\/context>/.exec(c[2] ?? '')?.[1] ?? '').trim(),
      ),
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

export async function check(file: string, profile = 'ua1'): Promise<Conformance> {
  if (!existsSync(VERA_PDF)) {
    throw new Error(
      `veraPDF not found at ${VERA_PDF}. Install it from https://software.verapdf.org/releases/ ` +
        `and set VERA_PDF to the launcher, or this check cannot run.`,
    );
  }

  const { stdout } = await $`${VERA_PDF} --format mrr -f ${profile} ${file}`.quiet().nothrow();
  const xml = stdout.toString();
  if (!xml.includes('<report>')) {
    throw new Error(
      `veraPDF produced no report for ${file}; it may not be a PDF, or it may be encrypted`,
    );
  }
  return parse(xml, file, profile);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args[0] === '--json';
  const files = (asJson ? args.slice(1) : args).filter((a) => a !== '--json');
  const profile = process.env.VERA_PROFILE ?? 'ua1';
  if (files.length === 0) {
    console.error('usage: bun tools/pdfua.ts [--json] <file.pdf> ...');
    process.exit(2);
  }

  const results: Conformance[] = [];
  for (const file of files) results.push(await check(file, profile));

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const head =
        `  ${basename(r.file).padEnd(28)} ${r.conforms ? 'PASS' : 'FAIL'} ` +
        `(${r.rulesEvaluated} rules, ${r.failures.length} failed)`;
      console.log(head);
      for (const f of r.failures) {
        console.log(`     [${f.clause}] x${f.failingObjects}  ${f.description.slice(0, 92)}`);
        if (f.contexts[0]) console.log(`            first: ${f.contexts[0].slice(0, 96)}`);
      }
    }
  }

  process.exit(results.every((r) => r.conforms) ? 0 : 1);
}
