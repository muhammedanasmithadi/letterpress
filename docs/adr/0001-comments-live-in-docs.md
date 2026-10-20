# ADR 0001: comments live in docs, not in the code

- Status: accepted
- Context: the coding guidelines (v0.18.0) say code reads by reading it, and
  that a comment explaining what the code does is the same sentence twice. This
  repository had 653 such comments in `src/`, `test/`, `viewer/` and `tools/`,
  many of them paragraphs of prose about a decision the code already makes.
  Some were carrying real weight: the reason a regexp is shaped the way it is,
  the measurement that showed a bug, the trap a future editor would walk into.
  Deleting them all would lose that. Leaving them all would keep the rule the
  guidelines rule out.
- Options: (a) leave the comments and record a deviation, as the previous
  adoption did; (b) delete every comment, losing the rationale; (c) move the
  rationale into `docs/` and delete the prose from the code.
- Decision: (c). The gate is `tools/lint-comments.mjs`, a ratchet in the shape
  of the duplication and complexity gates: `waivers/baseline.comments.json`
  records the current count, the count may fall but not rise, and a file that
  had no comments may not acquire some. Machine directives -- `noqa`,
  `prettier-ignore`, `nosemgrep` -- do not count, because they are
  instructions to a tool rather than prose. A comment that explains _what_ the
  code does is deleted; a comment that explains _why_ the code is shaped that
  way moves to `docs/`, where it can be longer, linked and dated.
- Consequences: the code gets shorter and the prose gets better, because prose
  that was squeezed into a comment can have the measurements and the dates in
  it. The gate is a ratchet rather than a zero, so the burn-down is visible
  rather than a single cliff; the baseline falls to zero as the last ones go.
  The count comes from the TypeScript scanner rather than a regex, because a
  `//` inside a string is not a comment and this repository ships a large block
  of browser JavaScript as a string.
