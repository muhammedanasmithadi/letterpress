import {
  dictCode,
  dictOf,
  maskStrings,
  streamDict,
  streamRange,
  trySplit,
  type Obj,
  type Parts,
} from './pdfparts.ts';

const LATIN1 = 'latin1' as BufferEncoding;

type Verification = { ok: boolean; failures: string[] };

function index(parts: Parts | undefined): Set<number> {
  const out = new Set<number>();
  if (parts) for (const o of parts.objs) out.add(o.num);
  return out;
}

export function contentPayloads(pdf: Uint8Array, parts?: Parts): string[] {
  const split = parts ?? trySplit(pdf);
  if (!split) return [];
  const byNum = new Map<number, Obj>(split.objs.map((o) => [o.num, o]));
  const out: string[] = [];
  for (const o of split.objs) {
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

function checkMarkers(text: string, failures: string[]): void {
  const pointers = text.match(/startxref/g);
  if (!pointers) {
    failures.push('no startxref');
  } else if (pointers.length > 1) {
    failures.push(`${pointers.length} startxref lines: readers disagree which one is current`);
  }
  const eofs = text.match(/%%EOF/g);
  if (!eofs) failures.push('no %%EOF');
  else if (eofs.length > 1) failures.push(`${eofs.length} %%EOF markers`);
}

function checkCrossRef(text: string, failures: string[]): void {
  const sx = Number(text.match(/startxref\s+(\d+)/)?.[1] ?? -1);
  if (sx < 0 || text.slice(sx, sx + 4) !== 'xref') {
    failures.push('startxref does not point at a cross-reference table');
    return;
  }
  const header = text.slice(sx).match(/^xref\s+0\s+(\d+)\s/);
  if (!header) {
    failures.push('cross-reference table has no subsection header');
    return;
  }
  const size = Number(header[1]);
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

function checkReferences(
  parts: ReturnType<typeof trySplit>,
  text: string,
  codes: string[],
  failures: string[],
): void {
  const defined = index(parts);
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)) defined.add(Number(m[1]));
  const codeRegions: string[] = parts
    ? [...codes, maskStrings(parts.trailer.toString(LATIN1))]
    : [maskStrings(text)];
  for (const region of codeRegions) {
    for (const m of region.matchAll(/(?:^|[^0-9])(\d+) \d+ R\b/g)) {
      if (!defined.has(Number(m[1]))) {
        failures.push(`a reference to object ${m[1]} that does not exist`);
        break;
      }
    }
    if (failures.some((f) => f.startsWith('a reference to'))) break;
  }
}

function checkStreamLength(
  o: Obj,
  byNum: Map<number, Obj>,
  failures: string[],
): 'continue' | 'break' {
  const length = streamDict(o).match(/\/Length\s+(\d+)(\s+0\s+R)?/);
  if (!length) return 'continue';
  if (length[2]) {
    const target = byNum.get(Number(length[1]));
    if (!target) {
      failures.push(`object ${o.num} declares /Length ${length[1]} 0 R, which is not in the file`);
      return 'break';
    }
    const value = dictOf(target)
      .replace(/^\s*\d+\s+\d+\s+obj\s*/i, '')
      .replace(/\s*endobj\s*$/i, '')
      .trim();
    if (!/^\d+$/.test(value)) {
      failures.push(`object ${o.num} points /Length at object ${length[1]}, which is not a number`);
      return 'break';
    }
    const range = streamRange(o.bytes);
    if (!range) {
      failures.push(`object ${o.num} has a stream with no endstream`);
      return 'break';
    }
    const payload = range.end - range.start;
    if (payload !== Number(value)) {
      failures.push(
        `object ${o.num} declares /Length ${value} via object ${length[1]} but carries ` +
          `${payload} bytes`,
      );
      return 'break';
    }
    return 'continue';
  }
  const range = streamRange(o.bytes);
  if (!range) {
    failures.push(`object ${o.num} has a stream with no endstream`);
    return 'continue';
  }
  const payload = range.end - range.start;
  if (payload !== Number(length[1])) {
    failures.push(`object ${o.num} declares /Length ${length[1]} but carries ${payload} bytes`);
    return 'break';
  }
  return 'continue';
}

function checkObjects(
  parts: ReturnType<typeof trySplit>,
  byNum: Map<number, Obj>,
  codes: string[],
  failures: string[],
): void {
  let at = 0;
  for (const o of parts?.objs ?? []) {
    const code = codes[at++] ?? '';
    const opened = (code.match(/<</g) ?? []).length;
    const closed = (code.match(/>>/g) ?? []).length;
    if (opened !== closed) {
      failures.push(`object ${o.num} opens ${opened} dictionaries and closes ${closed}`);
      break;
    }
    if (checkStreamLength(o, byNum, failures) === 'break') break;
  }
}

function checkPreserved(
  original: Uint8Array,
  pdf: Uint8Array,
  parts: Parts | undefined,
  failures: string[],
): void {
  const before = contentPayloads(original);
  const after = contentPayloads(pdf, parts);
  if (before.length !== after.length) {
    failures.push(`the document has ${after.length} content streams where it had ${before.length}`);
    return;
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      failures.push(
        `content stream ${i + 1} was rewritten, and no repair in this layer may do that`,
      );
      break;
    }
  }
}

export function verify(pdf: Uint8Array, original?: Uint8Array): Verification {
  const failures: string[] = [];
  const text = Buffer.from(pdf).toString(LATIN1);

  checkMarkers(text, failures);
  checkCrossRef(text, failures);

  const parts = trySplit(pdf);
  const byNum = new Map<number, Obj>((parts?.objs ?? []).map((o) => [o.num, o]));
  const codes = parts ? parts.objs.map((o) => dictCode(o)) : [];
  checkReferences(parts, text, codes, failures);
  checkObjects(parts, byNum, codes, failures);
  if (original) checkPreserved(original, pdf, parts, failures);

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
