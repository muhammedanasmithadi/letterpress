# Architecture assessment

An evaluation of what letterpress actually does, measured rather than assumed.
Every number here was produced by a script in this session; the scripts are named.
Nothing in this document is an estimate presented as a result.

The question asked was whether the architecture meets the use case, and whether
performance, output quality, reliability or design are being left on the table.
The short answer: performance is not the problem, and the design is sound in its
central decision. The problem is that the repair layer has no verification, and
that is why defects keep shipping through it.

## 1. Current state

The product renders HTML to PDF through Chromium's own print engine, with a
shell, a loopback render server, a template filler and a CLI. Roughly 4,000 lines
of source and 5,900 of tests, no runtime dependencies, Bun 1.4 only.

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

## 8. Still open

1. **A 2,000-page document has never been rendered.** The server's cap asserts it
   is possible; nothing has confirmed it.
2. **Headful parity** is one test behind a `DISPLAY` gate.
3. **The three fixes are tested on the documents that motivated them**, not a
   corpus. Generalisation is argued from the mechanism and is unverified.
4. **`stampPdf` truncates a title that exceeds its slot.** By design and
   documented, but it means a long document title is silently clipped.

## 9. How success would be verified

- The gate: inject a known corruption into a rendered PDF and assert the shipped
  file is the un-repaired one. That test is the gate's own proof.
- Idempotence: assert each repair returns its own output untouched, per font
  family.
- Concurrency: assert that a burst of 8 concurrent requests is queued and all 8
  succeed, with a bounded wait.
- The audit: re-run all twelve findings' reproductions against the fixed build
  and record which are fixed, retracted, or still open.