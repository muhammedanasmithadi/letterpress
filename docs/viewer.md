# The viewer shell

The browser shell: a source box, a toolbar, a preview, and the wiring between
them. `viewer/app.js` is the whole of it — `index.html`, `theme.css`,
`app.js` and nothing else.

Deliberately not in this file: CodeMirror. The shell is verified on its own
first, so a layout or control fault is not hidden behind a half-configured
editor. The preview is the browser's own PDF renderer drawing the returned
bytes — no vendored renderer, which is what keeps this repository
dependency-free.

The toolbar holds state, the state becomes a render request, and the request
goes to the same server the CLI is built on. Nothing here inspects or
rewrites HTML: the preview must show what the renderer produced, or it is not
a preview.

## The client deadline

A backstop against a connection that never answers.

Not the answer to a slow render, and deliberately generous. A document whose
script loops is answered by the server at its own 30s deadline with a real
message, so a shorter client deadline would only pre-empt a better answer and
would break the genuinely large documents that take most of that. What makes a
long wait tolerable is the visible elapsed counter, not a shorter fuse.

The first version of this was 45s with a comment claiming it stopped the UI
freezing for 31s, which it could not do: 45s is above the server's 30s, so it
never fired. It exists for a wedged socket, which the server's deadline cannot
cover because the request never reaches it.

## Render ordering

Renders are identified by a monotonically increasing number and every write
is gated on it.

Without this, a slow render that finishes after a fast one overwrites it, and
the measured result was: the editor holding a one-page document, the status
line reading "60 pages", and Download handing back 60 pages of somebody else's
document. That is silent wrong output, which is the one failure a preview
tool cannot have.

The previous request is also aborted, so the work is not merely ignored after
the fact.

## The image resolution cap

The cap, or undefined to leave the default alone.

`Number("")` is 0 and 0 means "do not downsample", so an empty or unusable
field used to silently switch the cap off and hand back a huge PDF reported
as a clean render. An unusable value now leaves the cap at its default, marks
the field invalid for assistive tech, and explains itself on the field's own
title: a number input cannot hold the text "abc" at all, so the reader has no
broken value to see and needs the sentence instead.

## The status line

One line about what the last render produced.

Findings are the renderer's own wording, which is written for a terminal and
mentions flags that do not exist in this UI: a blocked asset told the user to
"Pass --allow-network" while an Allow network checkbox sat in the same
toolbar. Measured at up to 358 characters, which pushed the status line to
three lines and stole height from the panes.

So: the first sentence, and a count. The full text goes to the title
attribute, which costs nothing until someone hovers.

## The preview

The browser's own PDF renderer draws the returned bytes: real pagination,
selectable text, no vendored renderer and no megabyte of third-party code in
this repository (which has no npm dependencies on purpose).
`navigator.pdfViewerEnabled` is false where no viewer exists, and there the
text placeholder stays instead of a dead frame. The preview shows exactly
these bytes — the same object URL the Download button hands out — so what is
on screen and what is saved cannot diverge.

Page navigation over the bytes on screen is fragment-only: setting src to the
same blob URL with a different `#page=` does not reload the document (and if
a browser ever did, the bytes are a blob: instant and offline). It never
re-renders, so a jump cannot disturb the editor, the findings or Download.
Out-of-range input clamps silently and the field reverts; there is no error
worth announcing for a number.

## Failures

A failure is reported without destroying what is on screen.

The preview used to keep asserting the previous document's page count while
the metrics beside it went blank, so the two halves of the footer disagreed
and the confident one was wrong. The last good render stays visible, marked
as not current, and Download is disabled.

## The margin field

A margin without a format is always a mistake, so the field is inert until a
paper size is chosen, and it says why.

`aria-disabled` rather than the `disabled` attribute. A disabled control
cannot be focused at all: measured, `margin.focus()` left
`document.activeElement` on BODY, so a keyboard or screen-reader user never
reaches it and never learns the reason. `aria-disabled` keeps it in the tab
order and announced as inactive, and the check below is what actually stops
it being used.

## Orientation

Orientation lives in `aria-pressed` on two buttons, not in a checkbox: the
segmented control reads as text, and a boolean carries the state to the
payload. Both buttons announce through `aria-pressed`, so the underline is
never the only signal.

## The editor

The editor is a plain textarea over a hand-written highlight layer and a
line gutter.

The highlighter is a tokenizer, not a parser: comments and declarations first
(they hold `<` `>` that would otherwise lex as tags), then tags with
attribute names and quoted values picked out, everything else plain text.
Every piece is HTML-escaped before any span wraps it, so mismatched markup
highlights wrong at worst — it can never inject. An unterminated `<di`
mid-typing still lexes as a tag start rather than vanishing the line.

## The agent's tool

The tool goes through the page's own render rather than fetching `/render`
itself, for two reasons. The page updates as it does for a person — the
preview, the page count, the findings in the status line — so the human
watching and the agent asking are looking at the same render. And the page is
where the toolbar lives, so the settings a tool is given have to go through
it: a `landscape` the page does not know about is a landscape the page does
not show.

The source box is left alone. An agent rendering a document it has not been
given a reason to show would overwrite what the human is editing, and the
human's document is not the agent's to replace.
