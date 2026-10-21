const dec = new TextDecoder('latin1');

import { isEncrypted, trySplit, walkObjects, type Parts } from './pdfparts.ts';

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

  encrypted: boolean;
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

  const parts = trySplit(pdf);
  const pageSizes = pageSizesInOrder(parts);

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
    outlineTitles: outlineTitles(parts),
    encrypted: isEncrypted(pdf),
  };
}

function pageSizesInOrder(parts: Parts | undefined): string[] {
  if (!parts) return [];
  const isPage = (d: string) => /\/Type\s*\/Page[^s]/.test(d);

  let rootNum: number | undefined;
  for (const o of parts.objs) {
    const d = o.bytes.toString('latin1');
    if (/\/Type\s*\/Pages/.test(d) && /\/Kids/.test(d)) {
      rootNum = o.num;
      break;
    }
  }

  const order: string[] = [];
  if (rootNum !== undefined) {
    walkObjects(
      parts,
      [rootNum],
      (o) => (isPage(o.dict) ? [] : kidsIn(o.dict)),
      (o) => {
        if (isPage(o.dict)) order.push(/\/MediaBox\s*\[[^\]]*\]/.exec(o.dict)?.[0] ?? '');
      },
    );
  }

  if (order.length === 0) {
    return parts.objs
      .filter((o) => isPage(o.bytes.toString('latin1')))
      .map((o) => /\/MediaBox\s*\[[^\]]*\]/.exec(o.bytes.toString('latin1'))?.[0] ?? '');
  }
  return order;
}

function kidsIn(dict: string): number[] {
  return [...(/\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) =>
    Number(m[1]),
  );
}

function outlineTitles(parts: Parts | undefined): string[] {
  if (!parts) return [];
  let rootNum: number | undefined;
  for (const o of parts.objs) {
    if (/\/Type\s*\/Outlines/.test(o.bytes.toString('latin1'))) {
      rootNum = o.num;
      break;
    }
  }
  if (rootNum === undefined) return [];

  const out: string[] = [];
  walkObjects(
    parts,
    [rootNum],
    (o) => [firstRef(o.dict, 'First'), nextRef(o.dict)].filter((n) => n > 0),
    (o) => {
      const title = /\/Title\s*\(([^)]*)\)/.exec(o.dict)?.[1];
      if (title !== undefined) out.push(title);
    },
  );
  return out;
}

function firstRef(dict: string, name: string): number {
  return Number(new RegExp(`/${name}\\s+(\\d+) 0 R`).exec(dict)?.[1] ?? 0);
}

function nextRef(dict: string): number {
  return firstRef(dict, 'Next');
}

function declaredPageProp(html: string, prop: string): string | null {
  for (const rule of pageRules(html)) {
    const m = new RegExp(`\\b${prop}\\s*:\\s*([^;}]+)`, 'i').exec(rule);
    if (m) return m[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  return null;
}

export function stripPageSize(html: string): string {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)/gi, (whole, tag, css, end) => {
    if (!/@page/i.test(css)) return whole;
    const stripped = css.replace(
      /(@page[^{]*\{)([^}]*)(\})/gi,
      (_w: string, open: string, body: string, close: string) =>
        open +
        body
          .replace(/((?:^|;)\s*)\bsize\s*:[^;}]*/gi, '$1')
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

function landscapeSizeValue(value: string): string | null {
  const v = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!v || /\blandscape\b/.test(v)) return null;
  const dims = /^([\d.]+)\s*(mm|cm|in|pt|pc|px|q)\s+([\d.]+)\s*(mm|cm|in|pt|pc|px|q)$/.exec(v);
  if (dims) {
    const first = inchesOf(`${dims[1]}${dims[2]}`);
    const second = inchesOf(`${dims[3]}${dims[4]}`);
    if (first !== null && second !== null && first > second) return null;
    return `${dims[3]}${dims[4]} ${dims[1]}${dims[2]}`;
  }
  if (/^(a3|a4|a5|b4|b5|jis-b[45]|letter|legal|tabloid|ledger)\b/.test(v)) {
    return `${v} landscape`;
  }
  return null;
}

export function transposePageSize(html: string): string | null {
  let rewritten = '';
  const out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)/gi,
    (whole, tag, css, end) => {
      if (!/@page/i.test(css)) return whole;
      const transposed = css.replace(PAGE_RULE_OR_LITERAL, (rule: string) => {
        if (/^(\/\*|["'])/.test(rule)) return rule;
        const next = rule.replace(DECLARATION_OR_LITERAL, (decl: string) => {
          if (/^(\/\*|["'])/.test(decl)) return decl;
          const value = decl.slice(decl.indexOf(':') + 1);
          const landscape = landscapeSizeValue(value);
          if (landscape === null) return decl;
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

export function injectPageRule(html: string, declarations: string): string {
  const style = `<style>@page{${declarations}}</style>`;
  const body = /<\/body\s*>/i.exec(html);
  if (body) return html.slice(0, body.index) + style + html.slice(body.index);
  const doc = /<\/html\s*>/i.exec(html);
  if (doc) return html.slice(0, doc.index) + style + html.slice(doc.index);
  return html + style;
}

const COMMENT_OR_STRING = String.raw`\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;

const PAGE_RULE_OR_LITERAL = new RegExp(`${COMMENT_OR_STRING}|@page[^{]*\\{[^}]*\\}`, 'gi');

const DECLARATION_OR_LITERAL = new RegExp(`${COMMENT_OR_STRING}|\\bsize\\s*:[^;}]+`, 'gi');

export function declaredPageMargin(html: string): string | null {
  return declaredPageProp(html, 'margin');
}

export function pageRules(html: string): string[] {
  const withoutHtml = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const styles = [...withoutHtml.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)];

  return (
    styles
      .flatMap((m) => m[1] ?? [])
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
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

export function declaredPageOrientation(html: string): 'portrait' | 'landscape' | null {
  const declared = declaredPageSize(html);
  if (declared === null) return null;
  if (/\blandscape\b/.test(declared)) return 'landscape';
  const dims = declared.match(/([\d.]+)\s*(mm|cm|in|pt|pc|px|q)\b/gi) ?? [];
  if (dims.length < 2) return 'portrait';
  try {
    return toInches(dims[0]!) > toInches(dims[1]!) ? 'landscape' : 'portrait';
  } catch {
    return 'portrait';
  }
}

function inchesOf(len: string): number | null {
  try {
    return toInches(len);
  } catch {
    return null;
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
