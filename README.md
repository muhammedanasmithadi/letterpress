# letterpress

Render HTML to PDF through Chromium's own print engine. The output is the same file
Chrome's Save-as-PDF produces: real vector text, an exact page box, a tagged
structure and heading bookmarks. Nothing is rasterised unless the document
contains a real image.

No npm dependencies. Bun only.

## Use

```bash
bun src/cli.ts page.html -o page.pdf
cat page.html | bun src/cli.ts - -o page.pdf
bun src/cli.ts https://example.com -o page.pdf      # implies --allow-network
bun src/cli.ts --template invoice --data order.json -o invoice.pdf
```

`--help` lists every option. Exit codes are `0` rendered, `1` render failed,
`2` bad usage.

## What the renderer gives you

|                              |                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| warm render                  | ~0.3 s                                                                                                                          |
| A4 from `@page { size: A4 }` | exactly 594.96 × 841.92 pt                                                                                                      |
| text                         | selectable and searchable, with `ToUnicode` maps                                                                                |
| structure                    | tagged PDF, bookmarks from `<h1>`–`<h6>`                                                                                        |
| fonts                        | embedded and subset, including a full Arabic set                                                                                |
| eight concurrent renders     | ~1.1 s wall; one browser is enough                                                                                              |
| image downsampling           | capped at 300 ppi by default; a 4000px photo at 180mm would otherwise print at 565 ppi and produce a PDF larger than the source |

## Writing a document that paginates well

Declare the paper in CSS. The document's own `@page` wins over the flags, which
is what makes the page box exact.

The CSS keyword is not always the name `--format` uses. `tabloid` is a `--format`
value and the trade's word for 17 × 11 in; the CSS keyword for the same sheet is
`ledger`. A `size` keyword CSS does not know is discarded, and the page comes out
at Chromium's default letter with no finding and no error, so a newspaper written
`size: tabloid landscape` prints as letter portrait.

| `--format` | `@page { size: }` | sheet       |
| ---------: | ----------------- | ----------- |
|       `a3` | `A3`              | 297 × 420mm |
|       `a4` | `A4`              | 210 × 297mm |
|       `a5` | `A5`              | 148 × 210mm |
|   `letter` | `letter`          | 8.5 × 11in  |
|    `legal` | `legal`           | 8.5 × 14in  |
|  `tabloid` | **`ledger`**      | 11 × 17in   |

`ledger` is the only name here that differs. Orientation is a second word in both:
`size: ledger landscape`.

```css
@page {
  size: A4;
  margin: 18mm 16mm;
  @top-right {
    content: 'ACME';
    font: 8pt sans-serif;
  }
  @bottom-right {
    content: 'page ' counter(page) ' of ' counter(pages);
    font: 8pt sans-serif;
  }
}
thead {
  display: table-header-group;
} /* headings repeat on every page */
tr {
  break-inside: avoid;
} /* never split a row */
```

Three things Chromium does **not** implement, all of which fail silently:

- `target-counter()` and `leader()`, so a table of contents built from them
  prints nothing at all. Resolve the page numbers in a second pass instead.
- `string()` and running elements, so `string-set` headers do not appear.
- `position: running()`.

The tool reports each of these as an `unsupported-paged-media` finding rather
than letting you find out from the finished document.

## Reproducible output

Chromium varies two things between runs of identical input: `/CreationDate`, and
the document title, which it takes from the page URL. Set `SOURCE_DATE_EPOCH` and
both are rewritten, so two runs of the same document are byte-identical:

```bash
SOURCE_DATE_EPOCH=1700000000 bun src/cli.ts page.html -o page.pdf
```

Without it, output keeps the timestamp and title Chromium produced. Animated CSS
is already deterministic in the print path, so no animation flag is needed.

## Images

Raster images print at their full stored resolution, which for a modern camera
means a PDF larger than the file you started from. `--max-image-ppi` caps the
effective resolution at 300 by default, the print convention; `0` disables it.
Every reduction is reported as an `image-downsampled` finding.

To make this work the document and its images are served together over loopback
rather than opened as files. A `file://` image taints the canvas, so it cannot
be read back for resizing at all.

### Assets beside the document

A document may only read files inside its own directory. That is the safe
default: an HTML file that references `../../etc/passwd` must not become a way
to read outside it.

It is narrower than most sites need. A page at `site/lessons/x.html`
referencing `../assets/styles.css` is ordinary layout, and it is refused. Name
the site root and it is allowed:

```
bun src/cli.ts --root site site/lessons/x.html -o lesson.pdf
```

`--root` bounds where a resolved path may land; it does not change what a
relative path means, so a document that says `assets/styles.css` still resolves
against its own directory. A stylesheet's `@import`s and a module script's
`import`s are followed to the same boundary. A reference that lands outside it
is reported as `asset-outside-root`, with each path and the flag that would
allow it. Whether the file exists is not checked: that would make the finding
a yes/no oracle over arbitrary paths, which the render server hands to whoever
asked.

## Findings

`--json` returns a `findings` array. Warnings and errors also go to stderr, and
`--quiet` does not silence them, because they are diagnostics rather than part
of the summary.

Six of these read the loaded page before it is printed, so they cost nothing
extra: the document is already there. `content-overflows-page` compares each
element against either the printable width or the page box, depending on
whether it is sized in pixels, because a fixed width survives into print while
a fluid one scales with its container. Two shapes it cannot separate are stated
in the finding itself rather than left as a surprise: a fixed width set by a
stylesheet rule rather than inline, and an element that only print CSS widens.

| code                        | meaning                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `orientation-ignored`       | `--landscape` was dropped: the declaration names no paper to transpose (`size: auto`)                                                 |
| `margin-ignored`            | `--margin` was dropped: the document declares `@page margin`                                                                          |
| `page-size-override`        | `--format` disagrees with the document's `@page`; the declaration is stripped and the request applied                                 |
| `orientation-ignored`       | `--landscape` cannot apply: the declaration names no paper to transpose, so there is nothing to turn                                  |
| `rtl-digit-run`             | `2026-10-03` after Arabic prints as `03-10-2026`; wrap it in `<bdi dir="ltr">`                                                        |
| `rtl-page-counter`          | a page counter in an `@page` margin box is laid out right-to-left, so page one of two prints `2 / 1`; set `direction: ltr` on the box |
| `missing-glyph`             | a character no installed font covers, so it prints as a blank box                                                                     |
| `unsupported-paged-media`   | a CSS paged-media function Chromium silently discards                                                                                 |
| `unfilled-placeholder`      | the document still contains `{{token}}`                                                                                               |
| `json-rendered`             | a data file was printed as a document                                                                                                 |
| `network-blocked`           | a remote request was blocked, with its URL                                                                                            |
| `subresource-failed`        | a referenced asset did not load, so the pdf will not look like the source                                                             |
| `asset-outside-root`        | the document references a path outside its own directory, which was not read; pass `--root`                                           |
| `selection-fragmented`      | a word gap is wider than 0.6 em, so a browser will break the selection into separate boxes at it                                      |
| `text-runs-merged`          | per-glyph text positioning folded into TJ arrays, glyph positions verified unchanged; also reports any block left alone               |
| `asset-overwrites-document` | the document references a file named `input.html` or `override.html`, which was not staged because it would replace the page          |
| `audit-failed`              | the document checks could not run at all; a bug in letterpress, not in the document                                                   |
| `audit-partial`             | the document checks stopped part way; findings above the failure were measured, the rest were not                                     |
| `figure-role-corrected`     | a grouping `Figure` around a described inner figure was re-tagged `Div`                                                               |
| `font-metrics`              | a font descriptor still carries a negative cap height, which a viewer may refuse to render text over                                  |
| `glyphs-skipped`            | further characters with no glyph are invisible formatting, so they are counted, not listed                                            |
| `image-downsampled`         | an image was downsampled to the PPI cap; pass `--max-image-ppi 0` to disable                                                          |
| `ligature-spans`            | redundant `/ActualText` spans around ligatures were removed; extraction verified unchanged                                            |
| `metadata-authored`         | the document's own `<meta name="author">` was written as the pdf author                                                               |
| `metadata-subject`          | the document's own `<meta name="subject">` was written as the pdf subject                                                             |
| `orientation-overridden`    | the paper was transposed against the document's `@page size`, which keeps its own size and margin                                     |
| `output-unverified`         | the finished file failed the structural check; an error, never a warning                                                              |
| `page-probe-failed`         | a page-side probe threw, so its measurement is absent                                                                                 |
| `repair-rejected`           | a repair was discarded because it did not leave a valid pdf; the file is unchanged                                                    |
| `dialog-dismissed`          | the document opened an `alert`/`confirm`/`prompt` mid-render and it was refused, so a blocked script never finished                   |
| `js-error`                  | the document threw an uncaught error while being printed, and the pdf was produced anyway                                             |
| `missing-alt`               | an image has no `alt` at all, so nothing describes it; `empty-alt` covers `alt=""` on an image that is not marked decorative          |
| `lang-undeclared`           | the document names no language, so Chromium stamped the pdf with the browser's locale instead                                         |
| `figure-uncaptioned`        | a `<figure>` has no `<figcaption>`, which is what makes Chromium emit a Figure role in the tagged pdf                                 |
| `content-overflows-page`    | an element is wider than the printable area, measured in screen layout                                                                |
| `stylesheet-unreadable`     | a cross-origin stylesheet could not be read, so layout findings cover only this origin                                                |
| `url-render-blocked`        | a remote URL needs `allowNetwork`; without it its subresource loads and usually the document itself is blocked                        |

### Findings over HTTP

`POST /render` answers in one of two shapes. The default is JSON, with
`findings` in the body. `"responseFormat": "pdf"` answers with the PDF bytes
and nothing else, so the findings travel in headers instead:

| header                   | meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `x-letterpress-pages`    | pages in the document                                                                 |
| `x-letterpress-ms`       | render time in milliseconds                                                           |
| `x-letterpress-tagged`   | whether the document has a structure tree                                             |
| `x-letterpress-findings` | how many findings, at any severity                                                    |
| `x-letterpress-errors`   | the codes of the error-severity findings, comma-separated, empty when there were none |

The status stays `200` for a document with error findings, because the PDF is
real and you asked for it. `x-letterpress-errors` is the only way to tell a
clean render from a failed one, so check it.

## HTTP API

`bun src/server.ts` starts the server on port `8787`, or `$PORT`. Every
response is JSON unless noted. Origins are loopback-only: a browser page from
anywhere else gets a 403, so the server is a local service, not a public one.

### `GET /health`

`{"ok": true, "port": 8787, "chromium": true}` — 200 when Chromium answers,
503 when it does not.

### `POST /render`

`content-type: application/json` (anything else is a 415). The body is one
JSON object:

| field             | type    | meaning                                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `html`            | string  | **required.** the document. A `path` key is refused: send the markup, not a filename          |
| `format`          | string  | `a3` `a4` `a5` `legal` `letter` `tabloid`; default is the document's own `@page`, then A4     |
| `landscape`       | boolean | transposes the paper; a document's own `@page` is turned, keeping its size and margin         |
| `margin`          | string  | absolute CSS length (`15mm`); needs `format`; ignored if the document declares `@page margin` |
| `pageRanges`      | string  | e.g. `"1-3"`; the response is marked `partial`                                                |
| `printBackground` | boolean | background graphics (default on)                                                              |
| `allowNetwork`    | boolean | permit remote `http(s)` requests instead of blocking them                                     |
| `maxImagePpi`     | number  | downsample images above this resolution (default 300; 0 disables)                             |
| `settleMs`        | number  | extra wait after fonts resolve                                                                |
| `timeoutMs`       | number  | per-render deadline in ms (default 30000)                                                     |
| `author`          | string  | pdf author                                                                                    |
| `subject`         | string  | pdf subject                                                                                   |
| `keywords`        | string  | pdf keywords                                                                                  |
| `responseFormat`  | string  | `"json"` (default) or `"pdf"`; anything else is a 400                                         |

Limits, all tunable: at most 4 renders run at once (`HTML2PDF_MAX_RENDERS`)
with 16 queued behind them (`HTML2PDF_MAX_QUEUE`); documents over 6000 pages
(`HTML2PDF_MAX_PAGES`) are refused with a 413 unless `pageRanges` narrows them;
request bodies over 8 MB are refused with a 413. A full queue answers 429 with
`retry-after: 2`; a render still queued at shutdown answers 503 with
`retry-after: 5`.

The JSON answer carries `ok`, the base64 `pdf`, `pages`, `bytes`, `ms`,
`mediaBoxes`, `tagged`, `findings`, `blocked`, and `partial`. A thrown render
answers 500 with `ok: false` and an `error`; anything the body gets wrong
answers 400 naming the field. With `"responseFormat": "pdf"` the answer is the
bytes with the report as headers (see above).

## The viewer

`bun src/server.ts` also serves a browser shell at `http://127.0.0.1:8787/`
(the port comes from `$PORT`, and the CLI message names it). It renders through
the same `render()` the CLI uses, so the preview and the PDF you download cannot
differ.

The starter document renders on load. Edit the source and it re-renders 400 ms
after the last keystroke; Ctrl+Enter (Cmd+Enter) renders at once. The settings
row mirrors the CLI flags: format, margin, image PPI, orientation, background
graphics, network. The preview draws the returned bytes with the browser's own
PDF viewer — nothing is vendored — and the PDF button saves exactly those bytes.

Notes:

- The editor is a plain textarea behind a tokenized highlight layer. There is no
  editor library and no build step.
- Where `navigator.pdfViewerEnabled` is false the preview pane says so and
  Download still works.
- The preview frame is outside the tab order on purpose: a browser PDF viewer
  brings a dozen tab stops of its own, which otherwise land between the editor
  and the page controls.
- Every edit re-renders the whole document. There is no page-range render and no
  large-document cutoff yet, so a very long document re-renders in full.

## Right-to-left text

Arabic shapes and joins correctly, reading order is right, and numeric columns
align. One trap, and it is a Unicode bidi rule rather than a bug: a hyphen
between digit groups is a neutral separator, so `2026-10-03` after Arabic text
prints as `03-10-2026`. Each group stays internally correct, which is what makes
it look plausible. Isolate it:

```html
<bdi dir="ltr">2026-10-03</bdi>
```

The tool reports the risk, once per distinct token with a count of how many
times it appears. It decides direction the way a browser does: an explicit `dir`
or CSS `direction` on an ancestor, otherwise the first strong character in the
paragraph, so an Arabic document with `lang="ar"` and no `dir` is still covered.
A strong left-to-right character before the number protects it, so `ISO 8601:
2026-10-03` and `INV-2026-0147` are correctly left alone, as is anything already
wrapped in `<bdi dir="ltr">`.

It cannot fix the text for you.

A second trap lives in the `@page` margin boxes, where there is no markup to wrap.
A page counter is a generated string, and the margin box inherits the page
direction, so on a document with `dir="rtl"` on `<html>`:

```css
@page {
  @top-right {
    content: counter(page) ' / ' counter(pages); /* page one prints 2 / 1 */
  }
}
```

The two number runs are reordered by the same bidi rule, and nothing reports it.
Give the box its own direction:

```css
@top-right {
  direction: ltr;
  content: counter(page) ' / ' counter(pages);
}
```

The `rtl-digit-run` finding does not cover this. It looks for a digit run in the
document text, and a margin box holds no document text at all. The rendering is
correct; the reading is not, which is why it has to be found by looking at the page.

## Selecting text in a browser

A browser draws one highlight box per text item, and a text item ends wherever the
gap between two glyphs leaves a band the viewer recognises. In Firefox's PDF.js —
the engine behind the built-in viewer — a gap is kept inside the current item only
between **0.102 and 0.6 em**. Inside that band it becomes a space you can select
across. Outside it, in either direction, the item ends and the gap becomes a
highlight of its own.

So a justified paragraph, whose word spaces stretch past 0.6 em, selects as a row of
separate boxes. So does a table, whose cell gutters are measured in ems. Neither is
a fault in the file: the gaps are real, the geometry is correct, and every reader
that applies the same rule does the same thing.

There is a third cause with a different origin, and this one is fixed rather than
explained. Chromium wraps **every ligature** in a marked-content span carrying
`/ActualText`, and a reader ends a text item at each of them whatever the spacing
says. `fi`, `fl` and `ffi` are the usual triggers. It is not caused by tagging: a
file rendered with `generateTaggedPDF` off is identical, because the spans come from
the shaping layer rather than the structure tree.

Establishing that took an intervention rather than a correlation. Stripping the span
wrappers from a rendered file while keeping every glyph took a page of ordinary prose
from 67 text items and 18 whitespace items down to 9 and none — nine being its nine
lines, which is what the geometry alone produces.

So this tool removes them. A span is removed only when the text its `/ActualText`
declares is exactly what the glyphs inside resolve to through `/ToUnicode`. Where the
two disagree the span is the only copy of that text and it stays. The extracted text
is unchanged character for character, so there is nothing to trade: on a page of
prose, 78 highlight boxes before and 8 after, and the 8 are the 8 lines.

`--keep-ligature-spans` turns it off if you want the spans regardless.

The other two causes are geometry, and only CSS touches them:

```css
/* justification is the usual cause; left, or a longer measure, brings it inside */
p {
  text-align: left;
  max-width: 34em;
}

/* tight table gutters */
table {
  border-collapse: separate;
  border-spacing: 0;
}
td,
th {
  padding: 0 2px;
}

/* letter-spacing narrows every space, including the ones you want */
body {
  letter-spacing: 0;
}
```

What you cannot do is change a gap in the PDF. Nothing in the file alters what the
gap measures — the ligature spans above are removed because they were never measuring
anything, not because the measurement changed.

`bun tools/selection.ts <file.html>` measures the real numbers on your document: how
many gaps there are, how wide the widest is, and how many ligature spans. It reads
the document before it attributes a cause — where justification is absent it says
so, rather than telling you to change a rule that is not there. It does not yet say
which element each gap belongs to, so finding the eight flex or grid gaps in your
document is still a job for the inspector.

## Templates

`--list-templates` prints what is bundled. Values come from JSON:

```json
{
  "invoice_no": "2026-014",
  "currency": "EUR",
  "vat_rate": 0.21,
  "items": [{ "description": "Consulting", "qty": 12, "unit": 1150 }]
}
```

`{{token}}` is escaped for markup, so a value cannot inject markup. `{{{token}}}`
passes HTML through untouched, for the few values that are built markup such as
table rows.

A slot inside a stylesheet needs a different escaper, because a value that cannot
break out of an element can still break out of a declaration. Use `_css`:

```html
@page { size: {{paper_css}}; } :root { --accent: {{accent_css}}; }
```

`_css` escapes everything a CSS value does not legitimately use — including the
semicolon and the brace that `{{token}}` leaves alone. An `accent` of
`red; } body { display: none } :root { --accent: red` printed an invoice with no
body at all, reported one page, and exited 0.

Use `_text` for a value inside a CSS `content:` string. A CSS string does not
decode HTML entities, so the markup escaper would be wrong there too.

Totals are computed from `items`, never read from the file. If the file also
carries a `subtotal`, `vat` or `total`, the computed figure wins and a mismatch
is an error, because printing a supplied total would send a wrong figure to a
customer. An empty `items` array, a non-numeric quantity, or a `vat_rate` that
is not a number are all errors too.

A line item description may not contain markup. `<script>` would hang the render
on the dialog it opens, and `<style>body{display:none}</style>` produces a blank
invoice that still reports success, so both are refused by name rather than
escaped and printed.

## Development

```bash
bun test          # 667 tests across 35 files
bun tools/selection.ts ~/Documents/a.html   # what a browser will do when a selection is dragged across it
bun run bench     # cold start, concurrency and footprint, cross-runtime
bun run typecheck
```

Tests assert against independent implementations rather than against this
renderer's own parser, because every real defect found so far came from one of
them and none from a test written here.

| tool                                                              | what it is for                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| poppler — `pdfinfo` `pdftotext` `pdffonts` `pdfimages` `pdftoppm` | the assertions in the test suite                         |
| ghostscript                                                       | an independent parser that disagrees usefully            |
| [veraPDF](https://software.verapdf.org/releases/) 1.30.3          | PDF/UA-1 and PDF/A conformance, via `bun tools/pdfua.ts` |

veraPDF is not vendored — 33MB of Java with a bundled JRE — so `tools/pdfua.ts`
reads `VERA_PDF` and points at an install. It is **not pinned by this repository**:
the conformance numbers recorded in `docs/architecture-assessment.md` were measured
with 1.30.3, and a different version can move them.

Encrypted files are reported rather than repaired. Seven repair modules — the
toUnicode, font descriptor, link description, metadata, figure-role, text-run and
ligature-span fixes — decline a file that declares `/Encrypt` in its trailer,
because repairing one would mean writing a key into it. `inspect()` reports
`encrypted` so a caller can see why nothing was fixed. A render cannot produce
one: Chromium writes the file, and a PDF passed in as input is refused as not
HTML.

`tools/structure-tree.ts <file.pdf>` prints a tagged document's structure tree and
the MCID census behind it, which is the fastest way to see what a change to the
repair layer actually did.

Several tests resolve a font family and depend on which face it lands on, so CI
installs the families they name — `fonts-dejavu-core`, `fonts-liberation2`,
`fonts-noto-core` — and prints what the runner actually resolved. See
`docs/measurements.md` for the numbers and for two Chromium lifecycle traps this
codebase works around.
