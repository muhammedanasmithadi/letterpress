const dec = new TextDecoder('latin1');

export type PdfInfo = {
  bytes: number;
  header: string;
  producer: string | null;

  pages: number;

  mediaBoxes: string[];

  pageSizes: string[];

  imageObjects: number;
  fontFiles: number;
  type0Fonts: number;
  toUnicodeMaps: number;
  tagged: boolean;
  outlineTitles: string[];
};

function pageCount(raw: string): number {
  const rootRef = raw.match(/\/Root\s+(\d+)\s+\d+\s+R/);
  if (rootRef) {
    const catalog = bodyOf(raw, rootRef[1]);
    const pagesRef = catalog?.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    if (pagesRef) {
      const count = bodyOf(raw, pagesRef[1])?.match(/\/Count\s+(\d+)/);
      if (count) return Number(count[1]);
    }
  }
  const counts = [...raw.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  return (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function bodyOf(raw: string, num: string | undefined): string | undefined {
  if (num === undefined) return undefined;
  const start = raw.search(new RegExp(`(?:^|[^0-9])${num}\\s+0\\s+obj`));
  if (start < 0) return undefined;
  const end = raw.indexOf('endobj', start);
  return raw.slice(start, end < 0 ? undefined : end);
}

export function inspect(pdf: Uint8Array): PdfInfo {
  const raw = dec.decode(pdf);
  const all = (re: RegExp) => [...raw.matchAll(re)].map((m) => m[0]);

  const pages = pageCount(raw);

  const pageSizes: string[] = [];
  for (const m of raw.matchAll(/\/Type\s*\/Page[^s][\s\S]{0,400}?/g)) {
    const box = m[0].match(/\/MediaBox\s*\[[^\]]*\]/);
    pageSizes.push(box ? box[0] : '');
  }

  return {
    bytes: pdf.byteLength,
    header: raw.slice(0, 8),
    producer: raw.match(/\/Producer\s*\(([^)]*)\)/)?.[1] ?? null,
    pages,
    mediaBoxes: [...new Set(all(/\/MediaBox\s*\[[^\]]*\]/g))],
    pageSizes,
    imageObjects: all(/\/Subtype\s*\/Image/g).length,
    fontFiles: all(/\/FontFile[23]?/g).length,
    type0Fonts: all(/\/Subtype\s*\/Type0/g).length,
    toUnicodeMaps: all(/\/ToUnicode/g).length,
    tagged: /\/StructTreeRoot/.test(raw),
    outlineTitles: all(/\/Title\s*\(([^)]*)\)/g).map((t) => t.slice(8, -1)),
  };
}

function declaredPageProp(html: string, prop: string): string | null {
  for (const rule of pageRules(html)) {
    const m = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, 'i').exec(rule);
    if (m) return m[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  return null;
}

/**
 * The same document with the `size` declaration taken out of every `@page` rule, so the
 * paper sent to Chromium wins over anything the page asked for.
 *
 * This walks `<style>` elements for the same reason `pageRules` does. The first version
 * replaced across the whole document and so reached into `<script>` bodies: a page builder
 * holding `"@page{size:A4}"` in a JavaScript string had that string rewritten to
 * `"@page{}"`, and a template injected at load time then carried no page size at all. The
 * replacement is inside a print pipeline whose contract is to change the paper and nothing
 * else, so leaving the script alone is the whole point.
 */
export function stripPageSize(html: string): string {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)/gi, (whole, tag, css, end) => {
    // A `<style>` with no `@page` in it is left byte-identical, so the no-op case cannot be
    // disturbed by a rewrite that was never needed.
    if (!/@page/i.test(css)) return whole;
    // `body` is matched on its own so that `^` anchors at the first declaration. Applied to
    // the whole rule instead, `@page{size:A4}` -- size first, nothing before it -- kept its
    // size, because `^` would have been the `@`.
    const stripped = css.replace(
      /(@page[^{]*\{)([^}]*)(\})/gi,
      (_w: string, open: string, body: string, close: string) =>
        open +
        body
          .replace(/((?:^|;)\s*)\bsize\s*:[^;}]*/gi, '$1')
          // The separators around the declaration that was taken out. `size` first in the
          // rule leaves the `;` that followed it leading the body; `size` last leaves the `;`
          // that preceded it trailing. Neither is a syntax error in CSS, but a page rule that
          // reads `{;margin:2cm}` is a page rule nobody wrote.
          .replace(/^\s*;\s*/, '')
          .replace(/;\s*;/g, ';')
          .replace(/\s*;\s*$/, '') +
        close,
    );
    return tag + stripped + end;
  });
}

export function declaredPageSize(html: string): string | null {
  return declaredPageProp(html, 'size');
}

/**
 * The landscape spelling of a declared `size`, or null when there is none to
 * give.
 *
 * A paper name takes the keyword (`a4` becomes `a4 landscape`) and two lengths
 * swap edges (`210mm 297mm` becomes `297mm 210mm`). A value that names no paper
 * -- `auto`, an unknown keyword -- returns null rather than a guess, because a
 * wrong rewrite would change the sheet a document chose, which is worse than
 * reporting that the request could not be honoured.
 */
function landscapeSizeValue(value: string): string | null {
  const v = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!v || /\blandscape\b/.test(v)) return null;
  const dims = /^([\d.]+)\s*(mm|cm|in|pt|pc|px|q)\s+([\d.]+)\s*(mm|cm|in|pt|pc|px|q)$/.exec(v);
  if (dims) {
    // Only ever portrait to landscape. Swapping unconditionally turned
    // `297mm 210mm` -- already landscape, and the one spelling that needs no
    // change -- into portrait. A transpose that can run backwards is not a
    // transpose.
    try {
      if (toInches(`${dims[1]}${dims[2]}`) > toInches(`${dims[3]}${dims[4]}`)) return null;
    } catch {
      // Not a unit printToPDF can take; the declaration still has an order, so
      // fall through and swap it.
    }
    return `${dims[3]}${dims[4]} ${dims[1]}${dims[2]}`;
  }
  if (/^(a3|a4|a5|b4|b5|jis-b[45]|letter|legal|tabloid|ledger)\b/.test(v)) {
    return `${v} landscape`;
  }
  return null;
}

/**
 * The same document with every declared `size` transposed to landscape, or null
 * when there is nothing that can be transposed.
 *
 * This is how a landscape request reaches a document that declares its own
 * paper. Chromium's `landscape` parameter is ignored whenever
 * `preferCSSPageSize` is set, so asking it to rotate a page it is deferring to
 * does nothing at all -- measured, the request left a portrait sheet and
 * nothing in the output said so. Transposing the declaration keeps the
 * document's own size and its own margin, which is what the flag must not
 * touch, and changes the one thing that was asked for.
 *
 * Only `<style>` elements are walked, for the same reason `stripPageSize` walks
 * only those: a `size` inside a script string is not a page declaration, and a
 * print pipeline's contract is to change the paper and nothing else.
 *
 * Comments and strings *inside* a stylesheet are skipped too, for the reason
 * `pageRules` skips them: a commented-out `@page{size:A5}` is a note about a
 * page, not a page. Rewriting one would put a landscape declaration in the
 * document's mouth that its author never wrote -- measured here, the first
 * version transposed the `size` inside a commented-out page rule as readily as
 * the live one.
 */
export function transposePageSize(html: string): string | null {
  let rewritten = '';
  const out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)/gi,
    (whole, tag, css, end) => {
      if (!/@page/i.test(css)) return whole;
      // Comments and strings are matched *before* the page rule in one pass, so
      // a rule inside either is never treated as a rule at all. Matching the rule
      // first is the trap: a commented-out `@page{size:A5}` is itself a match for
      // the rule pattern, and the measured result was that a page nobody had
      // written got a landscape declaration added to it.
      const transposed = css.replace(PAGE_RULE_OR_LITERAL, (rule: string) => {
        if (/^(\/\*|["'])/.test(rule)) return rule;
        const next = rule.replace(DECLARATION_OR_LITERAL, (decl: string) => {
          if (/^(\/\*|["'])/.test(decl)) return decl;
          const value = decl.slice(decl.indexOf(':') + 1);
          const landscape = landscapeSizeValue(value);
          if (landscape === null) return decl;
          // Whitespace that trailed the value is kept: `size: letter }` becomes
          // `size: letter landscape }` rather than closing the brace onto the
          // keyword.
          const tail = /\s*$/.exec(value)?.[0] ?? '';
          const head = decl.slice(0, decl.indexOf(':') + 1);
          return `${head} ${landscape}${tail}`;
        });
        if (next === rule) return rule;
        rewritten = 'yes';
        return next;
      });
      return transposed === css ? whole : tag + transposed + end;
    },
  );
  return rewritten === '' ? null : out;
}

const COMMENT_OR_STRING = String.raw`\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;

/** An `@page` rule, or a comment or string that must survive untouched. */
const PAGE_RULE_OR_LITERAL = new RegExp(`${COMMENT_OR_STRING}|@page[^{]*\\{[^}]*\\}`, 'gi');

/** A `size` declaration, or a comment or string that must survive untouched. */
const DECLARATION_OR_LITERAL = new RegExp(`${COMMENT_OR_STRING}|\\bsize\\s*:[^;}]+`, 'gi');

export function declaredPageMargin(html: string): string | null {
  return declaredPageProp(html, 'margin');
}

/**
 * The `@page` rules a browser would actually apply to `html`, and nothing else.
 *
 * The first version regexed the whole document. Every form of non-CSS text in a page --
 * an HTML comment, a `<script>` body, an attribute value, a CSS string literal -- matched
 * `@page { size: ... }` just as well as a stylesheet does, and each one reported a paper
 * the browser had never been told about. That is not a mislabelled finding: the caller
 * reads a non-null answer as "the document chose its own paper", turns off
 * `preferCSSPageSize`, and sends no paper to Chromium at all. Chromium's fallback is
 * Letter, so an A4 document silently printed on a Letter sheet with nothing reported. A
 * page builder that embeds a template in a script string triggers it on ordinary pages.
 *
 * Comments go first because they are the outer container: `<style>` inside an HTML comment
 * is the oldest way of toggling a stylesheet off, and the `<!--` is the only thing marking
 * it as text. The `|$` on each closing delimiter matches the browser, where an unterminated
 * comment or `<style>` runs to the end of the file rather than being ignored.
 *
 * `<template>` contents are the one case left where this can over-report: a `@page` in a
 * template is not applied, and this cannot tell. No page builder puts page geometry in a
 * template, and teaching this to parse HTML would cost more than the case is worth.
 */
export function pageRules(html: string): string[] {
  const withoutHtml = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const styles = [...withoutHtml.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)];

  return (
    styles
      .flatMap((m) => m[1] ?? [])
      .join('\n')
      // Comments before strings, for the same reason the HTML comments go first above:
      // the comment is the outer container, and an apostrophe inside one is not a
      // delimiter. Stripping the other way round, `/* it's fine */` opened a string at
      // the apostrophe and closed it at the next quote anywhere in the document, which
      // swallowed the `@page` rule whole. Nothing below could then match it, so
      // `declaredPageSize` answered null, `preferCSSPageSize` was turned off, and a
      // ledger-landscape newspaper printed on a letter sheet with no finding -- the
      // exact failure this function exists to prevent, caused by a comment that
      // mentioned nothing at all.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Quoted strings next, for the same reason. A `@page` rule takes keywords, lengths
      // and colours; it cannot hold a string literal, so a string that looks like one is
      // text and not a declaration. This also keeps a brace inside `content: "}"` from
      // ending the match early.
      .replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, '""')
      .match(/@page[^{]*\{[^}]*\}/gi) ?? []
  );
}

const ABSOLUTE_UNITS: Record<string, number> = {
  px: 96,
  in: 1,
  cm: 2.54,
  mm: 25.4,
  q: 101.6,
  pt: 72,
  pc: 6,
};

const RELATIVE_UNITS = [
  'em',
  'rem',
  'ex',
  'ch',
  'vw',
  'vh',
  'vmin',
  'vmax',
  '%',
  'lh',
  'rlh',
  'cap',
  'ic',
];

/**
 * The orientation a declared `size` asks for, or null when it names none.
 *
 * Two spellings mean landscape: the `landscape` keyword beside a paper name
 * (`a4 landscape`), and two lengths whose first is the longer edge
 * (`297mm 210mm`). Everything else is portrait, including a value too vague to
 * rewrite (`auto`), because this reads what the document declared and not what
 * a browser would eventually settle on.
 */
export function declaredPageOrientation(html: string): 'portrait' | 'landscape' | null {
  const declared = declaredPageSize(html);
  if (declared === null) return null;
  if (/\blandscape\b/.test(declared)) return 'landscape';
  const dims = declared.match(/([\d.]+)\s*(mm|cm|in|pt|pc|px|q)\b/gi) ?? [];
  if (dims.length < 2) return 'portrait';
  try {
    return toInches(dims[0]!) > toInches(dims[1]!) ? 'landscape' : 'portrait';
  } catch {
    // A size written in a unit printToPDF cannot take. The declaration is
    // still a declaration, and treating it as portrait is what the browser
    // would do with it.
    return 'portrait';
  }
}

export function toInches(len: string): number {
  const raw = len.trim();
  const m = raw.match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m)
    throw new Error(
      `margin "${len}" is not a css length: use a number with a unit, such as 15mm, 1in, 2cm, 40pt, or a bare 0.`,
    );
  const unit = (m[2] || 'px').toLowerCase();
  if (RELATIVE_UNITS.includes(unit)) {
    throw new Error(
      `margin unit "${unit}" is relative, so its size is only known after layout: ` +
        `"${unit}" resolves against a font size or a viewport, and printToPDF takes inches. ` +
        `use an absolute unit: mm, cm, in, pt, pc, px, or a bare 0.`,
    );
  }
  const factor = ABSOLUTE_UNITS[unit];
  if (factor === undefined) {
    throw new Error(`unsupported margin unit "${unit}". use mm, cm, in, pt, pc, px, or a bare 0.`);
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`margin "${len}" is not a number.`);
  }

  if (!m[2] && value !== 0) {
    throw new Error(
      `margin "${len}" needs a unit: a bare number is not a css length, only a bare 0 is. ` +
        `use px, pt, mm, cm or in.`,
    );
  }
  return value / factor;
}
