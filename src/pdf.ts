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
      // Quoted strings next, for the same reason. A `@page` rule takes keywords, lengths
      // and colours; it cannot hold a string literal, so a string that looks like one is
      // text and not a declaration. This also keeps a brace inside `content: "}"` from
      // ending the match early.
      .replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .match(/@page[^{]*\{[^}]*\}/gi) ?? []
  );
}
