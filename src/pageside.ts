/**
 * JavaScript that runs inside the page, as functions rather than template literals.
 *
 * A template literal is invisible to `tsc`. A free identifier inside one is not a compile
 * error, it is a `ReferenceError` thrown by the browser after the page has rendered, and the
 * CDP call returns nothing so the caller sees an empty result and carries on. That is
 * exactly how `report.push({ at: i, ... })` sat in this file for a commit with no `i` in
 * scope: `bun run typecheck` passed, the tree looked clean, and every document silently
 * stopped being downsampled.
 *
 * Writing these as functions makes the compiler check them, and `Function.prototype
 * .toString` sends the checked source. Each one takes everything it needs as a parameter and
 * references nothing at module scope, so the only names in the shipped source are parameters,
 * locals and DOM globals -- all of which exist in the page for the same reason.
 *
 * The caller interpolates only JSON-encoded literals into the call, so there is no longer any
 * way for a value to leak in from module scope by accident. `tools/lint-ts.mjs` fails the
 * build if a new interpolated page expression appears anywhere in `src`.
 */

/** One image the downsampler measured, with the index it was measured at. */
export type ImageMeasurement = {
  at: number;
  from: number;
  to: number;
  ppi: number;
  url: string;
};

export type ImageReplacement = { at: number; url: string };

/**
 * Measure every image that is both visible and over the cap, and return a JPEG of each at
 * the cap's resolution. Images that cannot be measured are skipped, so the results are a
 * subsequence of `document.images` -- which is why `applyImageReplacements` matches on the
 * index recorded here rather than on position in the returned list.
 */
export function measureImages(MAX: number): string {
  const report: ImageMeasurement[] = [];
  for (let i = 0; i < document.images.length; i++) {
    const img = document.images[i];
    if (!img || !img.naturalWidth) continue;
    const wIn = img.getBoundingClientRect().width / 96;
    if (!wIn) continue;
    const ppi = img.naturalWidth / wIn;
    if (ppi <= MAX) continue;
    const targetW = Math.max(1, Math.round(wIn * MAX));
    const scale = targetW / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    report.push({
      at: i,
      from: img.naturalWidth,
      to: canvas.width,
      ppi: Math.round(ppi),
      url: canvas.toDataURL('image/jpeg', 0.9),
    });
  }
  return JSON.stringify(report);
}

/** Put each replacement on the image it was measured from, and nothing on any other. */
export function applyImageReplacements(swaps: ImageReplacement[]): boolean {
  for (const e of swaps) {
    const img = document.images[e.at];
    if (img) img.src = e.url;
  }
  return true;
}

/** A gap wide enough that a reader ends a text item rather than joining across it. */
export type WideGap = {
  /** Shortest selector that reaches the element the text sits in. */
  selector: string;
  text: string;
  /** The gap in em, against the font size in force where the text began. */
  em: number;
  /** Where the gap sits on the line, so repeats can be told apart. */
  top: number;
  /** Whether anything in the document stretches this gap. */
  cause: 'flex-gap' | 'grid-gap' | 'margin' | 'space-between' | 'table-cell' | 'unknown';
};

/**
 * Every function in this file is shipped as its own source text, so it may not call anything
 * declared out here: a call to a module-scope helper is a `ReferenceError` in the browser and
 * `undefined` back on this side, with nothing in between to notice. `tsc` cannot catch it,
 * because here the helper is perfectly in scope.
 *
 * That is not hypothetical. `wideGaps` called `shortSelector` on its first version, so the
 * probe returned nothing and the report printed its old sentence with no gaps named -- which
 * looks exactly like a document that has no wide gaps, and had eight. Helpers are therefore
 * nested inside the function that ships them, and `render` reports a probe that throws rather
 * than handing back an empty result.
 */

/**
 * The gaps between adjacent inline boxes that are wider than a reader will join across,
 * with the element each one sits in.
 *
 * The PDF measures the gaps but cannot say what produced them, so a report can tell you a
 * document has eight of them and nothing else -- which is not enough to act on when the
 * answer is a `gap` on a flex container three rules away. This walks the laid-out document
 * instead, which is the thing the CSS is written on.
 */
export function wideGaps(limitEm = 0.6): WideGap[] {
  // Nested rather than module-scope: see the note at the top of this file.
  const shortSelector = (el: Element): string => {
    if (el.id) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 3 && node.nodeType === 1; depth++) {
      let part = node.tagName.toLowerCase();
      const cls = (node.getAttribute('class') ?? '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^(?:ng|css|sc)-/.test(c))
        .slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      parts.unshift(part);
      node = node.parentElement;
      if (node && node.tagName === 'BODY') {
        parts.unshift('body');
        break;
      }
    }
    return parts.join(' > ');
  };

  // Every laid-out text run on the page, in reading order.
  //
  // The first version compared a text node's rects against each other and found nothing on
  // a real document. The gaps that matter are almost never inside one text node: they sit
  // between two elements, so the left side is the last rect of one text node and the right
  // side is the first rect of the next. Comparing within a node only ever finds the gaps a
  // single element's own wrapping produced.
  type Run = {
    left: number;
    right: number;
    top: number;
    height: number;
    el: Element;
    text: string;
  };
  const runs: Run[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    const text = node;
    node = walker.nextNode();
    const parent = text.parentElement;
    if (!parent || /^(?:SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
    if (!text.nodeValue || !text.nodeValue.trim()) continue;
    // An element that is not laid out on screen, such as a print-only backdrop hidden with
    // display:none, has no rects and contributes nothing.
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0)
        runs.push({
          left: r.left,
          right: r.right,
          top: r.top,
          height: r.height,
          el: parent,
          text: (text.nodeValue ?? '').trim().slice(0, 40),
        });
    }
    range.detach?.();
  }

  // Reading order: line by line, left to right within a line.
  runs.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));

  const found = new Map<string, WideGap>();
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!;
    const cur = runs[i]!;
    // A run lower down is the next line. The space between lines is a paragraph, not a gap
    // a reader would draw a highlight box for, and counting it would bury the real ones.
    if (Math.abs(cur.top - prev.top) > Math.max(2, prev.height / 2)) continue;
    if (prev.el === cur.el) continue;
    const gap = cur.left - prev.right;
    if (gap <= 0) continue;

    const size = parseFloat(getComputedStyle(cur.el).fontSize) || 16;
    const em = gap / size;
    if (em <= limitEm) continue;

    // The gap belongs to whatever separates the two. The nearest ancestor that lays out in
    // columns is usually the answer, but not always: `.divider { margin: 0 4px }` puts the
    // space on the element itself, and an ancestor walk that stops at the first flex row
    // never sees it. The first version took `parentElement.querySelector('*')`, which is the
    // first child element and has nothing to do with the gap -- it reported `unknown` for a
    // flex row with a gap set, which is the one case the feature exists to name.
    const prevStyle = getComputedStyle(prev.el);
    const curStyle = getComputedStyle(cur.el);
    const ownMargin =
      (parseFloat(prevStyle.marginRight) || 0) + (parseFloat(curStyle.marginLeft) || 0);

    let container: Element = prev.el;
    let spaced = false;
    for (let n = prev.el.parentElement; n; n = n.parentElement) {
      const d = getComputedStyle(n).display;
      if (d.includes('flex') || d.includes('grid') || /^(?:TD|TH)$/.test(n.tagName)) {
        container = n;
        spaced = /space-(?:between|around|evenly)/.test(getComputedStyle(n).justifyContent);
        break;
      }
      if (n.tagName === 'BODY') break;
    }
    const style = getComputedStyle(container);
    const display = style.display;
    const columnGap = parseFloat(style.columnGap || '0') || 0;
    const cause: WideGap['cause'] = /^(?:TD|TH)$/.test(container.tagName)
      ? 'table-cell'
      : spaced
        ? 'space-between'
        : ownMargin > 0.5
          ? 'margin'
          : display.includes('grid')
            ? columnGap > 0
              ? 'grid-gap'
              : 'unknown'
            : display.includes('flex')
              ? columnGap > 0
                ? 'flex-gap'
                : 'unknown'
              : 'unknown';

    const key = `${cause}:${shortSelector(cur.el)}:${Math.round(cur.top / 8)}`;
    if (found.has(key)) continue;
    found.set(key, {
      selector: `${shortSelector(prev.el)} -> ${shortSelector(cur.el)}`,
      text: cur.text,
      em: Math.round(em * 100) / 100,
      top: Math.round(cur.top),
      cause,
    });
  }
  return [...found.values()].sort((a, b) => b.em - a.em).slice(0, 20);
}
