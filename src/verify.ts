/**
 * Verification of a repaired PDF, and the reason this module exists.
 *
 * The repair layer's failure mode is silence. Measured: 200 garbage bytes
 * injected into a content stream of a shipped PDF pass every structural check
 * available — the cross-reference table resolves, every indirect reference
 * resolves, and every stream's `/Length` matches its payload. A file that is
 * structurally perfect and visually wrong is indistinguishable from a good one at
 * runtime, and that is why every defect that came through the layer was a repair
 * that quietly did the wrong thing rather than a repair that failed loudly.
 *
 * So the gate checks four things and the fourth is the one that earns its place:
 *
 *   1. exactly one `startxref`, pointing at a table
 *   2. every in-use cross-reference entry points at its own object header
 *   3. every indirect reference resolves to a defined object
 *   4. every page's content stream is byte-identical to what Chromium emitted
 *
 * The fourth is the content check. No repair in this layer is supposed to move a
 * glyph: font descriptors, ToUnicode CMaps, the information dictionary and the
 * catalog are all outside the content stream. So a repair that changes a content
 * payload has changed something it had no business changing, and the glyphs are
 * in the wrong place. Comparing the *compressed* payload is sufficient and
 * avoids decompressing every page, which matters at 400 pages.
 *
 * Structure alone cannot find this. A `TJ` merge that misplaced 192 of 2,613
 * glyphs produced a file that passed all three structural checks and rendered 8%
 * wrong.
 */

import { dictCode, maskStrings, streamDict, streamRange, trySplit, type Obj } from "./pdfparts.ts";

const LATIN1 = "latin1" as BufferEncoding;

export type Verification = { ok: boolean; failures: string[] };

/** The objects a PDF defines, by number. */
function index(pdf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  const parts = trySplit(pdf);
  if (parts) for (const o of parts.objs) out.set(o.num, o.bytes.toString(LATIN1));
  return out;
}

/**
 * The payload of every stream a page names as its `/Contents`, in document order.
 *
 * Taken as raw bytes between `stream` and `endstream`, so the comparison needs no
 * decompression and cannot be fooled by a payload that inflates differently.
 */
export function contentPayloads(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) return [];
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const out: string[] = [];
  for (const o of parts.objs) {
    if (!/\/Type\s*\/Page\b/.test(o.bytes.toString(LATIN1))) continue;
    for (const m of o.bytes.toString(LATIN1).matchAll(/\/Contents\s*(?:(\d+)\s+0\s+R|\[([^\]]*)\])/g)) {
      const nums: number[] = m[1]
        ? [Number(m[1])]
        : [...(m[2] ?? "").matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
      for (const n of nums) {
        const target = byNum.get(n);
        if (!target) continue;
        const range = streamRange(target.bytes);
        if (!range) continue;
        out.push(target.bytes.toString(LATIN1).slice(range.start, range.end));
      }
    }
  }
  return out;
}

/**
 * Whether a PDF is structurally whole, and whether its content survived.
 *
 * `original` is the file as Chromium produced it. Passing it is what turns three
 * structural checks into four, because it makes "did the repair move anything"
 * a question with an answer.
 */
export function verify(pdf: Uint8Array, original?: Uint8Array): Verification {
  const failures: string[] = [];
  const text = Buffer.from(pdf).toString(LATIN1);

  // 1. One pointer, pointing at the table.
  const pointers = text.match(/startxref/g);
  if (!pointers) {
    failures.push("no startxref");
  } else if (pointers.length > 1) {
    failures.push(`${pointers.length} startxref lines: readers disagree which one is current`);
  }
  const sx = Number(text.match(/startxref\s+(\d+)/)?.[1] ?? -1);
  let size = -1;
  if (sx < 0 || text.slice(sx, sx + 4) !== "xref") {
    failures.push("startxref does not point at a cross-reference table");
  } else {
    const header = text.slice(sx).match(/^xref\s+0\s+(\d+)\s/);
    if (!header) {
      failures.push("cross-reference table has no subsection header");
    } else {
      size = Number(header[1]);
      const table = text.slice(sx + header[0].length);
      // 2. Every in-use entry points at its own object header.
      for (let n = 1; n < size; n++) {
        const entry = table.slice(n * 20, n * 20 + 20);
        if (entry.length < 20) {
          failures.push(`cross-reference entry ${n} is truncated`);
          break;
        }
        if (entry[17] !== "n") continue;
        const off = Number(entry.slice(0, 10));
        if (!text.startsWith(`${n} 0 obj`, off)) {
          failures.push(`cross-reference entry ${n} points at the wrong object`);
          break;
        }
      }
      if (!text.includes(`/Size ${size}`)) {
        failures.push(`trailer /Size disagrees with the table's ${size} entries`);
      }
    }
  }

  // 3. Every indirect reference resolves.
  //
  // Scanned against the file with literal strings masked out. A literal string is
  // arbitrary text sitting inside a dictionary, so a document whose alt text read "see
  // object 999 0 R" produced a reference to an object that does not exist -- and since
  // this check is what rejects a repair, every gated repair was discarded and the
  // document shipped with no author and no XMP packet. Measured before the masking.
  //
  // Scanned over the code only -- each object's dictionary and the trailer, with literal
  // strings masked and stream payloads left out entirely. A payload is data, so a
  // reference-shaped string inside one is not a reference: the XMP packet is XML, and a
  // document titled "object 999 0 R" had the title written into the packet and then
  // rejected for naming an object that does not exist. Masking literals alone was not
  // enough for that one.
  const parts = trySplit(pdf);
  const defined = index(pdf);
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)) defined.set(Number(m[1]), "");
  const codeRegions: string[] = parts
    ? [...parts.objs.map((o) => dictCode(o)), maskStrings(parts.trailer.toString(LATIN1))]
    : [maskStrings(text)];
  for (const region of codeRegions) {
    for (const m of region.matchAll(/(?:^|[^0-9])(\d+) 0 R\b/g)) {
      if (!defined.has(Number(m[1]))) {
        failures.push(`a reference to object ${m[1]} that does not exist`);
        break;
      }
    }
    if (failures.some((f) => f.startsWith("a reference to"))) break;
  }

  // Every stream's declared length must match what follows it, or a reader stops
  // at the wrong offset and the rest of the file is noise.
  for (const o of parts?.objs ?? []) {
    // The dictionary half, taken through streamDict rather than by splitting on the
    // substring "stream". A dictionary carrying `/Producer (upstream)` before its /Length
    // was cut there, so the length check was skipped entirely and a payload of the wrong
    // size passed -- and /Length is the check that would catch a repair that resized one.
    const len = streamDict(o).match(/\/Length\s+(\d+)/);
    if (!len) continue;
    const range = streamRange(o.bytes);
    if (!range) {
      failures.push(`object ${o.num} has a stream with no endstream`);
      continue;
    }
    const payload = range.end - range.start;
    if (payload !== Number(len[1])) {
      failures.push(`object ${o.num} declares /Length ${len[1]} but carries ${payload} bytes`);
      break;
    }
  }

  // 4. The content survived.
  if (original) {
    const before = contentPayloads(original);
    const after = contentPayloads(pdf);
    if (before.length !== after.length) {
      failures.push(`the document has ${after.length} content streams where it had ${before.length}`);
    } else {
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) {
          failures.push(`content stream ${i + 1} was rewritten, and no repair in this layer may do that`);
          break;
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Run `repair` and keep its output only if the file is still whole.
 *
 * Falling back to the un-repaired bytes turns a silent corruption into a silent
 * non-repair, which is a strictly better failure: the PDF is then Chromium's own,
 * with its font descriptors and its ligature codepoints, rather than a file whose
 * glyphs are in the wrong places. The alternative — shipping it — is what every
 * defect so far did.
 */
export function repairOrKeep(
  original: Uint8Array,
  repair: (pdf: Uint8Array) => Uint8Array,
): { pdf: Uint8Array; applied: boolean; failures: string[] } {
  let candidate: Uint8Array;
  try {
    candidate = repair(original);
  } catch (e) {
    return { pdf: original, applied: false, failures: [`the repair threw: ${e instanceof Error ? e.message : String(e)}`] };
  }
  // An unchanged result is not a repair and does not need verifying.
  if (candidate.length === original.length && candidate.every((v, i) => v === original[i])) {
    return { pdf: original, applied: false, failures: [] };
  }
  const result = verify(candidate, original);
  if (!result.ok) return { pdf: original, applied: false, failures: result.failures };
  return { pdf: candidate, applied: true, failures: [] };
}