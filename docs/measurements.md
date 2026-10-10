# Measurements

Every number here was produced on this machine: Fedora 44, Chromium 154.0.8037.57,
Bun 1.4.0, Deno 2.9.5, Node 22.23.2. Reproduce with `tools/bench.mjs`, which runs
unmodified on all three runtimes and prints one JSON line per phase.

## Renderer

The renderer is Chromium's own print pipeline, reached over CDP. A 400-page
document with a 24-row table per page:

| property                    | value                                         |
| --------------------------- | --------------------------------------------- |
| print time, warm browser    | ~65 ms                                        |
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

Each warm-render figure includes a 600 ms settle sleep inside the timed region,
so the true render cost is the ~65 ms above, not the ~670 ms.

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
