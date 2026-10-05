/**
 * Give a Figure structure element the description the document already contains.
 *
 * Chromium drops `<img alt>` on the floor. Measured across ten forms: `alt`,
 * `title`, `aria-label`, `role="img"` and `role="figure"` on the `<img>` itself
 * produce no Figure element and no `/Alt`. Only `<svg role="img" aria-label>`, and
 * generic containers carrying `role="img"` or `role="figure"` with an `aria-label`,
 * come through -- and a container that *wraps* an `<img>` does not, so there is no
 * attribute combination that gets an `<img>` described.
 *
 * That leaves post-processing as the only route, and it is safe here because a
 * Figure element's dictionary can be extended without touching a content stream:
 * the image is still drawn at the same place with the same glyphs, and the
 * description is added to the structure rather than to the page.
 *
 * The mapping is a depth-first walk of the structure tree, not the order objects
 * appear in the file. Those differ: a nested figure's element is written *before*
 * its parent's, so a file-order scan attributes descriptions inside out. The tree
 * walk gives document order, verified over flat, nested, doubly nested,
 * flat-then-nested and figure-inside-a-paragraph documents.
 */
import { dictOf, insertIntoDict, join, LATIN1, trySplit, type Parts } from "./pdfparts.ts";
import { pdfValue } from "./meta.ts";

/**
 * Read the description of every `<figure>` in the document, in document order.
 *
 * Run in the page before printing. Returns null when the document is shaped in a way
 * that makes the correspondence to the PDF untrustworthy, which is better than a
 * list that would attach the wrong description to the wrong figure: a screen reader
 * reads these aloud.
 *
 * A figure contributes the `alt` of the images that belong to *it*, meaning those
 * with no `<figure>` between them and the image. `querySelectorAll` is recursive, so
 * a nested figure's image counts against its parent too: measured, an outer figure
 * wrapping a nested one saw two images, so it took no description at all and the
 * outer figure -- the one a reader reaches first -- was the one left undescribed.
 * `closest('figure')` is the nearest enclosing figure, so each image is counted once.
 *
 * A figure with no image of its own, or with more than one, contributes an empty
 * string, which leaves its /Alt absent. The caption describes it, or nothing does,
 * and inventing a description is not this repair's job.
 */
export const FIGURE_ALT_JS = `(() => {
  const out = [];
  for (const fig of document.querySelectorAll('figure')) {
    const imgs = [...fig.querySelectorAll('img')].filter((img) => img.closest('figure') === fig);
    const alt = imgs.length === 1 ? (imgs[0].getAttribute('alt') || '').trim() : '';
    out.push(alt);
  }
  return JSON.stringify(out);
})()`;

/** Parse what FIGURE_ALT_JS returned. Anything unexpected yields null: skip the repair. */
export function parseFigureAlts(returned: unknown): string[] | null {
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

type Dict = { num: number; text: string };

/**
 * Structure elements with the given role, in document order, by walking the tree
 * from /StructTreeRoot.
 *
 * Shared because both repairs that match DOM nodes to structure elements need the
 * same thing, and the reason for a walk rather than a file scan is the same in both:
 * a nested element is written *before* its parent, so object order is not document
 * order.
 */
export function structElementsInOrder(parts: Parts, role: string): number[] {
  const byNum = new Map<number, Dict>();
  for (const o of parts.objs) byNum.set(o.num, { num: o.num, text: dictOf(o) });

  // The catalog holds /StructTreeRoot N 0 R. Found by scanning, because the
  // StructTreeRoot object itself does not name its own number.
  let start: number | undefined;
  for (const d of byNum.values()) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(d.text);
    if (m) { start = Number(m[1]); break; }
  }
  if (start === undefined) return [];

  // The slash is part of the pattern: the file holds `/S /Figure`, so matching
  // `/S\s*Figure` finds nothing. That mistake made every role return an empty list,
  // which looked exactly like a document with no figures of that kind.
  const want = new RegExp(`/S\\s*/${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const order: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    // A structure tree is a graph in principle, so a cycle guard is not paranoia;
    // depth is a second bound because a malformed tree could otherwise be very deep.
    if (seen.has(num) || depth > 64) return;
    seen.add(num);
    const d = byNum.get(num);
    if (!d) return;
    if (/\/Type\s*\/StructElem/.test(d.text) && want.test(d.text)) order.push(num);
    const kids = /\/K\s*(?:\[([\s\S]*?)\]|(\d+) 0 R)/.exec(d.text);
    if (!kids) return;
    const refs = kids[2] ? [Number(kids[2])] : [...(kids[1] ?? "").matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]));
    for (const ref of refs) walk(ref, depth + 1);
  };
  walk(start, 0);
  return order;
}

/** Figure structure elements in document order. */
export function figureOrder(parts: Parts): number[] {
  return structElementsInOrder(parts, "Figure");
}

/**
 * Attach `/Alt` to each Figure structure element, in document order.
 *
 * Returns the input unchanged when the two lists do not line up one for one. A
 * figure that already has an /Alt is left alone, which keeps the repair idempotent
 * and keeps a description Chromium supplied itself.
 */
export function fixFigureAlts(pdf: Uint8Array, alts: string[]): Uint8Array {
  if (alts.length === 0) return pdf;
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const figures = figureOrder(parts);
  if (figures.length !== alts.length) return pdf;

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  const wanted = figures.filter((_, i) => (alts[i] ?? "").length > 0);
  if (wanted.length === 0) return pdf;

  let changed = 0;
  for (const num of wanted) {
    const obj = byNum.get(num);
    if (!obj) continue;
    const dict = dictOf(obj);
    if (/\/Alt\b/.test(dict)) continue;
    const alt = alts[figures.indexOf(num)] ?? "";
    if (!alt) continue;
    // insertIntoDict counts `<<` nesting rather than anchoring at the last `>>`. A
    // Figure whose /K is an inline object reference dictionary ends in `>> >>`, and
    // the last pair belongs to the inner one -- so the earlier version of this wrote
    // `/Alt` inside an object reference dictionary, where it means nothing.
    obj.bytes = Buffer.from(insertIntoDict(obj.bytes.toString(LATIN1), `/Alt ${pdfValue(alt)}`), LATIN1);
    changed++;
  }
  if (changed === 0) return pdf;
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}

/** How many figures went undescribed, for a finding. Zero is good. */
export function undescribedFigures(pdf: Uint8Array, alts: string[]): number {
  const parts = trySplit(pdf);
  if (!parts) return 0;
  return figureOrder(parts).filter((num, i) => !(alts[i] ?? "").length).length;
}