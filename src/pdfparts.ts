import { inflateSync } from 'node:zlib';
export type Obj = { num: number; bytes: Buffer };
export type Parts = { head: Buffer; objs: Obj[]; trailer: Buffer };

export function objsByNum(parts: Parts): Map<number, Obj> {
  return new Map(parts.objs.map((o) => [o.num, o]));
}

export const LATIN1 = 'latin1' as BufferEncoding;

const MAX_OBJECT_NUMBER = 1_000_000;

const MAX_INFLATE = 64 * 1024 * 1024;

export function cappedInflate(raw: Buffer): Buffer {
  return inflateSync(raw, { maxOutputLength: MAX_INFLATE });
}
const NEWLINE = Buffer.from('\n', LATIN1);

function asBuffer(pdf: Uint8Array): Buffer {
  return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}

function dictClose(window: string): number {
  let depth = 0;
  for (let i = 0; i + 1 < window.length; i++) {
    const a = window.charCodeAt(i);
    const b = window.charCodeAt(i + 1);
    if (a === 60 && b === 60) {
      depth++;
      i++;
      continue;
    }
    if (a === 62 && b === 62) {
      depth--;
      i++;

      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function isEncrypted(pdf: Uint8Array): boolean {
  const buf = asBuffer(pdf);
  const at = findTrailer(buf);
  if (at === -1) return false;
  const end = buf.indexOf('startxref', at);
  const trailer = buf.subarray(at, end === -1 ? buf.length : end).toString(LATIN1);
  return /\/Encrypt\b/.test(maskStrings(trailer));
}

function findTrailer(text: Buffer | string): number {
  const source = typeof text === 'string' ? text : text.toString(LATIN1);
  const m = /(?:^|\n)[ \t]*trailer[ \t]*(?:\r?\n|$)/.exec(source);
  return m ? m.index : -1;
}

export function hasPostTrailerObjects(pdf: Uint8Array): boolean {
  const text = asBuffer(pdf).toString(LATIN1);
  const at = findTrailer(text);
  if (at === -1) return false;
  return /(?:^|\n)\d+ \d+ obj\b/.test(text.slice(at));
}

function sliceObject(text: string, raw: Buffer, num: number, from: number, next: number): Obj {
  const window = text.slice(from, next);
  const marker = findStream(window, 'newline');
  let to: number;
  if (marker !== -1) {
    const endKw = endstreamOf(text, from + marker);
    if (endKw !== -1) {
      let end = endKw + '\nendstream'.length;
      const tail = /^\s*endobj/.exec(text.slice(end));
      if (tail) end += tail[0].length;
      to = end;
    } else {
      to = next;
    }
  } else {
    const maskedWindow = maskStrings(window);
    const dictEnd = dictClose(maskedWindow);

    const after = dictEnd === -1 ? 0 : dictEnd;
    const m = /\bendobj[ \t]*[\r\n]/.exec(maskedWindow.slice(after));
    to = m ? from + after + m.index + 6 : next;
  }
  return { num, bytes: raw.subarray(from, to) };
}

function endstreamOf(text: string, from: number): number {
  let at = from;
  for (;;) {
    const found = text.indexOf('\nendstream', at);
    if (found === -1) return -1;
    if (/^\s*endobj/.test(text.slice(found + '\nendstream'.length))) return found;
    at = found + 1;
  }
}

export function split(raw: Buffer): Parts {
  const text = raw.toString(LATIN1);

  const starts: Array<{ num: number; at: number }> = [];
  for (const m of text.matchAll(/(?:^|\n)(\d+)\s+\d+\s+obj\b/g)) {
    starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== '0' ? 1 : 0) });
  }
  const trailerAt = findTrailer(text);
  const first = starts[0];
  if (first === undefined || trailerAt === -1) throw new Error('not a linear pdf');
  const bodyStarts = starts.filter((s) => s.at < trailerAt);
  if (bodyStarts.length === 0) throw new Error('no objects before the trailer');
  const objs: Obj[] = [];
  let at = 0;
  while (at < bodyStarts.length) {
    const s = bodyStarts[at]!;
    const next = bodyStarts[at + 1];
    const obj = sliceObject(text, raw, s.num, s.at, next === undefined ? trailerAt : next.at);
    objs.push(obj);
    const end = s.at + obj.bytes.length;
    while (at + 1 < bodyStarts.length && bodyStarts[at + 1]!.at < end) at++;
    at++;
  }

  const oldStartxref = text.indexOf('\nstartxref', trailerAt);
  if (oldStartxref === -1) throw new Error('no startxref');
  return {
    head: raw.subarray(0, first.at),
    objs,
    trailer: raw.subarray(trailerAt + 1, oldStartxref),
  };
}

export function join(head: Buffer, objs: Obj[], trailer: Buffer): Buffer {
  const parts: Buffer[] = [head];
  const at = new Map<number, number>();
  let length = head.length;
  for (const o of objs) {
    at.set(o.num, length);
    parts.push(o.bytes);
    length += o.bytes.length;

    parts.push(NEWLINE);
    length += 1;
  }
  const highest = Math.max(...objs.map((o) => o.num));
  const size = (Number.isSafeInteger(highest) && highest < MAX_OBJECT_NUMBER ? highest : 0) + 1;
  const xrefAt = length;
  parts.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, LATIN1));
  for (let n = 1; n < size; n++) {
    const off = at.get(n);

    parts.push(
      Buffer.from(
        off === undefined ? '0000000000 65535 f \n' : `${String(off).padStart(10, '0')} 00000 n \n`,
        LATIN1,
      ),
    );
  }

  const fixed = Buffer.from(
    trailer.toString(LATIN1).replace(/\/Size\s+\d+/, `/Size ${size}`),
    LATIN1,
  );
  parts.push(fixed, NEWLINE, Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, LATIN1));
  return Buffer.concat(parts);
}

export function trySplit(pdf: Uint8Array): Parts | undefined {
  try {
    return split(asBuffer(pdf));
  } catch {
    return undefined;
  }
}

export function insertIntoDict(body: string, entry: string): string {
  const code = maskStrings(body);
  let depth = 0;
  let close = -1;
  for (let i = 0; i < code.length - 1; i++) {
    const pair = code.slice(i, i + 2);
    if (pair === '<<') {
      depth++;
      i++;
    } else if (pair === '>>') {
      depth--;

      if (depth === 0) close = i;
      i++;
    }
  }
  if (close === -1) return body;
  return body.slice(0, close) + entry + '\n' + body.slice(close);
}

export function findStream(text: string, mode: 'word' | 'newline'): number {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '%') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (ch === '(') {
      i = skipString(text, i);
      continue;
    }
    if (ch === 's' && isStreamKeyword(text, i, mode)) return i;
    i++;
  }
  return -1;
}

function skipString(text: string, at: number): number {
  let i = at + 1;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === ')') return i + 1;
    i++;
  }
  return n;
}

function isStreamKeyword(text: string, at: number, mode: 'word' | 'newline'): boolean {
  if (!text.startsWith('stream', at)) return false;
  const after = text[at + 6] ?? ' ';
  if (mode === 'newline') return after === '\n' || after === '\r';
  const before = at === 0 ? ' ' : text[at - 1]!;
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

const DICT_LIMIT = 8192;

export function maskStrings(text: string): string {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '%') {
      let end = i + 1;
      while (end < n && text[end] !== '\n' && text[end] !== '\r') end++;
      out.push(text.slice(last, i + 1), ' '.repeat(end - i - 1));
      last = end;
      i = end;
      continue;
    }
    if (ch !== '(') {
      i++;
      continue;
    }
    const masked = maskStringBody(text, i + 1);
    out.push(text.slice(last, i + 1));
    if (masked.escapes !== '') out.push(masked.escapes);
    if (masked.body !== '') out.push(masked.body);
    last = masked.end;
    i = masked.end + 1;
  }
  out.push(text.slice(last));
  return out.join('');
}

function maskStringBody(
  text: string,
  start: number,
): { end: number; escapes: string; body: string } {
  let j = start;
  const n = text.length;
  const escapes: string[] = [];
  const body: string[] = [];
  let run = 0;
  while (j < n) {
    const c = text[j]!;
    if (c === '\\') {
      if (run > 0) {
        body.push(' '.repeat(run));
        run = 0;
      }
      escapes.push(text.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (c === ')') break;
    if (c === '\n') {
      if (run > 0) {
        body.push(' '.repeat(run));
        run = 0;
      }
      body.push('\n');
      j++;
      continue;
    }
    run++;
    j++;
  }
  if (run > 0) body.push(' '.repeat(run));
  return { end: Math.min(j, n), escapes: escapes.join(''), body: body.join('') };
}

export function dictOf(o: Obj): string {
  const bytes = o.bytes;
  const limit = Math.min(bytes.length, DICT_LIMIT);
  const head = bytes.subarray(0, limit).toString(LATIN1);
  const at = findStream(head, 'word');
  if (at !== -1) return head.slice(0, at).trim();
  if (limit === bytes.length) return head.trim();
  const text = bytes.toString(LATIN1);
  const full = findStream(text, 'word');
  return (full === -1 ? text : text.slice(0, full)).trim();
}

export function dictCode(o: Obj): string {
  return maskStrings(dictOf(o));
}

export function bracketed(
  text: string,
  at: number,
  open: string,
  close: string,
): string | undefined {
  const width = open.length;
  let depth = 0;
  for (let i = at; i + width <= text.length; i += width) {
    if (text.startsWith(open, i)) {
      depth++;
      continue;
    }
    if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return text.slice(at + width, i);
    }
  }
  return undefined;
}

function refsIn(body: string, depth: number): number[] {
  if (depth > 32) return [];
  const out: number[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('<<', i)) {
      const inner = bracketed(body, i, '<<', '>>');
      if (inner === undefined) break;
      i += inner.length + 4;
      continue;
    }
    if (body[i] === '[') {
      const inner = bracketed(body, i, '[', ']');
      if (inner === undefined) break;
      out.push(...refsIn(inner, depth + 1));
      i += inner.length + 2;
      continue;
    }
    const m = /^\s*(\d+) 0 R/.exec(body.slice(i));
    if (m) {
      out.push(Number(m[1]));
      i += m[0].length;
      continue;
    }
    i++;
  }
  return out;
}

export function kidsOf(rawText: string): number[] {
  const at = slashK(rawText);
  if (at === undefined) return [];
  if (at.value!.startsWith('[')) {
    const body = bracketed(at.value!, 0, '[', ']');
    return body === undefined ? [] : refsIn(body, 0);
  }
  const m = /^(\d+) 0 R/.exec(at.value!);
  return m ? [Number(m[1])] : [];
}

export function slashK(rawText: string): { value: string } | undefined {
  const text = maskStrings(rawText);
  const at = /\/K\s*/.exec(text);
  if (!at) return undefined;
  let i = at.index + at[0].length;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return { value: text.slice(i) };
}

export function structElementsInOrder(parts: Parts, role: string): number[] {
  const byNum = new Map<number, string>();
  for (const o of parts.objs) byNum.set(o.num, dictCode(o));

  let start: number | undefined;
  for (const text of byNum.values()) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(text);
    if (m) {
      start = Number(m[1]);
      break;
    }
  }
  if (start === undefined) return [];

  const want = new RegExp(`/S\\s*/${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const order: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    if (seen.has(num) || depth > 64) return;
    seen.add(num);
    const text = byNum.get(num);
    if (text === undefined) return;
    if (/\/Type\s*\/StructElem/.test(text) && want.test(text)) order.push(num);
    for (const ref of kidsOf(text)) walk(ref, depth + 1);
  };
  walk(start, 0);
  return order;
}

export function streamRange(bytes: Uint8Array): { start: number; end: number } | undefined {
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString(LATIN1)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(LATIN1);
  const marker = text.match(/stream\r?\n/);
  if (!marker || marker.index === undefined) return undefined;
  const start = marker.index + marker[0].length;
  const end = text.lastIndexOf('endstream');
  if (end < start) return undefined;
  let stop = end;
  if (stop > start && text[stop - 1] === '\n') stop--;
  return { start, end: stop };
}

export function inflatedStream(o: Obj, inflate: (b: Buffer) => Buffer): Buffer | undefined {
  const range = streamRange(o.bytes);
  if (!range) return undefined;
  try {
    return inflate(o.bytes.subarray(range.start, range.end));
  } catch {
    return undefined;
  }
}

export function streamDict(o: Obj): string {
  const text = o.bytes.toString(LATIN1);
  const at = findStream(text, 'newline');
  return maskStrings(at === -1 ? text : text.slice(0, at));
}

export function walkObjects(
  parts: Parts,
  roots: number[],
  children: (obj: { num: number; dict: string }) => number[],
  visit: (obj: { num: number; dict: string }, depth: number) => void,
): void {
  const byNum = new Map<number, string>(parts.objs.map((o) => [o.num, o.bytes.toString(LATIN1)]));
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const obj = { num, dict: byNum.get(num) ?? '' };
    visit(obj, depth);
    for (const kid of children(obj)) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}
