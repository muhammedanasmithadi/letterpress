import type { Finding } from "./render.ts";
import type { Tab } from "./browser.ts";

/**
 * Checks that need the live document, so they run in the page and come back as
 * findings rather than as regex guesses over the source HTML.
 *
 * All of it in one evaluate: a round trip costs more than the work.
 */
const AUDIT = String.raw`
(() => {
  const out = [];
  const add = (code, severity, message, extra) =>
    out.push(Object.assign({ code, severity, message }, extra || {}));

  // ---- 1. unfilled template placeholders -------------------------------
  const braces = document.documentElement.innerHTML.match(/\{\{[#/]?\w+\}\}/g) || [];
  if (braces.length) {
    add("unfilled-placeholder", "error",
      "the document still contains " + braces.length + " template placeholder(s) such as " +
      braces.slice(0, 4).join(", ") + ". fill them, or render through --template.");
  }

  // ---- 2. a data file rendered as a document ---------------------------
  const body = document.body ? document.body.innerText.slice(0, 400) : "";
  if (/^\s*[[{]/.test(body) && document.querySelectorAll("pre").length <= 2 &&
      document.querySelectorAll("table,img,h1,h2").length === 0) {
    add("json-rendered", "error",
      "this looks like JSON or another data file, not a document. the pdf shows the " +
      "browser's data viewer. pass html or a .html path, or use --template with --data.");
  }

  // ---- 3. paged-media functions Chromium does not implement ------------
  // Chromium discards an entire 'content' declaration when it meets one of
  // these, so a table of contents built on target-counter renders as nothing,
  // silently.
  const unsupported = { "target-counter": 1, "target-text": 1, "leader(": 1, "string(": 1, "running(": 1 };
  const seenCss = {};
  const scanRules = (rules) => {
    for (const rule of rules || []) {
      // Recurse only when there is something nested. A plain style rule exposes
      // an empty but truthy cssRules for nesting support, so recursing on truth
      // alone silently skips every ordinary rule.
      if (rule.cssRules && rule.cssRules.length) { scanRules(rule.cssRules); }
      const text = rule.cssText || "";
      if (!/content|@page|::after|::before|::marker/.test(text)) continue;
      for (const name of Object.keys(unsupported)) {
        if (text.includes(name) && !seenCss[name]) {
          seenCss[name] = 1;
          add("unsupported-paged-media", "error",
            "the stylesheet uses " + name.replace("(", "()") + ", which Chromium does not " +
            "implement. it silently drops the whole content declaration, so anything that " +
            "depends on it renders as nothing: no error, no text. page numbers must come " +
            "from @page margin boxes with counter(page) instead. for a table of contents, " +
            "resolve the numbers in a second pass.");
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { scanRules(sheet.cssRules); } catch (e) { /* cross-origin sheet */ }
  }

  // ---- 4. digits at risk of bidi reordering in right-to-left text -------
  // "2026-10-03" after Arabic renders as "03-10-2026": the hyphen is a neutral
  // separator, so the number groups are ordered right to left. Each group stays
  // internally correct, which is why it looks plausible and is still wrong.
  const risky = /\d+(?:\s*[-‐‑‒–—―_−×÷]\s*\d+)+|\+\d{2,}|\d+\s+\d{2,}\s+\d{2,}/g;
  const seenRisk = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || "";
    if (!/\d/.test(text)) continue;
    const el = node.parentElement;
    if (!el) continue;
    const rtl = getComputedStyle(el).direction === "rtl" ||
                (el.closest("[dir]") || {}).dir === "rtl";
    if (!rtl) continue;
    if (el.closest("bdi,[dir='ltr'],.lat") || el.querySelector("bdi,[dir='ltr']")) continue;
    risky.lastIndex = 0;
    let m;
    while ((m = risky.exec(text)) !== null) {
      const snippet = text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 8).trim();
      const key = m[0];
      if (seenRisk.has(key)) continue;
      seenRisk.add(key);
      add("rtl-digit-run", "warn",
        "\"" + key + "\" appears in right-to-left text and will print with its groups " +
        "reversed (" + key.split(/\s*[-–—_−×÷]\s*/).reverse().join("-") + "). wrap it in " +
        "<bdi dir=\"ltr\"> or a span with direction:ltr; unicode-bidi:isolate.", { sample: snippet });
      if (seenRisk.size >= 10) break;
    }
    if (seenRisk.size >= 10) break;
  }

  // ---- 5. characters the chosen font cannot draw -----------------------
  // Compare a rendered glyph against U+FFFE, which every font maps to .notdef.
  // Identical pixels means the real character is missing too.
  const missing = new Map();
  const fonts = new Map();
  const fontWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while ((node = fontWalker.nextNode())) {
    const text = node.nodeValue || "";
    const el = node.parentElement;
    if (!el || !text) continue;
    const cs = getComputedStyle(el);
    const font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    if (!fonts.has(font)) fonts.set(font, new Set());
    const bucket = fonts.get(font);
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80 || bucket.has(ch)) continue;
      if (code >= 0xD800 && code <= 0xDFFF) continue;
      bucket.add(ch);
    }
  }
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const glyph = (font, ch) => {
    ctx.font = font;
    ctx.clearRect(0, 0, 40, 40);
    ctx.fillText(ch, 2, 30);
    return ctx.getImageData(0, 0, 40, 40).data.join(",");
  };
  for (const [font, chars] of fonts) {
    const notdef = glyph(font, "\uFFFE");
    const blank = glyph(font, " ");
    for (const ch of chars) {
      if (missing.has(ch)) continue;
      const drawn = glyph(font, ch);
      if (drawn === notdef || drawn === blank) {
        missing.set(ch, font);
      }
    }
  }
  for (const [ch, font] of missing) {
    add("missing-glyph", "warn",
      "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") +
      " (" + ch + ") has no glyph in " + font.split(" ").slice(2).join(" ") +
      " and will print as a blank box. choose a font that covers the script, " +
      "or set a font-family fallback chain.");
    if (missing.size >= 12) break;
  }

  return out;
})()
`;

export async function audit(tab: Tab, timeoutMs: number): Promise<Finding[]> {
  try {
    const res = await tab.send("Runtime.evaluate", {
      expression: AUDIT,
      returnByValue: true,
      awaitPromise: false,
    }, timeoutMs);
    const value = res?.result?.value;
    return Array.isArray(value) ? value as Finding[] : [];
  } catch {
    // An audit failure must never fail the render; the PDF is the deliverable.
    return [];
  }
}