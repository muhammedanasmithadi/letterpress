import { dictCode, maskStrings, streamDict, streamRange, trySplit, type Obj } from './pdfparts.ts';

const LATIN1 = 'latin1' as BufferEncoding;

export type Verification = { ok: boolean; failures: string[] };

function index(pdf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  const parts = trySplit(pdf);
  if (parts) for (const o of parts.objs) out.set(o.num, o.bytes.toString(LATIN1));
  return out;
}

export function contentPayloads(pdf: Uint8Array): string[] {
  const parts = trySplit(pdf);
  if (!parts) return [];
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const out: string[] = [];
  for (const o of parts.objs) {
    if (!/\/Type\s*\/Page\b/.test(o.bytes.toString(LATIN1))) continue;
    for (const m of o.bytes
      .toString(LATIN1)
      .matchAll(/\/Contents\s*(?:(\d+)\s+0\s+R|\[([^\]]*)\])/g)) {
      const nums: number[] = m[1]
        ? [Number(m[1])]
        : [...(m[2] ?? '').matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
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

export function verify(pdf: Uint8Array, original?: Uint8Array): Verification {
  const failures: string[] = [];
  const text = Buffer.from(pdf).toString(LATIN1);

  const pointers = text.match(/startxref/g);
  if (!pointers) {
    failures.push('no startxref');
  } else if (pointers.length > 1) {
    failures.push(`${pointers.length} startxref lines: readers disagree which one is current`);
  }
  // A reader that reaches the end without %%EOF throws away the cross-reference table and
  // rebuilds one by scanning for object headers, which is a reconstruction, not a read. A
  // truncated write looks exactly like this, so it is a damaged file rather than a
  // tolerated one.
  const eofs = text.match(/%%EOF/g);
  if (!eofs) failures.push('no %%EOF');
  else if (eofs.length > 1) failures.push(`${eofs.length} %%EOF markers`);
  const sx = Number(text.match(/startxref\s+(\d+)/)?.[1] ?? -1);
  let size = -1;
  if (sx < 0 || text.slice(sx, sx + 4) !== 'xref') {
    failures.push('startxref does not point at a cross-reference table');
  } else {
    const header = text.slice(sx).match(/^xref\s+0\s+(\d+)\s/);
    if (!header) {
      failures.push('cross-reference table has no subsection header');
    } else {
      size = Number(header[1]);
      const table = text.slice(sx + header[0].length);

      for (let n = 1; n < size; n++) {
        const entry = table.slice(n * 20, n * 20 + 20);
        if (entry.length < 20) {
          failures.push(`cross-reference entry ${n} is truncated`);
          break;
        }
        if (entry[17] !== 'n') continue;
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

  const parts = trySplit(pdf);
  const defined = index(pdf);
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)) defined.set(Number(m[1]), '');
  const codeRegions: string[] = parts
    ? [...parts.objs.map((o) => dictCode(o)), maskStrings(parts.trailer.toString(LATIN1))]
    : [maskStrings(text)];
  for (const region of codeRegions) {
    // The generation is part of the reference and can be anything, so a match on `0 R`
    // alone leaves `9 1 R` unchecked and a dangling reference passes the gate.
    for (const m of region.matchAll(/(?:^|[^0-9])(\d+) \d+ R\b/g)) {
      if (!defined.has(Number(m[1]))) {
        failures.push(`a reference to object ${m[1]} that does not exist`);
        break;
      }
    }
    if (failures.some((f) => f.startsWith('a reference to'))) break;
  }

  for (const o of parts?.objs ?? []) {
    // A dictionary that is opened and never closed is the shape a repair that truncates
    // an object body leaves behind. Nothing downstream notices: the splitter clamps the
    // object at the next header, the writer recomputes a self-consistent cross-reference
    // table around what survived, and the result parses. Checking that every dictionary
    // balances is what makes a truncated body visible to the gate.
    const code = dictCode(o);
    const opened = (code.match(/<</g) ?? []).length;
    const closed = (code.match(/>>/g) ?? []).length;
    if (opened !== closed) {
      failures.push(`object ${o.num} opens ${opened} dictionaries and closes ${closed}`);
      break;
    }
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

  if (original) {
    const before = contentPayloads(original);
    const after = contentPayloads(pdf);
    if (before.length !== after.length) {
      failures.push(
        `the document has ${after.length} content streams where it had ${before.length}`,
      );
    } else {
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) {
          failures.push(
            `content stream ${i + 1} was rewritten, and no repair in this layer may do that`,
          );
          break;
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

export function repairOrKeep(
  original: Uint8Array,
  repair: (pdf: Uint8Array) => Uint8Array,
): { pdf: Uint8Array; applied: boolean; failures: string[] } {
  let candidate: Uint8Array;
  try {
    candidate = repair(original);
  } catch (e) {
    return {
      pdf: original,
      applied: false,
      failures: [`the repair threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (candidate.length === original.length && candidate.every((v, i) => v === original[i])) {
    return { pdf: original, applied: false, failures: [] };
  }
  const result = verify(candidate, original);
  if (!result.ok) return { pdf: original, applied: false, failures: result.failures };
  return { pdf: candidate, applied: true, failures: [] };
}
