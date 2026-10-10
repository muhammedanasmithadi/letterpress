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

function bodyOf(raw: string, num: string): string | undefined {
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

export function declaredPageSize(html: string): string | null {
  return declaredPageProp(html, 'size');
}

export function declaredPageMargin(html: string): string | null {
  return declaredPageProp(html, 'margin');
}

export function pageRules(html: string): string[] {
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, ' ');

  return [...withoutComments.matchAll(/@page[^{]*\{[^}]*\}/gi)].map((m) => m[0]);
}
