const dec = new TextDecoder("latin1");

export type PdfInfo = {
  bytes: number;
  header: string;
  producer: string | null;
  /** Page count from the page tree, falling back to counting page objects. */
  pages: number;
  /** Every distinct MediaBox, in points. */
  mediaBoxes: string[];
  /** Count of image XObjects. Vector output has none. */
  imageObjects: number;
  fontFiles: number;
  type0Fonts: number;
  toUnicodeMaps: number;
  tagged: boolean;
  outlineTitles: string[];
};

export function inspect(pdf: Uint8Array): PdfInfo {
  const raw = dec.decode(pdf);
  const all = (re: RegExp) => [...raw.matchAll(re)].map((m) => m[0]);

  const counted = raw.match(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/s);
  const pages = counted ? Number(counted[1]) : all(/\/Type\s*\/Page[^s]/g).length;

  return {
    bytes: pdf.byteLength,
    header: raw.slice(0, 8),
    producer: raw.match(/\/Producer\s*\(([^)]*)\)/)?.[1] ?? null,
    pages,
    mediaBoxes: [...new Set(all(/\/MediaBox\s*\[[^\]]*\]/g))],
    imageObjects: all(/\/Subtype\s*\/Image/g).length,
    fontFiles: all(/\/FontFile[23]?/g).length,
    type0Fonts: all(/\/Subtype\s*\/Type0/g).length,
    toUnicodeMaps: all(/\/ToUnicode/g).length,
    tagged: /\/StructTreeRoot/.test(raw),
    outlineTitles: all(/\/Title\s*\(([^)]*)\)/g).map((t) => t.slice(8, -1)),
  };
}

/** True when the PDF declares a page size in CSS via an @page size rule. */
export function declaredPageSize(html: string): string | null {
  const rules = html.match(/@page[^{]*\{[^}]*\}/gi) ?? [];
  for (const r of rules) {
    const m = r.match(/\bsize\s*:\s*([^;}]+)/i);
    if (m) return m[1].trim().replace(/\s+/g, " ").toLowerCase();
  }
  return null;
}