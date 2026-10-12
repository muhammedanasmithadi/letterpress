# Guideline adoption (coding-guidelines v0.12)

Baseline 2026-10-10, Bun + TypeScript 7.0.2 codebase (18 src files, 23 test files).

## Adopted, enforced in CI (`gates` job)

- Format: oxfmt 0.72.0 (`bun run format:check`; config migrated from Prettier via `oxfmt --migrate=prettier`). One-time normalization applied.
- Lint: oxlint 1.87.0 `--max-warnings 0` over `src/ test/ tools/ viewer/` (ESLint-compatible IDs: `no-unused-vars`, `no-empty`, `no-warning-comments`, `typescript/no-explicit-any`). oxlint carries its own TS parser, so it covers `.ts` now — the typescript-eslint/TS 7 blocker below is gone. `no-empty` keeps `allowEmptyCatch` for best-effort kills.
- TS patterns: `tools/lint-ts.mjs` bans `as any`, `console.*`, `debugger`, marker comments in `src/` + `test/` (AST-exact via TS 5.9 parser sidecar — TS 7 ships no compiler API; grammar verified clean on all 41 files).
- Duplication: `bun run dup` fails on any new clone vs `waivers/baseline.jscpd.json` (57 clones / 526 lines today; product clones extracted twice: `objsByNum`, `bracketEnd`; remainder is test-file import boilerplate, budgeted in the baseline).
- Supply chain: `bun audit` clean (268 packages). Secrets: gitleaks pre-commit hook (the Action now needs a license key; the hook at pinned rev covers staged/all files).
- Types: `tsc --noEmit`, clean — with `noUnusedLocals` + `noUnusedParameters` on (12 dead declarations removed to get there).
- Next ratchet, enforced: `noUncheckedIndexedAccess` is on — 62 sites fixed without behavior change (guards, destructure defaults, tuple types; `!` only in tests on fixtures).
- Spelling: cspell 10 on `README.md` + `docs/*.md` (en-GB + 40 domain words in `cspell.yaml`).
- Security scan: Semgrep `p/default` on `src/` + `tools/` (verified action refs were stale; runs via pinned pip instead). Gate fails on ERROR severity only; loopback bench URLs carry rule-targeted `nosemgrep` (justified: no external traffic). Placement trap, verified: the suppression must sit on the finding's start line (own-line comments do not suppress), guarded by a formatter guard (`prettier-ignore`, which oxfmt honours) so formatting cannot move it.
- Lint overrides: `.oxlintrc.json` waives pre-existing findings the old `eslint tools` never saw — `typescript/no-explicit-any` in the DevTools plumbing (`src/browser.ts`, `src/chromium.ts`) and the bench harnesses (`tools/bench-*.ts`), plus `no-control-regex` and `no-useless-escape` in `src/render.ts`. The `any`s are dynamic protocol/JSON envelopes whose typing is a refactor, not a lint fix; the renderer regexes match raw PDF bytes, where control characters are legitimate. Every other finding the new gate surfaced was fixed mechanically (unused imports, a redundant `\-` escape, two redundant spreads).
- Security backlog adjudicated 2026-10-11, all safe: the 7 dynamic-RegExp sites use linear patterns (character classes, no nested quantifiers) over PDF bytes, and every interpolated value is either a code literal or escaped (`rolePattern` now escapes like the `want` builder). `rolePattern` hardening commit covers the one unescaped case.
- Complexity ratchet: `tools/ratchet.mjs` fails on any NEW CC>15/L>200 function. 6 known breaches baselined in `waivers/baseline.lizard.txt`. Several were split into helpers during the oxlint/oxfmt migration (`#onMessage`, `readString`, `replay`, `unresolvedLigatures`, `parseSfnt`, `fixFontDescriptors`, `mergeBlock`, `parseArgs`, `buildTemplateData`) and one stale entry (`parseW`, fixed earlier) was dropped. Splitting `parseArgs` also fixed a lizard parse slip that had been hiding `main`; it is baselined pending its own split. `textFlow` (CC 24) stays waived pending a split decision once the font work settles.
- Coverage: `bun run coverage` ≥85% lines (measured 93.28 local / 89.94 CI). Floor sits 5 points below the lowest observed: coverage is font/browser-env-sensitive (±3 measured), so a tight floor would fail on noise, not regressions. Runs in the `suite` job, not `gates`: line hits depend on the same fonts/readers the suite installs.
- Commits: commitlint (conventional) on new commits. History before adoption is exempt.
- Suite: `bun test` (505 pass) + typecheck + CLI render proof, unchanged.

## Deviations with rationale (not silent)

- No type-aware lint: oxlint runs without `--type-aware` (its own parser, no compiler types). `tsc --noEmit` stays the type gate. typescript-eslint still refuses TS 7.0 (https://github.com/typescript-eslint/typescript-eslint/issues/10940, https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
- Comments: 134 in `src/` + 31 in CI config, kept. They carry load-bearing why-context (font dependence, env traps). No machine enforcement on existing code; new code follows the spirit (names over narration).
- Complexity: 6 known CC>15 functions waived with this file as justification; all are parser/renderer hot spots, all covered by tests.
- Browser test `selection.test.ts` fails without Chromium + DejaVu/Noto fonts (local env); passes in CI where the workflow installs them. Environment-gated, not a product defect.
- Tests assert properties, never incidental formatting (quote style, whitespace). A formatter run must not break the suite.
