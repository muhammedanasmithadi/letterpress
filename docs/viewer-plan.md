# letterpress viewer — implementation plan

Status: approved to build. Written 2026-10-04, after eight adversarial user-test
rounds and a CDP protocol investigation. Everything asserted below was measured
on this machine unless marked unverified.

## What already exists

`src/render.ts` drives Chromium's own print pipeline over CDP. 57 tests green,
typecheck clean, no npm dependencies. The CLI renders a file, stdin, a URL, or a
JSON order through a bundled template.

**The renderer is finished. This plan only adds a viewer, plus three changes to
the render API that the protocol investigation surfaced.**

## Verified findings this plan rests on

Each was tested. Two earlier claims of mine were retracted during verification;
see "What I got wrong" below.

| finding | evidence |
|---|---|
| `Page.printToPDF` works headless **and** headful, identically | 3-page Arabic doc: same page count, same MediaBox, same `HDR` count, same `page 3 of 3` footer, byte sizes within 8 of each other |
| Headful needs `--ozone-platform=x11` | Wayland start-up printed the DevTools endpoint then the process exited; X11 stayed up |
| `pageRanges` selects exactly the named pages | `pdftotext`: `"1-2"`→PAGE_1,PAGE_2 · `"5"`→PAGE_5 · `"3,7"`→PAGE_3,PAGE_7 · `"2-2"`→PAGE_2 |
| `pageRanges` keeps total-page counters correct | `"1-2"` of a 3-page doc prints footer `page 2 of 3`, not `of 2` |
| `transferMode:"ReturnAsStream"` matches base64 | 14,980 streamed bytes vs 14,980 predicted. Returns `eof:false` on a 64 KB read of a 14 KB doc, so the last chunk is short |
| `Page.setDocumentContent` prints with no file written | 9,244 base64 chars, zero disk writes |
| …but cannot resolve relative assets | `<img src="relative.png">` → `naturalWidth: 0`. No origin to resolve against |
| Print media emulation does **not** paginate | `matchMedia('print')` true, 3 page divs still in DOM, 3,061 px doc in a 437 px viewport, no page boxes |
| `WebMCP.invokeTool` works over CDP, no extension | `toolResponded` → `status:"Completed"`, `output.text:"sum=42"`. Needs `--enable-blink-features=WebMCP` + secure context + `{frameId, toolName, input}` |
| A `file://` image taints the canvas | `toDataURL` throws "Tainted canvases may not be exported" |
| Image ppi formula | `effective_ppi = source_px / (css_px / 96)`. 4000px at 180mm → 565 ppi |

## The one decision that shapes everything

**Print media emulation does not paginate.** A live HTML preview therefore cannot
show real page breaks, and any "live preview" that claims to is lying by about
half its output. So:

**The viewer renders the actual PDF and displays it with PDF.js.**

This is the opposite of a live-HTML preview, and it is the honest choice. The
cost is a render round trip per edit. Three mitigations make it acceptable:

1. Debounce 400 ms.
2. `pageRanges` renders only the page in view — a 3-page doc costs a third of a
   full render.
3. Above ~10 pages or ~250 KB of HTML, the viewer stops re-rendering on
   keystroke and shows a "press Render" affordance. A 400-page document takes
   ~5 s to print; pretending otherwise is how you ship a broken document.

Rejected: live HTML at paper width (cannot paginate), native `<embed>` PDF
viewer (renders nothing headless; prints a 1,072-byte blank PDF; zero
programmatic control).

## Architecture

```
browser (user's own window)
  └── viewer/index.html          shell: toolbar, split panes, native controls
        ├── CodeMirror 6         HTML+CSS, minimal extension set
        ├── pdf.js               renders the returned bytes to canvas
        └── fetch POST /render   → server.ts
                                    └── src/render.ts  (unchanged core)
                                          └── warm Chromium via CDP
```

The viewer is served by the tool's own server. It renders through the *same*
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
  transfer?: "base64" | "stream";
};
```

**Stream drain.** `printToPDF` with `transferMode:"ReturnAsStream"` returns
`{stream}`. Loop `IO.read({handle, size: 262144})` until `eof`, concatenating
`Buffer.from(chunk.data, "base64")`. Do not trust `eof` on the first read — a
14 KB document returns `eof:false` on a 64 KB read.

**Fast path.** When `fastPath` is set *and* a pre-scan finds no relative `src`/
`href` (regex: `/(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|#|mailto:)[^"']/i`),
skip `stageAssets` and `serveWorkDir`, and drive the tab with
`Page.setDocumentContent({frameId, html})`. Saves a temp dir, a socket, and a
loopback round trip. This is the common case: most documents are one HTML
string with no images.

**pageRanges.** Pass straight through. Note in the doc comment that the returned
`pages` count is the number *emitted*, not the document total — `inspect()`
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

**`viewer/editor.js`** — CodeMirror 6, hand-picked extensions, **not**
`basicSetup` (saves 42 KB gzip):

```js
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting,
         defaultHighlightStyle } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
```

~146 KB gzip, ~94 ms import. `@codemirror/lang-html` pulls `@lezer/javascript`
(78 KB) statically and cannot be dropped without losing HTML completion — accepted.

**`viewer/preview.js`** — PDF.js 6.4.299, Apache-2.0, loaded from our own origin.
`pdf.min.mjs` + `pdf.worker.min.mjs` = 505 KB gzip. Must:
- call `getDocument({url})`, **not** a bare string — v6 rejects it
- set `GlobalWorkerOptions.workerSrc` explicitly, or the fast worker path is lost
- self-host `cmaps/`, `standard_fonts/`, `wasm/`

Renders the current page plus neighbours, at `devicePixelRatio` capped to 2.
Known limitation to surface in the UI: PDF.js has open RTL bugs in selection
and search (#20097, #16116, #16716), which matters given this project's Arabic
work.

**`viewer/theme.css`** — the research says these five remove most hand-written
UI CSS: anchor positioning (Firefox 147 closed the last gap in 2026),
`light-dark()` + `color-mix()` + `contrast-color()`, `:has()`, popover with
invokers + `@starting-style` + `transition-behavior: allow-discrete`, and CSS
nesting + container queries.

**Iframe colour scheme.** Verified behaviour: `prefers-color-scheme` inside an
iframe follows the *host's* scheme, but `light-dark()` does not flip unless the
iframe's own `:root` sets `color-scheme`. Set it explicitly and keep it in sync,
because a mismatch forces an opaque canvas.

### Phase 4 — WebMCP surface (optional, cheap, no infrastructure)

Because the extension route is gone, use the CDP domain. The viewer page
registers one tool; the server invokes it:

```js
document.modelContext.registerTool({
  name: "html_to_pdf",
  description: "Render HTML to PDF through Chromium's native print engine",
  inputSchema: { type: "object", properties: {
    html: { type: "string" }, path: { type: "string" },
    format: { type: "string", enum: ["a3","a4","a5","legal","letter","tabloid"] },
    landscape: { type: "boolean" },
  }},
  execute: async (args) => ({ content: [{ type: "text", text: JSON.stringify(result) }] }),
});
```

Server side: `WebMCP.enable`, wait for `toolsAdded`, then
`invokeTool({frameId, toolName, input})` and await `toolResponded` by
`invocationId`. Requires `--enable-blink-features=WebMCP` and a secure context,
which the loopback server already provides.

Deferrable: it adds nothing a human needs and the CLI already covers agents that
can run commands.

## What I got wrong, and what I am therefore careful about

- **"Animations are already deterministic."** My test compared the first 40 bytes
  of a PNG, which is the magic number plus the IHDR header — identical for every
  image of the same size. With real pixel hashes, an animation gives 4 distinct
  hashes and a static control gives 1. Animations *do* advance on screen. The
  *rendered PDF* is still deterministic; that is a separate, untested-for-animations
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

1. Render API: `pageRanges`, stream drain, fast path. Plus tests.
2. `src/server.ts` + a curl-level smoke test.
3. Viewer shell with native controls and theme. Verify by screenshot.
4. CodeMirror editor, then PDF.js preview.
5. Headful parity test.
6. WebMCP tool, if it still seems worth it once the viewer exists.

## Explicitly not doing

- Live HTML preview. It cannot paginate.
- Native `<embed>` PDF viewer. Blank in headless, no control.
- Monaco. 7× the bytes.
- Framework wrappers around PDF.js. They re-export an API we call directly.
- A build step. PDF.js is vendored as-is; CodeMirror needs an import map, not a
  bundler.