import { dictCode, insertIntoDict, join, LATIN1, structElementsInOrder, trySplit, type Obj, type Parts } from "./pdfparts.ts";
import { pdfValue } from "./meta.ts";

export const LINK_DESC_JS = `(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text) {
      const img = a.querySelector('img[alt]');
      text = img ? (img.getAttribute('alt') || '').trim() : '';
    }
    if (!text) {
      try { text = new URL(a.getAttribute('href'), document.baseURI).href; } catch { text = a.getAttribute('href') || ''; }
    }
    out.push(text);
  }
  return JSON.stringify(out);
})()`;

export function parseLinkDescs(returned: unknown): string[] | null {
  if (typeof returned !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(returned);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  for (const v of value) if (typeof v !== "string") return null;
  return value as string[];
}

export function linkOrder(parts: Parts): number[] {
  return structElementsInOrder(parts, "Link");
}

export function linkAnnotations(parts: Parts, linkNum: number): number[] {
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const link = byNum.get(linkNum);
  if (!link) return [];
  const text = dictCode(link);
  const out: number[] = [];
  for (const m of text.matchAll(/<<([\s\S]*?)>>/g)) {
    const body = m[1]!;
    if (!/\/Type\s*\/OBJR\b/.test(body)) continue;
    const obj = /\/Obj\s+(\d+) 0 R/.exec(body)?.[1];
    if (obj) out.push(Number(obj));
  }
  return out;
}

export function fixLinkDescs(pdf: Uint8Array, descs: string[]): Uint8Array {
  if (descs.length === 0) return pdf;
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const links = linkOrder(parts);
  if (links.length !== descs.length) return pdf;

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  let changed = 0;
  links.forEach((linkNum, index) => {
    const desc = (descs[index] ?? "").trim();
    if (!desc) return;
    for (const annotNum of linkAnnotations(parts, linkNum)) {
      const obj = byNum.get(annotNum);
      if (!obj) continue;
      const text = obj.bytes.toString(LATIN1);
      if (/\/Subtype\s*\/Link\b/.test(text) === false) continue;
      if (/\/Contents\b/.test(dictCode(obj))) continue;
      const next = Buffer.from(insertIntoDict(text, `/Contents ${pdfValue(desc)}`), LATIN1);

      if (next.equals(obj.bytes)) continue;
      obj.bytes = next;
      changed++;
    }
  });
  if (changed === 0) return pdf;
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}
