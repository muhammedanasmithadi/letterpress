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
  statusBar: document.querySelector('.status'),
  metrics: $('metrics'),
};

const DEBOUNCE_MS = 400;

const CLIENT_TIMEOUT_MS = 90_000;

let seq = 0;
let inflight = 0;
let controller = null;

function syncBusy() {
  el.render.disabled = inflight > 0;
  el.render.textContent = inflight > 1 ? `Rendering (${inflight})` : 'Render';
}

function settings() {
  const format = el.format.value;
  const margin = el.format.value ? el.margin.value.trim() : '';
  return {
    format: format || undefined,
    ...(format && margin ? { margin } : {}),
    landscape: landscapeOn,
    printBackground: el.background.checked,
    maxImagePpi: readPpi(),
    allowNetwork: el.network.checked,
  };
}

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
  if (n > 1200) {
    el.ppi.value = '1200';
    return 1200;
  }
  return n;
}

function say(message, level = 'info') {
  el.status.textContent = message;
  el.status.title = '';
  el.statusBar.dataset.level = level;
}

function findingLine(findings) {
  if (!findings.length) return 'no findings';
  const first = String(findings[0].message).split(/(?<=[.!?])\s/)[0];
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
  return `${first}${more}`;
}

function showPreview(main, sub) {
  const box = el.preview;
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = main;
  if (sub) {
    const span = document.createElement('span');
    span.className = 'sub';
    span.textContent = sub;
    p.append(span);
  }
  box.replaceChildren(p);
}

function showPdf() {
  if (navigator.pdfViewerEnabled === false) return false;
  const iframe = document.createElement('iframe');
  iframe.title = 'PDF preview';
  iframe.src = objectUrl;
  iframe.tabIndex = -1;
  el.preview.replaceChildren(iframe);
  frame = iframe;
  return true;
}

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
  el.previewNote.hidden = !on || !lastBytes;
  if (on && lastBytes) {
    el.previewNote.textContent = 'Showing the last good render (out of date).';
    el.previewNote.title = why;
  }
  el.download.disabled = on || !lastBytes;
}

let lastBytes = null;
let objectUrl = null;
let frame = null;
let pageCount = 1;
let currentPage = 1;

function setBytes(bytes) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  lastBytes = bytes;
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

async function render(overrides = {}) {
  const mine = ++seq;
  controller?.abort();
  const mine_controller = new AbortController();
  controller = mine_controller;
  const timer = setTimeout(() => mine_controller.abort('timeout'), CLIENT_TIMEOUT_MS);

  const html = typeof overrides.html === 'string' ? overrides.html : el.source.value;
  if (!html.trim()) {
    clearTimeout(timer);
    say('Nothing to render: the source is empty.', 'warn');
    el.metrics.textContent = '';
    markStale(true, 'source is empty');
    return null;
  }

  inflight++;
  syncBusy();
  const startedAt = performance.now();
  const ticker = setInterval(() => {
    if (mine === seq) say(`Rendering… ${Math.round((performance.now() - startedAt) / 1000)}s`);
  }, 1000);
  say('Rendering…');

  try {
    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...settings(), ...overrides, html }),
      signal: controller.signal,
    });
    const body = await res.json();
    if (mine !== seq) return null;

    if (!res.ok || body.ok === false) {
      fail(body.error ?? `render failed: ${res.status}`, 'error');
      return null;
    }

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
      landscapeOn = false;
      paintOrientation();
    }
    if (!findings.length) {
      say(`Rendered ${pages}, no findings.`);
    } else {
      const errors = findings.filter((f) => f.severity === 'error').length;
      const line = findingLine(findings);
      say(`Rendered ${pages}. ${line}`, errors ? 'error' : 'warn');
      el.status.title = findings.map((f) => f.message).join('\n\n');
    }
    return body;
  } catch (e) {
    if (mine !== seq) return null;
    const aborted = e instanceof Error && e.name === 'AbortError';
    if (aborted && mine_controller.signal.reason === 'timeout') {
      fail(
        `Gave up after ${Math.round(CLIENT_TIMEOUT_MS / 1000)}s without an answer. That is this page's ` +
          `own backstop for a connection that never completes, so the renderer is not the slow part here. ` +
          `Restart it, or check that it is still running.`,
        'error',
      );
    } else if (aborted) {
      return null;
    } else {
      fail(
        `Could not reach the renderer (${e instanceof Error ? e.message : e}). ` +
          `Is the server still running?`,
        'error',
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    inflight--;
    syncBusy();
  }
}

function fail(message, level) {
  say(message, level);
  el.status.title = message;
  el.metrics.textContent = '';
  markStale(true, message.split(/(?<=[.!?])\s/)[0]);
}

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

let marginTimer;
el.margin.addEventListener('input', () => {
  clearTimeout(marginTimer);
  marginTimer = setTimeout(() => void renderMargin(), DEBOUNCE_MS);
});

function isLengthLike(v) {
  return /^0(?:\.0+)?$/.test(v) || /^-?\d*\.?\d+(mm|cm|in|pt|px|pc|q)$/.test(v);
}

async function renderMargin() {
  const v = el.margin.value.trim();
  if (v === '' || isLengthLike(v)) return render();
  say('That is not a length. A margin is a number and a unit, such as 15mm.', 'warn');
  return null;
}

el.margin.addEventListener('change', () => {
  clearTimeout(marginTimer);
  void renderMargin();
});

for (const control of [el.background, el.network]) {
  control.addEventListener('change', () => void render());
}

let landscapeOn = false;

function setOrientation(toLandscape) {
  landscapeOn = toLandscape;
  paintOrientation();
  void render();
}

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
  el.file.value = '';
  el.source.value = await file.text();
  renderHighlight();
  say(`Loaded ${file.name}, ${el.source.value.length} characters.`);
  void render();
});

syncMargin();

void render();

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

el.source.addEventListener('compositionstart', () => {
  el.highlight.style.visibility = 'hidden';
});
el.source.addEventListener('compositionend', () => {
  el.highlight.style.visibility = '';
  renderHighlight();
});

renderHighlight();

export async function renderForTool(args = {}) {
  const overrides = {};
  if (typeof args.format === 'string') {
    if (!hasFormat(args.format)) {
      throw new Error(`there is no paper called ${args.format}`);
    }
    el.format.value = args.format;
    syncMargin();
  }
  if (typeof args.margin === 'string') {
    if (!el.format.value) {
      throw new Error('a margin needs a paper to apply to');
    }
    el.margin.value = args.margin;
  }
  if (typeof args.landscape === 'boolean') {
    landscapeOn = args.landscape;
    paintOrientation();
  }
  if (typeof args.allowNetwork === 'boolean') el.network.checked = args.allowNetwork;

  if (typeof args.html === 'string') {
    overrides.html = args.html;
  }
  if (typeof args.pageRanges === 'string') overrides.pageRanges = args.pageRanges;

  return render(overrides);
}

function hasFormat(name) {
  return [...el.format.options].some((o) => o.value === name);
}
