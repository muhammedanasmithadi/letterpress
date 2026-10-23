# What the tests pin, and why they are shaped that way

A test that asserts a number usually needs a reason, and the reason is rarely
in the test name. This is where those reasons live. The prose was beside the
assertions; it is here now, and the assertions are bare.

The subject matter belongs to the other documents in this directory: the
paper rules are in [render-pipeline.md](./render-pipeline.md), the file
structure and the repairs in [pdf-structure.md](./pdf-structure.md), the
selection geometry in [selection.md](./selection.md), the shell in
[viewer.md](./viewer.md).

## The paper is one spelling, not two

594.96pt, not 595.92. The default is written as `@page { size: a4 }` rather
than passed to `printToPDF` as 8.2677 inches, because Chromium quantizes the
inch form: measured across 19 widths, a request landing on a whole CSS pixel
comes back exact and every other one comes back larger, never smaller.

This was "agree to within a point", and 1.5pt was the drift: the flag went to
`printToPDF` as 8.2677 inches and came back 595.92pt where the same paper
written in CSS is 594.96pt. Both are now the same rule, so the tolerance is
gone rather than narrowed — two spellings of one paper that disagree are
exactly the failure a preview tool cannot have.

The numbers are asserted as well as the strings, so a failure says which
edge moved rather than only that the two differ.

`--landscape` under a portrait `@page` transposes the document's own
declaration. This used to be an error finding and a portrait sheet. Chromium
discards its `landscape` parameter whenever `preferCSSPageSize` is set, and a
document that declares its own page is exactly that case, so the flag was
sent, dropped, and reported as having had no effect. Measured before the fix:
595x842 with `--landscape had no effect`. Now the declaration is transposed
and the paper comes back wide.

The document's own A4, transposed, gives 841.89pt high becoming the width. A
format flag would have given 842.0 from `FORMATS`' decimal inches instead.

A transpose that swaps unconditionally turns `297mm 210mm` into portrait: a
document that already had what was asked for would be printed wrong by the
request asking for it.

## Declaring a page is not the same as mentioning one

`declaredPageSize` is what the pipeline asks before it decides whether the
document has chosen its own paper. When it says yes, no paper is sent to
Chromium at all and the fallback is Letter. A false yes therefore does not
merely mislabel a finding — it changes the sheet, with nothing reported. It
had no test at all.

The case that shipped: the author's `@page { size: A4 }` sits in an HTML
comment, the probe reported A4, `preferCSSPageSize` went on, no paper was
sent, and the A4 document printed on Letter.

If the comment stopped at the first `-->` that was never typed, the live
`@page` behind it would be counted and the paper flipped the other way: a
Letter sheet on an A4 document, which is the same defect wearing the other
hat.

The same defect from the other side. Stripping quoted strings before CSS
comments let the apostrophe in `trade's` open a string, which then closed at
the next quote in the document — the one in `content: 'The Estuary
Chronicle'` — and swallowed the whole `@page` rule in between.
`declaredPageSize` answered null, `preferCSSPageSize` was never turned on, no
paper was sent, and a ledger-landscape newspaper printed on A4 with no
finding at all. The comment has to be closed by a second quote for the
phantom string to close on something, so the fixture carries one. A comment
holding the document's only quote does not reproduce it, which is why a
shorter fixture would have looked fine.

The same defect, four more sources of text that is not CSS. Each one reads
back as a live declaration, and a live declaration turns off the paper sent
to Chromium.

## The font is the one the renderer drew

`document.fonts.check` answers `true` for any family with no matching
`@font-face`. The question has to be asked of the renderer.

Measured false positive before this was handled: `src: local(...)` under a
new name draws the concrete face, and `getPlatformFontsForNode` reports that
name rather than the alias, so the comparison called it a substitution that
had not happened.

`serif` is a request for whatever the system considers serif. There is
nothing behind it to fall back from.

A chain whose first entry exists never falls back either.

Whatever face this machine has. `fc-list` decides that, and the test asks
the renderer rather than naming one, so it holds on a machine with a
different font set installed.

`DOM.querySelector` is the only handle CDP takes, and a node id cannot be
written into a value-only evaluate, so the page marks one element per
family. The window where the document is not as it was found is inside one
step, and this is what closes it.

## Characters that have no glyph

U+00A0 has no glyph in most fonts, so the canvas comparison used to report it
as "will print as a blank box". Measured in the page, `A&nbsp;B` and `A B`
have identical widths: it occupies exactly a space and prints as one. A
finding that fires on `&nbsp;` fires on nearly every HTML file, which teaches
people to ignore the rest.

U+180E, a bidi isolate and a variation selector have no glyph in DejaVu
Sans, so the canvas test finds them "missing" — but Chromium shapes format
characters to nothing rather than tofu (measured: blank pixels, unequal to
.notdef, zero advance for each of these). Predicting a "blank box" for them
is the NBSP phantom again. U+FE1F rides along as the control: it renders
as a .notdef box and must report.

## Right-to-left

The finding recommends wrapping the run in `<bdi dir="ltr">`. The walk broke
on `dir="ltr"` leaving "not right-to-left so far", which the content
fallback then read as "no opinion" and overrode — so applying the advice
re-triggered it. This is the narrow case that worked by accident (digits
alone) beside the common one that did not.

Two pages, so the reversal is observable rather than a matter of taste: page
one of two prints "2 / 1" with the counter alone, because the margin box
inherits the document's direction. The counter text is correct; the order it
is read in is not.

The same stylesheet, without the RTL document. A check that fired on the
margin box rather than on the direction would flag every paginated document
in the corpus.

## Dialogs, crashes, and the deadline

A document calling `alert()` needs no permission and no user gesture, and
blocks the renderer until something answers it. Measured before this was
handled: the render sat out its whole deadline and came back as `cdp socket
closed` — an error naming the transport rather than the document, which is
the one failure a caller cannot act on.

The refusal is not politeness: a script blocked on a decision does not
continue, so whatever the rest of the run produced is whatever ran next, and
the file alone cannot show that.

A tab killed by the out-of-memory killer on a very large document emits
nothing on the print path, so the deadline was the only signal — and paying
it in full says less than this event does. The event is what the render's
fast-fail reads. This proves the mechanism, not the render path: `Page.crash`
cannot be staged inside a real render, so what is pinned here is that the
event fires on a crash at all. Without the subscription there is no other
signal.

The call itself never answers — the tab is gone — so it is given a short
deadline rather than the 30s default, and the wait afterwards polls rather
than guessing: the renderer takes its own time to actually die.

## Images

The measuring loop skips images it cannot measure — hidden on screen, or not
yet loaded — so its results are a subsequence of `document.images`. Assigning
them positionally hands the first replacement to the hidden image, and the
photograph that was meant to be downsampled keeps its full resolution while
the finding says it was reduced. A print-only backdrop or a `data-src` lazy
load is the shape that triggers it.

Exactly one image was measurable. With the positional walk the hidden
backdrop took the replacement and the finding was reported against the wrong
image entirely.

Two tests write images to a scratch directory, write a document beside them
and render it at a given cap. Factored out because a copy of the setup is
what the duplication gate counts, and because the setup is not what either
test is about.

The two tests below want the same thing from a capped render: that an image
was reduced and that the finding says so. Asserted once, because a second
copy of these three lines is what the duplication gate counts and not what
either test is about.

## Overflow

A4 less 15mm margins is 642px of printable width. Measured on a 780px
viewport: html, body and a plain paragraph all come back at 780px, and a
figure at its default margins at 684px — which prints as 584px and fits.
Comparing every element against the printable width therefore reported
ordinary documents as overflowing.

A fixed pixel width survives into print, so 700px overflows 642px.

The finding names what Chromium stamped instead, read from the file.

## The date

The stamp matches a byte range and writes over it, padding with spaces to
keep every later offset valid. Its date pattern allowed five characters
after the offset sign and Chromium writes six — `+00'00'` — so the match
stopped one character short of the closing quote, which kept its old value.
The stamped file read `D:20231114221320Z '`, with the stale apostrophe
still in it. No test caught it because the assertion above only checks that
the date starts right, and a conforming reader stops at the `Z`.

Length equality used to be the check, but every file now carries a
compressed XMP packet and deflate output breathes by a byte with different
timestamp input (7460 vs 7459 measured). What matters is stronger anyway,
checked at both levels the timestamps live at: the rest of the file must be
identical after its date fields are normalised, and the inflated packet must
be identical after its ISO dates are.

`startxref` is normalised too: it is the byte offset of the xref table, which
moves when the compressed packet breathes. With the packet stripped and every
date normalised, the offset is a pure function of packet length, so nothing
else can move it; xref correctness itself is pinned by the verify suite, not
here.

## Findings that fire on ordinary documents

Every finding here is one that fires on ordinary documents if it is wrong, so
the negative case is the one that matters most.

`alt=""` plus `role="presentation"` is the correct spelling of "this image is
not content". Reporting it would teach authors to avoid the mechanism that
makes decorative images correct.

Measured across the markup shapes: an image with alt text inside a `figure`
is tagged a Figure whose name is the alt text, so that shape needs no
`figcaption` to have structure. An image with no alt, or text content, is
tagged a Figure with no name, and an empty `figure` gets no element at all —
those are the shapes the finding counts.

Before this existed the only finding was about text runs: nothing said the
document had failed to run, so a caller could not tell the PDF apart from
one produced by the document they wrote.

Measured false positive. `Log.entryAdded` was read as a second source of
script errors, and it is not one: console messages arrive through
`Runtime.consoleAPICalled` and never appear there, while failed resource
loads do — with `source: 'network'`. Chromium requests `/favicon.ico` on
its own for anything loaded over http, so this reported "the document threw
an uncaught error" on every render that used the static server, for a
request the document never made, duplicating `subresource-failed`.

The fact is still reported, by the check that owns it.

## The shell

Eleven controls plus a wordmark never fit one row; the settings wrap onto a
full-width second row instead of a dropdown. Every control keeps its id and
its label.

Orientation is a two-button native toggle; `aria-pressed` carries the state
and a boolean carries it to the payload (no `.checked` anywhere).

A refused orientation reverts the toggle to the effective state: the control
must not display a request the engine could not honour. Refusal is now rare
— a document that declares its own sheet has it transposed — but it is still
reachable when the declaration names no paper (`size: auto`), so the branch
is live code and stays.

The pressed button is bold, laid side by side — the only visual signal, and
color-free per the bare shell.

Plain buttons with clear names. The status opens plain.

Margin re-renders as you type, but only for committable values:
intermediates must not flash server rejections.

The source head names its line count; it exists nowhere else. Counts also
live in the live status line, so pane metadata hides from assistive tech.

No svg icons and no dropdown: quiet text throughout, settings always
visible. The starter demonstrates print, set in Georgia serif.

No unicode chevrons anywhere in the shell: markers are drawn with borders, and
every svg hides itself.

File import repaints the highlight layer and gutter: a programmatic value set
fires no input event, so without the repaint the editor shows the previous
document while the value and preview are already the new one. Positioned
with `indexOf` rather than a regex window: a `{0,400}` bound fails the
moment an unrelated comment lands inside the handler, which is a false alarm
about a real defect. Order is what matters, so order is what is asserted.

The input is released right after the file is captured. A file input only
fires `change` when its value differs, so without the reset, re-picking the
same file runs no handler at all: no import, no repaint, no status — a viewer
that looks frozen. The captured File must outlive the reset, which is why
the capture comes first, and the reset precedes the await so a failed read
cannot leave the input stuck on a value that will never fire again.

PPI honesty: the server clamps to 1200, so the box caps there natively and
the reader reflects the effective value instead of sending a number the
engine silently ignores.

The meta sets UA defaults before the stylesheet loads; the CSS alone arrives
too late for first-paint form controls and scrollbars.

No authored color anywhere except the error rule: failure must not look like
success, so it keeps its pair and is cut out before the scan. Warnings read
in the default text — no second color.

What stays is mechanics: the overlay cell, the caret that must survive
transparent text, the dropdown anchor, the pager hide, keyboard ring.

Visible tokens without paint: bold tags, italic strings, dimmed comments —
monochrome emphasis, no colors admitted.

Severity still reads: failure must not look like success.

Each pane holds three children against three grid tracks, so auto-placement
put the textarea in an auto row: measured 57px tall inside a 544px pane,
with the flex track going nowhere useful. The editor wrapper holds the row
now that the field lives inside an overlay; both content elements need
explicit rows.

Both layers must read every metric from the same variables; a metric set in
two places drifts per line and compounds. Measured the failure first: a 57px
textarea inside a 544px pane, from grid auto-placement.

Escape-then-wrap: a mismatched tag highlights wrong at worst, never injects.

While composing, the textarea shows the composition string and the layer
would show uncomposed text: doubling. It hides for the duration.

The gutter follows the code pane; the highlight layer scrolls with it by
sharing its cell, so only the gutter needs syncing.

Clearing the source before anything rendered must not claim a "last good
render" that never happened. And app strings are sentence-case; renderer
findings keep their lowercase voice, but the shell's own words do not.

Fragment-only navigation: the iframe src gains `#page=N` on the same blob
URL, so a jump can neither disturb the editor nor trigger a render.

The object URL plus fragment, not a bare `#page=` that also matches prose: a
comment broke this assertion once already.

The preview pane used to keep a text placeholder after every render. It now
holds an iframe on the same object URL Download hands out, drawn by the
browser's own PDF renderer — selectable text and real pagination with no
vendored renderer.

A titled frame, because an untitled one is announced as noise.

Held URLs pile up: each render minted one for Download and never let go.

The foreign toolbar cannot be styled from outside, so the frame carries a
hairline edge where paper meets pane.

The rules are `.status[data-level=...]` and `.status` is the footer. The
level used to be set on the live-region output, which carries no such class,
so the colour never applied: measured, an error painted rgb(0,0,0).

A browser PDF viewer holds its own tab stops; measured, ~16 Tabs were
consumed inside the frame before the pager was reached.

`order` reorders paint, not the focus sequence. The actions must precede
the settings row in the DOM, and no `order` value may put them back.

## Waiting for the page, not the clock

Registration happens when the page's module is evaluated, which is after the
navigation resolves and not at the same moment, so a fixed sleep is a race
with the page and loses on a loaded machine. The test polls for the count it
expects instead, which is what the test means.

The crash event has the same problem from the other side: a renderer that
dies under memory pressure takes longer to say so, and a ten-second budget is
not enough on a machine with less than a gigabyte free. The budget is twenty
seconds, and the test's own timeout is thirty.

## Three things the tests say

A repaired font descriptor must fail on the missing reference, not on
something incidental that a rewritten cross-reference table happened to
break.

A stream that is not one, or not one this can inflate, is not a finding here.

Empty bodies occur by design in the fuzz corpus — a tenth of documents — and
the joins hold either way.

## The coverage floor

The floor is on the code that runs in the test process. The page-side probes
are shipped into the browser and run there, so the coverage of this process
says nothing about them: they were five lines out of two hundred and sixty,
and no change to this repository can move that number, because the code is not
run here. Their own tests run them, in the browser, where they are.

## Cleaning up after a run

`tools/cleanup.sh` kills the browsers and the servers a run leaves behind,
and it matches them on the profile directory rather than on the binary, so
the user's own chromium is never touched. The number it prints at the end
counts the same way: a browser that is not ours is not counted, so the
number means something.

## Tests that measure

Two of the tests measure rather than assert a value, and both are about the
same thing: the pdf is parsed into objects, and the work must not grow with
the size of the document.

One is a scale test. A document with forty thousand `@page` and no brace
after them took ten seconds to scan before the scan was rewritten, and takes
a millisecond now. The bound is a third of what the old code took, so a
regression of that size is caught and a busy machine is not.

The other is a smoke test. A document with a thirty-two megabyte stream in
it must still split in under two seconds, and the difference between
splitting it and splitting a small one must be under six hundred
milliseconds. The bounds are generous on purpose: the machine these run on
may be busy, and a bound that fails under load is worse than no bound. What
they catch is a scan of the stream, which takes seconds where the work
should take milliseconds.

## The two tool catalogues

The model context protocol server and the viewer page keep separate copies of
their tool lists, which the guidelines allow at two uses. What must not happen
is the page offering a tool the server does not, or naming the same tool
differently in the two places: an agent reads the names, and a name that means
one thing in the browser and another in the server is worse than either.

## What a shared server will not do

The render endpoint accepts no path and no url, so the tools on the same route
accept neither: a path is a file-read primitive for every local process on the
machine, and a url is a way to make the server fetch whatever the caller named
and get the answer back in the rendered document. The body is read with the
same cap, the document is bounded by the same page limit, the render takes a
slot in the same queue, and two callers do not get the same file.

The other side of that: the stdio server reads and writes anywhere, because
its caller is whoever started the process, and that caller can already do
both.

## The agent surfaces

The listing and the implementation of a tool are one structure, so a tool
cannot be advertised without a way to run it. The check is that the names
agree, in case the two are ever split again.

## The flags

`--margin` took the next argv entry unconditionally, so `--margin --json
doc.html` consumed `--json` and threw it away. The error named the margin
and never mentioned the flag that had just been lost, so the obvious next
move — retyping the command — fails the same way.

`'.html'.replace(/\.html?$/i, '')` is the empty string, and `'' + '.pdf'` is
a file named `.pdf`, so the default output path for a file called `.html` was
a dotfile rather than a name.

A named family, not the generic sans-serif. A generic family resolves
through fontconfig, so the page count came out 2 on the machine that wrote
the test and 1 on a CI runner with a different font set — and the test was
asserting on fontconfig's choice rather than on the tool.

## The repair pipeline

A `/Type0` with no descendant anywhere in the file. Reading the parent finds
no `/W`, and the fallback made every glyph exactly one em wide, which turns
a letter fit into a gap. Leaving the name out means the stream is refused
instead.

The glyphs cannot be measured and are counted rather than guessed at.
Refusing the stream instead, as an earlier version did, threw away every
page that used a fallback.

`readPost` used to set the field only for a monospaced font, so it could
only be true. `flagsFrom()` could then set the FixedPitch bit but never
clear it, and a descriptor wrongly claiming a proportional font was
monospaced survived the repair. An explicit 0 in the font is the font saying
"proportional", which is data; a short table, which still yields undefined,
is the absence of data.

## Fixtures and helpers

The tests assert against independent implementations rather than against this
renderer's own parser, because every real defect found so far came from one
of them and none from a test written here.

A test that asserts a value the tool also computes proves the tool is
self-consistent, which is not the same as correct. The poppler assertions
are the independent check, and they live in the tests rather than in the
tool.
