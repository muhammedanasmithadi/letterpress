# Distribution

The engine runs on this machine as a Bun repo. Everything it needs is
here: the repair pipeline, the CDP driver, the audit, the CLI, the
server, 958 tests. Nothing is published anywhere. This document states
the packaging facts and the recommended install paths, cheapest first.

## Runtime facts that decide packaging

- The code is Bun-locked. `src/` calls `Bun.stdin`, `Bun.file`,
  `Bun.write`, `Bun.Glob`, `Bun.argv`, `Bun.which`, `Bun.serve`,
  `Bun.sleep`, `Bun.spawn`, `Bun.nanoseconds`. No runtime shim exists,
  so Node and Deno cannot execute the package today. Any registry
  listing must state "runs under Bun >= 1.4" (`engines` already does).
- The code is dependency-free at runtime (`dependencies: {}`); dev
  tooling is the only npm footprint. A distribution artifact never
  needs to bundle more than `src/`, `viewer/`, and the manifest.
- Chromium is not bundled and never will be in this repo: `src/chromium.ts`
  resolves the browser through `Bun.which`. A consumer needs a
  `chromium` or `chrome` binary on PATH; that is a documented
  requirement of every install path, not a bug to fix later.
- `src/cli.ts` already begins with `#!/usr/bin/env bun`, so a
  `bin`-linked entry executes correctly everywhere Bun invokes it.

## Worksheets in the manifest (shipped)

`package.json` now carries `bin` (`letterpress` → `src/cli.ts`),
a `repository` field, a version, and no `private` flag. Those are the
only manifest facts a registry-free install consumes. A guard test
(`test/manifest.test.ts`) pins the bin target to a bun-shebang script,
the bun-only engines claim, and the empty dependencies object, so the
packaging contract is tested, not remembered.

## Install paths, recommended order

**1. Git-tag install (works today, no credentials).** After a tag:

```
bun add github:muhammedanasmithadi/letterpress#v0.1.0
letterpress render in.html out.pdf
```

Bun resolves the repo, runs `bun install` semantics on it, links the
`bin` entry, and runs TypeScript directly. All it requires is the tag
pushed and the manifest facts listed above. This is the fastest honest
path: nothing more to build, no account to create.

**2. Compiled single-file binaries (self-contained, no registry).**
`bun build --compile src/cli.ts --outfile letterpress-linux-x64`
embeds the Bun runtime and all sources in one executable (~100 MB per
platform). Attach three artifacts to a GitHub release (linux, macos,
windows) and a consumer needs nothing at all except Chromium itself
and a way to run the file. Worth adding the first time someone asks
for a no-Bun install; until then it is a one-command release step, not
a priority.

**3. JSR publish (needs your account).** JSR suits the source shape:
TypeScript modules in, TS out, no build step to maintain. To scaffold:

```
# jsr.json at repo root
{
  "name": "@muhammedanasmithadi/letterpress",
  "version": "0.1.0",
  "exports": {
    ".": "./src/render.ts",
    "./cli": "./src/cli.ts"
  }
}
```

then `deno publish --dry-run`, fix slow types it reports, and publish
with your JSR token. Two constraints to hold on to before starting:
JSR type-checks everything it exports with Deno's no-slow-types rules,
and this codebase's Bun globals guarantee a few `// @ts-ignore`-grade
findings there; the honest move is to publish with the "Bun-only"
statement in jsr.json's README block and the README itself, not to
wrap `Bun.*` at every call site to appease a checker for a runtime the
package will never run under. Phase 2 only.

## What the maintainer must decide before any public publish

There is no LICENSE file. Under the default rules, code with no
license is all-rights-reserved: a tarball or a registry package
without one gives downstream users nothing they can rely on. Pick a
license (MIT dominates for this shape; Apache-2.0 if patent language
matters) before tagging anything public. After the license, the tag
itself is the last piece, since path 1 needs nothing else.
