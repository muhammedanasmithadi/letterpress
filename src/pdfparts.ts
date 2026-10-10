export type Obj = { num: number; bytes: Buffer };
export type Parts = { head: Buffer; objs: Obj[]; trailer: Buffer };

export const LATIN1 = 'latin1' as BufferEncoding;
const NEWLINE = Buffer.from('\n', LATIN1);

export function asBuffer(pdf: Uint8Array): Buffer {
  return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}

function dictClose(window: string): number {
  let depth = 0;
  for (let i = 0; i + 1 < window.length; i++) {
    const pair = window.slice(i, i + 2);
    if (pair === '<<') {
      depth++;
      i++;
      continue;
    }
    if (pair === '>>') {
      depth--;
      i++;

      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function split(raw: Buffer): Parts {
  const text = raw.toString(LATIN1);

  const starts: Array<{ num: number; at: number }> = [];
  for (const m of text.matchAll(/(?:^|\n)(\d+) \d+ obj\b/g)) {
    starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== '0' ? 1 : 0) });
  }
  const trailerAt = text.indexOf('\ntrailer\n');
  if (!starts.length || trailerAt === -1) throw new Error('not a linear pdf');
  const objs: Obj[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const next = i + 1 < starts.length ? starts[i + 1].at : trailerAt;

    const window = text.slice(from, next);
    const marker = maskStrings(window).match(/stream\r?\n/);
    let to: number;
    if (marker && marker.index !== undefined) {
      const endKw = window.lastIndexOf('\nendstream');
      if (endKw !== -1) {
        let end = endKw + '\nendstream'.length;
        const tail = /^\s*endobj/.exec(window.slice(end));
        if (tail) end += tail[0].length;
        to = from + end;
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
    objs.push({ num: starts[i].num, bytes: raw.subarray(from, Math.min(to, next)) });
  }

  const oldStartxref = text.indexOf('\nstartxref', trailerAt);
  if (oldStartxref === -1) throw new Error('no startxref');
  return {
    head: raw.subarray(0, starts[0].at),
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
  const size = Math.max(...objs.map((o) => o.num)) + 1;
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

export function maskStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '%') {
      out += '%';
      i++;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch !== '(') {
      out += ch;
      i++;
      continue;
    }

    out += '(';
    i++;
    let body = '';
    for (;;) {
      if (i >= text.length) {
        out += body;
        break;
      }
      const c = text[i]!;
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === ')') {
        out += body + ')';
        i++;
        break;
      }
      body += c === '\n' ? '\n' : ' ';
      i++;
    }
  }
  return out;
}

export function dictOf(o: Obj): string {
  const text = o.bytes.toString(LATIN1);

  const at = maskStrings(text).search(/\bstream\b/);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

export function dictCode(o: Obj): string {
  return maskStrings(dictOf(o));
}

function bracketed(text: string, at: number, open: string, close: string): string | undefined {
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
  const text = maskStrings(rawText);
  const at = /\/K\s*/.exec(text);
  if (!at) return [];
  let i = at.index + at[0].length;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === '[') {
    const body = bracketed(text, i, '[', ']');
    return body === undefined ? [] : refsIn(body, 0);
  }
  const m = /^(\d+) 0 R/.exec(text.slice(i));
  return m ? [Number(m[1])] : [];
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
  const end = text.lastIndexOf('\nendstream');

  if (end < start) return undefined;
  return { start, end };
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
  const text = maskStrings(o.bytes.toString(LATIN1));
  const marker = text.match(/stream\r?\n/);
  return text.slice(0, marker?.index ?? text.length);
}
