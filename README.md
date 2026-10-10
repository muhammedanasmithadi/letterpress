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
| warm render                  | ~65 ms                                                                                                                          |
| A4 from `@page { size: A4 }` | exactly 594.96 × 841.92 pt                                                                                                      |
| text                         | selectable and searchable, with `ToUnicode` maps                                                                                |
| structure                    | tagged PDF, bookmarks from `<h1>`–`<h6>`                                                                                        |
| fonts                        | embedded and subset, including a full Arabic set                                                                                |
| eight concurrent renders     | ~1.1 s wall; one browser is enough                                                                                              |
| image downsampling           | capped at 300 ppi by default; a 4000px photo at 180mm would otherwise print at 565 ppi and produce a PDF larger than the source |

## Writing a document that paginates well

Declare the paper in CSS. The document's own `@page` wins over the flags, which
is what makes the page box exact.

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

| code                        | meaning                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `orientation-ignored`       | `--landscape` was dropped: the document declares `@page size`                                                                |
| `margin-ignored`            | `--margin` was dropped: the document declares `@page margin`                                                                 |
| `page-size-override`        | `--format` disagrees with the document's `@page`; the declaration is stripped and the request applied                        |
| `orientation-ignored`       | `--landscape` cannot apply: the document declares `@page size` and no `--format` was given                                   |
| `rtl-digit-run`             | `2026-10-03` after Arabic prints as `03-10-2026`; wrap it in `<bdi dir="ltr">`                                               |
| `missing-glyph`             | a character no installed font covers, so it prints as a blank box                                                            |
| `unsupported-paged-media`   | a CSS paged-media function Chromium silently discards                                                                        |
| `unfilled-placeholder`      | the document still contains `{{token}}`                                                                                      |
| `json-rendered`             | a data file was printed as a document                                                                                        |
| `network-blocked`           | a remote request was blocked, with its URL                                                                                   |
| `subresource-failed`        | a referenced asset did not load, so the pdf will not look like the source                                                    |
| `asset-outside-root`        | the document references a path outside its own directory, which was not read; pass `--root`                                  |
| `selection-fragmented`      | a word gap is wider than 0.6 em, so a browser will break the selection into separate boxes at it                             |
| `text-runs-merged`          | per-glyph text positioning folded into TJ arrays, glyph positions verified unchanged; also reports any block left alone      |
| `asset-overwrites-document` | the document references a file named `input.html` or `override.html`, which was not staged because it would replace the page |

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

`{{token}}` is escaped, so a value cannot inject markup. `{{{token}}}` passes
HTML through untouched, for the few values that are built markup such as table
rows.

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
bun test          # 511 tests across 23 files
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

`tools/structure-tree.ts <file.pdf>` prints a tagged document's structure tree and
the MCID census behind it, which is the fastest way to see what a change to the
repair layer actually did.

Several tests resolve a font family and depend on which face it lands on, so CI
installs the families they name — `fonts-dejavu-core`, `fonts-liberation2`,
`fonts-noto-core` — and prints what the runner actually resolved. See
`docs/measurements.md` for the numbers and for two Chromium lifecycle traps this
codebase works around.
