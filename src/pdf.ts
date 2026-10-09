const dec = new TextDecoder("latin1");

export type PdfInfo = {
  bytes: number;
  header: string;
  producer: string | null;
  /** Page count, resolved from the document catalog's page tree. */
  pages: number;
  /** Every distinct MediaBox, in points. */
  mediaBoxes: string[];
  /** MediaBox per page, in page order. Same length as `pages`. */
  pageSizes: string[];
  /** Count of image XObjects. Vector output has none. */
  imageObjects: number;
  fontFiles: number;
  type0Fonts: number;
  toUnicodeMaps: number;
  tagged: boolean;
  outlineTitles: string[];
};

/**
 * Resolve the page count through trailer -> catalog -> page tree root.
 *
 * Taking the first "/Count" in byte order reads an interior node of the tree,
 * which is how this reported 8 pages for every document of 9 or more. Interior
 * nodes hold the size of their own subtree, so the root must be followed by
 * object number. Falling back to the largest Count seen is still correct,
 * because no interior node can exceed the total.
 */
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

/** The body of an indirect object, e.g. "12 0 obj ... endobj". */
function bodyOf(raw: string, num: string): string | undefined {
  const start = raw.search(new RegExp(`(?:^|[^0-9])${num}\\s+0\\s+obj`));
  if (start < 0) return undefined;
  const end = raw.indexOf("endobj", start);
  return raw.slice(start, end < 0 ? undefined : end);
}

export function inspect(pdf: Uint8Array): PdfInfo {
  const raw = dec.decode(pdf);
  const all = (re: RegExp) => [...raw.matchAll(re)].map((m) => m[0]);

  const pages = pageCount(raw);

  // /Type /Page objects appear in page order, so their MediaBoxes do too.
  const pageSizes: string[] = [];
  for (const m of raw.matchAll(/\/Type\s*\/Page[^s][\s\S]{0,400}?/g)) {
    const box = m[0].match(/\/MediaBox\s*\[[^\]]*\]/);
    pageSizes.push(box ? box[0] : "");
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

/**
 * A declaration from the first `@page` rule that carries it.
 *
 * One function rather than one per property, because the two callers were the same
 * loop over `pageRules` differing only in the property name, and the normalisation at
 * the end is the part that has to agree.
 */
function declaredPageProp(html: string, prop: string): string | null {
  for (const rule of pageRules(html)) {
    const m = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, "i").exec(rule);
    if (m) return m[1]!.trim().replace(/\s+/g, " ").toLowerCase();
  }
  return null;
}

/** True when the PDF declares a page size in CSS via an @page size rule. */
export function declaredPageSize(html: string): string | null {
  return declaredPageProp(html, "size");
}

/** The declared @page margin, if any. */
export function declaredPageMargin(html: string): string | null {
  return declaredPageProp(html, "margin");
}

/**
 * Every @page rule in the document, with CSS comments stripped first.
 *
 * A commented-out `@page { size: A5 }` is not a declaration, but reading it as
 * one made the tool report a landscape PDF as portrait. Stripping comments
 * before matching is what keeps the reported conflict real.
 */
export function pageRules(html: string): string[] {
  const withoutComments = html
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // a <style> or <script> body is not markup, but @page inside one is still
    // live css; only comment stripping applies here.
    ;
  return [...withoutComments.matchAll(/@page[^{]*\{[^}]*\}/gi)].map((m) => m[0]);
}