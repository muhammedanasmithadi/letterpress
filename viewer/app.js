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
  status: $("status"),
  metrics: $("metrics"),
};

const DEBOUNCE_MS = 400;

/** Read the toolbar. Empty format means "let the document decide". */
function settings() {
  const format = el.format.value;
  const margin = el.margin.value.trim();
  return {
    format: format || undefined,
    // The server rejects a margin without a format, because a document's own
    // @page margin wins anyway and the combination is always a mistake.
    ...(format && margin ? { margin } : {}),
    landscape: el.landscape.checked,
    background: el.background.checked,
    maxImagePpi: Number(el.ppi.value) || 0,
    allowNetwork: el.network.checked,
  };
}

function say(message, level = "info") {
  el.status.textContent = message;
  el.status.dataset.level = level;
}

/**
 * Render the editor contents and report what came back.
 *
 * The metrics line is what this phase can honestly show. The pages and the byte
 * count come from the render itself, not from counting lines in the textarea,
 * which would be a guess dressed as a fact.
 */
async function render() {
  const html = el.source.value;
  const s = settings();

  if (!html.trim()) {
    say("Nothing to render: the source is empty.", "warn");
    el.metrics.textContent = "";
    el.download.disabled = true;
    return;
  }

  el.render.disabled = true;
  say("Rendering…");

  try {
    const res = await fetch("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html, ...s }),
    });
    const body = await res.json();

    if (!res.ok || body.ok === false) {
      say(body.error ?? `render failed: ${res.status}`, "error");
      el.metrics.textContent = "";
      el.download.disabled = true;
      return;
    }

    // Hold the bytes for Download. Kept as a Blob rather than a data URL so a
    // large document does not become a string in memory twice.
    const bytes = Uint8Array.from(atob(body.pdf), (c) => c.charCodeAt(0));
    let objectUrl = null;
    const makeUrl = () => {
      objectUrl ??= URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      return objectUrl;
    };
    el.download.disabled = false;
    el.download.onclick = () => {
      const a = document.createElement("a");
      a.href = makeUrl();
      a.download = "document.pdf";
      a.click();
    };

    const kb = body.bytes < 1024 * 1024
      ? `${Math.round(body.bytes / 1024)} KB`
      : `${(body.bytes / 1048576).toFixed(1)} MB`;
    el.metrics.textContent = `${body.pages} page${body.pages === 1 ? "" : "s"} · ${kb} · ${body.ms} ms`;
    el.preview.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "placeholder",
        textContent: `${body.pages} page${body.pages === 1 ? "" : "s"}, ${kb}. `,
      }),
      Object.assign(document.createElement("span"), {
        className: "sub",
        textContent: "PDF.js draws these bytes here in the next phase.",
      }),
    );

    // Findings are diagnostics. Two of them are errors in the tool's own
    // judgement, which the server already reports as a non-2xx.
    const findings = body.findings ?? [];
    if (!findings.length) {
      say("Rendered with no findings.");
    } else {
      const errors = findings.filter((f) => f.severity === "error").length;
      say(
        findings.length === 1 ? findings[0].message : findings.map((f) => f.message).join("  ·  "),
        errors ? "error" : "warn",
      );
    }
  } catch (e) {
    say(`could not reach the renderer: ${e instanceof Error ? e.message : e}`, "error");
    el.metrics.textContent = "";
    el.download.disabled = true;
  } finally {
    el.render.disabled = false;
  }
}

// ---- events ----

// A margin without a format is always a mistake, so disable the field rather
// than let the request come back rejected.
function syncMargin() {
  el.margin.disabled = !el.format.value;
}
el.format.addEventListener("change", () => { syncMargin(); void render(); });
el.margin.addEventListener("change", () => void render());

for (const control of [el.landscape, el.background, el.ppi, el.network]) {
  control.addEventListener("change", () => void render());
}

el.render.addEventListener("click", () => void render());

let timer;
el.source.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void render(), DEBOUNCE_MS);
});

// Ctrl+Enter renders without waiting for the debounce, which is the reflex
// after half a second of typing and should not need a mouse.
el.source.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(timer);
    void render();
  }
});

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