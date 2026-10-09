# Architecture assessment

An evaluation of what letterpress actually does, measured rather than assumed.
Every number here was produced by a script in this session; the scripts are named.
Nothing in this document is an estimate presented as a result.

The question asked was whether the architecture meets the use case, and whether
performance, output quality, reliability or design are being left on the table.
The short answer: performance is not the problem, and the design is sound in its
central decision. The problem was that the repair layer had no verification, and
that is why defects kept shipping through it. That gap is now closed -- see F1 --
and the rest of this document is a record of what the assessment found, kept as
it was written rather than tidied afterwards.

## 1. Current state

The product renders HTML to PDF through Chromium's own print engine, with a
shell, a loopback render server, a template filler and a CLI. Roughly 5,300 lines
of source and 6,900 of tests, no runtime dependencies, Bun 1.4 only.

### The pipeline

    stage assets on a loopback server
    CDP: navigate, intercept Network + Fetch
    document.fonts.ready -> settle -> beforePrint (image ppi cap)
    audit() reads the live DOM
    Page.printToPDF
      -> fixToUnicode        rebuilds the file
      -> fixFontDescriptors  rebuilds the file
      -> addMetadata         rebuilds the file
      -> stampPdf            edits in place at fixed offsets
    inspect()

Four post-print steps, three of which decompress, edit, recompress and rebuild the
cross-reference table.

### The central architectural decision

Chromium's output is treated as a draft to be repaired. Three of the twelve audit
defects were fixed this way, and the decision is sound: Chromium's font
descriptors, its ToUnicode and its metadata cannot be configured from outside.
Verified against the binary — `strings` over the 333 MB executable finds
`disable-pdf-tagging` and `generate-pdf-document-outline` and nothing that
controls descriptor fields or an XMP packet. There is no flag, so there is
nothing to configure, so a repair layer is the only route.

## 2. Baseline

Measured with `baseline2.ts`. Every workload's page count was **measured, not
assumed** — the first attempt labelled its workloads 1p/20p/200p and they turned
out to be 1, 12 and 113 pages.

| workload | pages | KB | cold p50 | warm p50 | repair p50 | repair as % of warm |
|---|---|---|---|---|---|---|
| letter | 1 | 14 | 220 ms | 193 ms | 2 ms | 1.0% |
| resume | 1 | 54 | 482 ms | 355 ms | 7 ms | 2.0% |
| 20p | 21 | 121 | 282 ms | 228 ms | 6 ms | 2.6% |
| 100p | 106 | 554 | 489 ms | 477 ms | 20 ms | 4.2% |
| 400p | 421 | 2,182 | 1,812 ms | 1,874 ms | 60 ms | 3.2% |

Cold means a fresh browser per render; warm is one browser reused, which is how
the server and the viewer run. Three cold and five warm runs each, p50 reported.

**421 pages in 1.9 s, and the entire repair layer costs 1–4% of that.** The
repair layer is not a performance problem and never will be at this ratio. Any
argument for restructuring it on speed grounds is unfounded.

### Concurrency

`scale.ts`, against the real server, after a warm-up request:

| concurrent | wall | throughput | ok | refused | latency p50 |
|---|---|---|---|---|---|
| 1 | 258 ms | 3.88/s | 1/1 | 0 | 258 ms |
| 2 | 353 ms | 5.67/s | 2/2 | 0 | 353 ms |
| 4 | 648 ms | 6.18/s | 4/4 | 0 | 646 ms |
| 8 | 795 ms | — | 4/8 | **4** | 761 ms |

Throughput rises 1.46x from 1 to 2 and then flattens: the cap of 4 sits close to
where the curve stops paying. At 8 the server **refuses half the requests**
rather than queueing. On a single box that is a defensible choice, and the code
says why: 30 concurrent renders measured 4.7 GB of Chromium, so the queue is
bounded. The trade-off is that fail-fast converts a burst into errors.

## 3. Assumption and evidence register

**Verified by measurement**

- 421 pages render in 1.9 s warm; the repair layer is 1–4% of render time.
- Chromium exposes no flag controlling font descriptors or XMP emission.
- The repair layer is idempotent for every repair except the one fixed today.
- poppler and ghostscript disagree with a structurally valid, content-wrong file
  only through their own extraction — nothing in the pipeline does.
- A file with 200 garbage bytes injected into a content stream passes every
  structural check available: xref resolves, every reference resolves, every
  stream `/Length` matches its payload.
- `/W` in the audited resume disagrees with the advance Chromium used for 163 of
  2,499 consecutive glyph pairs; the median disagreement is 0.0005 pt, and one
  font/size carries a constant +0.5442 pt of tracking `/W` cannot express.
- Chromium's structure tree is in document order regardless of paint order.

**Inferred, and load-bearing**

- The three shipped fixes generalise beyond the documents they were tested on.
  Reasonable from the mechanism, untested across a corpus.
- A Type 3 font's cap height is not derivable, because a Type 3 font's glyphs are
  procedures with no font program. Solid, but only spot-checked.

**Untested**

- Behaviour on a 2,000-page document. The server's cap is 2,000 and nothing has
  rendered one.
- Headful parity. One test, gated on `DISPLAY`.
- Firefox and WebKit. Never run; the native-select claim is research.

**Blocked**

- A2, merging `Tj` into `TJ`. Worth about 5% of file size. The provably safe
  subset is worth 50 bytes; the version worth 2,786 bytes placed 192 of 2,613
  glyphs wrongly and fragmented poppler's word extraction from 413 to 531.
  Two structural obstacles, both documented, both absorbable in principle.

## 4. Technology review

### Chromium's print engine — retain

Irreplaceable under the constraints. No other HTML renderer gives Chromium's
layout fidelity, and the no-dependency rule rules out Prince and WeasyPrint.
Rendering to canvas and wrapping in a PDF would destroy text selection,
extraction and search, which is disqualifying for the stated use case.

The finding is that it cannot be *configured* into correctness, only repaired.
That is now evidenced rather than assumed.

### CDP over the DevTools HTTP/WS API — retain, with one gap

The right protocol, and `Schema.getDomains` returns no command descriptors in
this build, so the parameter list cannot be discovered at runtime. Not worth
fixing; the parameters are known and stable.

### Bun — retain

326 tests in 154 s. No reason to look elsewhere.

### poppler and ghostscript — retain, and use more

These are the only independent check available, and they caught **every** real
defect in this project: the missing `endobj`, the malformed XMP packet, the
ligature short-circuit. They are currently used only in tests. They are the
natural engine for the verification gate that is missing.

### Whole-file rebuild per repair — reconsider

Three repairs each split, edit, recompress and rebuild the xref. Three distinct
xref bugs have already been realised across two of them, each producing a file
that opened and was wrong. The cost is 1–4% of render time, so this is a
correctness-surface argument, not a performance one.

## 5. Findings, by impact

### F1 — The repair layer has no verification gate. Confidence: high, measured.

**Status: closed.** `src/verify.ts` now gates every repair. A repair is kept only if the
file stays structurally whole *and* every page's content stream is byte-identical to
Chromium's own; otherwise Chromium's bytes are shipped unchanged and a `repair-rejected`
finding says so. Its own proof is a test that injects corruption into a rendered PDF and
asserts the shipped file is the unrepaired one. Six defects have been found and fixed
*through* the gate since it was written, including four in the parsers it depends on --
see "Closed since this section was written" in §9 and §11.

The evidence below is what was true when the assessment was made.

**Evidence.** 200 garbage bytes injected into a content stream of a shipped PDF
pass xref resolution, reference resolution and `/Length` matching. Nothing in the
pipeline distinguishes "repaired" from "corrupted".

**Consequence.** Every defect that has shipped through this layer was a repair
that quietly did the wrong thing: the `??` short-circuit that skipped bfchar
entries, the XMP packet with no `dc:creator` because the dictionary's spelling
was passed through, and my A2 attempt, which mislaid 8.29% of the page's pixels
and reported no error. The layer's failure mode is silent, and nothing in it is
watching.

**This is the root cause the question was aimed at.** It is not that the
architecture is wrong; it is that a repair layer without a gate is a layer whose
bugs are invisible.

### F2 — A shipped defect: ligatures skipped in serif documents. Fixed today.

`fixCMapBoth` was `fixRanges(cmap) ?? fixCMap(cmap)`. `??` short-circuits, so a
CMap with a ligature in a bfrange destination never had its bfchar entries read.
With `font-family: serif` the shipped file kept U+FB03, so a search for
"efficient" failed. The tests used the default sans stack, where one range
carries all four ligatures, so the combination was never exercised. Commit
`444e1ae`, with a test asserting that a repair is a function of its input across
five font configurations.

### F3 — Fail-fast concurrency turns bursts into errors. Confidence: high.

At 8 concurrent, 4 requests are refused. Queueing for a bounded wait would absorb
a burst at no memory cost, since the cap already bounds concurrency. Reversible
and small.

### F4 — Benchmarks asserted what they had not measured. Confidence: high.

The first baseline labelled workloads 20p and 200p; they produced 12 and 113
pages. Every page count in this document is now measured, and the harness grows
the document until `printToPDF` reports enough.

### F5 — Two of the twelve findings were misdiagnoses.

B1, heading roles, and A1, paint order. Chromium tags `<h1>`–`<h6>` correctly, and
the resume contains no heading elements at all. Chromium's paint order diverges,
and its structure tree — which is what a screen reader walks — does not. Both are
recorded as retractions with tests.

## 6. Recommended next steps

**Immediate, small and reversible**

1. **A verification gate after the repair chain**, using checks already written.
   The gate should assert four things and fall back to the pre-repair bytes if any
   fails: the xref resolves, every reference resolves, every `/Length` matches,
   and **the content stream is byte-identical to what `printToPDF` produced** —
   because no repair in the layer is supposed to move a glyph, and that invariant
   is what catches the A2 failure mode that structure alone cannot.
2. **Assert repair idempotence in the test suite** for every repair, across more
   than one font family. This is the property that would have caught F2.
3. **Queue instead of refusing** under burst, with a bounded wait.

**Worth an experiment**

4. Move the verification checks out of the tests and into the render path. They
   are cheap — a single linear pass — and today they only run in CI, which is why
   a defect reached a release.
5. Render a 2,000-page document once, to find out whether the server's own limit
   is reachable or merely asserted.

**Not recommended**

- Replacing Chromium. The no-dependency rule and the fidelity requirement both
  hold, and there is no evidence of a limit being hit.
- A2. 5% of file size is not worth a transform whose failure mode is misplaced
  glyphs, and the safe subset is worth 50 bytes.
- Consolidating the three rebuilds into one pass. The performance argument does
  not exist at 1–4%; the correctness argument is real but is better answered by
  the gate.

## 7. What was implemented, and what it cost

All three recommendations below were carried out after the assessment. Numbers
are re-measured, not estimated.

### A verification gate — `src/verify.ts`, `5bf7cfa`

Four checks: one `startxref` pointing at a table, every in-use xref entry pointing
at its own object header, every indirect reference resolving with every stream
`/Length` matching, and — the one that earns its place — **every page's content
stream byte-identical to what Chromium emitted**. No repair in this layer may move
a glyph, so a changed content payload means one has done something it had no
business doing. Comparing compressed payloads avoids decompressing every page.

A failed check falls back to Chromium's own bytes and reports a `repair-rejected`
warning, so the failure mode becomes a silent non-repair rather than a silent
corruption.

Measured cost: **0.1% of render time at one page, 2.3% at 74.** The gate's own
proof is a test that rewrites a content stream and asserts the three structural
checks pass while the content check fails — which is the demonstration that
structure alone cannot do this job.

### A queue instead of refusal — `3b07868`

| burst | before | after |
|---|---|---|
| 8 | 4 ok, 4 refused | **8 ok**, 0 refused |
| 12 | 4 ok, 8 refused | **12 ok** |
| 24 | — | 20 ok, 4 refused |
| 40 | — | 20 ok, 20 refused |

Twenty is the designed ceiling: 4 running plus 16 queued. What protects the
machine — never more than 4 at once — is unchanged.

### Idempotence asserted per font family — `444e1ae`

Every repair must return its own output untouched, asserted across five font
configurations. This is the property that would have caught the `??` short-circuit
before it shipped.

### What was not done

- **A2.** Unchanged. Worth 5% of file size, unsafe to implement, and the safe
  subset is worth 50 bytes.
- **Replacing Chromium.** No evidence of a limit being hit.
- **Consolidating the rebuilds.** No performance argument exists at 1–4%.

## 8. Large documents — measured, and a dead limit found

The 2,000-page claim was never tested. It is now. Both documents were calibrated
by measuring page count, not by assuming one: a first guess of 2,353 sections
produced 1,177 pages, and 3,999 produced 2,000.

| document | pages | PDF | render | peak RSS | gate | `Suspects` |
|---|---|---|---|---|---|---|
| calibrated | 2,000 | 15.5 MB | 25.7 s | 820 MB | ok | no |
| trimmed to fit the body cap | 3,664 | 28.6 MB | 76.5 s | 1,262 MB | ok | no |

Both are correct at scale, not merely produced: ghostscript reports zero errors,
`pdftotext` extracts from page 1 and from page 2,000, the gate passes in 376 ms
and 615 ms respectively, and the repair layer reports zero negative cap heights
and zero unresolved ligatures. The 3,664-page file holds 172,714 objects and
3,664 content streams, every one intact.

**Cost per page is flat.** 12.9 ms/page at 2,000 pages against the documented
13.75 ms/page at 400. Memory is ~340 KB per page, so a page cap is a memory cap.

### The finding: `MAX_PAGES` was dead code

`MAX_PAGES = 2000` was declared and never referenced. Nothing enforced it, and the
8 MB body cap was doing the work instead — so a 7.5 MB document rendering to
**3,664 pages** was served with `ok: true` by a server that claimed a 2,000-page
limit. A limit that is not checked is worse than no limit, because it is a claim
in the source that a reader has to disprove.

It is now enforced, at 6,000 pages, at the only point where the count is
knowable: after the print. Refusing up front would mean refusing documents that
would have been fine, so the render happens and the result is declined with the
real page count and the reason. `pageRanges` is exempt, because its count is what
was emitted rather than the document's length.

The value is measured rather than guessed: 2,000 pages cost 820 MB and 3,664 cost
1,262 MB, so 6,000 lands near 2 GB, which is a defensible ceiling on a machine
doing other work. Time needs no separate cap — `MAX_TIMEOUT_MS` already ends an
over-long render, and it does so with a message that names the flag.

### What actually bounds a document

| bound | value | notes |
|---|---|---|
| body size | 8 MB | ~3,700 pages of text |
| page count | 6,000 | measured, enforced after the print |
| timeout | 120 s | ~9,000 pages at 12.9 ms/page, so pages bind first |
| memory | ~340 KB/page | 2 GB at 6,000 pages |

The body cap binds before the page cap for text, which is worth knowing: raising
`MAX_PAGES` without raising `MAX_BODY_BYTES` changes nothing for HTML input.

## 9. Still open

1. **The repairs are tested on the documents that motivated them**, not a corpus.
   Generalisation is argued from the mechanism and is only partly verified. What has
   changed is that CI runs on a different font set from the machine the repairs were
   written on, and it caught nine tests that had been passing by accident. That is a
   sample of one environment, not of one document.
2. **Chromium's own tagging gaps.** A `<dl>` produces no semantic role, and
   `section`/`nav`/`main`/`header`/`footer` produce none. Upstream, and recorded as
   tests in `test/tags.test.ts` rather than papered over: faking the roles would be
   fabricating semantics the document does not have.
3. **An `img` with an absolute local path does not load.** Staging one would mean
   reading outside the document's own directory, which the code deliberately refuses. It
   is reported as `subresource-failed` rather than passing silently, so this is a
   limitation rather than a defect, but it is one.

   What this item was worth hiding: the same refusal applied to a *relative* `../assets`
   reference, which is ordinary layout and how most sites are laid out. Measured on a real
   ten-page site on this machine, eight of its pages rendered with no stylesheet at all,
   and the only symptom was a failed subresource naming a stylesheet that had loaded
   perfectly well. The corpus is what found it -- every test until then used documents
   sitting in one directory beside their assets, which is a layout that essentially does
   not occur outside a test fixture.

   The site is one particular project on this machine, so that ratio is a session
   measurement and not a number anyone else can check. What anyone can check is the class
   of it: `bun tools/corpus.ts <dir>` renders real HTML and reports the post-conditions,
   and it is what found both this and the negative cap heights above.

   Fixed by `--root`, which widens the boundary only when a caller names it, because
   guessing either loses a document's assets or opens a filesystem boundary and the caller
   is the one who knows where the site root is. The default is unchanged, and a refused
   reference is reported as `asset-outside-root` naming each path and the flag that would
   allow it. All seven pages of that site now render with no failed subresource.

   Three further defects came out of the same review, two of them in the parsers rather
   than in this feature: `--root` staged assets at a filesystem-relative path while the
   browser resolves from the origin, so a page lost its own siblings; the boundary was
   checked lexically, so a symlink inside the document's directory read a file outside it;
   and the finding probed for existence, which turned it into a yes/no oracle over
   arbitrary paths that the render server hands to whoever asked.
4. **The default render deadline is 30 seconds.** A representative document measured
   555ms on two cores, so the headroom is large; a very large document on a cold shared
   machine is where it would bite.

### Closed since this section was written

Three of the four items above are no longer open, and a list that still claims they are
is worse than no list.

- **Headful parity** -- `03668e6`. Seven dimensions compared, all matching, including the
  structure-tree role histogram and decoded pixels. It runs in CI under Xvfb now rather
  than sitting behind a `DISPLAY` gate.
- **The base64 transfer path** -- `eb5fd69`. The server streams inbound and can return
  `application/pdf` outbound: 804MB against 663MB of peak RSS at 2,000 pages, and 26%
  smaller on the wire.
- **`stampPdf` truncating a long title** -- `4223054`. It wrote into whatever slot
  Chromium left, which is however long `about:blank` is, so a 61-character filename came
  out as `Quarterly-R`. The title is set through the gated chain now, which has no such
  limit.


## 10. How success would be verified

- The gate: inject a known corruption into a rendered PDF and assert the shipped
  file is the un-repaired one. That test is the gate's own proof.
- Idempotence: assert each repair returns its own output untouched, per font
  family.
- Concurrency: assert that a burst of 8 concurrent requests is queued and all 8
  succeed, with a bounded wait.
- The audit: re-run all twelve findings' reproductions against the fixed build
  and record which are fixed, retracted, or still open.
## 11. Conformance, measured against an independent implementation

Everything above reasons from mechanism. veraPDF is an independent implementation of
ISO 14289-1 — the same relationship to this renderer that poppler and ghostscript
already are — and its PDF/UA-1 profile encodes 106 machine-evaluated rules, so a claim
about tagging or alternate text can be a verdict rather than an argument. `tools/pdfua.ts`
runs it; `tools/structure-tree.ts` prints the tree and the MCID census behind a result.

### The calibration that matters

| document | rules failed, of 106 |
|---|---|
| text, heading, list, table, blockquote | 1 |
| link | 1 |
| figure | 2 |
| the full sample | 2 |
| **ISO 32000-2 spec, 1,023 pages** | **16** |

The ISO's own publication fails every one of the 16 rules it evaluates, across 12
clauses and at least 666 objects, and 10 of those failures are fonts it does not embed.
We fail a strict subset of the clauses it fails. Conformance to PDF/UA-1 is therefore
not a quality measure on its own, and the one clause every clean document fails — 5,
the identification schema — is failed deliberately: writing `pdfuaid:part` asserts
conformance this output does not have.

### What was fixed, and what each one was

- **7.18.1, 7.18.5 — link descriptions.** Chromium writes every link annotation with no
  `/Contents`. The pairing is the hard part: a Link structure element and its annotation
  are unrelated object numbers, and counting disagrees (one Link element named two
  annotations for a link wrapping an image; two elements and one annotation for an
  external plus an internal link). Chromium fills in the key PDF provides — an inline
  `/Obj` inside the element's object-reference dictionary — so the annotation is found
  by following a reference.
- **7.3 — figure descriptions.** Not an engine fix. A repair was written for it and then
  deleted: see the retraction below. `tools/probe-image-alt.ts` reproduces the
  measurement.
- **Headful parity.** One test, seven dimensions, all matching including the role
  histogram. `--headless=new` had to be omitted rather than overridden, since Chromium
  takes the last occurrence of a switch.

### Retracted: Chromium discards an image's `alt`

The figure repair was justified by ten measured forms, and every one used a hand-written
base64 string that was not valid base64 — 193 characters, not a multiple of four.
Chromium rejected the image, drew its broken-image placeholder, and painted the `alt` as
untagged glyphs. What was measured was the placeholder.

With an image that loads, Chromium tags the image as a Figure element nested inside the
one its `<figure>` produced, and carries the `alt` itself. An `aria-label` overrides the
`alt`; an `img` with no `alt` yields a Figure with no `/Alt`, which is correct.

So the repair was removed rather than kept as a rarely-used path. It could only ever act
where Chromium had tagged nothing, and its one guard — the description count has to
match the Figure element count — meant it declined to act in the ordinary case anyway,
returning its input byte for byte. A no-op that exists to be justified is worse than no
op. `tools/probe-image-alt.ts` keeps the measurement; `tools/structure-tree.ts` prints
the tree it reads.

The retraction dissolved the next piece of work as well. Clause 7.1 was reported at 61
unmarked content items, which were the placeholder's own alt text plus its two draws.
With a loadable image there is no 7.1 failure, so **no content-stream surgery is needed**
and `verify()` keeps its byte-identity guarantee rather than being weakened to
"text operators in the same order".

### The one remaining failure

```
39 Figure   no /Alt                <- the <figure> element
  40 Figure  Alt=(a description)   <- the <img>, tagged by Chromium
```

Chromium makes both the `<figure>` and the `<img>` a Figure. A nested Figure whose outer
element is a pure grouping is a modelling artefact, and 7.3 fails on it. Re-tagging the
outer element `Div` when it has a child Figure carrying an `/Alt` would close it with one
key on one dictionary, inventing no text and announcing nothing twice.

### The lesson

Eight findings this session were wrong, and five survived into code or a commit message
before being caught. Every one was caught by something other than the author's own
reading: a toggled property, a second reader disagreeing with the first, poppler or
ghostscript or veraPDF returning something unexpected, or a fixture asserted to be
loadable. None was caught by writing the code carefully.
