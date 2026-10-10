# Guideline adoption (coding-guidelines v0.12)

Baseline 2026-10-10, Bun + TypeScript 7.0.2 codebase (18 src files, 23 test files).

## Adopted, enforced in CI (`gates` job)

- Format: Prettier 3.9.9 (`bunx prettier --check`). One-time normalization applied.
- Lint: ESLint core recommended + `no-warning-comments` + `no-empty` (allowEmptyCatch for best-effort kills). Covers `tools/` (`.mjs`); `.ts` is covered by `tsc --noEmit` — type-aware lint is blocked until typescript-eslint supports TS 7.
- Types: `tsc --noEmit`, clean.
- Spelling: cspell 10 on `README.md` + `docs/*.md` (en-GB + 40 domain words in `cspell.yaml`).
- Complexity ratchet: `tools/ratchet.mjs` fails on any NEW CC>15/L>200 function. 14 known breaches baselined in `waivers/baseline.lizard.txt`.
- Coverage: `bun run coverage` ≥85% lines (measured 93.28 local / 89.94 CI). Floor sits 5 points below the lowest observed: coverage is font/browser-env-sensitive (±3 measured), so a tight floor would fail on noise, not regressions. Runs in the `suite` job, not `gates`: line hits depend on the same fonts/readers the suite installs.
- Commits: commitlint (conventional) on new commits. History before adoption is exempt.
- Suite: `bun test` (505 pass) + typecheck + CLI render proof, unchanged.

## Deviations with rationale (not silent)

- No type-aware ESLint: typescript-eslint refuses TS 7.0 (https://github.com/typescript-eslint/typescript-eslint/issues/10940, https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). Revisit when the tracker closes. `tsc --noEmit` stays the type gate.
- Comments: 134 in `src/` + 31 in CI config, kept. They carry load-bearing why-context (font dependence, env traps). No machine enforcement on existing code; new code follows the spirit (names over narration).
- Complexity: 14 known CC>15 functions waived with this file as justification; all are parser/renderer hot spots, all covered by tests.
- Browser test `selection.test.ts` fails without Chromium + DejaVu/Noto fonts (local env); passes in CI where the workflow installs them. Environment-gated, not a product defect.
