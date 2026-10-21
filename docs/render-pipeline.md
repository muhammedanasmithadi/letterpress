# The render pipeline

How a document becomes a PDF, and the decisions that shape it. The modules are
`src/render.ts` (the orchestrator and the paper rules), `src/pageside.ts` (the
JavaScript that runs inside the page) and `src/lint.ts` (the page-side audit).

## Paper travels in CSS

Every paper decision ends up in an `@page` rule, because that is the only
channel that yields the sheet a browser would have chosen. Chromium quantizes
`printToPDF`'s inch parameters — measured: A4 asked for as 8.2677in comes back
595.92pt, where the same paper written as `@page { size: a4 }` is 594.96pt —
and it ignores `preferCSSPageSize` outright when no rule exists, falling back
to Letter.

Which rewrite depends on what was asked for:

- a format takes the paper outright, so the document's sizes are stripped and
  the flag's size and margin are appended;
- landscape without a format keeps the document's own paper and margin, and
  only the declared orientation is transposed;
- no format and no declared page gets the A4 default written down, which is
  the same sheet the old default sent and now arrives exact;
- a document that declares its own page, with nothing asked of it, is left
  byte-identical.

Only reachable with source markup in hand: a remote document is navigated to,
not rewritten, so its paper still travels the old way.

The sheet as `printToPDF` is finally told about it: the paper is in CSS
whenever the engine wrote a rule for it, and otherwise whenever the document
declares one. Everything else — a remote document, which is navigated to
rather than rewritten — still goes through the inch parameters, the one path
left that Chromium quantizes.

A negative margin is refused there rather than passed on: `printToPDF` rejects
it on all four sides, and the message belongs with the arithmetic that read the
value.

## Reading a document's own page rules

A document's `@page` rules are found by scanning its stylesheets, and the
scanning has to survive text that is not CSS.

Comments go first, for the same reason the HTML comments go first above: the
comment is the outer container, and an apostrophe inside one is not a
delimiter. Stripping the other way round opened a string at the apostrophe and
closed it at the next quote anywhere in the document, which swallowed the
`@page` rule whole. Nothing below could then match it, so `declaredPageSize`
answered null, `preferCSSPageSize` was turned off, and a ledger-landscape
newspaper printed on a letter sheet with no finding — the exact failure this
function exists to prevent, caused by a comment that mentioned nothing at all.

An unterminated comment runs to the end, in the stylesheet as in the browser,
so a rule that follows one is inside it and is not a live rule.

The three scans above are scans and not patterns. A pattern that looks for the
end of a comment that is never closed reads to the end of the text, once per
opening marker, and a document is untrusted input, so that is a way to hold a
server busy. Measured: a document with 40,000 `@page` and no
brace after them took ten seconds to scan, and the shape grows quadratically
from there. The same document takes a millisecond now.

Quoted strings next, for the same reason. A `@page` rule takes keywords,
lengths and colours; it cannot hold a string literal, so a string that looks
like one is text and not a declaration. This also keeps a brace inside
`content: "}"` from ending the match early.

A declaration that is taken out leaves the separators around it behind. `size`
first in the rule leaves the `;` that followed it leading the body; `size`
last leaves the `;` that preceded it trailing. Neither is a syntax error in
CSS, but a page rule that reads `{;margin:2cm}` is a page rule nobody wrote.

A size in a unit `printToPDF` cannot take is not a reason to give up: the
declaration still has an order, so the paper is swapped anyway. The
conversion is asked for as a value that may be absent rather than as a
thrown error, because a caller that cannot convert a unit still wants to
know the order the two lengths were written in.

## Reading a document

The document is parsed into its objects, and the parts are read from there.
Two of the reads used to copy the whole document to find one thing in it, and
a document with a large stream in it is mostly stream.

The `stream` keyword is found by a scan, not by a mask: the question is where
the keyword is, and the answer is a position, so the text does not need to be
copied at all. The keyword has to be outside a string literal and outside a
comment, which is what a mask would have hidden.

A text block is put back where it came from rather than looked for again, so
a document with many blocks in one stream costs a search per block no more.

The mask itself is built from slices rather than from one character at a
time. A masked copy of a content stream is megabytes of allocation, and
thirteen thousand objects times a dozen passes is a lot of that.

## The printable width

The printable width in CSS pixels, or 0 when it cannot be worked out. Zero
means "do not check": a wrong number here would produce overflow findings
about a sheet the document never asked for, which is worse than saying
nothing. Every step that could fail says so instead of guessing — a page size
named in a form this does not know, a length in a unit `printToPDF` cannot
take.

The unit matters. Page geometry arrives in points, `getBoundingClientRect`
answers in CSS pixels at 96 per inch, and comparing the two is the mistake
that makes every element look like it overflows: A4 with 15mm margins is
481.6pt, which is 642px, not 510.

## The font check

Whether the PDF is set in the typeface the document asked for.

The question has to be asked of the renderer rather than of the document,
because the document's own view is unreliable: `document.fonts.check` answers
`true` for any family with no matching `@font-face`, measured on a machine
with neither "Totally Absent Face" nor "Helvetica Neue" installed. The face
actually drawn is reported by `CSS.getPlatformFontsForNode`, so this compares
what was asked for against what was used.

The cost is one round trip per distinct family, not per element: the page
marks one representative per family and this asks about each of those. A
document naming only generic families asks nothing.

Never throws. A renderer that cannot answer this is not a renderer that
cannot print, and losing a finding is not worth failing a render over. The two
domains the check needs are enabled the same way: a renderer that will not
answer them cannot answer the font question either.

The DOM domain caches a document, so it is the document pushed after the
content is set that the check queries, not whatever this enabled against.
Without the domain the deadline still applies, so nothing is lost but the
early signal — which is not worth failing a render over.

## The favicon

Chromium asks for `/favicon.ico` unprompted for anything loaded over http,
so it fails on every document the static server serves and the document never
mentioned it. Measured on a page with a missing stylesheet and a missing
image: `subresource-failed` reported three, naming a file that was not in the
markup. The document is missing two things and that is what it should say.

One definition for both handlers that see a failure, so the rule cannot be
applied in one place and forgotten in the other — which is how it was, with the
response handler exempting the favicon and the failure handler not.

## The creation date

The date Chromium writes is `D:20261011135334+00'00'`, and the match for it
stopped one character short of the closing quote: the `[\d'Z]{0,5}` pattern
allowed five characters after the offset sign and Chromium writes six — `+00'00'`
— so the byte the pattern never reached kept its old value:
`D:20261011135334+00'00'` stamped to `D:20231114221320Z     '`, with the stale
apostrophe still sitting in the file. Every reproducible build has it, because
Chromium always writes the six-character form.

A conforming reader stops at the `Z` and never sees the fragment, which is why
no test caught it: the file was valid and the finding was true as far as
anyone could tell.

## The metadata guard

The subject is guarded the way the author is. `--subject "Q3 report"` beats
the document's own meta tag, and the gate may have rejected the whole
metadata repair, so without this the finding names a value that is not in the
file.

## JavaScript that runs inside the page

The page-side code is written as functions rather than as template literals.

A template literal is invisible to `tsc`. A free identifier inside one is not
a compile error, it is a `ReferenceError` thrown by the browser after the page
has rendered, and the CDP call returns nothing so the caller sees an empty
result and carries on. That is exactly how `report.push({ at: i, ... })` sat in
this file for a commit with no `i` in scope: `bun run typecheck` passed, the
tree looked clean, and every document silently stopped being downsampled.

Writing these as functions makes the compiler check them, and
`Function.prototype.toString` sends the checked source. Each one takes
everything it needs as a parameter and references nothing at module scope, so
the only names in the shipped source are parameters, locals and DOM globals —
all of which exist in the page for the same reason.

The caller interpolates only JSON-encoded literals into the call, so there is
no longer any way for a value to leak in from module scope by accident.
`tools/lint-ts.mjs` fails the build if a new interpolated page expression
appears anywhere in `src`.

Every function in this file is shipped as its own source text, so it may not
call anything declared out here: a call to a module-scope helper is a
`ReferenceError` in the browser and `undefined` back on this side, with
nothing in between to notice. `tsc` cannot catch it, because here the helper
is perfectly in scope.

That is not hypothetical. `wideGaps` called `shortSelector` on its first
version, so the probe returned nothing and the report printed its old sentence
with no gaps named — which looks exactly like a document that has no wide
gaps, and had eight. Helpers are therefore nested inside the function that
ships them, and the render reports a probe that throws rather than handing
back an empty result.

## The page-side findings

The audit runs as a synchronous script in the page and reports what it found.
Two of its inputs need explaining.

**The gaps.** The PDF measures the gaps but cannot say what produced them, so
a report can tell you a document has eight of them and nothing else — which
is not enough to act on when the answer is a `gap` on a flex container three
rules away. The page-side walk goes over the laid-out document instead, which
is the thing the CSS is written on.

**The images.** The measurement returns a JPEG of each image that is both
visible and over the cap, at the cap's resolution. Images that cannot be
measured are skipped, so the results are a subsequence of `document.images` —
which is why the replacement matches on the index recorded during the
measurement rather than on position in the returned list.

**The stylesheet text.** The audit reads the source of the `<style>` elements
and of the linked stylesheets, because a name inside a comment or a quoted
string is prose and not a declaration. The comments are removed by a scan
rather than by a pattern: a pattern that looks for the end of a comment that
is never closed reads to the end of the text, once per opening marker, and the
text is the document's own. A document with 16,000 open comments in its
stylesheet took half a second to strip, and the shape grows quadratically
from there.

**The linked stylesheets** are fetched before the synchronous script runs.
Contained on purpose: any failure here — a hung fetch, a closed socket — must
leave the audit running as before, without the linked sources, rather than
break it. A failure there is not a finding: the audit runs without the linked
sources.
