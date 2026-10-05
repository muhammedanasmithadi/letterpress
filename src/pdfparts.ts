/**
 * Whole-file PDF object surgery, shared by the output fixes.
 *
 * Anything that changes a stream's length invalidates the cross-reference table,
 * because that table stores byte offsets. So a fix that edits content has to
 * rebuild the table too, and the two operations are easy to get subtly wrong in
 * ways a reader tolerates while a second reader does not. Three such bugs are
 * documented at the call sites below; they all produced files that opened.
 */

export type Obj = { num: number; bytes: Buffer };
export type Parts = { head: Buffer; objs: Obj[]; trailer: Buffer };

export const LATIN1 = "latin1" as BufferEncoding;
const NEWLINE = Buffer.from("\n", LATIN1);

/**
 * A Buffer view over any Uint8Array, without copying.
 *
 * `pdf as Buffer` is a type assertion, not a conversion, and it leaves a
 * Uint8Array in place. Its toString ignores the encoding argument and returns no
 * bytes at all, so a split that looked for objects found none and the function
 * returned its input untouched and silently. This exists so that cannot happen
 * again by accident.
 */
export function asBuffer(pdf: Uint8Array): Buffer {
  return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}

/**
 * Split a PDF into header, indirect objects and trailer.
 *
 * Throws for anything that is not a classic linear-layout file with an xref
 * table, so a caller that has not verified the structure passes its input
 * through rather than rewriting it blind.
 */
export function split(raw: Buffer): Parts {
  const text = raw.toString(LATIN1);
  const starts: Array<{ num: number; at: number }> = [];
  for (const m of text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)) {
    starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== "0" ? 1 : 0) });
  }
  const trailerAt = text.indexOf("\ntrailer\n");
  if (!starts.length || trailerAt === -1) throw new Error("not a linear pdf");
  const objs: Obj[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    // An object ends at its own `endobj`, not at the next header: a stream
    // payload may contain bytes that look like one.
    const endObj = text.indexOf("endobj", from);
    const next = i + 1 < starts.length ? starts[i + 1].at : trailerAt;
    const to = endObj !== -1 && endObj + 6 <= next ? endObj + 6 : next;
    objs.push({ num: starts[i].num, bytes: raw.subarray(from, to) });
  }
  // The trailer stops at the file's own `startxref`, not at `%%EOF`. Slicing to
  // `%%EOF` carries the old pointer along, and appending a fresh one then
  // produces two `startxref` lines: readers disagree about which to honour, and
  // the stale offset points into the middle of the rebuilt table.
  const oldStartxref = text.indexOf("\nstartxref", trailerAt);
  if (oldStartxref === -1) throw new Error("no startxref");
  return {
    head: raw.subarray(0, starts[0].at),
    objs,
    trailer: raw.subarray(trailerAt + 1, oldStartxref),
  };
}

/** Reassemble objects into a file with a freshly computed cross-reference table. */
export function join(head: Buffer, objs: Obj[], trailer: Buffer): Buffer {
  const parts: Buffer[] = [head];
  const at = new Map<number, number>();
  let length = head.length;
  for (const o of objs) {
    at.set(o.num, length);
    parts.push(o.bytes);
    length += o.bytes.length;
    // A newline after every object, so the last one does not end glued to the
    // keyword that follows. `endobjxref` is one token to a reader: ghostscript
    // reported "object lacks an endobj" and stopped there, while poppler happened
    // to recover and read the file anyway.
    parts.push(NEWLINE);
    length += 1;
  }
  const size = Math.max(...objs.map((o) => o.num)) + 1;
  const xrefAt = length;
  parts.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n`, LATIN1));
  for (let n = 1; n < size; n++) {
    const off = at.get(n);
    // Chromium numbers its objects contiguously, so a free entry here means the
    // input had a gap. It is written as the tail of the free list, which no
    // reference can reach.
    parts.push(Buffer.from(
      off === undefined ? "0000000000 65535 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`, LATIN1));
  }
  // /Size is one past the highest object number. Trusting the input's value is
  // how a rebuilt table ends up contradicting itself.
  const fixed = Buffer.from(trailer.toString(LATIN1).replace(/\/Size\s+\d+/, `/Size ${size}`), LATIN1);
  parts.push(fixed, NEWLINE, Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, LATIN1));
  return Buffer.concat(parts);
}

/** Split, or return undefined when the file is not one this can rewrite. */
export function trySplit(pdf: Uint8Array): Parts | undefined {
  try {
    return split(asBuffer(pdf));
  } catch {
    return undefined;
  }
}

/** Decompressed payload of a FlateDecode stream object, if that is what it is. */
export function inflatedStream(o: Obj, inflate: (b: Buffer) => Buffer): Buffer | undefined {
  const text = o.bytes.toString(LATIN1);
  const marker = text.match(/stream\r?\n/);
  if (!marker || marker.index === undefined) return undefined;
  const at = marker.index + marker[0].length;
  const end = text.lastIndexOf("\nendstream");
  if (end <= at) return undefined;
  try {
    return inflate(o.bytes.subarray(at, end));
  } catch {
    return undefined;
  }
}

/** The dictionary half of a stream object, up to the `stream` keyword. */
export function streamDict(o: Obj): string {
  const text = o.bytes.toString(LATIN1);
  const marker = text.match(/stream\r?\n/);
  return text.slice(0, marker?.index ?? text.length);
}