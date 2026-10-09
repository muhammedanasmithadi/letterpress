/**
 * Re-tag a Figure that is only a container.
 *
 * `<figure><img alt="…"><figcaption>…</figcaption></figure>` produces two Figure
 * structure elements. Chromium tags the image as a Figure carrying the description, and
 * tags the `<figure>` itself as a Figure carrying nothing:
 *
 *   51 Figure   no /Alt                <- the <figure> element
 *     52 Figure  Alt=(a bar chart)     <- the <img>
 *     53 Caption -> NonStruct          <- the <figcaption>
 *
 * Clause 7.3 of PDF/UA-1 requires every Figure to carry a description or replacement
 * text, so the outer element fails it. Re-tagging it `Div` closes that: `Div` is the
 * grouping element ISO 32000-1 defines for exactly this, and the image keeps its own
 * Figure and its own description.
 *
 * Three alternatives were considered and rejected:
 *
 *   Copying the description onto the outer element also passes, and a screen reader
 *   then announces the same sentence twice.
 *
 *   Leaving it fails 7.3 on every document using `<figure>`, which is the ordinary way
 *   to write one.
 *
 *   Inventing a description is not available, and would be wrong if it were.
 *
 * Nothing here touches a content stream. The change is one value of one key in one
 * dictionary, so `verify()`'s byte-identity guarantee on content streams holds unchanged.
 *
 * The conditions are deliberately narrow. An element is re-tagged only when it has no
 * description of its own AND a descendant Figure does. Anything else is left alone,
 * because stripping a Figure role from something that has no described child would
 * remove semantics rather than correct them.
 */
import { dictCode, join, kidsOf, LATIN1, structElementsInOrder, trySplit, type Obj, type Parts } from "./pdfparts.ts";

/** A structure element's description, if it has one. */
function hasDescription(text: string): boolean {
  return /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.test(text);
}

/** `/S` followed by a role name, as opposed to `/Subtype`, `/StructElem` and the like. */
function rolePattern(role: string): RegExp {
  return new RegExp(`/S(\\s*)/${role}\\b`);
}

/**
 * Object numbers of the Figures to re-tag, in tree order.
 *
 * Exported so a test can assert the decision without inspecting the bytes, and so a
 * caller can report what changed.
 */
export function redundantFigures(parts: Parts): number[] {
  const byNum = new Map<number, string>(parts.objs.map((o) => [o.num, dictCode(o)]));
  const figures = structElementsInOrder(parts, "Figure");
  if (figures.length === 0) return [];

  const described = new Set<number>();
  for (const n of figures) if (hasDescription(byNum.get(n) ?? "")) described.add(n);

  // A Figure qualifies when it has none of its own and something below it does. Walking
  // down from each undescribed Figure rather than up from each described one keeps the
  // test local, and a cycle guard is warranted because the tree is a graph in principle.
  const out: number[] = [];
  const guard = new Set<number>();
  const hasDescribedDescendant = (num: number, depth: number): boolean => {
    if (depth > 64 || guard.has(num)) return false;
    guard.add(num);
    const text = byNum.get(num);
    if (text === undefined) return false;
    for (const child of kidsOf(text)) {
      if (described.has(child)) return true;
      if (hasDescribedDescendant(child, depth + 1)) return true;
    }
    return false;
  };

  for (const n of figures) {
    const text = byNum.get(n) ?? "";
    if (hasDescription(text)) continue;
    guard.clear();
    if (hasDescribedDescendant(n, 0)) out.push(n);
  }
  return out;
}

/**
 * Re-tag redundant Figures as Div.
 *
 * Returns the input unchanged when there is nothing to do, which also makes it
 * idempotent: a second pass finds no `/S /Figure` left to rewrite.
 */
export function fixRedundantFigures(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;
  const targets = redundantFigures(parts);
  if (targets.length === 0) return pdf;

  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  let changed = 0;
  for (const num of targets) {
    const obj = byNum.get(num);
    if (!obj) continue;
    const text = obj.bytes.toString(LATIN1);
    if (!rolePattern("Figure").test(text)) continue;
    obj.bytes = Buffer.from(text.replace(rolePattern("Figure"), "/S$1/Div"), LATIN1);
    changed++;
  }
  if (changed === 0) return pdf;
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}

/** How many Figures were re-tagged, so the caller can say so rather than change silently. */
export function redundantFigureCount(pdf: Uint8Array): number {
  const parts = trySplit(pdf);
  return parts ? redundantFigures(parts).length : 0;
}
