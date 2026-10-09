/**
 * Give a link annotation the description the document already contains.
 *
 * Chromium writes the annotation without a /Contents, and clause 7.18.5 of PDF/UA-1
 * fails every link in the document because of it. Measured: /Contents is absent from
 * every link annotation on every document tried, including a link whose text is a
 * perfectly good description.
 *
 * The interesting part is the key. A link is two objects -- a Link structure element
 * and a /Link annotation -- and their object numbers have no relation to each other,
 * so pairing them by position is not safe. Measured counts disagree: a link wrapping
 * an image produced one Link element and two annotations, and a document with an
 * external and an internal link produced two elements and one annotation.
 *
 * PDF provides the real key and Chromium fills it in: the Link element's /K is an
 * array holding an inline object reference dictionary, `<</Type /OBJR /Obj 5 0 R
 * /Pg 2 0 R>>`, and that /Obj is the annotation. So the annotation is found by
 * following the reference rather than by counting, and one Link element can name two
 * annotations without anything going wrong.
 *
 * /Contents goes on the annotation, not the structure element. Clause 7.18.5 is
 * checked against the annotation; 7.18.1 accepts either the annotation's /Contents or
 * an /Alt on the enclosing element.
 */
import { dictOf, insertIntoDict, join, LATIN1, structElementsInOrder, trySplit, type Obj, type Parts } from "./pdfparts.ts";
import { pdfValue } from "./meta.ts";

/**
 * The description of every link in the document, in document order.
 *
 * The visible text, because that is what the author wrote for a reader. A link whose
 * text is only an image takes that image's alt, and a link with neither falls back to
 * its own address -- a URL is a poor description but an absent one is silence.
 *
 * Returns null when the document is shaped in a way that makes the correspondence
 * untrustworthy, which is better than a list that would put the wrong text on the
 * wrong link: these are read aloud.
 */
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

/** Parse what LINK_DESC_JS returned. Anything unexpected yields null: skip the repair. */
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

/** Link structure elements in document order. */
export function linkOrder(parts: Parts): number[] {
  return structElementsInOrder(parts, "Link");
}

/**
 * The annotation object numbers a Link structure element names.
 *
 * Read from the inline object reference dictionaries in its /K. Only /Obj inside a
 * dict that declares /Type /OBJR counts: a /K array also holds the MCID references
 * that name the marked content, and those are content items, not annotations. Taking
 * every number in the array would put a description on the page's content streams.
 */
export function linkAnnotations(parts: Parts, linkNum: number): number[] {
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const link = byNum.get(linkNum);
  if (!link) return [];
  const text = dictOf(link);
  const out: number[] = [];
  for (const m of text.matchAll(/<<([\s\S]*?)>>/g)) {
    const body = m[1]!;
    if (!/\/Type\s*\/OBJR\b/.test(body)) continue;
    const obj = /\/Obj\s+(\d+) 0 R/.exec(body)?.[1];
    if (obj) out.push(Number(obj));
  }
  return out;
}

/**
 * Attach `/Contents` to every link annotation, following the structure element's own
 * reference to it.
 *
 * Returns the input unchanged when the description list and the Link element list do
 * not line up one for one. An annotation that already has a /Contents is left alone,
 * which keeps the repair idempotent.
 */
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
      if (/\/Contents\b/.test(dictOf(obj))) continue;
      obj.bytes = Buffer.from(insertIntoDict(text, `/Contents ${pdfValue(desc)}`), LATIN1);
      changed++;
    }
  });
  if (changed === 0) return pdf;
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}

/** How many links went undescribed, for a finding. */
export function undescribedLinks(pdf: Uint8Array, descs: string[]): number {
  const parts = trySplit(pdf);
  if (!parts) return 0;
  return linkOrder(parts).filter((_, i) => !(descs[i] ?? "").trim()).length;
}