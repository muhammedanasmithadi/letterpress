# Text selection in a reader

What a browser does when a selection is dragged across a document, and what to
change in the document to make it do something else. `src/selection.ts`
measures it; `tools/selection.ts` reports it per document with the edit that
would fix it.

## How a reader groups text

Firefox's PDF.js does not draw one highlight per line. It draws one per _text
item_, and it decides where one item ends and the next begins from the
geometry: a gap between two visible glyphs is kept inside the current item
only when it falls in a narrow band relative to the font size, and outside that
band the item is ended and the gap becomes a whitespace item of its own. The
visible result is a highlight broken at every word, and one DOM span per break
to lay out on every selection.

The band, from `src/core/evaluator.js` in pdf.js:

```
const TRACKING_SPACE_FACTOR = 0.102;   // narrower than this is tracking, not a space
const NEGATIVE_SPACE_FACTOR = -0.2;    // moving backwards ends the item
const SPACE_IN_FLOW_MIN_FACTOR = 0.102;
const SPACE_IN_FLOW_MAX_FACTOR = 0.6;  // wider than this ends the item
const VERTICAL_SHIFT_RATIO = 0.25;     // a move of this much vertically ends it too
```

Justified text lands outside it: on a measured page, changing `text-align`
from `justify` to `left` took the gaps that break a run from 10 to 1 and the
longest line from 19 items to 9, with nothing else changed. A gap wider than
0.6 em is a stretched word space; a gap narrower than 0.102 em is a word space
squeezed by letter-spacing.

Nothing in the file can change what those gaps are. The geometry is the
layout's, and a reader measures it correctly. So the useful thing to do is
measure it and say so, rather than let the reader of the PDF find out by
dragging a cursor over it.

## Positions are in text space

Throughout, positions are held in text space. A reader measures in device space
and divides by the CTM scale to arrive at the same place; dividing a
text-space difference by that scale as well shrinks every gap by it, and the
implementation was doing exactly that: the page Firefox reports 14 breaks on
came out at 48. Removing the second division takes it to 9, and the gutter
count on the table page, which was already right, stays at 179 against the 180
the reader produces.

`Tm` and `Td` operands are text space, and a glyph advance is
`width/1000 * size`, all of which is the same space the font size is in.
Dividing again would make each threshold behave as if the font were scale
times larger.

## What the model does not cover

The reader adds things on top of this arithmetic that are not modelled: it
ends an item at a font change, at a marked-content boundary, and when a chunk's
accumulated width goes negative, which inverts the sign of the band tests. So
`breaks` is an upper estimate and `widest` is the number to act on.

The marked-content case is established by intervention rather than by
correlation: stripping the span wrappers from a rendered file while keeping
every glyph took a page of ordinary prose from 67 text items and 18 whitespace
items down to 9 items and none — 9 items being its 9 lines, which is what this
report says the geometry alone produces. Tagging is not the cause: the same
file rendered with `generateTaggedPDF` off is identical in both counts, because
the spans come from the shaping layer rather than the structure tree.

The count of spans is an upper bound on the reader's whitespace items — 18
against 20 on that page, 49 against 68 on the multilingual one — because a span
with no gap in front of it starts a fresh item without producing one.
Modelling that exactly means carrying a position across each boundary, which
the masking pass deliberately destroys.

## Which gaps are which

- A gap past the band but no larger than 3 em is what a stretched word space
  looks like. Above 3 em the reader is moving from one block, column or cell
  to the next, which ends a text item just the same but has nothing to do with
  justification.
- A gap narrower than a tracking space is absorbed into the run on its own. It
  only ends the item when a space glyph came just before it, because then the
  reader would rather split than leave the layer misaligned.
- A move to another line is not a word gap, and Chromium writes the whole line
  from its left margin, so at a line break the pen also jumps backwards.
  Testing the horizontal move first books every line break as a backwards
  move and leaves `lines` counting nothing, which is how a document with four
  hundred line breaks reported thirty-nine.
- Moving back within a line ends the item. That is a layout shape rather than
  a word gap, so it is reported apart from them.

Only a gap that could be a word space is worth quoting: the widest one on a
table is the jump to the next column, and naming that as a stretched word
space would send whoever reads the finding to the wrong CSS property.

## Counting

The walk covers a whole content stream rather than one text object at a time,
because that is what a reader does: `BT` resets the text matrix, not the item
being built, so the gap from the last cell of a table row to the first cell of
the next column is measured like any other. Measuring per text object misses
exactly the gaps a table is made of.

Only the operators Chromium emits are handled. A wrong reading of an operator
would invent gaps that are not there, which is the one thing a report about
gaps cannot afford:

- `Tz`, `Tc`, `Tw`, `TL`, `T*` and a pre-existing `TJ` all move the pen.
  Skipping any of them would measure gaps the reader does not see, so meeting
  one refuses the stream rather than passing over it.
- `b` and `c` decide where a `Td` puts the pen, so a sheared matrix cannot be
  read as a plain move or every gap on the line is invented.
- A literal string inside `TJ` shows glyphs through an encoding this does not
  read. Passing over it leaves the pen where it was and shifts every gap after
  it, which is the one failure a report about gaps cannot have.
- A Type 3 subset uses one byte per code and a CID font two, and the bytes
  themselves do not say which: `<70>` is one glyph in the first and half of one
  in the second. Splitting every string into pairs halved the advance of every
  fallback glyph and invented a gap after each.
- One byte per code in a simple font and two in a CID font, and which this is
  cannot be told from the bytes, so the run is counted once rather than
  guessing a count of glyphs. The pen does not move: an advance that is not
  known is not invented.
- A reader folds an invisible glyph into the pen advance instead of placing
  one, but it still remembers that a space came by, which is what decides
  whether a following narrow gap ends the item.
- A font with no readable widths — a Type 3 subset, or anything whose advances
  are in `/Widths` rather than `/W` — does not refuse the stream. Refusing
  threw away the whole page: a document with eighteen Type 3 fallback fonts
  for CJK and one Latin face measured nothing at all. Its glyphs are marked
  instead, the run is re-anchored after them so no gap is measured across what
  is unknown, and the count is reported.
- The advance is unknown, so no gap may be measured to or from that glyph.
  Dropping the anchor means the next readable glyph starts a fresh comparison
  rather than inheriting a position that was never established.
- A literal string is masked first: without it, an `ET`, a `Td` or a `TJ`
  inside one is an operator, and the block it ends is text that has not been
  measured.
- One item spans the stream, as it does in a reader: a new text object does not
  end it.

A stream is dropped when it will not inflate, when its page binds no font
under the name the stream uses, or when it sets a text matrix this cannot
interpret — and a dropped stream takes its glyphs out of every count while the
counts still read as a document total. A document where not one stream could be
read has no measurement to report, and a row of zeroes read as "this document
has no wide gaps" is the opposite of the truth.

## What the counters mean

- `gaps` — gaps between two visible glyphs that did not move to another line.
- `breaks` — of those, the ones a reader will end a text item on.
- `tooWide` — gaps past the band but no larger than 3 em.
- `jump` — gaps larger than that, which are jumps between blocks rather than
  between words.
- `widest` — the widest word-sized gap in em, which is the one worth acting
  on.
- `widestAll` — the widest gap of any size, jumps included. Every other
  counter is a category or a minimum, and a width read from the wrong page
  moves none of them: both the right and the wrong advance can land in the
  same bucket, and the smallest gap is whichever page happened to read
  correctly. This is the quantity that changes.
- `narrowest` — the narrowest gap of any kind, in em, including the negative
  ones a kern produces.
- `spans` — marked-content spans carrying `/ActualText`.
- `unreadable` — glyphs whose font had no readable advance, so no gap around
  them was measured.
- `streams` — text streams this walked, and `read` — how many of those it
  could read.

`textFlow` returns null for a file whose text it cannot read, which is a
different answer from a file with no gaps.
