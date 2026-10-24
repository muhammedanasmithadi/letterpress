# PDF structure, and the repairs that change it

What this tool reads, what it rewrites, and why each rewrite is safe. The
modules here are `src/pdfparts.ts` (splitting a file into objects),
`src/pdf.ts` (inspecting one), `src/verify.ts` (checking the result), and the
repair modules: `src/spans.ts`, `src/tjmerge.ts`, `src/tounicode.ts`,
`src/fontdesc.ts`, `src/textfont.ts`.

## The shapes a reader accepts

A cross-reference stream is an object, and it is what every writer from pdf
1.5 onwards produces, so a pointer to one is a pointer to a cross-reference
table. A file that has been updated has more than one pointer and more than
one end of file marker, and the last of each is the one a reader uses. The
tokens of a pdf are separated by any whitespace, so `1  0  obj` is an object
header. A reader looks for the header in the first thousand and twenty-four
bytes, so a file with a little something in front of it is still a file.

A content stream that says it is compressed and does not decode leaves the
page blank in every reader, and saying so is the difference between a
document that is fine and a document that is not.

The bytes of a stream may hold anything, and a document that says "1 0 obj"
on a line of its own is a document that explains pdf syntax. The end of an
object with a stream is found from its own endstream rather than from the next
header, and the endstream that ends it is the one the end of the object
follows, because a payload may name the keyword itself.

An object that lives inside an object stream is not in the file as an object,
and a reference to one of them is not a dangling reference. The splitter
cannot see inside a compressed stream, so such a reference is not reported
rather than reported wrongly.

## Splitting a file

`split()` reads a PDF into its objects and the trailer. Two things make it
decline the file whole rather than work on part of it.

**Encryption.** If the trailer declares `/Encrypt`, every string and stream in
the file is ciphertext except the trailer itself. A repair that reads content
— glyphs, spans, font programs — would reason about random bytes, and one that
writes trailer keys would plant plaintext inside an encrypted file. Repairs
decline such files whole, the way they decline what `split()` only partly
sees. Trailer-only on purpose: `/Encrypt` inside a content stream is document
text or ciphertext, not a declaration.

**Objects past the first trailer.** Trailing garbage, a concatenated file, or
a linearized later revision all put object headers after the trailer.
`split()` only sees what precedes the trailer, so a repair that rewrites from
its objects would drop the rest. A 13 KB linearized file came back as 680
bytes.

The object headers at or past the trailer are not objects of this revision:
trailing garbage after `%%EOF`, or a second file concatenated behind the
first, both match the header pattern. Reading them as objects gave the last
one an end before its start (its "next" is the trailer behind it), so it
round-tripped as empty bytes while `join` still wrote its xref entry — and
every repair using split/join turned a verifying file into one whose table
points at the wrong object. Found by mutation fuzzing: `file.pdf` plus
`42 0 obj...` past `%%EOF` verifies, then breaks. Bytes past the trailer never
reach the output; no PDF parser reads past `%%EOF`.

## What `verify()` checks, and what it does not

`verify()` checks the framing markers — exactly one `startxref` and one
`%%EOF` — and every indirect reference against the set of objects the file
defines.

Scanned: every object dictionary, and the trailer. Not scanned: the payload of
a stream, because `dictCode` stops at `stream`. Measured: on a Chromium-produced
file, dropping any one of its 27 objects is caught, because all 27 are
referenced from a dictionary. A hand-built file whose content stream says
`/Annots 5 0 R`, with object 5 deleted, passes this gate — and no other check
in the file sees it either, since `checkPreserved` compares content streams by
payload and the payload is simply absent from both sides.

That gap is not reachable from the render path: `repairOrKeep` always passes
the original, and `checkPreserved` refuses any repair that changed a content
stream at all, so no repair can put a reference inside one. It is written down
because `verify()` reads like a total check and is not one.

A reference is matched with its generation, not on `0 R` alone. The generation
is part of the reference and can be anything, so a match on `0 R` leaves `9 1 R`
unchecked and a dangling reference passes the gate.

## Removing `/ActualText` spans

Chromium wraps every ligature in a marked-content span carrying `/ActualText`:

```
/Span<</ActualText (fi) >> BDC [-0.000231 <0864>] TJ EMC
```

A reader ends a text item at each one whatever the spacing says, so a page of
ordinary prose comes back as sixty text items where the geometry alone gives
seven. Dragging a selection across it draws sixty highlight boxes, seventeen
of them for gaps that are not there, and the result reads as random rather
than as a paragraph.

Measured in Firefox on one page: sixty items and seventeen whitespace items as
rendered, seven and none with the spans gone. Seven is seven lines. Extraction
is byte-identical, because the font's `/ToUnicode` already maps the ligature
glyph to the two characters the span names — the span is saying what the file
already says.

Which is the whole guard. A span is removed only when the text its
`/ActualText` declares is exactly what the glyphs inside it resolve to through
`/ToUnicode`. Where the two disagree the span is the only copy of that text
and it stays, because removing it would lose a character and leave the PDF
quietly wrong. This is why the repair is safe to make the default rather than
an option.

The resolution follows the font active at each glyph, and a span body may
restate its own font: when a span opens a text block, Chromium places the
`Tf` inside the body, and the font from the previous run can lack the glyph
entirely. Reading the body through the font named before the opener resolved
an empty string, kept every such span as if it were the only copy of its
text, and warned `selection-fragmented` on ordinary pages whose spans the
font's `/ToUnicode` already resolved.

The span is matched in Chromium's own shape, `/Span<</ActualText (fi) >> BDC`,
and the dictionary body is `[^<>]*` and nothing more. The first version allowed
`<<` and `>>` inside it, which is correct PDF and catastrophic here: the body
is greedy, so it ran past this span's closing `>>` through the glyph operators
and the `EMC`, all the way to a later span's `>> BDC`. The cut then removed
everything between, which took the glyphs with it — every "fills" printed as
"lls" — and left the `EMC`s behind, so the content stream no longer balanced.
`verify()` passed it. A file missing a letter is still a valid file.

Two removals, not one. The first version cut from `/Span` through `EMC` and
took the glyph operations with it, so every "fills" printed as "lls" — and
`verify()` passed the result, because a file with a letter missing is still a
valid file. Structural validity is not content correctness, and only comparing
the extracted text against the original found it.

Every cut is unconditional. The first version guarded each one with
`/ActualText/.test(region)`, which is right for the opening and wrong for the
closing: the text of a bare `EMC` contains no `/ActualText`, so all nineteen
closings were skipped and the stream was left with one `BDC` against nineteen
`EMC`. poppler called it "Mismatched EMC operator" and carried on. A guard that
silently drops half the work is worse than no guard.

The cut is made from the end, so an earlier offset stays valid, and it emits
exactly the region the span covered: the marked-content wrapper goes, the glyph
operations stay. The span runs to the next `EMC`; a span that never closes is
not one to reason about.

The comparison is not merely equality: the span must have covered something,
or a span holding a single glyph that resolves to nothing would compare equal
to an empty `ActualText`.

Ciphertext is not content. A span pattern matched inside an encrypted stream
is random bytes agreeing with a regex, and cutting there corrupts the file
while every structural check still passes.

The count of spans is taken before the font check, because that count is what
the finding reports. A span in a stream whose fonts cannot be resolved is left
alone and not repaired, so a count taken afterwards omitted it: the document
carried 36 spans and the finding said "removed 18 of 18" while 18 of them were
still in the file.

## Folding per-glyph positioning into `TJ` arrays

Chromium emits one glyph per text-showing operator, each preceded by its own
relative `Td`. Measured on a ten-line paragraph: 822 `Tj`, zero `TJ`, about 82
show operations per line. A pdfTeX-produced PDF writes a handful of `TJ` arrays
per line instead, each carrying many glyphs with the kerning as numbers
between them.

That difference is not cosmetic. A reader that builds a selection rectangle per
show-operation gets 82 boxes for a line rather than a few, and a reader that
has to group them has to guess. Merging states the run structure.

The arithmetic. `Td` is relative to the _line_ matrix, so the pen position for
glyph N is the running sum of the deltas. Showing a string advances the pen by
the glyph widths; a number `n` inside `TJ` shifts it by `-n/1000 * Tfs`. To land
glyph N+1 where `Td` put it:

```
n_N = -(delta_N - width_N/1000 * Tfs) * 1000 / Tfs
```

An adjustment is emitted to six decimals and the rounding residue is carried
into the next one, so a line of any length accumulates no drift and no
adjustment is silently discarded. Dropping every small number instead would
push the error past the tolerance on a long line and make the proof reject the
whole block — safe, but the feature would quietly stop applying to the longest
lines in a document.

Two things in the input decide whether this can be done at all rather than
merely done right, and both were found by a reader disagreeing with the
arithmetic rather than by the arithmetic being wrong.

Chromium wraps a ligature in a marked-content span carrying `/ActualText`,
inside the text object; rebuilding the block from tokens drops it, and the two
characters go with it. The block is therefore tokenized rather than matched
against one anchored pattern: the shape Chromium emits is small, and a single
regex over it is easy to get subtly wrong. Any text not covered by a token
refuses the block, because a rebuild from tokens silently loses whatever it
skipped — which is how the ligature span went missing the first time. The
shape that is kept:

```
/Span<</ActualText (fi) >> BDC
<0047> Tj
EMC
```

Dropping that loses the two characters a screen reader and a text extractor
are given, so the span is kept and the array is split around it: several `TJ`
arrays in one text object cost the pen nothing, since the text matrix survives
between show operators.

The merge turns absolute positions into width-relative adjustments, so a width
read wrongly shifts every glyph after it while leaving the characters and the
pixels exactly where they were. `/W` has two forms and reading one leaves the
other as absent.

Correctness is checked, not argued: the merge replays the original stream and
the rewritten one and compares every glyph's position. If any glyph moves
beyond the tolerance, the input is returned untouched. That replay is
necessary and not sufficient: it uses the same width table the merge does, so
a table read wrongly agrees with itself. The word boxes poppler reports are the
independent check, and they live in the test.

The advance widths are held per page font resource, keyed by resource name. A
`/Type0` font is a parent: it names a descendant through `/DescendantFonts`,
and the widths live on the descendant. Reading the parent finds nothing, which
looks like a font with no metrics rather than one indirection away.

There is one table per content stream, for the same reason the gap report does
it that way: a resource name is page-local, and one table keyed by name lets
the last page that binds `/F1` decide the widths for every other page. The
replay proof reads this same table, so a wrong one agrees with itself and the
merge moves glyphs while reporting that it did not — which is the one failure
this stage cannot detect on its own.

Every font this handles is a `/Type0` with an `/Identity-H` encoding over a
`CIDFontType2` descendant, so each glyph is two bytes. Chromium shows a whole
string of them in one `Tj` — `<337D34C45836>` is three CJK glyphs, not one —
and reading it as a single number puts the whole run at the wrong advance. An
odd digit count is a code that is not two bytes, which is not a shape this
handles.

Only the operators Chromium emits are handled, in the replay as well as in the
merge. Anything else marks the block untransformable rather than being
interpreted, because a wrong reading of an operator would move a glyph and the
proof would be comparing two wrong answers. A rotated or scaled text matrix is
not the case this handles: only the untransformed shape, `a b c d = 1 0 0 ±1`.
Any shear, rotation or mirror changes what a `Td` does to the origin, and
reading it as a plain horizontal move puts glyphs somewhere the proof cannot
see, because the proof walks the same mistake.

## ToUnicode CMaps

A `bfchar` entry is `<src> <dst>`. A `bfrange` line is `<lo> <hi> <dst>` and a
`codespacerange` line is `<lo> <hi>`, and the old pattern could not tell them
apart: its `\s*` between the operands matched a newline and its lookahead
accepted the `<` that begins the next line, so `<0041>` on one line paired
with `<FB00>` on the next. The result declared `2 beginbfrange` and supplied
six operands on one line — not a valid `bfrange` at all — and turned a
codespace declaration into a three-byte destination. `verify` cannot see inside
a CMap, so both passed the gate and the report then said the font was clean.

Entries inside a block may still be one per line, so the separator is `[ \t]*`
and the lookahead accepts a line end — a newline is now never consumed as a
separator.

## Font descriptors

`isFixedPitch` sits at offset 12 in every `post` format, including 3.0, which
omits everything after the 32-byte header. It is a Fixed 16.16: 0 means
proportional, and both `0x00010000` and the legacy `0xFFFFFFFF` mean
monospaced.

The old code read it unsigned and set the field only for values other than 0
and `0xFFFFFFFF`, so the legacy "yes" was treated as "no" and `fixedPitch`
could only ever be true. That meant the flag could be set but never cleared: a
descriptor wrongly claiming a proportional font was monospaced was never
repaired. An explicit 0 from the font is data, not absence — absence is a
short table, which still leaves the field undefined and the descriptor's bit
untouched.

A descriptor with no `/Flags` key is still worth repairing. The old code
returned undefined for anything that was not a finite number, so one missing
key skipped the whole descriptor — taking the CapHeight fix with it, even when
the embedded font had supplied everything needed to compute both. The PDF
spec's default for an absent `/Flags` is 0; the flags are then derived from
there, and the missing key is written back rather than silently omitted.

A replace that matches nothing changes nothing, so a key the producer never
wrote — which is exactly the case a repair exists to fix — stayed absent while
the value travelled through the whole repair and was thrown away at the last
step. A viewer reads the missing key as "unknown", not as "wrong".

## Page fonts

What a page font tells a reader about a glyph: how far it advances the pen,
and what character it stands for. Both facts are needed in more than one place
and neither is cheap to get right. The `/W` grammar has two forms and reading
only one leaves glyphs with no width at all. And a reader decides whether a
gap is a space by looking at the character, not at the geometry, so a caller
that wants to know which glyphs are invisible has to ask the ToUnicode map
rather than guess.

Bytes per code: one for a simple font or a Type 3 subset, two for a CID font,
and it cannot be inferred from the bytes themselves — `<70>` is one glyph in a
simple font and half of one in a CID font.

The body of the dictionary at `/Key <<`, to its matching `>>`. A resource
dictionary carries several sub-dictionaries that look alike —
`/ExtGState <</G3 3 0 R>> /XObject <</X22 22 0 R>> /Font <</F4 4 0 R>>` — so
finding one by hand needs the same balanced scan, and a greedy or lazy search
for the next `>>` lands inside whichever dictionary came first.

## Retagging the anonymous containers

Chromium tags `nav`, `section`, `main`, `header`, `footer`, `dl`, `dt`, and
`dd` as bare `NonStruct` containers: the nesting and the marked content are
all there, but every one of the eight carries the anonymous type, so a reader
exploring by structure meets a list presented as an unlabeled box. `src/
structroles.ts` gives each container the type its element names.

The mapping is measured, not editorial. On a jsdom-free render checked against
veraPDF's 106-rule PDF/UA set: `dl` becomes `L` and its items become `LI`,
because `7.2` fails an `L` holding anything else ("may contain only L, LI and
Caption") and fails an `LI` with block children ("may contain only Lbl and
LBody"). `nav` and `section` become `Sect`, `main`, `header`, and `footer`
become `Part` — the four role names a bare custom string would need (`Main`,
`Header`, `Footer`, `Nav`) all fail `7.1`, so only the standard types pass.

Identification is DOM-derived or nothing. The page-side census lists the eight
tags in document order with normalized text and the index of the nearest
census-tagged ancestor (an `owner`, -1 otherwise). Each container's decoded
marked-content text must equal the element's text one for one after
whitespace falls away; two unrelated containers with the same text are both
left anonymous, equal-text containers nested in each other resolve to the
outermost, and an element whose text the tree does not contain exactly is
skipped without a finding. Ligatures come along: a span's `/ActualText` value
is published at its `EMC` into the enclosing MCID, so `definition` reads as
`definition` rather than `denition`.

Skips are honesty, not polish. A leaf wrapper — one whose `/K` is a bare
integer — is never a retag target, whatever its text says, because a re-run
otherwise plans a retag onto an element that already has one. An `LI` is only
planned under a fully planned `L`: veraPDF fails a mixed `L` (the paragraph
inside a `dd` becomes a `P` child of the would-be `LI`) and fails an orphan
`LI` whose list was skipped, so a `dl` whose items mismatch is skipped as a
whole and stays tagged the way Chromium wrote it. The three outcomes — all
eight retagged, landmarks retagged with the list skipped, everything
anonymous — leave the reader with a tree that never claims more than the
markup said.

The tree keeps the leaves it had. The walk recurses through any tagged
element, so a `dd` containing a paragraph contributes the paragraph's glyphs
to its wrapper's text; retagging swaps only `/S /NonStruct` for the target
type inside the object body, and the page stream is byte-identical, so text
parity holds by construction. `verify()` gates the result like any other
repair, and a success publishes the `role-retagged` finding with the counts
per tag. The step runs after the figure repair and before text-run merging,
because the census shape is the pre-merge stream.
