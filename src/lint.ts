import type { Finding } from './render.ts';
import type { Tab } from './browser.ts';

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
  //
  // Deciding "is this run right-to-left" from a dir attribute alone gets both
  // directions wrong: an Arabic document with lang="ar" and no dir reverses
  // silently, while a leading strong LTR character, as in "ISO 8601:" or an
  // invoice reference, protects the number and must not be reported. The rule
  // below is the part of UAX#9 that decides this case: a number stays in
  // left-to-right order when the last strong character before it is LTR.
  // An em dash or en dash between digit groups is not the hazard a hyphen is:
  // "2019 — 2022" is a range, not a date, and it prints in the right order. Only
  // separators that Unicode treats as part of a number belong here, plus the
  // spaced-digit and signed cases that genuinely reorder in RTL.
  const risky = /\d+(?:\s*[-‐‑‒_−]\s*\d+)+|\+\d{2,}|\d[\d\s]{5,}\d|\d+\s*[-−]\s*\d*\s*(?:ريال|درهم|د\.إ)?/g;
  // The ranges below must be disjoint. An earlier version tested Latin ranges
  // first, and they overlap Arabic-Indic digits, so the digit run in "2026" was
  // classified as a strong LTR letter and every report was suppressed.
  const LATIN_STRONG = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿḀ-῿]/;
  const RTL_STRONG = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
  const STRONG = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿḀ-῿֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
  const counts = new Map();
  const samples = new Map();

  // Direction of the run, per UAX#9: the last strong character before the token
  // decides whether the numbers keep left-to-right order.
  const lastStrong = (text, upto) => {
    let last = null;
    for (const m of text.slice(0, upto).matchAll(new RegExp(STRONG.source, "g"))) {
      last = RTL_STRONG.test(m[0]) ? "rtl" : "ltr";
    }
    return last;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || "";
    if (!/\d/.test(text)) continue;
    const el = node.parentElement;
    if (!el) continue;

    // Paragraph direction is what matters, not the inline element. A date
    // already wrapped in <bdi dir="ltr"> is safe, and that is the fix this
    // finding recommends, so honouring it stops the advice re-triggering.
    //
    // Only an explicit dir attribute is trusted. The computed unicode-bidi is
    // not: Chromium reports "isolate" for every block element by default, so
    // testing it broke out of the walk on the first ancestor and concluded the
    // paragraph was left-to-right whatever it said.
    let rtl = false;
    // The loop variable is declared without a type annotation. This whole string
    // is evaluated as JavaScript in the page, and a TypeScript annotation on it
    // is a syntax error at runtime that fails silently, taking every finding
    // in this file with it.
    for (let p = el; p; p = p.parentElement) {
      const dirAttr = p.getAttribute && p.getAttribute("dir");
      if (dirAttr === "rtl") { rtl = true; break; }
      if (dirAttr === "ltr" || dirAttr === "auto") break;
      const cs = getComputedStyle(p);
      if (cs.direction === "rtl") { rtl = true; break; }
      if (cs.direction === "ltr") break;
    }
    if (!rtl) {
      // No explicit direction anywhere: fall back to the first strong
      // character, which is how a browser infers direction for the paragraph.
      const whole = (el.textContent || "").trim();
      rtl = lastStrong(whole, whole.length) === "rtl";
    }
    if (!rtl) continue;

    risky.lastIndex = 0;
    let m;
    while ((m = risky.exec(text)) !== null) {
      const before = lastStrong(text, m.index);
      // A strong LTR character before the number keeps the run left-to-right.
      if (before === "ltr") continue;
      // A document with no strong character anywhere before it is ambiguous
      // only if the token itself has no RTL context, which we already know.
      const key = m[0];
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!samples.has(key)) {
        samples.set(key, text.slice(Math.max(0, m.index - 12), m.index + key.length + 8).trim());
      }
    }
  }

  for (const [key, count] of counts) {
    add("rtl-digit-run", "warn",
      "\"" + key + "\" appears in right-to-left text" + (count > 1 ? " (" + count + " times)" : "") +
      " and will print with its groups reversed (" +
      key.split(/\s*[-–—_−×÷]\s*/).reverse().join("-") +
      "). wrap it in <bdi dir=\"ltr\"> or a span with direction:ltr; unicode-bidi:isolate.",
      { sample: samples.get(key), occurrences: count });
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
  // A zero-width joiner or variation selector occupies no advance width, so it
  // can never produce a visible box. Reporting it teaches people to ignore the
  // findings array, and &nbsp; appears in nearly every HTML file.
  // U+00A0 was here and should not be. A no-break space has no glyph in most
  // fonts but occupies exactly a space's width and prints as one, so grouping it
  // with the formatting characters made ordinary documents report a phantom
  // problem and described it as invisible, which it is not.
  const invisible = /^[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uFE0E\uFE0F]$/;
  // No cap. A truncated list that does not say so reads as "that was all of
  // them", which is how a document ends up with 12 problems and one warning.
  const shown = [...missing.entries()].filter(([ch]) => !invisible.test(ch));
  for (const [ch, font] of shown) {
    add("missing-glyph", "warn",
      "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") +
      " (" + ch + ") has no glyph anywhere in the font stack " +
      font.split(" ").slice(2).join(" ") +
      " and will print as a blank box.");
  }
  const skipped = missing.size - shown.length;
  if (skipped > 0) {
    add("glyphs-skipped", "info",
      skipped + " further character(s) with no glyph are invisible formatting characters, " +
      "which occupy no space and print nothing, so they are not listed.");
  }

  return out;
})()
`;

export async function audit(tab: Tab, timeoutMs: number): Promise<Finding[]> {
  try {
    const res = await tab.send(
      'Runtime.evaluate',
      {
        expression: AUDIT,
        returnByValue: true,
        awaitPromise: false,
      },
      timeoutMs,
    );
    const value = res?.result?.value;
    if (!Array.isArray(value)) {
      return [
        {
          code: 'audit-failed',
          severity: 'warn',
          message:
            'the document checks could not run, so no layout, text or font findings are available. this is a bug in letterpress, not in the document.',
        },
      ];
    }
    return value as Finding[];
  } catch (e) {
    return [
      {
        code: 'audit-failed',
        severity: 'warn',
        message: `the document checks could not run, so no layout, text or font findings are available: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
}
