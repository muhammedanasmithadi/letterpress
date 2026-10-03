# html2pdf

HTML to PDF through Chromium's own print engine. The output is the same file
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

| | |
|---|---|
| warm render | ~65 ms |
| A4 from `@page { size: A4 }` | exactly 594.96 × 841.92 pt |
| text | selectable and searchable, with `ToUnicode` maps |
| structure | tagged PDF, bookmarks from `<h1>`–`<h6>` |
| fonts | embedded and subset, including a full Arabic set |
| eight concurrent renders | ~1.1 s wall; one browser is enough |

## Writing a document that paginates well

Declare the paper in CSS. The document's own `@page` wins over the flags, which
is what makes the page box exact.

```css
@page {
  size: A4;
  margin: 18mm 16mm;
  @top-right    { content: "ACME"; font: 8pt sans-serif }
  @bottom-right { content: "page " counter(page) " of " counter(pages); font: 8pt sans-serif }
}
thead { display: table-header-group }   /* headings repeat on every page */
tr    { break-inside: avoid }           /* never split a row */
```

Three things Chromium does **not** implement, all of which fail silently:

- `target-counter()` and `leader()`, so a table of contents built from them
  prints nothing at all. Resolve the page numbers in a second pass instead.
- `string()` and running elements, so `string-set` headers do not appear.
- `position: running()`.

The tool reports each of these as an `unsupported-paged-media` finding rather
than letting you find out from the finished document.

## Findings

`--json` returns a `findings` array. Warnings and errors also go to stderr, and
`--quiet` does not silence them, because they are diagnostics rather than part
of the summary.

| code | meaning |
|---|---|
| `orientation-ignored` | `--landscape` was dropped: the document declares `@page size` |
| `margin-ignored` | `--margin` was dropped: the document declares `@page margin` |
| `page-size-override` | `--format` disagrees with the document's `@page`; the request won |
| `rtl-digit-run` | `2026-10-03` after Arabic prints as `03-10-2026`; wrap it in `<bdi dir="ltr">` |
| `missing-glyph` | a character no installed font covers, so it prints as a blank box |
| `unsupported-paged-media` | a CSS paged-media function Chromium silently discards |
| `unfilled-placeholder` | the document still contains `{{token}}` |
| `json-rendered` | a data file was printed as a document |
| `network-blocked` | a remote request was blocked, with its URL |

## Right-to-left text

Arabic shapes and joins correctly, reading order is right, and numeric columns
align. One trap, and it is a Unicode bidi rule rather than a bug: a hyphen
between digit groups is a neutral separator, so `2026-10-03` after Arabic text
prints as `03-10-2026`. Each group stays internally correct, which is what makes
it look plausible. Isolate it:

```html
<bdi dir="ltr">2026-10-03</bdi>
```

The tool reports the risk; it cannot fix the text for you.

## Templates

`--list-templates` prints what is bundled. Values come from JSON:

```json
{ "invoice_no": "2026-014", "currency": "EUR", "vat_rate": 0.21,
  "items": [{ "description": "Consulting", "qty": 12, "unit": 1150 }] }
```

`{{token}}` is escaped, so a value cannot inject markup. `{{{token}}}` passes
HTML through untouched, for the few values that are built markup such as table
rows. Totals are computed from `items` rather than taken from the file, so a
hand-typed total cannot reach a customer. A missing value is an error, never an
empty hole.

## Development

```bash
bun test          # 41 tests, verified against poppler
bun run bench     # cold start, concurrency and footprint, cross-runtime
```

Poppler (`pdfinfo`, `pdftotext`, `pdffonts`, `pdfimages`, `pdftoppm`) is an
independent PDF implementation, so tests assert with it rather than with the
renderer's own parser. See `docs/measurements.md` for the numbers and for two
Chromium lifecycle traps this codebase works around.