# Measurements

Every number here was produced on this machine: Fedora 44, Chromium 154.0.8037.57,
Bun 1.4.0, Deno 2.9.5, Node 22.23.2. Reproduce with `tools/bench.mjs`, which runs
unmodified on all three runtimes and prints one JSON line per phase
(`deno run --allow-run --allow-read --allow-write --allow-net --allow-env`;
probe documents generate into the system temp dir unless `$BENCH_DIR` says otherwise).

## The measurements, and how to take them again

Every number in this file came from one of the tools in `tools/`, and each of
them is a script that can be run:

| script                      | what it measures                                |
| --------------------------- | ----------------------------------------------- |
| `bun run bench`             | chromium's own print pipeline, phase by phase   |
| `bun run bench:baseline`    | the cost of each repair as the document grows   |
| `bun run bench:burst`       | the server under a burst of renders             |
| `bun run bench:concurrency` | the server under renders that overlap           |
| `bun run bench:determinism` | whether two renders of one document agree       |
| `bun run bench:transfer`    | the cost of moving a two-thousand-page document |
| `bun run bench:verify`      | the cost of the verification that always runs   |

The numbers depend on the machine, so they are recorded with the machine they
came from, and the ratios are what a change should be judged on.

## Renderer

The renderer is Chromium's own print pipeline, reached over CDP. A 400-page
document with a 24-row table per page:

| property                    | value                                         |
| --------------------------- | --------------------------------------------- |
| print time, warm browser    | ~20 ms                                        |
| print time, 400 pages       | ~5.2–5.7 s                                    |
| print time, 2,000 pages     | 25.7 s, 820 MB peak RSS                       |
| print time, 3,664 pages     | 76.5 s, 1,262 MB peak RSS                     |
| PDF size, 400 pages         | 16.9 MB (18.5 MB base64)                      |
| base64 frame over WebSocket | 22.5 MB, handled intact by all three runtimes |

Output quality, verified by parsing the PDF: zero `/Subtype /Image` objects, four
embedded Type0/CID fonts with `Identity-H` and `ToUnicode` (so text is selectable,
searchable and Arabic-capable), `/Producer` of `Skia/PDF m154`, a `StructTreeRoot`
tagged structure, and heading bookmarks produced by `generateDocumentOutline`.

`displayHeaderFooter: true` reserves space inside the page box and moved a
three-page document to four. Page numbers therefore come from CSS `@page` margin
boxes with `counter(page)`, which work natively and reserve nothing.

## Reading the pdf back

Chromium prints the pdf and this project then rewrites it. The rewriting is
where the time goes, and it goes on one thing: the pdf is parsed into its
objects, and the parts are read from there. A 1.9 MB document from 38 pages:

| measurement                            | before   | after    |
| -------------------------------------- | -------- | -------- |
| parses of the same bytes in one render | 35       | 20       |
| the time in the parses, per render     | 3 269 ms | 316 ms   |
| the text masked to find a keyword      | 180.7 MB | 52.2 MB  |
| the whole render of a 38-page table    | 5 498 ms | 1 672 ms |
| the whole render of a 12-page text     | 665 ms   | 429 ms   |
| the whole render of a 1-page document  | 399 ms   | 352 ms   |

The before column is the tree this work started from and the after column is
the tree it ended with, measured by running the two alternately so that the
load falls on both equally, and taking the best of ten of each. The numbers
were taken on a machine with nothing else on it: the same measurement on a
busy machine gives a different answer, and the old code's answer moves more
than the new one's does, because the old code was spending its time in
allocations and a busy machine objects to that more.

The parse is the whole of the difference. A 38-page document is parsed
thirty-five times in one render, and each parse copies the document to look
for one keyword in it: 180 MB of text masked, in a million and a half calls.
The document is parsed twenty times now, over 52 MB, and the copies are gone.
A parse went from 93 ms to 16 ms, and the render from 5 498 ms to 1 672 ms.

How much it saves depends on the document. The savings are in the work per
text block, so a document made of tables -- thousands of cells, each a block
of its own -- gains the most, and a document of plain paragraphs gains
about a third.

What the mask was for: the `stream` keyword is where a stream begins, and the
old way of finding it was to copy the whole object with the string literals
blanked, which for a page's content stream is a megabyte of allocation to
learn that the keyword is a hundred bytes in. The keyword is found by a scan
now, and the mask is only made for the part of the object that is a
dictionary.

The parses are the next thing to look at, and there are twenty of them where
there were thirty-five. A document is parsed for the repair, for the check
after the repair, and for the check that the content streams were not
rewritten; the parts a function has already parsed are now passed to it
rather than parsed again, and the encryption check reads the trailer instead
of the document.

What is left is nine of the repairs, each of which is given the whole
document and returns the whole document, and each of which is checked
afterwards, and the check parses too. That is a change of shape rather than a
change of speed: a repair would take the parts and return the parts, and the
document would be written once at the end.

The dictionary of an object is read from the front of it, so the stream after
the dictionary is never turned into a string to be thrown away. A dictionary
longer than the window falls back to the whole object, which is rare.

The payload of a stream ends before the line feed that precedes the
`endstream` keyword, and the carriage return before that is a byte of the
payload: a writer that ends its data with one means the length it declares
counts it. The keyword may also have no line feed before it at all, which the
spec allows and which a reader that insists on one will refuse to open.

Three more things cost a copy of the whole document each and now cost none
of it. The check that every reference resolves built a map of every object's
text when it only ever asked whether a number was in it. The check that a
repair did not rewrite a content stream parsed the document a second time for
the answer the caller already had. And the encryption check parsed the whole
document to look at the trailer, which is a region at the end of the file.

Where the time goes now, on the same document, measured inside the render:

| stage                          | ms  |
| ------------------------------ | --- |
| the nine repairs               | 776 |
| chromium's own printing        | 548 |
| the page-side audit            | 189 |
| the findings                   | 31  |
| preparing the document         | 5   |
| the tab, the network, the rest | 261 |

The whole command was 2 398 ms, and the difference from the 1 810 ms inside
the render is the browser starting up and the command's own start-up.

The repairs are the biggest part, and the biggest repair is the one that folds
text runs into TJ arrays: it scans every text block in the document, and it
was asking a slice and a trim of every gap between every pair of tokens
whether the gap was empty. The gap is asked of the text now, and the blocks
are put back at the offsets they came from rather than looked for again.

## Runtime comparison

| metric                     | Node 22 | Bun 1.4.0 | Deno 2.9.5 |
| -------------------------- | ------- | --------- | ---------- |
| spawn to DevTools endpoint | 464 ms  | 634 ms    | 470 ms     |
| spawn to first PDF         | 1307 ms | 1516 ms   | 1323 ms    |
| warm render each           | ~670 ms | ~670 ms   | ~665 ms    |
| 2 concurrent renders, wall | 663 ms  | 700 ms    | 691 ms     |
| 4 concurrent renders, wall | 783 ms  | 747 ms    | 770 ms     |
| 8 concurrent renders, wall | 1054 ms | 1087 ms   | 1167 ms    |
| 400 pages, serial          | 5509 ms | 5391 ms   | 5224 ms    |
| RSS at cold start          | 60 MB   | **28 MB** | 49 MB      |
| RSS after concurrency      | 80 MB   | **40 MB** | 59 MB      |
| RSS after 400-page render  | 155 MB  | 116 MB    | 110 MB     |

Each warm-render figure includes a 600 ms settle sleep inside the timed region.
An earlier version of this paragraph derived "~65 ms" by subtracting the sleep
from the ~670 ms total. That arithmetic was never a measurement, and a direct
one disagrees: raw `Page.printToPDF` on a warm browser takes ~20 ms (five runs,
19–22 ms), while a full `render()` -- navigate, settle, print, repairs, verify,
metadata -- takes ~0.3 s warm. The README quotes the pipeline number, which is
the one a caller experiences.

**Speed is a tie.** Every phase lands within noise. The runtime moves bytes; the
engine does the work. Choosing a runtime on render speed would be choosing noise.

**Bun wins on resident memory**, which is what decides it. It is 2× lighter than
Node at cold start and half its footprint through the concurrency phases. An
earlier single-socket measurement showed a wider gap (239 MB against 806 MB) when
a 22.5 MB payload was held in one WebSocket message; the honest reading is that
Bun's advantage is largest when a large payload is in flight or the process is
idle, and modest during a burst. A long-lived service is mostly idle.

**Concurrency needs no pool.** Eight simultaneous renders finish in ~1.1 s wall,
roughly what eight serial 65 ms renders plus overhead would cost. One Chromium
absorbs a viewer page, an agent and a CLI at the same time.

## Chromium's own footprint

Attributed to a single profile, summing RSS across its 10 processes:

| state                              | RSS     |
| ---------------------------------- | ------- |
| idle after launch                  | 1068 MB |
| after 20 warm renders              | 1179 MB |
| after 30 s idle                    | 989 MB  |
| after SIGTERM to the process group | 0       |

RSS double-counts pages shared between the browser, GPU and network processes, so
the unique cost is lower than 1 GB. The order of magnitude stands, and it is the
dominant term: the Bun process itself never exceeded 116 MB.

## Decisions these numbers force

**The CLI starts cold.** Relaunching costs 1.3–1.5 s and holding Chromium warm
costs roughly a gigabyte. A one-shot invocation should pay the 1.5 s and leave
nothing resident.

**The service keeps Chromium warm, with a five minute idle timeout.** Relaunch is
1.3 s, which is invisible against any human action, so there is no reason to stay
warm past the point where the user is likely still there. After five idle minutes
the process exits and the next request pays the cold cost.

**No renderer pool.** Concurrency measurements do not justify one.

**Render timeout is 30 s, not 10 s.** A legitimate 400-page document takes about
5 s to print, and transfer plus decode pushes past 10 s for large files. A
page-count ceiling, not a wall-clock timeout, is the real guard against runaway
documents.

## Toolchain available here

Poppler **is** installed: `poppler-utils-26.01.0`, providing `pdftotext`,
`pdfinfo`, `pdffonts`, `pdfimages` and `pdftoppm` under `/usr/bin`. An earlier
note in this file claimed poppler was absent; that was wrong. The check that
produced it ran `pkill -f 'remote-debugging-port=9333'` in the same command, and
the pattern matched the checking shell's own command line, so the shell was
killed before `which` ran. Verification therefore uses poppler rather than
hand-rolled PDF parsing, and `src/pdf.ts` exists only as a dependency-free
fallback for environments without it.

Also present: Chromium 154, Node 22.23.2, Bun 1.4.0, Deno 2.9.5, CUPS. Absent:
puppeteer, playwright, any PDF or HTML-to-PDF library. The project declares no
npm dependencies at all; PDF.js will be the only one, loaded in the viewer page
at a pinned version.

## Two bugs this work uncovered

**Chromium leaks processes if you signal only the parent.** Three bench runs left
27 orphaned Chromium processes holding about a gigabyte. `detached: true` plus
`process.kill(-pid)` to the process group measured a clean exit to 0 processes
under Node's `child_process`. Under `Bun.spawn`, `detached: true` does **not**
create a new process group: `process.kill(-pid)` either fails with `ESRCH` or
signals the caller's own process tree. That was measured killing the shell
running the probe. Teardown therefore uses the CDP `Browser.close` command and
lets Chromium dismantle its own children, with a direct `proc.kill()` as the
fallback. Never signal a process group from this codebase.

**A CDP connection can open and then never be answered.** Chromium prints its
DevTools endpoint before a page session will accept commands, so connecting the
instant the endpoint appears yields a socket that opens and silently drops
`Page.enable`. `Browser.#awaitSession` polls until a trivial command actually
round-trips.

## Bugs found by testing the tool as a user

Five subagents drove the CLI blind and reported what blocked them. Three
independently hit the same defect, which is the signal worth recording.

**The page count was capped at 8.** `inspect` took the first `/Count` in byte
order, which is an interior node of the page tree. Every document of nine pages
or more reported 8, including one whose own footer read "page 14 of 14" because
Chromium resolved `counter(pages)` correctly while the tool did not. Now
resolved through trailer to catalog to the tree root, verified against poppler
for 1, 7, 8, 9, 12, 40 and 120 pages.

**A TypeScript annotation inside an evaluated string silenced every finding.**
The audit runs as JavaScript in the page. A `for (let p: Element | null = ...)`
is a syntax error there, so the whole audit returned nothing and reported no
problem with any document. `audit` now returns an `audit-failed` finding when its
expression does not evaluate to an array, so this class of bug is visible.

**Chromium ignores paper arguments while `preferCSSPageSize` is on.** Not just
`paperWidth`: `landscape` is ignored too, and setting `landscape: false` does not
help. So `--format a4 --landscape` produced portrait with exit 0 and a warning
saying the request had won. The declaration is now stripped from the document so
the request genuinely takes precedence.

**A commented-out `@page` read as a declaration.** The precedence check matched
CSS text without stripping comments, so `/* @page{size:A5} */` made the tool
report a landscape PDF as portrait. Comments are stripped before matching now.

**`&nbsp;` was reported as a missing glyph.** It has no glyph in the font and
occupies no space, so it can never print a box, and it appears in nearly every
HTML file. Warning on it trains people to ignore the findings array. Invisible
format characters are now excluded, and listed separately as a count so the
suppression is visible rather than silent.

## Non-obvious findings

**PDFs are not byte-reproducible.** The SHA-256 differs between every render of
the same input, because Chromium stamps a creation date and a document ID into
each file. Never compare checksums across runs to decide whether output changed.
Assert on page count, page geometry, and extracted text instead.

**WebMCP moved and is flag-gated.** On Chromium 154 `navigator.modelContext` is
`undefined`; the live API is `document.modelContext`, with `registerTool`,
`getTools`, `executeTool` and `ontoolchange` on its prototype. It requires a
secure context, so it is absent on `about:blank` and present on
`http://127.0.0.1`. Neither the API nor its global constructor appears without
`--enable-blink-features=WebMCP` or `--enable-features=WebMCPTesting`.
`registerTool` succeeds; `executeTool` takes a registered tool handle rather than a
name, and `getTools` is what resolves names.

**`executeTool` takes a JSON string, and answers with one.** Measured on
Chromium 154 with `--enable-blink-features=WebMCP`, against a page served from
`http://127.0.0.1`:

- `executeTool(tool, {x: 'hello'})` fails with `UnknownError: Failed to parse
  input arguments`. `executeTool(tool, JSON.stringify({x: 'hello'}))` works.
- The result is a **string** holding the JSON, not an object. `r.content[0].text`
  is a `TypeError`; `JSON.parse(r).content[0].text` is the answer.
- `getTools()` hands back `inputSchema` as a string too, so a schema has to be
  parsed before it can be read as one.

Two of the three are the kind of mistake that looks like a missing feature: the
tool is registered, it is listed, and the call fails anyway.

## The PDF/UA identification matrix

Measured on Fedora 44, Chromium 154.0.8037.57, veraPDF 106 rules, against a
letterpress-rendered page whose page stream and structure tree are otherwise
unchanged. The XMP packet was rebuilt per variant by rewriting only the
`/Metadata` stream of the same PDF, keeping the bytes identical elsewhere.

| variant | `pdfuaid:part` | `pdfuaid:rev` | namespace                             | result              |
| ------- | -------------- | ------------- | ------------------------------------- | ------------------- |
| M0      | (none)         | (none)        | (none)                                | rule 5 fires        |
| M1      | `1`            | (none)        | `http://www.aiim.org/pdfua/ns/id/`    | 106 rules, 0 failed |
| M2      | `1`            | `2020`        | `http://www.aiim.org/pdfua/ns/id/`    | 106 rules, 0 failed |
| M3      | `1`            | `2020`        | `http://example.invalid/pdfua/ns/id/` | rule 5 fires        |

`rev` is optional for compliance (M1 and M2 both pass) but we ship M2: it
names the revision we validate against, and a reader that checks the revision
gets an answer. The namespace is the whole check (M3 fails with the right
part and rev), so it is the registered AIIM URI and not a configurable value.
The same oracle run on three document shapes (prose, roles, blocky `dl`)
reports `PASS (106 rules, 0 failed)` for the prose and roles shapes; the
blocky shape fails only 7.4.2, which comes from the source document and fails
identically on the unpatched print.

## Measured limitations (not yet repaired)

Battle-tested across 48 diverse documents at HEAD 5f01187. The failures below are
real and measured; none has a repair yet, and each needs its own measurement
phase before one is attempted.

- **Native lists (7.2, `LI` may contain only `Lbl` and `LBody`)**: Chromium tags
  `<li>` as `LI` with its content directly inside, no `LBody` wrapper. Fails on
  nested `ul`/`ol` (`deep-list`, `ol-deep`, `ul-nested`). Repair would require
  creating `LBody` struct elements and rewiring `/K` plus the ParentTree — a
  dict-level restructuring, not a byte swap.
- **RTL text (7.21.7, ToUnicode values must be greater than zero)**: measured on a
  single-line Arabic document — 7 glyph IDs
  (0010, 0012, 0015, 0034, 011A, 011F, 013E) map to U+0000 in Chromium's
  ToUnicode CMap; a mixed Arabic/Latin document shows 2 (0010, 013C). The
  embedded subset's own cmap was parsed (NotoSansArabic, 10 316 bytes): it
  holds 8 mappings covering gids 8–62, while the subset contains 319 glyphs.
  The 7 zero-referenced GIDs exist as drawn glyphs — gid 0010 is below
  numGlyphs 319 — but carry no unicode mapping anywhere in the embedded
  file. The information is absent from the PDF, so no repair can derive it
  from the document alone. Honest miss, measured with sound wiring (the
  font-cmap fallback below is teeth-proven on synthetic PDFs and provably
  cannot fire for this Chromium output). Latin-only and emoji documents
  produce zero entries.
- **Empty documents (`empty`, `dl-empty`)**: fail 6.2 (MarkInfo), 7.1 (structure
  hierarchy root), 7.2 (natural language for metadata). These are degenerate
  inputs with no real content; not worth repairing.
- **`details` element (7.1, untagged content)**: Chromium leaves the element's
  content unmarked. Not addressable by retagging or RoleMap.

## Battle test round 2: 37 diverse documents (HEAD 1be7042)

Run on 2026-10-24, Fedora 44, Chromium 154. Results:

**Verify (structural integrity): 37/37 pass, 0 failures.** Every document
produces a valid PDF whose structure tree passes `verify()`.

**PDF/UA oracle (106 rules):**

- PASS 0 failed: all-repairs, article-aside, aside-in-main, col-images,
  deep-list3, dl-dup-term, dl-empty-items, dl-nested, dup-sections,
  empty-list(?), empty-section(?), flex-many, footnotes, grid-complex,
  longdoc50, many-ligatures, math, mixed-lists, multicol, multi-nav,
  nested-bq, nested-equal, nested-table, pagebreak, print-media,
  single-item, table-complex, unicode, wide-table.
- FAIL with only doc-inherent/known issues:
  - canvas: 7.3 (figure needs alt text — Chromium draws canvas as bitmap,
    no structure element; honest miss)
  - deep-sect, list-blocks: 7.4.2 (heading sequence — source document
    has no H1; honest miss, out by principle)
  - details: 7.1 (untagged content — Chromium leaves details content
    unmarked; honest miss, already recorded)
  - empty-list, empty-section: 6.2/7.1/7.2 (degenerate inputs — honest miss)
  - form-complex: 7.1 (content untagged — form controls not tagged by
    Chromium; Chromium limitation)
  - mixed-rtl: 7.21.7 x3, rtl-full: 7.21.7 x10 (ToUnicode zero glyphs
    — Chromium subsetting bug; honest miss, already recorded)
  - svg: 6.2 (MarkInfo), 7.1 (no structure hierarchy root — Chromium
    renders SVG as graphics without structure elements; Chromium
    limitation)

**Interaction results:** All four repairs compose cleanly in a single
document (all-repairs: role-retagged, role-mapped, list-bodied,
ligature-spans, text-runs-merged → PASS 0 failed). Empty lists and empty
sections fail only degenerate-metadata clauses (already recorded).

Conclusion: every remaining pdf/ua failure is either Chromium
not-emitting-structure-elements (canvas, svg, form controls), a source
document choice (7.4.2 heading sequence), or an already-recorded honest
miss (RTL, details, empty). There is no repairable gap left in the
structure-tree repair space.

## Font-cmap fallback for zero ToUnicode entries (uncommitted work, 2026-10-25)

`src/fontcmap.ts` parses the sfnt cmap of an embedded font file
(format 4 and format 12, preferring Unicode subtables: platform 0 with
encoding ≥ 4, platform 3 with encoding 1 or 10; format 12 beats format 4).
`fixToUnicode` walks Type0 font → descendant CIDFont → FontDescriptor →
FontFile2/FontFile3 → the stream, gated on `/Length1`, and feeds the parsed
glyph→codepoint map to the zero-entry repair: a `<gid> <0000>` row whose
glyph the font cmap knows is rewritten to the real codepoint. Gids the font
does not know are left untouched byte for byte; faces without an embedded
font file are left byte-identical.

Corrupt-font hazards are bounded by construction: subtable-record offsets
and format-4 array extents are bounds-checked (a truncated extent yields an
empty map instead of a RangeError), glyph ids are capped at the 16-bit gid
space, and the whole codepoint scan is capped at 4× the gid space
(0x40000 scans) — a flood font of 8 000 over-full segments (the maximum the
u16 subtable length allows) parses in the same budget as a normal font,
measured 109 ms for the full 11-test suite. `parseFontCmap` is wrapped in a
tripwire: any unforeseen read fault degrades to an empty map, never to a
crash inside the render gate.

Scope measured on four Chromium renders (Latin, emoji, Arabic RTL,
mixed): the repair changes none of them — the zero GIDs are beyond the
subset's 8-entry cmap cover, so the fallback cannot fire for Chromium
output. It exists for third-party PDFs where the mapping survives in the
font but ToUnicode was written or rewritten broken — the case pdf.js hits
in the wild. Teeth: 11 unit tests over synthetic format-4/format-12 cmap fixtures
(range mapping, glyph-array indirection, gid-0 refusal, format-12
preference, truncated extents, past-end record offsets, hostile ranges,
flood budgets, junk input) and 4 end-to-end tests over synthetic PDFs
(repair fires and is idempotent and leaves the rest untouched; unknown
glyph and missing font file stay byte-identical; format 12 recovers the
same way). First wiring attempt folded two bugs, both caught red: the
descriptor lookup missed the `/DescendantFonts` chain, and the FontFile2
hop between descriptor and stream was folded into the `/Length1` gate.

## Per-block TJ merge (2026-10-25)

`mergeTextRuns` used to merge at stream grain: if any text block in a
content stream was not the simple shape the rewrite understands, every
block in that stream was refused. One Arabic ActualText block with
diagonal `Td` moves vetoed the 19 mergeable table blocks next to it.
Measured on raw Chromium prints (pre-pipeline): before the change,
0 of every block total merged; after, prose 2/2, table 20/20, spans
10/10, ligature 1/1, justified text 5/5, and the mixed-script document
12/20 — the 8 refusals are the RTL ActualText blocks whose inner `Td`
carries a y component, which are honestly unmergeable because TJ arrays
can only carry horizontal compensations. Each block is verified
independently (`replay` before, `replay` of the merged run after, glyph
positions within 1e-4 pt), so a refusal costs that block only. Suite
teeth: the six pipeline tests gained one — a document with both an RTL
block and a mergeable plain block now reports `merged > 0` and
`refused > 0` and leaves the extracted text identical (the old veto
produced `merged = 0`).

Diagnosing the first wiring attempt: the verification call passed
`replay`'s whole `{placed, simple}` object where `sameGlyphs` wants the
`Placed[]` projection, so every merge verified false and the new code
refused exactly as much as the old veto. Temporary stderr tracing
(`process.stderr.write` on refusal branches) located it inside one
round-trip; the trace lines are gone from the committed code.

## Span ActualText in hex form (2026-10-25)

Chromium writes ActualText in two forms: latin for Latin ligatures
(`/ActualText (ffi)`) and hex UTF-16BE with a FEFF byte order mark for
Arabic (`/ActualText <FEFF0629>`). Two dead spots kept every hex-form
span invisible: `SPAN_OPEN` captured only dicts without angle brackets
inside (`<<([^<>]*)>>`), and `unescapePdfString` decoded hex payloads
byte-wise as latin1, so `<FEFF0629>` became the three mojibake bytes
`ï¿½*` rather than U+0629. `SPAN_OPEN` widened to `<<([\s\S]*?)>>`, and
hex payloads now decode as UTF-16BE: FEFF skips one following unit, FFFE
swaps each following unit's halfwords, unit-aligned payloads map one
code unit at a time, and a non-multiple-of-four length falls back to the
old latin1 byte path (odd tails do exist in third-party files).

Effect measured on raw Chromium prints: Latin ligature spans are the
same before and after (they were already visible in latin form); the
mixed-script document's 11 RTL spans are now _seen_ — previously they
did not even count (`seen: 0` before, `seen: 11, kept: 11` after). They
stay kept: each resolves to a zero-row gid, so stripping the span would
delete the reader's only recoverable text. After `fixToUnicode` runs,
Latin ligature spans strip 8/8 through the full pipeline, and the bullet
document's interleaving span strips 1/1. Teeth: five tests over the
hex/BOM fixture builder (plain hex, FEFF, FFFE, kept-when-unconfirmable)
plus the pre-existing latin contract at 14 tests in the span suite.

Deferred, recorded honestly: `src/structroles.ts` has the same
`<<([^<>]*)>>` hole in its `STREAM_TOKEN`, so the role census also
cannot see hex-form ActualText text. Fixing it touches the role-plan
contract and its own suite, so it is left for a measured pass of its
own rather than riding along here.
