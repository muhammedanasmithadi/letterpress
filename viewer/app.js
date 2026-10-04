/*
  Shell wiring.

  The toolbar holds state, the state becomes a render request, and the request
  goes to the same server the CLI is built on. Nothing here inspects or rewrites
  HTML: the preview must show what render() produced, or it is not a preview.

  Deliberately not in this file: CodeMirror and PDF.js. The shell is verified on
  its own first, so a layout or control fault is not hidden behind a
  half-configured editor.
*/

const $ = (id) => document.getElementById(id);

const el = {
  file: $("file"),
  format: $("format"),
  landscape: $("landscape"),
  margin: $("margin"),
  background: $("background"),
  ppi: $("ppi"),
  network: $("network"),
  render: $("render"),
  download: $("download"),
  source: $("source"),
  preview: $("preview"),
  previewNote: $("preview-note"),
  status: $("status"),
  metrics: $("metrics"),
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
  el.render.textContent = inflight > 1 ? `Rendering (${inflight})` : "Render";
}

/** Read the toolbar. Empty format means "let the document decide". */
function settings() {
  const format = el.format.value;
  // readOnly rather than disabled, so the field can still be focused and read.
  // Its value is ignored here while a format is unset, because the server refuses
  // a margin without one.
  const margin = el.format.value ? el.margin.value.trim() : "";
  return {
    format: format || undefined,
    // The server rejects a margin without a format, because a document's own
    // @page margin wins anyway and the combination is always a mistake.
    ...(format && margin ? { margin } : {}),
    landscape: el.landscape.checked,
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
 * Number("") is 0 and 0 means "do not downsample", so an empty or mistyped field
 * used to silently switch the cap off and hand back a huge PDF reported as a
 * clean render. An unusable value now leaves the cap at its default and says so.
 */
function readPpi() {
  const raw = el.ppi.value.trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    el.ppi.setAttribute("aria-invalid", "true");
    return undefined;
  }
  el.ppi.removeAttribute("aria-invalid");
  return n;
}

function say(message, level = "info") {
  el.status.textContent = message;
  el.status.dataset.level = level;
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
  if (!findings.length) return "no findings";
  const first = String(findings[0].message).split(/(?<=[.!?])\s/)[0];
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
  return `${first}${more}`;
}

/** Replace the preview's contents without dropping the stale marker. */
function showPreview(main, sub) {
  const box = el.preview;
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = main;
  if (sub) {
    // A child of .placeholder. As a sibling it missed the `.placeholder .sub`
    // rule, so the first render silently changed the pane's typography.
    const span = document.createElement("span");
    span.className = "sub";
    span.textContent = sub;
    p.append(span);
  }
  box.replaceChildren(p);
}

function markStale(on, why = "") {
  el.previewNote.hidden = !on;
  if (on) {
    el.previewNote.textContent = `showing the last good render, not the current source${why ? ` — ${why}` : ""}`;
  }
  // Download is disabled on a failure, because the bytes on offer belong to a
  // document the user has already changed.
  el.download.disabled = on || !lastBytes;
}

let lastBytes = null;

async function render() {
  const mine = ++seq;
  controller?.abort();
  controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), CLIENT_TIMEOUT_MS);

  const html = el.source.value;
  if (!html.trim()) {
    clearTimeout(timer);
    say("Nothing to render: the source is empty.", "warn");
    el.metrics.textContent = "";
    markStale(true, "source is empty");
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
  say("Rendering…");

  try {
    const res = await fetch("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html, ...settings() }),
      signal: controller.signal,
    });
    const body = await res.json();
    // Every write below is gated. A response for an older request is dropped
    // whole, not merged.
    if (mine !== seq) return;

    if (!res.ok || body.ok === false) {
      fail(body.error ?? `render failed: ${res.status}`, "error");
      return;
    }

    // Held as bytes rather than a data URL, so a large document is not a string
    // in memory twice.
    lastBytes = Uint8Array.from(atob(body.pdf), (c) => c.charCodeAt(0));
    let objectUrl = null;
    el.download.disabled = false;
    el.download.onclick = () => {
      objectUrl ??= URL.createObjectURL(new Blob([lastBytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "document.pdf";
      a.click();
    };
    markStale(false);

    const kb = body.bytes < 1048576
      ? `${Math.round(body.bytes / 1024)} KB`
      : `${(body.bytes / 1048576).toFixed(1)} MB`;
    const pages = `${body.pages} page${body.pages === 1 ? "" : "s"}`;
    el.metrics.textContent = `${pages} · ${kb} · ${body.ms} ms`;
    showPreview(
      `${pages}, ${kb}.`,
      body.partial
        ? "Only the requested pages were rendered, so this is not the document length."
        : "PDF.js draws these bytes here in the next phase.",
    );

    const findings = body.findings ?? [];
    if (!findings.length) {
      // The page count is in the message as well as the metrics, because the
      // status line is the live region and the metrics are not. Saying the same
      // words every time announced nothing at all.
      say(`Rendered ${pages}, no findings.`);
    } else {
      const errors = findings.filter((f) => f.severity === "error").length;
      const line = findingLine(findings);
      say(`Rendered ${pages}. ${line}`, errors ? "error" : "warn");
      // The full wording, for anyone who wants it.
      el.status.title = findings.map((f) => f.message).join("\n\n");
    }
  } catch (e) {
    if (mine !== seq) return;
    const aborted = e instanceof Error && e.name === "AbortError";
    const elapsed = Math.round(performance.now() - startedAt);
    if (aborted && controller.signal.reason === "timeout") {
      fail(
        `gave up after ${Math.round(CLIENT_TIMEOUT_MS / 1000)}s without an answer. that is this page's ` +
        `own backstop for a connection that never completes, well past the server's 30s deadline, ` +
        `so the renderer is not the slow part here. restart it, or check that it is still running.`,
        "error",
      );
    } else if (aborted) {
      // Superseded by a newer request, which is not a failure worth reporting.
      return;
    } else {
      fail(
        `could not reach the renderer (${e instanceof Error ? e.message : e}). ` +
        `is the server still running?`,
        "error",
      );
    }
    void elapsed;
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
  el.metrics.textContent = "";
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
  el.margin.setAttribute("aria-disabled", inert ? "true" : "false");
  el.margin.readOnly = inert;
  el.margin.title = inert
    ? "Margins apply to a paper size you choose here. A document's own @page margin wins otherwise."
    : "";
}
el.format.addEventListener("change", () => { syncMargin(); void render(); });
el.margin.addEventListener("change", () => void render());

for (const control of [el.landscape, el.background, el.network]) {
  control.addEventListener("change", () => void render());
}
el.ppi.addEventListener("input", () => {
  readPpi();
  clearTimeout(ppiTimer);
  ppiTimer = setTimeout(() => void render(), DEBOUNCE_MS);
});

let timer;
let ppiTimer;
el.source.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void render(), DEBOUNCE_MS);
});

// Ctrl+Enter renders without waiting for the debounce, which is the reflex after
// half a second of typing. It queues rather than bypassing the in-flight guard,
// because the old version let it start a second render while one was running.
el.source.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(timer);
    void render();
  }
});

el.render.addEventListener("click", () => void render());

el.file.addEventListener("change", async () => {
  const file = el.file.files?.[0];
  if (!file) return;
  el.source.value = await file.text();
  say(`Loaded ${file.name}, ${el.source.value.length} characters.`);
  void render();
});

syncMargin();

// Render the starter document on load. A viewer whose preview is empty until
// something is clicked cannot show that it works, and the first thing anyone
// opens it with is already on screen.
void render();