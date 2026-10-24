import { trySplit, join, dictOf, slashK, bracketed, type Obj } from './pdfparts.ts';

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

type Kid = { kind: 'ref'; num: number } | { kind: 'inline'; text: string };

function parseKids(rawText: string): Kid[] {
  const at = slashK(rawText);
  if (at === undefined) return [];
  let i = 0;
  const rest = at.value;
  if (rest === undefined) return [];
  while (i < rest.length && /\s/.test(rest[i]!)) i++;
  const kids: Kid[] = [];
  if (rest[i] === '[') {
    const end = rest.indexOf(']', i);
    if (end === -1) return [];
    const body = rest.slice(i + 1, end);
    let j = 0;
    while (j < body.length) {
      if (body.startsWith('<<', j)) {
        const inner = bracketed(body, j, '<<', '>>');
        if (inner === undefined) break;
        kids.push({ kind: 'inline', text: body.slice(j, j + inner.length + 4) });
        j += inner.length + 4;
        continue;
      }
      if (body[j] === '[') {
        const inner = bracketed(body, j, '[', ']');
        if (inner === undefined) break;
        j += inner.length + 2;
        continue;
      }
      const m = /^\s*(\d+) 0 R/.exec(body.slice(j));
      if (m) {
        kids.push({ kind: 'ref', num: Number(m[1]) });
        j += m[0].length;
        continue;
      }
      j++;
    }
    return kids;
  }
  const m = /^(\d+) 0 R/.exec(rest.slice(i));
  return m ? [{ kind: 'ref', num: Number(m[1]) }] : [];
}

function partitionKids(kids: Kid[], byNum: Map<number, Obj>): { lbls: Kid[]; others: Kid[] } {
  const lbls: Kid[] = [];
  const others: Kid[] = [];
  for (const kid of kids) {
    if (kid.kind === 'ref' && isLegalChild(byNum.get(kid.num))) {
      lbls.push(kid);
    } else {
      others.push(kid);
    }
  }
  return { lbls, others };
}

function reparentChildren(
  byNum: Map<number, Obj>,
  others: Kid[],
  fromNum: number,
  toNum: number,
): void {
  const pattern = new RegExp(`/P\\s+${fromNum}\\s+0\\s+R`);
  const replacement = `/P ${toNum} 0 R`;
  for (const kid of others) {
    if (kid.kind !== 'ref') continue;
    const kd = byNum.get(kid.num);
    if (!kd) continue;
    const text = kd.bytes.toString('latin1');
    if (!pattern.test(text)) continue;
    kd.bytes = Buffer.from(text.replace(pattern, replacement), 'latin1');
  }
}

function kidToKString(kid: Kid): string {
  if (kid.kind === 'ref') return `${kid.num} 0 R`;
  return kid.text;
}

function rewriteLiK(liText: string, newKids: Kid[]): string | null {
  const pattern = /\/K\s*(?:\[[^\]]*\]|\d+\s+0\s+R)/;
  const replacement = `/K [${newKids.map(kidToKString).join(' ')}]`;
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
    const kids = parseKids(li.bytes.toString('latin1'));
    if (kids.length === 0) continue;

    const { lbls, others } = partitionKids(kids, byNum);
    if (others.length === 0) continue;

    const lbodyNum = nextNum++;
    const lbodyKids = others.map(kidToKString).join(' ');
    newObjs.push({
      num: lbodyNum,
      bytes: Buffer.from(
        `${lbodyNum} 0 obj\n<< /Type /StructElem /S /LBody /P ${liNum} 0 R /K [${lbodyKids}] >>\nendobj\n`,
        'latin1',
      ),
    });

    reparentChildren(byNum, others, liNum, lbodyNum);

    const newLiText = rewriteLiK(li.bytes.toString('latin1'), [
      ...lbls,
      { kind: 'ref', num: lbodyNum },
    ]);
    if (!newLiText) continue;
    li.bytes = Buffer.from(newLiText, 'latin1');
    changed = true;
  }

  if (!changed) return pdf;
  const objs = [...parts.objs, ...newObjs];
  return new Uint8Array(join(parts.head, objs, parts.trailer));
}
