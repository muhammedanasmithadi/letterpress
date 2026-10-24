import { trySplit, join, dictOf, type Obj, type Parts } from './pdfparts.ts';

const ROLE_MAP: Record<string, string> = {
  Aside: 'Sect',
};

function nonStandardTypes(parts: Parts): Set<string> {
  const found = new Set<string>();
  for (const o of parts.objs) {
    const m = /\/S\s*\/(\w+)/.exec(dictOf(o));
    if (m?.[1] && m[1] in ROLE_MAP) found.add(m[1]);
  }
  return found;
}

export function applyRoleMap(pdf: Uint8Array): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;
  const types = nonStandardTypes(parts);
  if (types.size === 0) return pdf;

  let rootNum: number | undefined;
  for (const o of parts.objs) {
    const m = /\/StructTreeRoot\s+(\d+)\s+0\s+R/.exec(dictOf(o));
    if (m) {
      rootNum = Number(m[1]);
      break;
    }
  }
  if (rootNum === undefined) return pdf;
  const root = parts.objs.find((o) => o.num === rootNum);
  if (!root) return pdf;

  const body = root.bytes.toString('latin1');
  const rmMatch = /\/RoleMap\s*<<([^<>]*)>>/.exec(body);
  const existing = new Map<string, string>();
  if (rmMatch) {
    for (const m of rmMatch[1]!.matchAll(/\/(\w+)\s*\/(\w+)/g)) {
      existing.set(m[1]!, m[2]!);
    }
  }

  let changed = false;
  for (const t of types) {
    if (!existing.has(t)) {
      existing.set(t, ROLE_MAP[t]!);
      changed = true;
    }
  }
  if (!changed) return pdf;

  const entries = [...existing.entries()].map(([k, v]) => `/${k} /${v}`).join(' ');
  const newRoleMap = `/RoleMap << ${entries} >>`;
  let newBody: string;
  if (rmMatch) {
    newBody = body.replace(rmMatch[0], newRoleMap);
  } else {
    const close = body.lastIndexOf('>>');
    newBody = body.slice(0, close) + newRoleMap + ' ' + body.slice(close);
  }

  const newRoot: Obj = { num: root.num, bytes: Buffer.from(newBody, 'latin1') };
  const objs = parts.objs.map((o) => (o.num === rootNum ? newRoot : o));
  return new Uint8Array(join(parts.head, objs, parts.trailer));
}
