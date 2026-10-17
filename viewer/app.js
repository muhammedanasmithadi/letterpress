/*
  Shell wiring.

  The toolbar holds state, the state becomes a render request, and the request
  goes to the same server the CLI is built on. Nothing here inspects or rewrites
  HTML: the preview must show what render() produced, or it is not a preview.

  Deliberately not in this file: CodeMirror. The shell is verified on its own
  first, so a layout or control fault is not hidden behind a half-configured
  editor. The preview is the browser's own PDF renderer drawing the returned
  bytes -- no vendored renderer, which is what keeps this repo dependency-free.
*/

const $ = (id) => document.getElementById(id);

const el = {
  file: $('file'),
  format: $('format'),
  portrait: $('portrait'),
  landscape: $('landscape'),
  margin: $('margin'),
  background: $('background'),
  ppi: $('ppi'),
  network: $('network'),
  render: $('render'),
  download: $('download'),
  source: $('source'),
  gutter: $('gutter'),
  codewrap: $('codewrap'),
  highlight: $('highlight'),
  pager: $('pager'),
  pagePrev: $('page-prev'),
  pageNum: $('page-num'),
  pageCount: $('page-count'),
  pageNext: $('page-next'),
  preview: $('preview'),
  previewNote: $('preview-note'),
  sourceMeta: $('source-meta'),
  status: $('status'),
  // The severity rules in theme.css are written `.status[data-level=...]`, and
  // `.status` is the footer that holds the live region, not the live region
  // itself. Setting the level on the output left the whole rule dead: measured,
  // an error painted rgb(0,0,0). The level belongs on the element the selector
  // actually names.
  statusBar: document.querySelector('.status'),
  metrics: $('metrics'),
};

const DEBOUNCE_MS = 400;

/**
 * A backstop against a connection that never answers.
 *
 * Not the answer to a slow render, and deliberately generous. A document whose
 * script loops is answered by the server at its own 30s deadline with a real
 * message, so a shorter client deadline would only pre-empt a better answer and
 * would break the genuinely large documents that take most of that. What makes a
 * long wait tolerable is the visible elapsed counter below, not a shorter fuse.
 *
 * The first version of this was 45s with a comment claiming it stopped the ui
 * freezing for 31s, which it could not do: 45s is above the server's 30s, so it
 * never fired. It exists for a wedged socket, which the server's deadline cannot
 * cover because the request never reaches it.
 */
const CLIENT_TIMEOUT_MS = 90_000;

/**
 * Renders are identified by a monotonically increasing number and every write
 * is gated on it.
 *
 * Without this, a slow render that finishes after a fast one overwrites it, and
 * the measured result was: the editor holding a one-page document, the status
 * line reading "60 pages", and Download handing back 60 pages of somebody
 * else's document. That is silent wrong output, which is the one failure a
 * preview tool cannot have.
 *
 * The previous request is also aborted, so the work is not merely ignored after
 * the fact.
 */
let seq = 0;
let inflight = 0;
let controller = null;

function syncBusy() {
  // A count, not a boolean. With a flag, the first render to finish re-enabled
  // the button while another was still running, and Ctrl+Enter started further
  // ones regardless, so renders could stack without limit.
  el.render.disabled = inflight > 0;
  el.render.textContent = inflight > 1 ? `Rendering (${inflight})` : 'Render';
}

/** Read the toolbar. Empty format means "let the document decide". */
function settings() {
  const format = el.format.value;
  // readOnly rather than disabled, so the field can still be focused and read.
  // Its value is ignored here while a format is unset, because the server refuses
  // a margin without one.
  const margin = el.format.value ? el.margin.value.trim() : '';
  return {
    format: format || undefined,
    // The server rejects a margin without a format, because a document's own
    // @page margin wins anyway and the combination is always a mistake.
    ...(format && margin ? { margin } : {}),
    landscape: isLandscape(),
    // The server's field is printBackground, matching the CLI's --no-background.
    // This sent "background", which the server never read, so the checkbox did
    // nothing at all: measured, the red page still printed with the box off.
    printBackground: el.background.checked,
    maxImagePpi: readPpi(),
    allowNetwork: el.network.checked,
  };
}

/**
 * The image resolution cap, or undefined to leave the default alone.
 *
 * Number("") is 0 and 0 means "do not downsample", so an empty or unusable
 * field used to silently switch the cap off and hand back a huge PDF reported
 * as a clean render. An unusable value now leaves the cap at its default, marks
 * the field invalid for assistive tech, and explains itself on the field's own
 * title: a number input cannot hold the text "abc" at all, so the reader has no
 * broken value to see and needs the sentence instead.
 */
function readPpi() {
  const raw = el.ppi.value.trim();
  if (raw === '') {
    el.ppi.removeAttribute('aria-invalid');
    el.ppi.title = 'Empty: the 300 ppi default applies.';
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    el.ppi.setAttribute('aria-invalid', 'true');
    el.ppi.title = `"${raw}" is not a whole number of ppi; the 300 ppi default applies.`;
    return undefined;
  }
  el.ppi.removeAttribute('aria-invalid');
  el.ppi.title = '';
  // The server clamps to 1200 silently, so the box shows the effective cap
  // instead of claiming a resolution the engine ignores. The max attribute
  // above already paints out-of-range input invalid.
  if (n > 1200) {
    el.ppi.value = '1200';
    return 1200;
  }
  return n;
}

function say(message, level = 'info') {
  el.status.textContent = message;
  // Cleared here so a later clean success cannot keep hovering an old failure.
  // fail() and the findings branch set it again right after.
  el.status.title = '';
  el.statusBar.dataset.level = level;
}

/**
 * One line about what the last render produced.
 *
 * Findings are the renderer's own wording, which is written for a terminal and
 * mentions flags that do not exist in this UI: a blocked asset told the user to
 * "Pass --allow-network" while an Allow network checkbox sat in the same
 * toolbar. Measured at up to 358 characters, which pushed the status line to
 * three lines and stole height from the panes.
 *
 * So: the first sentence, and a count. The full text goes to the title
 * attribute, which costs nothing until someone hovers.
 */
function findingLine(findings) {
  if (!findings.length) return 'no findings';
  const first = String(findings[0].message).split(/(?<=[.!?])\s/)[0];
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
  return `${first}${more}`;
}

/** Replace the preview's contents without dropping the stale marker. */
function showPreview(main, sub) {
  const box = el.preview;
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = main;
  if (sub) {
    // A child of .placeholder. As a sibling it missed the `.placeholder .sub`
    // rule, so the first render silently changed the pane's typography.
    const span = document.createElement('span');
    span.className = 'sub';
    span.textContent = sub;
    p.append(span);
  }
  box.replaceChildren(p);
}

/**
 * Draw the returned bytes in the preview pane.
 *
 * The browser's own PDF renderer draws them: real pagination, selectable text,
 * no vendored renderer and no megabyte of third-party code in this repo (which
 * has no npm dependencies on purpose). `navigator.pdfViewerEnabled` is false
 * where no viewer exists, and there the text placeholder stays instead of a
 * dead frame. The preview shows exactly these bytes -- the same object URL the
 * Download button hands out -- so what is on screen and what is saved cannot
 * diverge.
 */
function showPdf() {
  if (navigator.pdfViewerEnabled === false) return false;
  const iframe = document.createElement('iframe');
  iframe.title = 'PDF preview';
  iframe.src = objectUrl;
  // Out of the tab order. A browser PDF viewer holds a dozen or more of its own
  // tab stops (Firefox's PDF.js toolbar), and every one of them sits between the
  // editor and the pager: measured, a keyboard user pressed Tab ~16 times inside
  // this frame before reaching the page controls. The preview is paint; the
  // pager beside it and Download are the keyboard paths.
  iframe.tabIndex = -1;
  el.preview.replaceChildren(iframe);
  frame = iframe;
  return true;
}

/**
 * Page navigation over the bytes on screen. Fragment-only: setting src to the
 * same blob URL with a different #page= does not reload the document (and if a
 * browser ever did, the bytes are a blob: instant and offline). It never
 * re-renders, so a jump cannot disturb the editor, the findings or Download.
 * Out-of-range input clamps silently and the field reverts; there is no error
 * worth announcing for a number.
 */
function syncPager() {
  el.pager.hidden = pageCount <= 1;
  el.pagePrev.disabled = currentPage <= 1;
  el.pageNext.disabled = currentPage >= pageCount;
  el.pageNum.value = String(currentPage);
  el.pageCount.textContent = `of ${pageCount}`;
}

function goToPage(n) {
  if (!frame || pageCount <= 1) return;
  const at = Math.min(pageCount, Math.max(1, Math.floor(Number(n)) || 1));
  currentPage = at;
  frame.src = `${objectUrl}#page=${at}`;
  syncPager();
  say(`Page ${at} of ${pageCount}.`);
}

el.pagePrev.addEventListener('click', () => goToPage(currentPage - 1));
el.pageNext.addEventListener('click', () => goToPage(currentPage + 1));
el.pageNum.addEventListener('change', () => goToPage(Number(el.pageNum.value)));

function markStale(on, why = '') {
  // The note names a render the user can still see. With no successful render
  // behind it there is nothing stale -- the placeholder already says nothing
  // rendered yet -- so claiming a "last good render" would be false. Kept to
  // one short line: at half-pane width a longer note wraps to two, and the
  // detail lives in the title and was already announced in the status line.
  el.previewNote.hidden = !on || !lastBytes;
  if (on && lastBytes) {
    el.previewNote.textContent = 'Showing the last good render (out of date).';
    el.previewNote.title = why;
  }
  // Download is disabled on a failure, because the bytes on offer belong to a
  // document the user has already changed.
  el.download.disabled = on || !lastBytes;
}

let lastBytes = null;
let objectUrl = null;
let frame = null;
let pageCount = 1;
let currentPage = 1;

/** Hold new bytes, releasing the previous object URL so renders do not pile up. */
function setBytes(bytes) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  lastBytes = bytes;
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

async function render() {
  const mine = ++seq;
  controller?.abort();
  controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), CLIENT_TIMEOUT_MS);

  const html = el.source.value;
  if (!html.trim()) {
    clearTimeout(timer);
    say('Nothing to render: the source is empty.', 'warn');
    el.metrics.textContent = '';
    markStale(true, 'source is empty');
    return;
  }

  inflight++;
  syncBusy();
  const startedAt = performance.now();
  // A ticking counter rather than a static "Rendering…". Measured: the status line
  // read the same thirty times over 31 seconds, so a live document looked
  // exactly like a wedged one.
  const ticker = setInterval(() => {
    if (mine === seq) say(`Rendering… ${Math.round((performance.now() - startedAt) / 1000)}s`);
  }, 1000);
  say('Rendering…');

  try {
    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, ...settings() }),
      signal: controller.signal,
    });
    const body = await res.json();
    // Every write below is gated. A response for an older request is dropped
    // whole, not merged.
    if (mine !== seq) return;

    if (!res.ok || body.ok === false) {
      fail(body.error ?? `render failed: ${res.status}`, 'error');
      return;
    }

    // Held as bytes rather than a data URL, so a large document is not a string
    // in memory twice.
    setBytes(Uint8Array.from(atob(body.pdf), (c) => c.charCodeAt(0)));
    el.download.disabled = false;
    el.download.onclick = () => {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'document.pdf';
      a.click();
    };
    markStale(false);

    const kb =
      body.bytes < 1048576
        ? `${Math.round(body.bytes / 1024)} KB`
        : `${(body.bytes / 1048576).toFixed(1)} MB`;
    const pages = `${body.pages} page${body.pages === 1 ? '' : 's'}`;
    el.metrics.textContent = `${pages} · ${kb} · ${body.ms} ms`;
    pageCount = body.pages;
    currentPage = 1;
    syncPager();
    if (!showPdf()) {
      showPreview(
        `${pages}, ${kb}.`,
        body.partial
          ? 'Only the requested pages were rendered, so this is not the document length.'
          : 'This browser has no PDF viewer, so the pages cannot be drawn here. Download still works.',
      );
    }

    const findings = body.findings ?? [];
    if (findings.some((f) => f.code === 'orientation-ignored')) {
      // The engine kept the document's own box: show the effective state, not
      // the request. Paint only -- the bytes on screen already match, so no
      // second render. The status message beside this carries the why and the
      // fix; the control stops overpromising.
      landscapeOn = false;
      paintOrientation();
    }
    if (!findings.length) {
      // The page count is in the message as well as the metrics, because the
      // status line is the live region and the metrics are not. Saying the same
      // words every time announced nothing at all.
      say(`Rendered ${pages}, no findings.`);
    } else {
      const errors = findings.filter((f) => f.severity === 'error').length;
      const line = findingLine(findings);
      say(`Rendered ${pages}. ${line}`, errors ? 'error' : 'warn');
      // The full wording, for anyone who wants it.
      el.status.title = findings.map((f) => f.message).join('\n\n');
    }
  } catch (e) {
    if (mine !== seq) return;
    const aborted = e instanceof Error && e.name === 'AbortError';
    if (aborted && controller.signal.reason === 'timeout') {
      fail(
        `Gave up after ${Math.round(CLIENT_TIMEOUT_MS / 1000)}s without an answer. That is this page's ` +
          `own backstop for a connection that never completes, so the renderer is not the slow part here. ` +
          `Restart it, or check that it is still running.`,
        'error',
      );
    } else if (aborted) {
      // Superseded by a newer request, which is not a failure worth reporting.
      return;
    } else {
      fail(
        `Could not reach the renderer (${e instanceof Error ? e.message : e}). ` +
          `Is the server still running?`,
        'error',
      );
    }
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    inflight--;
    syncBusy();
  }
}

/**
 * Report a failure without destroying what is on screen.
 *
 * The preview used to keep asserting the previous document's page count while
 * the metrics beside it went blank, so the two halves of the footer disagreed
 * and the confident one was wrong. The last good render stays visible, marked
 * as not current, and Download is disabled.
 */
function fail(message, level) {
  say(message, level);
  el.status.title = message;
  el.metrics.textContent = '';
  markStale(true, message.split(/(?<=[.!?])\s/)[0]);
}

// ---- events ----

/**
 * A margin without a format is always a mistake, so the field is inert until a
 * paper size is chosen, and it says why.
 *
 * aria-disabled rather than the disabled attribute. A disabled control cannot be
 * focused at all: measured, margin.focus() left document.activeElement on BODY,
 * so a keyboard or screen-reader user never reaches it and never learns the
 * reason. aria-disabled keeps it in the tab order and announced as inactive, and
 * the check below is what actually stops it being used.
 */
function syncMargin() {
  const inert = !el.format.value;
  el.margin.setAttribute('aria-disabled', inert ? 'true' : 'false');
  el.margin.readOnly = inert;
  el.margin.title = inert
    ? "Margins apply to a paper size you choose here. A document's own @page margin wins otherwise."
    : '';
}
el.format.addEventListener('change', () => {
  syncMargin();
  void render();
});

// Margin types like PPI: debounced input, but gated on validity. Intermediate
// keystrokes ("2", "20m") are not CSS lengths, and sending them would flash a
// 400 the user never committed. change (blur/Enter) below still sends whatever
// is there, so a genuinely bad value gets a real rejection, not silence.
let marginTimer;
el.margin.addEventListener('input', () => {
  clearTimeout(marginTimer);
  marginTimer = setTimeout(() => {
    const v = el.margin.value.trim();
    if (v === '' || isLengthLike(v)) void render();
  }, DEBOUNCE_MS);
});

/** Mirrors the server's checkMargin length test. Transient input only. */
function isLengthLike(v) {
  return /^0(?:\.0+)?$/.test(v) || /^-?\d*\.?\d+(mm|cm|in|pt|px|pc|q)$/.test(v);
}

el.margin.addEventListener('change', () => void render());

for (const control of [el.background, el.network]) {
  control.addEventListener('change', () => void render());
}

/**
 * Orientation lives in aria-pressed on two buttons, not in a checkbox: the
 * segmented control reads as text, and a boolean carries the state to the
 * payload. Both buttons announce through aria-pressed, so the underline is
 * never the only signal.
 */
let landscapeOn = false;

function isLandscape() {
  return landscapeOn;
}

function setOrientation(toLandscape) {
  landscapeOn = toLandscape;
  paintOrientation();
  void render();
}

/** Reflect the state in both buttons. Split out so the engine can correct the
 * display without requesting another render (see orientation-ignored below). */
function paintOrientation() {
  el.landscape.setAttribute('aria-pressed', String(landscapeOn));
  el.portrait.setAttribute('aria-pressed', String(!landscapeOn));
}

el.landscape.addEventListener('click', () => setOrientation(true));
el.portrait.addEventListener('click', () => setOrientation(false));
el.ppi.addEventListener('input', () => {
  readPpi();
  clearTimeout(ppiTimer);
  ppiTimer = setTimeout(() => void render(), DEBOUNCE_MS);
});

let timer;
let ppiTimer;
el.source.addEventListener('input', () => {
  renderHighlight();
  clearTimeout(timer);
  timer = setTimeout(() => void render(), DEBOUNCE_MS);
});

// Ctrl+Enter renders without waiting for the debounce, which is the reflex after
// half a second of typing. It supersedes any render already running: render()
// aborts the previous request and starts this one, so the newest source always
// wins and a slow earlier render cannot land on top of it. The Render button,
// by contrast, is disabled while a render is in flight.
el.source.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(timer);
    void render();
  }
});

el.render.addEventListener('click', () => void render());

el.file.addEventListener('change', async () => {
  const file = el.file.files?.[0];
  if (!file) return;
  el.source.value = await file.text();
  // Repaint the highlight layer and gutter: programmatic value sets fire no
  // input event, so without this the editor keeps showing the previous
  // document while the value and preview are already the new one.
  renderHighlight();
  say(`Loaded ${file.name}, ${el.source.value.length} characters.`);
  void render();
});

syncMargin();

// Render the starter document on load. A viewer whose preview is empty until
// something is clicked cannot show that it works, and the first thing anyone
// opens it with is already on screen.
void render();

/**
 * The editor highlight layer and its line gutter.
 *
 * A tokenizer, not a parser: comments and declarations first (they hold < > that
 * would otherwise lex as tags), then tags with attribute names and quoted
 * values picked out, everything else plain text. Every piece is HTML-escaped
 * before any span wraps it, so mismatched markup highlights wrong at worst --
 * it can never inject. An unterminated `<di` mid-typing still lexes as a tag
 * start rather than vanishing the line.
 */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paintTag(token) {
  const m = /^(<\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[\s\S]*?))(\/?>?)$/.exec(token);
  if (!m) return `<span class="tok-tag">${esc(token)}</span>`;
  const attrs = m[3].replace(
    /([a-zA-Z-:]+)(=("[^"]*"|'[^']*'|[^\s>]+))?/g,
    (whole, name, eq) =>
      `<span class="tok-attr">${esc(name)}</span>${eq ? `<span class="tok-str">${esc(eq)}</span>` : ''}`,
  );
  return `${esc(m[1])}<span class="tok-tag">${esc(m[2])}</span>${attrs}${esc(m[4])}`;
}

function highlightHtml(src) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<![^<>]*>|<\/?[a-zA-Z][^<>]*>?/gi;
  let at = 0;
  for (const m of src.matchAll(re)) {
    out.push(esc(src.slice(at, m.index)));
    const token = m[0];
    out.push(
      token.startsWith('<!--') || token[1] === '!'
        ? `<span class="tok-com">${esc(token)}</span>`
        : paintTag(token),
    );
    at = m.index + token.length;
  }
  out.push(esc(src.slice(at)));
  return out.join('');
}

function renderHighlight() {
  const src = el.source.value;
  el.highlight.innerHTML = highlightHtml(src);
  const n = src.split('\n').length;
  el.sourceMeta.textContent = `HTML · ${n} line${n === 1 ? '' : 's'}`;
  const box = el.gutter;
  // Rebuild only when the count changes; per-keystroke DOM churn on every
  // key is what makes editors feel slow on long documents.
  if (box.childElementCount !== n) {
    box.replaceChildren();
    for (let i = 1; i <= n; i++) {
      const d = document.createElement('div');
      d.textContent = String(i);
      box.appendChild(d);
    }
  }
  syncGutter();
}

function syncGutter() {
  el.gutter.scrollTop = el.codewrap.scrollTop;
}

el.codewrap.addEventListener('scroll', syncGutter, { passive: true });

// While composing (CJK, Arabic IME), the textarea shows the composition string
// but the highlight shows uncomposed text: doubling. Hide the layer for the
// duration; plain text for a keystroke beats a wrong render.
el.source.addEventListener('compositionstart', () => {
  el.highlight.style.visibility = 'hidden';
});
el.source.addEventListener('compositionend', () => {
  el.highlight.style.visibility = '';
  renderHighlight();
});

renderHighlight();
