import { trySplit, join, dictOf, kidsOf, type Obj } from './pdfparts.ts';

function liNumbers(parts: NonNullable<ReturnType<typeof trySplit>>): number[] {
  const out: number[] = [];
  for (const o of parts.objs) {
    if (/\/Type\s*\/StructElem/.test(dictOf(o)) && /\/S\s*\/LI\b/.test(dictOf(o))) {
      out.push(o.num);
    }
  }
  return out;
}

function isLegalChild(kd: Obj | undefined): boolean {
  if (!kd) return false;
  const d = dictOf(kd);
  return /\/S\s*\/Lbl\b/.test(d) || /\/S\s*\/LBody\b/.test(d);
}

function partitionKids(
  kids: number[],
  byNum: Map<number, Obj>,
): { lbls: number[]; others: number[] } {
  const lbls: number[] = [];
  const others: number[] = [];
  for (const k of kids) {
    if (isLegalChild(byNum.get(k))) lbls.push(k);
    else others.push(k);
  }
  return { lbls, others };
}

function reparentChildren(
  byNum: Map<number, Obj>,
  others: number[],
  fromNum: number,
  toNum: number,
): void {
  const pattern = new RegExp(`/P\\s+${fromNum}\\s+0\\s+R`);
  const replacement = `/P ${toNum} 0 R`;
  for (const k of others) {
    const kd = byNum.get(k);
    if (!kd) continue;
    const text = kd.bytes.toString('latin1');
    if (!pattern.test(text)) continue;
    kd.bytes = Buffer.from(text.replace(pattern, replacement), 'latin1');
  }
}

function rewriteLiK(liText: string, newKids: number[]): string | null {
  const pattern = /\/K\s*(?:\[[^\]]*\]|\d+\s+0\s+R)/;
  const replacement = `/K [${newKids.map((k) => `${k} 0 R`).join(' ')}]`;
  const next = liText.replace(pattern, replacement);
  return next === liText ? null : next;
}

export function applyListBody(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;

  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const lis = liNumbers(parts);
  if (lis.length === 0) return pdf;

  let nextNum = Math.max(0, ...parts.objs.map((o) => o.num)) + 1;
  const newObjs: Obj[] = [];
  let changed = false;

  for (const liNum of lis) {
    const li = byNum.get(liNum);
    if (!li) continue;
    const kids = kidsOf(li.bytes.toString('latin1'));
    if (kids.length === 0) continue;

    const { lbls, others } = partitionKids(kids, byNum);
    if (others.length === 0) continue;

    const lbodyNum = nextNum++;
    const lbodyKids = others.map((k) => `${k} 0 R`).join(' ');
    newObjs.push({
      num: lbodyNum,
      bytes: Buffer.from(
        `${lbodyNum} 0 obj\n<< /Type /StructElem /S /LBody /P ${liNum} 0 R /K [${lbodyKids}] >>\nendobj\n`,
        'latin1',
      ),
    });

    reparentChildren(byNum, others, liNum, lbodyNum);

    const newLiText = rewriteLiK(li.bytes.toString('latin1'), [...lbls, lbodyNum]);
    if (!newLiText) continue;
    li.bytes = Buffer.from(newLiText, 'latin1');
    changed = true;
  }

  if (!changed) return pdf;
  const objs = [...parts.objs, ...newObjs];
  return new Uint8Array(join(parts.head, objs, parts.trailer));
}
