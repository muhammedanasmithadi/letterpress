# letterpress viewer — implementation plan

Status: approved to build. Written 2026-10-04, after eight adversarial user-test
rounds and a CDP protocol investigation. Everything asserted below was measured
on this machine unless marked unverified.

> **Update 2026-10-16 — the shell shipped, but not as this plan proposed.**
> The viewer is finished and in `viewer/`: `index.html`, `theme.css`, `app.js`
> and nothing else. It has **no CodeMirror and no vendored PDF.js**; the editor
> is a textarea over a hand-written highlight layer, and the preview is the
> browser's own PDF viewer drawing the returned bytes in an `<iframe>`. Two
> plan mitigations (per-page `pageRanges` renders and a large-document
> auto-render cutoff) were never built, and Phase 4 (WebMCP) was not either.
> Sections below are corrected where the code disagrees; the CDP findings that
> drove the original decision are kept, because they are still true.
>
> **Update 2026-10-20 — Phase 4 shipped, in the other direction.** The viewer
> now also serves `webmcp.js`, which registers `render_html` and
> `list_findings` with `document.modelContext` so an agent in the browser tab
> can drive the page. The plan proposed the reverse — the page registers a tool
> and the server invokes it over the CDP `WebMCP` domain — and the reason for
> the change is in the Phase 4 section below.
>
> One artifact of the blob URL: the platform viewer logs
> `Invalid absolute docBaseUrl: "blob:..."` once per render, because a blob has
> no base for relative links. It is inside the browser's own viewer and cannot
> be silenced from the page.

## What already exists

`src/render.ts` drives Chromium's own print pipeline over CDP. 57 tests green,
typecheck clean, no npm dependencies. The CLI renders a file, stdin, a URL, or a
JSON order through a bundled template.

**The renderer is finished. This plan only adds a viewer, plus three changes to
the render API that the protocol investigation surfaced.**

## Verified findings this plan rests on

Each was tested. Earlier claims of mine that verification retracted are listed
under "What I got wrong" below — including the tagged-PDF one, which was the
basis for treating heading roles as an engine defect.

| finding                                                       | evidence                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Page.printToPDF` works headless **and** headful, identically | 3-page Arabic doc: same page count, same MediaBox, same `HDR` count, same `page 3 of 3` footer, byte sizes within 8 of each other                      |
| Headful needs `--ozone-platform=x11`                          | Wayland start-up printed the DevTools endpoint then the process exited; X11 stayed up                                                                  |
| `pageRanges` selects exactly the named pages                  | `pdftotext`: `"1-2"`→PAGE_1,PAGE_2 · `"5"`→PAGE_5 · `"3,7"`→PAGE_3,PAGE_7 · `"2-2"`→PAGE_2                                                             |
| `pageRanges` keeps total-page counters correct                | `"1-2"` of a 3-page doc prints footer `page 2 of 3`, not `of 2`                                                                                        |
| `transferMode:"ReturnAsStream"` matches base64                | 14,980 streamed bytes vs 14,980 predicted. Returns `eof:false` on a 64 KB read of a 14 KB doc, so the last chunk is short                              |
| `Page.setDocumentContent` prints with no file written         | 9,244 base64 chars, zero disk writes                                                                                                                   |
| …but cannot resolve relative assets                           | `<img src="relative.png">` → `naturalWidth: 0`. No origin to resolve against                                                                           |
| Print media emulation does **not** paginate                   | `matchMedia('print')` true, 3 page divs still in DOM, 3,061 px doc in a 437 px viewport, no page boxes                                                 |
| `WebMCP.invokeTool` works over CDP, no extension              | `toolResponded` → `status:"Completed"`, `output.text:"sum=42"`. Needs `--enable-blink-features=WebMCP` + secure context + `{frameId, toolName, input}` |
| A `file://` image taints the canvas                           | `toDataURL` throws "Tainted canvases may not be exported"                                                                                              |
| Image ppi formula                                             | `effective_ppi = source_px / (css_px / 96)`. 4000px at 180mm → 565 ppi                                                                                 |

## The one decision that shapes everything

**Print media emulation does not paginate.** A live HTML preview therefore cannot
show real page breaks, and any "live preview" that claims to is lying by about
half its output. So:

**The viewer renders the actual PDF and displays it.**

The plan proposed displaying it with a vendored PDF.js. The shipped code instead
hands the bytes to the platform's own PDF viewer through an `<iframe>` on a
`blob:` URL. That keeps the repository dependency-free — the plan's own
"Explicitly not doing" list rules out a build step — and the frame that renders
the preview is the same object URL the Download button hands out, so the two
cannot diverge. The cost the plan named still holds: there is no programmatic
control of the drawn pages, so no thumbnails and no text-layer hook. In Firefox
the platform viewer _is_ PDF.js (the console reports `PDF.js: 6.3.335`), which
is why the RTL caveats below still apply to the preview; the version is whatever
the user's browser ships, not a version this repository pins.

This is the opposite of a live-HTML preview, and it is the honest choice. The
cost is a render round trip per edit. The plan proposed three mitigations; the
notes say which were built:

1. Debounce 400 ms. **Built** (`DEBOUNCE_MS`).
2. `pageRanges` renders only the page in view — a 3-page doc costs a third of a
   full render. **Not built.** The viewer never sends `pageRanges`; every edit
   re-renders the whole document.
3. Above ~10 pages or ~250 KB of HTML, stop re-rendering on keystroke and show
   a "press Render" affordance. **Not built.** A 44-page, 471 KB document was
   measured auto-rendering in ~1.5 s after the debounce, with no cutoff.

Rejected: live HTML at paper width (cannot paginate), native `<embed>` PDF
viewer (renders nothing headless; prints a 1,072-byte blank PDF; zero
programmatic control). The shipped `<iframe>` is not the rejected `<embed>`: it
carries a title, is taken out of the tab order, and always points at the bytes
the Download button offers.

## Architecture

```
browser (user's own window)
  └── viewer/index.html          shell: toolbar, split panes, native controls
        ├── textarea + highlight  HTML editing, no CodeMirror
        ├── <iframe src=blob:>    the browser's own PDF viewer, no vendored PDF.js
        └── fetch POST /render   → server.ts
                                    └── src/render.ts  (unchanged core)
                                          └── warm Chromium via CDP
```

The viewer is served by the tool's own server. It renders through the _same_
`render()` the CLI uses, so the preview and the download cannot diverge.

## Implementation

### Phase 1 — render API additions (`src/render.ts`)

Three additions, no behaviour change for existing callers.

```ts
export type RenderRequest = {
  // ...existing...
  /** Render only these 1-based pages, e.g. "3-5". Verified to select exactly
   *  those pages while keeping counter(pages) correct. */
  pageRanges?: string;
  /** Skip the work-server fast path and inject via Page.setDocumentContent.
   * Only valid when the document references no relative assets. */
  fastPath?: boolean;
  /** Drain the PDF from the CDP stream instead of a base64 JSON string. */
  transfer?: 'base64' | 'stream';
};
```

**Stream drain.** `printToPDF` with `transferMode:"ReturnAsStream"` returns
`{stream}`. Loop `IO.read({handle, size: 262144})` until `eof`, concatenating
`Buffer.from(chunk.data, "base64")`. Do not trust `eof` on the first read — a
14 KB document returns `eof:false` on a 64 KB read.

**Fast path.** When `fastPath` is set _and_ a pre-scan finds no relative `src`/
`href` (regex: `/(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|#|mailto:)[^"']/i`),
skip `stageAssets` and `serveWorkDir`, and drive the tab with
`Page.setDocumentContent({frameId, html})`. Saves a temp dir, a socket, and a
loopback round trip. This is the common case: most documents are one HTML
string with no images.

**pageRanges.** Pass straight through. Note in the doc comment that the returned
`pages` count is the number _emitted_, not the document total — `inspect()`
reports 2 for `"1-2"` of a 3-page document. The viewer must not display that as
the document length.

### Phase 2 — the server (`src/server.ts`)

```
GET  /            viewer/index.html + assets
POST /render      {html, format?, landscape?, pageRanges?, maxImagePpi?}
                 → 200 {pdf: base64, pages, findings[], ms, mediaBoxes[]}
GET  /health      {ok, chromium: bool}
```

`Bun.serve`, loopback only, port from `--port` (default 8787). CORS not needed:
same origin. Bodies capped at 8 MB with a clear 413, because this endpoint
executes arbitrary HTML and JS and an unbounded body is a free memory DoS.

Response is JSON with base64 — simpler than streaming and the payload is a
single page. Stream transfer stays inside `render()` where the 22 MB case lives
(a full 400-page document), and is not exposed over HTTP.

### Phase 3 — the viewer (`viewer/`)

**`viewer/index.html`** — three regions: toolbar, editor, preview.

Toolbar controls are **native elements**: `<select>` for format, `<input
type=number>` for margin, `<input type=checkbox>` for background graphics,
`<button>` for Render and Download. Native controls are platform-styled,
keyboard-correct, and accessible for free. Theming comes from
`color-scheme: light dark` plus `accent-color`, which the research confirmed
works across all three engines. Custom `<select>` styling is the one place to
avoid: Firefox has no `appearance: base-select`, so a styled select looks
broken there.

**`viewer/editor.js`** — **Not built.** The plan called for CodeMirror 6 with
hand-picked extensions. The shipped `app.js` instead paints a tokenized
highlight layer behind a plain `<textarea>` and never loads an editor library:
the shell has no build step and no dependencies, and the shell had to be judged
on its own before an editor landed. The CodeMirror extension list below is kept
as the design that was dropped, not as a description of the code:

```js
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
```

~146 KB gzip, ~94 ms import. `@codemirror/lang-html` pulls `@lezer/javascript`
(78 KB) statically and cannot be dropped without losing HTML completion — accepted.

**`viewer/preview.js`** — **Not built.** The plan called for PDF.js 6.4.299,
Apache-2.0, vendored and self-hosted. The shipped preview is an `<iframe>` on
the object URL, drawn by the browser's own PDF viewer; `navigator.pdfViewerEnabled
=== false` falls back to a text placeholder. Nothing is vendored. For reference,
the dropped design specified:

- call `getDocument({url})`, **not** a bare string — v6 rejects it
- set `GlobalWorkerOptions.workerSrc` explicitly, or the fast worker path is lost
- self-host `cmaps/`, `standard_fonts/`, `wasm/`

The RTL caveat still reaches the shipped preview, because Firefox's own viewer
is PDF.js: it has open RTL bugs in selection and search (#20097, #16116,
#16716), which matters given this project's Arabic work.

**`viewer/theme.css`** — the research says these five remove most hand-written
UI CSS: anchor positioning (Firefox 147 closed the last gap in 2026),
`light-dark()` + `color-mix()` + `contrast-color()`, `:has()`, popover with
invokers + `@starting-style` + `transition-behavior: allow-discrete`, and CSS
nesting + container queries.

**Iframe colour scheme.** Verified behaviour: `prefers-color-scheme` inside an
iframe follows the _host's_ scheme, but `light-dark()` does not flip unless the
iframe's own `:root` sets `color-scheme`. Set it explicitly and keep it in sync,
because a mismatch forces an opaque canvas.

### Phase 4 — WebMCP surface (optional, cheap, no infrastructure)

**Built, in the other direction.** `viewer/webmcp.js` registers two tools —
`render_html` and `list_findings` — with `document.modelContext`, so an agent
in the browser tab can drive the page. `test/webmcp.test.ts` proves it against
a real browser with the flag on, loading the real page over the real loopback
server.

The plan below proposed the reverse: the page registers a tool and the _server_
invokes it over the CDP `WebMCP` domain. That is a different arrangement, and
the page-driven one is the one WebMCP is for: the browser's own agent is
already in the tab, it can already see the page, and a tool that reuses the
page's own code keeps what the human sees and what the agent sees the same.
The CDP route is for a server-side agent driving a page it controls, which is
what the MCP server does more directly.

`src/server.ts` still passes `--enable-blink-features=WebMCP` when
`HTML2PDF_WEBMCP` is set. That flag is on the server's _rendering_ browser,
which is not the browser the viewer is viewed in, so it does nothing for the
viewer page: the flag has to be on the browser that opens
`http://127.0.0.1:8787/`. Both are opt-in and neither is required.

Three measurements from `docs/measurements.md` shaped the implementation, and
each of them is a way to get nothing back: the API is
`document.modelContext` and not `navigator.modelContext`; it needs a secure
context, so `about:blank` does not count and `http://127.0.0.1` does; and
`executeTool` takes its arguments as a JSON string and answers with one.

The original sketch, for the record:

```js
document.modelContext.registerTool({
  name: 'html_to_pdf',
  description: "Render HTML to PDF through Chromium's native print engine",
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string' },
      path: { type: 'string' },
      format: { type: 'string', enum: ['a3', 'a4', 'a5', 'legal', 'letter', 'tabloid'] },
      landscape: { type: 'boolean' },
    },
  },
  execute: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] }),
});
```

Server side, had it gone that way: `WebMCP.enable`, wait for `toolsAdded`,
then `invokeTool({frameId, toolName, input})` and await `toolResponded` by
`invocationId`.

## What I got wrong, and what I am therefore careful about

- **"Animations are already deterministic."** My test compared the first 40 bytes
  of a PNG, which is the magic number plus the IHDR header — identical for every
  image of the same size. With real pixel hashes, an animation gives 4 distinct
  hashes and a static control gives 1. Animations _do_ advance on screen. The
  _rendered PDF_ is still deterministic; that is a separate, untested-for-animations
  claim. Open question, not a decision.
- **"Virtual time freezes rendering."** Same broken comparison. Re-tested: 4
  distinct hashes while "frozen". `Emulation.setVirtualTimePolicy` does not
  control CSS animation timing. Dropped.
- **"No display exists."** Wrong. Hyprland with Xwayland on `:0`. Everything up to
  this point was tested headless, which is why the headful parity check mattered.
- **Monaco's licence.** The subagent's first pass implied a Microsoft
  restriction. `LICENSE.txt` is verbatim MIT, one commit since 2021. Monaco is
  rejected for size (7× the bytes, 5–8× startup), not licence.
- **"DevTools uses CodeMirror 6."** It uses CodeMirror **5**. CM6 is still the
  right pick, on different grounds.
- **"Chromium emits `NonStruct` for `<h1>`–`<h6>`, so heading roles are
  missing."** The engine tags them correctly. Measured across 35 constructs:
  `<h1>`–`<h6>` give `H1`–`H6`, `<p>` gives `P`, `<ul>`/`<ol>`/`<li>` give
  `L`/`LI`/`Lbl`, tables give `Table`/`TR`/`TH`/`TD`, `<figure>` gives
  `Figure`/`Caption`, and `<blockquote>`, `<strong>`, `<em>`, `<code>`,
  `<a href>`, `<article>`, `<aside>` and `<img alt>` all give their own roles.
  Ghostscript reports no problems and `pdfinfo` reports `Suspects: no`.

  The audited resume emitted no `H*` and no `P` because **it contains neither**:
  its element census is 48 `span`, 42 `div`, 14 `li`, 5 `section`, 3 `ul`, 2 `a`,
  1 `header`, and zero `h1`–`h6` or `p`. Every heading and paragraph on that page
  is a `div` or a `span`. For those, `NonStruct` is the correct answer — a `div`
  carries no semantics, and assigning it a role would be fabricating one.

  So this is a **document-markup** finding, not an output-quality defect. The fix
  is real `<h2>`, `<p>` and `<ul>` in the source, which changes the HTML rather
  than the PDF. Two gaps are real but small and neither is worth post-processing:
  `<dl>`/`<dt>`/`<dd>` produce only `NonStruct`, and `<section>`, `<nav>`,
  `<main>`, `<header>` and `<footer>` produce none.

- **Two false alarms from my own ParentTree checker.** Checking MCID ownership
  against the structure tree reported a defect on the resume — twice, on identical
  data. Both were the checker: Chromium batches all 95 MCIDs into a single
  `/ParentTreeNumberTree` array node with `/ParentTreeNextKey 3`, which is valid
  PDF and which a per-key lookup does not understand. Real readers are
  unambiguous. Trusting my checker would have meant "fixing" a non-defect and
  probably breaking the tag tree. A finding now needs a reader to agree with it,
  not just a script I wrote.

## Unverified, and therefore not load-bearing

- **Large-document render throughput.** 400 pages measured at ~5 s with base64
  in a one-off script. The stream path is implemented but not benchmarked at that
  size.
- **Animated-document determinism in the PDF itself.** Screenshots advance on
  screen; whether `printToPDF` freezes them is untested. If it does not, output
  is not reproducible and a `--deterministic` flag becomes necessary.
- **PDF.js with our real Arabic invoices.** The RTL bugs are documented in the
  library's tracker; whether our documents trigger them is unknown.
- **Memory for a 400-page render through the fast path.** Measured 1.5 GB peak in
  an early probe; not re-measured since.

## Test strategy

- Every protocol claim gets a test that **asserts on the output**, not on a call
  succeeding. `pageRanges` is tested with `pdftotext` reading back `PAGE_n`
  markers — a byte-count comparison would have passed while the wrong pages came
  out, which is exactly what my own broken inflate check nearly did.
- Render tests run headless. One parity test runs headful via
  `--ozone-platform=x11` and compares page count, MediaBox, and margin-box text
  against the headless run. It is the only test that needs `DISPLAY`, and it
  skips cleanly without one.
- Any determinism test hashes **decoded pixels**, never encoded file headers.

## Order of work

1. Render API: `pageRanges`, stream drain, fast path. Plus tests. **Done.**
2. `src/server.ts` + a curl-level smoke test. **Done.**
3. Viewer shell with native controls and theme. Verify by screenshot. **Done**,
   but the shell is a textarea, not CodeMirror — the editor library was dropped
   to keep the shell dependency-free and to judge the layout on its own.
4. CodeMirror editor, then PDF.js preview. **Not done, and now rejected:** the
   shipped preview is the browser's own viewer, and the editor is a tokenized
   highlight layer over a textarea.
5. Headful parity test. **Done** (`test/parity.test.ts`).
6. WebMCP tool, if it still seems worth it once the viewer exists. **Not done.**

## Explicitly not doing

- Live HTML preview. It cannot paginate.
- Native `<embed>` PDF viewer. Blank in headless, no control.
- Monaco. 7× the bytes.
- Framework wrappers around PDF.js. They re-export an API we call directly.
- A build step. Nothing is vendored, because the browser draws the preview; a
  build-free shell is why the editor is not CodeMirror either.
