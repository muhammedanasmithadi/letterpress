import {
  cappedInflate,
  dictOf,
  join,
  LATIN1,
  slashK,
  streamRange,
  trySplit,
  type Obj,
  type Parts,
} from './pdfparts.ts';
import { cmapStreams, fontsByContent, type FontTable } from './textfont.ts';
import { unescapePdfString } from './spans.ts';

export type RoleElement = { tag: string; text: string; owner: number };

export type RolePlanEntry = { tag: string; role: string; num: number };

export type RolePlan = {
  entries: RolePlanEntry[];
  ambiguous: number;
  unmatched: number;
};

const ROLE_OF: Record<string, string> = {
  nav: 'Sect',
  section: 'Sect',
  main: 'Part',
  header: 'Part',
  footer: 'Part',
  dl: 'L',
  dt: 'LI',
  dd: 'LI',
};

function normalizedText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function parseRoleCensus(returned: unknown): RoleElement[] {
  if (typeof returned !== 'string') return [];
  let value: unknown;
  try {
    value = JSON.parse(returned);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: RoleElement[] = [];
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue;
    const tag = (row as { tag?: unknown }).tag;
    const text = (row as { text?: unknown }).text;
    const owner = (row as { owner?: unknown }).owner;
    if (typeof tag !== 'string' || typeof text !== 'string') continue;
    if (!(tag in ROLE_OF)) continue;
    out.push({
      tag,
      text: normalizedText(text),
      owner: typeof owner === 'number' ? owner : -1,
    });
  }
  return out;
}

const STREAM_TOKEN = /\/(\w+)\s*<<([\s\S]*?)>>\s*BDC|\/(\w+)\s+[\d.]+\s+Tf|EMC|<([0-9A-Fa-f\s]*)>/g;

const ACTUAL_TEXT = /\/ActualText\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/;

type MarkStack = Array<number | string | null>;

function openToken(stack: MarkStack, dict: string): void {
  const mcid = /\/MCID\s+(\d+)/.exec(dict)?.[1];
  if (mcid !== undefined) {
    stack.push(Number(mcid));
    return;
  }
  const actual = ACTUAL_TEXT.exec(dict)?.[1];
  stack.push(actual === undefined ? null : unescapePdfString(actual));
}

function closeToken(byMcid: Map<number, string>, stack: MarkStack): void {
  const closed = stack.pop();
  const target = stack[stack.length - 1];
  if (typeof closed !== 'string' || typeof target !== 'number') return;
  byMcid.set(target, (byMcid.get(target) ?? '') + closed);
}

function glyphToken(
  byMcid: Map<number, string>,
  stack: MarkStack,
  table: FontTable | null,
  hex: string,
): void {
  const target = stack[stack.length - 1];
  if (typeof target !== 'number' || !table) return;
  const body = hex.replace(/\s/g, '');
  if (!body) return;
  const width = body.length % 4 === 0 ? 4 : 2;
  let text = byMcid.get(target) ?? '';
  for (let i = 0; i + width <= body.length; i += width) {
    text += table.unicodeOf(parseInt(body.slice(i, i + width), 16));
  }
  byMcid.set(target, text);
}

export function markedText(stream: string, fonts: Map<string, FontTable>): Map<number, string> {
  const byMcid = new Map<number, string>();
  const stack: MarkStack = [];
  let table: FontTable | null = null;
  stream.replace(
    STREAM_TOKEN,
    (
      whole: string,
      openTag: string | undefined,
      openDict: string | undefined,
      fontName: string | undefined,
      hex: string | undefined,
    ): string => {
      if (openTag !== undefined) {
        openToken(stack, openDict ?? '');
        return whole;
      }
      if (fontName !== undefined) {
        table = fonts.get(fontName) ?? table;
        return whole;
      }
      if (whole === 'EMC') {
        closeToken(byMcid, stack);
        return whole;
      }
      if (hex !== undefined) glyphToken(byMcid, stack, table, hex);
      return whole;
    },
  );
  return byMcid;
}

type Kid = { kind: 'ref'; num: number } | { kind: 'mcid'; mcid: number; page?: number };

const K_ENTRY = /<<[^<>]*?>>|\d+\s+0\s+R|(?<![\d.])\d+(?![\d.])/g;

function kidsOfElem(rawText: string): Kid[] {
  const rest = slashK(rawText)?.value;
  if (rest === undefined) return [];
  let i = 0;
  while (i < rest.length && /\s/.test(rest[i]!)) i++;
  const kids: Kid[] = [];
  const fromBody = (body: string): void => {
    for (const m of body.matchAll(K_ENTRY)) {
      const token = m[0];
      if (token.startsWith('<<')) {
        const mcid = /\/MCID\s+(\d+)/.exec(token);
        if (!mcid) continue;
        const pg = /\/Pg\s+(\d+)\s+0\s+R/.exec(token);
        kids.push({ kind: 'mcid', mcid: Number(mcid[1]), page: pg ? Number(pg[1]) : undefined });
        continue;
      }
      if (/0\s+R$/.test(token)) {
        kids.push({ kind: 'ref', num: Number(token.split(/\s+/)[0]) });
        continue;
      }
      kids.push({ kind: 'mcid', mcid: Number(token) });
    }
  };
  if (rest[i] === '[') {
    const end = rest.indexOf(']', i);
    if (end === -1) return [];
    fromBody(rest.slice(i + 1, end));
    return kids;
  }
  const scalar = /^(<<[^<>]*?>>|\d+\s+0\s+R|\d+)/.exec(rest.slice(i));
  if (scalar) fromBody(scalar[0]);
  return kids;
}

type Wrapper = { num: number; text: string; depth: number; pure: boolean; holds: boolean };

type Gathered = { wrappers: Wrapper[]; ancestors: Map<number, number[]> };

type WalkResult = { text: string; pure: boolean };

type KidResult = WalkResult & { holds: boolean };

type Walker = {
  byNum: Map<number, Obj>;
  mcids: Map<number, Map<number, string>>;
  visited: Set<number>;
  wrappers: Wrapper[];
  ancestors: Map<number, number[]>;
};

const EMPTY_WALK: WalkResult = { text: '', pure: false };

function mcidTextAt(w: Walker, page: number | undefined, mcid: number): string {
  if (page === undefined) return '';
  return w.mcids.get(page)?.get(mcid) ?? '';
}

function mcrText(w: Walker, text: string, page: number | undefined): string {
  const mcid = Number(/\/MCID\s+(\d+)/.exec(text)?.[1] ?? -1);
  const own = Number(/\/Pg\s+(\d+)\s+0\s+R/.exec(text)?.[1] ?? 0) || undefined;
  return mcidTextAt(w, own ?? page, mcid);
}

function roleOf(text: string): string | undefined {
  return /\/S\s*\/(\w+)/.exec(text)?.[1];
}

function pageAt(text: string): number | undefined {
  const at = /\/Pg\s+(\d+)\s+0\s+R/.exec(text);
  return at ? Number(at[1]) : undefined;
}

function startPure(isElem: boolean, role: string | undefined): boolean {
  return !isElem || role === 'NonStruct' || role === 'Document';
}

function walkKids(
  w: Walker,
  text: string,
  depth: number,
  ownPage: number | undefined,
  here: number[],
  pure: boolean,
): KidResult {
  let out = '';
  let ok = pure;
  let holds = false;
  for (const kid of kidsOfElem(text)) {
    if (kid.kind === 'ref') {
      holds = true;
      const res = walk(w, kid.num, depth + 1, ownPage, here);
      out += res.text;
      ok &&= res.pure;
      continue;
    }
    out += mcidTextAt(w, kid.page ?? ownPage, kid.mcid);
  }
  return { text: out, pure: ok, holds };
}

function registerWrapper(
  w: Walker,
  num: number,
  depth: number,
  chain: number[],
  kids: KidResult,
): void {
  w.ancestors.set(num, chain);
  w.wrappers.push({
    num,
    depth,
    holds: kids.holds,
    text: kids.text,
    pure: kids.pure && kids.text.length > 0,
  });
}

function walk(
  w: Walker,
  num: number,
  depth: number,
  page: number | undefined,
  chain: number[],
): WalkResult {
  if (depth > 64 || w.visited.has(num)) return EMPTY_WALK;
  w.visited.add(num);
  const obj = w.byNum.get(num);
  if (!obj) return EMPTY_WALK;
  const text = obj.bytes.toString(LATIN1);
  if (/\/Type\s*\/MCR\b/.test(text)) return { text: mcrText(w, text, page), pure: true };
  const isElem = /\/Type\s*\/StructElem\b/.test(text);
  if (!isElem && !/\/Type\s*\/StructTreeRoot\b/.test(text)) return EMPTY_WALK;
  const role = roleOf(text);
  const ownPage = pageAt(text) ?? page;
  const wrapping = role === 'NonStruct';
  const here = wrapping ? [...chain, num] : chain;
  const kids = walkKids(w, text, depth, ownPage, here, startPure(isElem, role));
  if (wrapping) registerWrapper(w, num, depth, chain, kids);
  return { text: kids.text, pure: kids.pure };
}

function rootNumber(byNum: Map<number, Obj>): number | undefined {
  for (const o of byNum.values()) {
    const m = /\/StructTreeRoot\s+(\d+)\s+0\s+R/.exec(dictOf(o));
    if (m) return Number(m[1]);
  }
  return undefined;
}

function pageContents(byNum: Map<number, Obj>): Map<number, number> {
  const contents = new Map<number, number>();
  for (const o of byNum.values()) {
    const dict = dictOf(o);
    if (!/\/Type\s*\/Page\b/.test(dict)) continue;
    const ref = Number(/\/Contents\s+(\d+)\s+0\s+R/.exec(dict)?.[1] ?? 0);
    if (ref) contents.set(o.num, ref);
  }
  return contents;
}

function streamText(target: Obj): string | undefined {
  const range = streamRange(target.bytes);
  if (!range) return undefined;
  const raw = target.bytes.subarray(range.start, range.end);
  try {
    return (/FlateDecode/.test(dictOf(target)) ? cappedInflate(raw) : Buffer.from(raw)).toString(
      LATIN1,
    );
  } catch {
    return undefined;
  }
}

function markedByPage(
  pdf: Uint8Array,
  parts: Parts,
  byNum: Map<number, Obj>,
  contents: Map<number, number>,
): Map<number, Map<number, string>> {
  const cmaps = cmapStreams(pdf);
  const byContent = fontsByContent(parts, (num) => cmaps.get(num) ?? null);
  const out = new Map<number, Map<number, string>>();
  for (const [pageObj, streamObj] of contents) {
    const target = byNum.get(streamObj);
    if (!target) continue;
    const text = streamText(target);
    if (text === undefined) continue;
    out.set(pageObj, markedText(text, byContent.get(streamObj) ?? new Map()));
  }
  return out;
}

function gather(pdf: Uint8Array): Gathered | undefined {
  const parts = trySplit(pdf);
  if (!parts) return undefined;
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  const root = rootNumber(byNum);
  if (root === undefined) return undefined;
  const w: Walker = {
    byNum,
    mcids: markedByPage(pdf, parts, byNum, pageContents(byNum)),
    visited: new Set<number>(),
    wrappers: [],
    ancestors: new Map<number, number[]>(),
  };
  walk(w, root, 0, undefined, []);
  return { wrappers: w.wrappers, ancestors: w.ancestors };
}

function shadows(gathered: Gathered, outer: number, inner: number): boolean {
  const chain = gathered.ancestors.get(inner);
  return chain !== undefined && chain.includes(outer);
}

function candidatesFor(
  gathered: Gathered,
  matches: (wrapperText: string) => boolean,
  consumed: Set<number>,
): number[] {
  return gathered.wrappers
    .filter((w) => w.holds && matches(w.text) && !consumed.has(w.num))
    .map((w) => w.num);
}

function elMatch(el: RoleElement): (wrapperText: string) => boolean {
  return (wrapperText) => normalizedText(wrapperText) === el.text;
}

function elMirrorMatch(el: RoleElement): (wrapperText: string) => boolean {
  return (wrapperText) => [...normalizedText(wrapperText)].reverse().join('') === el.text;
}

type Match = { num: number; pure: boolean };

type PlanState = {
  elements: RoleElement[];
  match: Array<Match | undefined>;
  planned: Map<number, number>;
};

function itemTag(tag: string): boolean {
  return tag === 'dt' || tag === 'dd';
}

function censusMatch(
  gathered: Gathered,
  elements: RoleElement[],
  plan: RolePlan,
): Array<Match | undefined> {
  const wrapperOf = new Map(gathered.wrappers.map((w) => [w.num, w]));
  const outermostOf = (candidates: number[]): number | undefined =>
    candidates.find((a) => candidates.every((b) => a === b || shadows(gathered, a, b)));
  const consumed = new Set<number>();
  const match: Array<Match | undefined> = Array.from({ length: elements.length });
  for (const [i, el] of elements.entries()) {
    if (!el.text) continue;
    let candidates = candidatesFor(gathered, elMatch(el), consumed);
    if (candidates.length === 0) {
      candidates = candidatesFor(gathered, elMirrorMatch(el), consumed);
    }
    if (candidates.length === 0) continue;
    const chosen = candidates.length === 1 ? candidates[0] : outermostOf(candidates);
    if (chosen === undefined || !wrapperOf.has(chosen)) {
      plan.ambiguous++;
      continue;
    }
    const wrapper = wrapperOf.get(chosen)!;
    if (itemTag(el.tag) && !wrapper.pure) continue;
    consumed.add(chosen);
    match[i] = { num: chosen, pure: wrapper.pure };
  }
  return match;
}

function kidsByOwner(elements: RoleElement[], owner: number): number[] {
  const out: number[] = [];
  for (const [k, e] of elements.entries()) if (e.owner === owner) out.push(k);
  return out;
}

function listComplete(state: PlanState, gathered: Gathered, dl: number, dlNum: number): boolean {
  for (const k of kidsByOwner(state.elements, dl)) {
    const kid = state.match[k];
    if (!kid || !shadows(gathered, dlNum, kid.num)) return false;
    if (state.elements[k]!.tag === 'dl') {
      if (!state.planned.has(k)) return false;
      continue;
    }
    if (!kid.pure) return false;
  }
  return true;
}

function planListKids(state: PlanState, dl: number): void {
  for (const k of kidsByOwner(state.elements, dl)) {
    const kid = state.match[k];
    if (kid !== undefined && !state.planned.has(k)) state.planned.set(k, kid.num);
  }
}

function planItems(state: PlanState, gathered: Gathered): void {
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const m = state.match[i];
    if (!m) continue;
    const tag = state.elements[i]!.tag;
    if (itemTag(tag)) continue;
    if (tag !== 'dl') {
      state.planned.set(i, m.num);
      continue;
    }
    if (!listComplete(state, gathered, i, m.num)) continue;
    state.planned.set(i, m.num);
    planListKids(state, i);
  }
}

export function rolePlan(pdf: Uint8Array, elements: RoleElement[]): RolePlan {
  const plan: RolePlan = { entries: [], ambiguous: 0, unmatched: 0 };
  if (elements.length === 0) return plan;
  const gathered = gather(pdf);
  if (!gathered) return { ...plan, unmatched: elements.length };
  const state: PlanState = {
    elements,
    match: censusMatch(gathered, elements, plan),
    planned: new Map<number, number>(),
  };
  planItems(state, gathered);
  for (const [i, el] of elements.entries()) {
    if (!el.text) continue;
    const n = state.planned.get(i);
    if (n === undefined) {
      plan.unmatched++;
      continue;
    }
    plan.entries.push({ tag: el.tag, role: ROLE_OF[el.tag]!, num: n });
  }
  return plan;
}

export function applyRolePlan(pdf: Uint8Array, plan: RolePlan): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts || plan.entries.length === 0) return pdf;
  const byNum = new Map<number, Obj>(parts.objs.map((o) => [o.num, o]));
  for (const entry of plan.entries) {
    const obj = byNum.get(entry.num);
    if (!obj) continue;
    const text = obj.bytes.toString(LATIN1);
    if (!/\/S\s*\/NonStruct\b/.test(text)) continue;
    obj.bytes = Buffer.from(text.replace(/\/S(\s*)\/NonStruct\b/, `/S$1/${entry.role}`), LATIN1);
  }
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}
