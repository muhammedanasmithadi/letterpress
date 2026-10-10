import {
  dictCode,
  join,
  kidsOf,
  LATIN1,
  structElementsInOrder,
  trySplit,
  type Obj,
  type Parts,
} from './pdfparts.ts';

function hasDescription(text: string): boolean {
  return /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.test(text);
}

function rolePattern(role: string): RegExp {
  return new RegExp(`/S(\\s*)/${role}\\b`);
}

export function redundantFigures(parts: Parts): number[] {
  const byNum = new Map<number, string>(parts.objs.map((o) => [o.num, dictCode(o)]));
  const figures = structElementsInOrder(parts, 'Figure');
  if (figures.length === 0) return [];

  const described = new Set<number>();
  for (const n of figures) if (hasDescription(byNum.get(n) ?? '')) described.add(n);

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
    const text = byNum.get(n) ?? '';
    if (hasDescription(text)) continue;
    guard.clear();
    if (hasDescribedDescendant(n, 0)) out.push(n);
  }
  return out;
}

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
    if (!rolePattern('Figure').test(text)) continue;
    obj.bytes = Buffer.from(text.replace(rolePattern('Figure'), '/S$1/Div'), LATIN1);
    changed++;
  }
  if (changed === 0) return pdf;
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}

export function redundantFigureCount(pdf: Uint8Array): number {
  const parts = trySplit(pdf);
  return parts ? redundantFigures(parts).length : 0;
}
