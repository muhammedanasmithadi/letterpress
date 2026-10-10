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
/**
 * Where the object's top-level dictionary closes, or -1 when it has none.
 *
 * Counting rather than searching, because dictionaries nest and an object reference
 * dictionary sits inside a structure element. The text is masked by the caller, so a
 * `<<` inside a literal string cannot open one.
 */
function dictClose(window: string): number {
  let depth = 0;
  for (let i = 0; i + 1 < window.length; i++) {
    const pair = window.slice(i, i + 2);
    if (pair === "<<") { depth++; i++; continue; }
    if (pair === ">>") {
      depth--;
      i++;
      // The index of the second `>`, which is where the search for the keyword starts.
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function split(raw: Buffer): Parts {
  const text = raw.toString(LATIN1);
  // Headers must begin a line, which is what separates one from a literal string that
  // spells one -- `<img alt="2 0 obj">` puts `/Alt (2 0 obj)` in a dictionary.
  //
  // Masking first was the obvious fix and it is wrong: maskStrings reads the text as
  // syntax, and a stream payload is not. An unbalanced `(` in binary data blanks every
  // header after it and objects merge, measured as `/Length 293 but carries 860`.
  const starts: Array<{ num: number; at: number }> = [];
  for (const m of text.matchAll(/(?:^|\n)(\d+) \d+ obj\b/g)) {
    starts.push({ num: Number(m[1]), at: m.index + (m.index > 0 && m[0][0] !== "0" ? 1 : 0) });
  }
  const trailerAt = text.indexOf("\ntrailer\n");
  if (!starts.length || trailerAt === -1) throw new Error("not a linear pdf");
  const objs: Obj[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const next = i + 1 < starts.length ? starts[i + 1].at : trailerAt;
    // An object ends at its own `endobj`, or after its own `endstream` if it is a stream.
    // A stream payload may hold anything, so the payload keyword decides the end rather
    // than a search for `endobj` -- a dictionary or payload carrying those bytes used to
    // truncate the object, and the gate then had no payload on either side to compare.
    const window = text.slice(from, next);
    const marker = maskStrings(window).match(/stream\r?\n/);
    let to: number;
    if (marker && marker.index !== undefined) {
      // Last occurrence within the object: a payload may contain the bytes, and the
      // terminator is written after it.
      const endKw = window.lastIndexOf("\nendstream");
      if (endKw !== -1) {
        let end = endKw + "\nendstream".length;
        const tail = /^\s*endobj/.exec(window.slice(end));
        if (tail) end += tail[0].length;
        to = from + end;
      } else {
        to = next; // no terminator: fall through to the next header rather than guess
      }
    } else {
      // Three constraints, none sufficient alone. Masking, because a string can carry
      // the keyword. An end-of-line after it, because a URL containing `endobject` begins
      // with those six letters. And a position past the dictionary's `>>`, because a bare
      // *name* ending a line -- `<< /A endobj\n>>` -- is otherwise identical to it.
      const maskedWindow = maskStrings(window);
      const dictEnd = dictClose(maskedWindow);
      // Zero when there is no dictionary to search past, or every object without one is
      // cut a byte early.
      const after = dictEnd === -1 ? 0 : dictEnd;
      const m = /\bendobj[ \t]*[\r\n]/.exec(maskedWindow.slice(after));
      to = m ? from + after + m.index + 6 : next;
    }
    objs.push({ num: starts[i].num, bytes: raw.subarray(from, Math.min(to, next)) });
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

/**
 * Add an entry inside a dictionary that spans several lines.
 *
 * The insert point is the last `>>` not nested inside another `<<`, counted rather than
 * guessed. Dictionaries nest -- the catalog carries `/MarkInfo << /Marked true >>` -- and
 * `lastIndexOf(">>")` picks the inner one there.
 */
export function insertIntoDict(body: string, entry: string): string {
  // Counted on the masked copy so a `<<` inside a string cannot drive the depth negative,
  // which would return the body unchanged while the caller counted a write.
  const code = maskStrings(body);
  let depth = 0;
  let close = -1;
  for (let i = 0; i < code.length - 1; i++) {
    const pair = code.slice(i, i + 2);
    if (pair === "<<") {
      depth++;
      i++;
    } else if (pair === ">>") {
      depth--;
      // The entry goes before the first `>` of the pair; after it lands the key outside
      // the dictionary, where no reader sees it.
      if (depth === 0) close = i;
      i++;
    }
  }
  if (close === -1) return body;
  return body.slice(0, close) + entry + "\n" + body.slice(close);
}

/**
 * The same text with the contents of every literal string and comment blanked out.
 *
 * A literal string and a `%` comment are both arbitrary text sitting inside a dictionary,
 * so anything searched for in code can be found in one. Blanked to spaces rather than
 * removed, so offsets found in the masked copy index into the original.
 *
 * Only literal strings are blanked. A hex string is a run of hex digits and cannot carry a
 * delimiter, and blanking it would stop callers reading values they need -- an /Alt
 * written as UTF-16BE, for one. Escapes are honoured, so `\)` does not close a string.
 */
export function maskStrings(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    // ISO 32000-1 §7.2.4: a comment runs to end of line. Skipping it matters because an
    // unbalanced `(` inside one would open a string that never closes. A `%` inside a
    // literal string is not a comment and never reaches here.
    if (ch === "%") {
      out += "%";
      i++;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") { out += " "; i++; }
      continue;
    }
    if (ch !== "(") { out += ch; i++; continue; }
    // Copy the delimiters so a caller matching on "(" or ")" still sees the string's
    // extent; blank only what is between them.
    out += "(";
    i++;
    let body = "";
    for (;;) {
      if (i >= text.length) { out += body; break; }
      const c = text[i]!;
      if (c === "\\") {
        // Keep the pair, blanking neither, so a `\)` does not look like a close and a
        // `\(` does not look like an open.
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === ")") { out += body + ")"; i++; break; }
      body += c === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}

/**
 * An object's dictionary with any stream payload removed, trimmed. Values are intact.
 *
 * Use this to read a value -- `/Alt (a logo)`, `/URI (https://x.example/)`. For finding
 * *structure* inside a dictionary use dictCode, which blanks string contents first.
 */
export function dictOf(o: Obj): string {
  const text = o.bytes.toString(LATIN1);
  // The keyword is found in the masked copy and applied to the original. Searching the
  // original truncated the dictionary at the word "stream" inside a value -- a link whose
  // URL contained it lost everything after the URL, including the /Contents the repair
  // needed to look for.
  const at = maskStrings(text).search(/\bstream\b/);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

/**
 * An object's dictionary with string contents blanked, for searching rather than reading.
 *
 * A literal string is arbitrary text sitting inside a dictionary, so anything searched
 * for in code can be found in one by accident. Measured: `/Alt (a stream of monthly
 * revenue)` made the figure look undescribed and the repair silently did nothing;
 * `/URI (https://x.example/stream/)` cut the annotation before its /Contents, so the
 * idempotence guard missed and a second pass wrote a duplicate key.
 *
 * Lengths are preserved, so offsets found here index into dictOf's output.
 */
export function dictCode(o: Obj): string {
  return maskStrings(dictOf(o));
}

/**
 * Structure elements with the given role, in document order, by walking the tree from
 * /StructTreeRoot.
 *
 * A walk rather than a scan of the file, because the two orders differ: a nested
 * element is written *before* its parent, so object order is not document order.
 * Measured for outer-then-inner figures: [15,12] in the file, [12,15] in the tree.
 *
 * Lives here rather than in a repair, because matching a document node to the structure
 * element it produced needs it and the walk is the same either way.
 */
/**
 * Child structure elements of an element, by object number.
 *
 * `/K` has three shapes and only two of them name children: a bare reference, and an
 * array mixing references with MCIDs. A bare integer is an MCID resolved against the
 * element's `/Pg`, so treating it as a reference would walk to whichever unrelated
 * object happened to share that number.
 *
 * Only references at the *top level* of the array count. An array also holds inline
 * object reference dictionaries, and those name things that are not children:
 *
 *   /K [13 0 R <</Type /OBJR /Obj 5 0 R /Pg 2 0 R>> 19 0 R]
 *        ^ a child        ^ the image, and the page it is on
 *
 * Matching every `N 0 R` in the array returns [13, 2, 19] -- the page, in place of the
 * image. That is not a harmless extra step: a walk that lands on a page object treats it
 * as a structure element and stops descending, so an element's descendants can be
 * reported as missing. Skipping a `<<` group therefore means skipping it to its *matching*
 * `>>`, counting rather than searching, because these dictionaries nest.
 *
 * Arrays nest too. `/K [[1 0 R] [2 0 R]]` used to yield [1] and lose 2, because the array
 * was extracted with a non-greedy `\[([\s\S]*?)\]` that stopped at the first `]`. The
 * same counting finds the real end, and a nested array is descended into rather than
 * skipped -- unlike an inline dictionary, it holds references and nothing else.
 */

/** The text between `at`'s bracket pair and its match, or undefined when unbalanced. */
function bracketed(text: string, at: number, open: string, close: string): string | undefined {
  // Compared with startsWith rather than a two-character slice, because these delimiters
  // are not all two characters: `text.slice(i, i + 2)` is never "[" except in the last
  // byte of the string, so the single-character case silently matched nothing.
  const width = open.length;
  let depth = 0;
  for (let i = at; i + width <= text.length; i += width) {
    if (text.startsWith(open, i)) { depth++; continue; }
    if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return text.slice(at + width, i);
    }
  }
  return undefined;
}

/** References named at the top level of `body`, descending into nested arrays. */
function refsIn(body: string, depth: number): number[] {
  // A bound independent of the bracket matching, so a file that opens more brackets than
  // it closes cannot spin here.
  if (depth > 32) return [];
  const out: number[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("<<", i)) {
      const inner = bracketed(body, i, "<<", ">>");
      if (inner === undefined) break;
      i += inner.length + 4;
      continue;
    }
    if (body[i] === "[") {
      const inner = bracketed(body, i, "[", "]");
      if (inner === undefined) break;
      out.push(...refsIn(inner, depth + 1));
      i += inner.length + 2;
      continue;
    }
    const m = /^\s*(\d+) 0 R/.exec(body.slice(i));
    if (m) { out.push(Number(m[1])); i += m[0].length; continue; }
    i++;
  }
  return out;
}

export function kidsOf(rawText: string): number[] {
  // Masked: /Alt (/K 99 0 R) would otherwise read as a child reference, and a document
  // that said so had every gated repair rejected.
  const text = maskStrings(rawText);
  const at = /\/K\s*/.exec(text);
  if (!at) return [];
  let i = at.index + at[0].length;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === "[") {
    const body = bracketed(text, i, "[", "]");
    return body === undefined ? [] : refsIn(body, 0);
  }
  const m = /^(\d+) 0 R/.exec(text.slice(i));
  return m ? [Number(m[1])] : [];
}

export function structElementsInOrder(parts: Parts, role: string): number[] {
  const byNum = new Map<number, string>();
  for (const o of parts.objs) byNum.set(o.num, dictCode(o));

  // The catalog holds /StructTreeRoot N 0 R. Found by scanning, because the
  // StructTreeRoot object itself does not name its own number.
  let start: number | undefined;
  for (const text of byNum.values()) {
    const m = /\/StructTreeRoot\s+(\d+) 0 R/.exec(text);
    if (m) { start = Number(m[1]); break; }
  }
  if (start === undefined) return [];

  // The slash is part of the pattern: the file holds `/S /Figure`, so matching
  // `/S\s*Figure` finds nothing. That mistake made every role return an empty list,
  // which looked exactly like a document with no elements of that kind.
  const want = new RegExp(`/S\\s*/${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const order: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    // A structure tree is a graph in principle, so a cycle guard is not paranoia;
    // depth is a second bound because a malformed tree could otherwise be very deep.
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

/**
 * The byte range of a stream object's payload.
 *
 * Written once because five call sites had the same four lines, in two variants that
 * disagreed at the boundary: two compared `end <= startOfPayload` and two compared
 * `end <= startOfKeyword`. Those differ by the length of the `stream\r?\n` marker, so a
 * stream with a short payload was accepted by one and rejected by another. The rule for
 * what a payload is has to be the same everywhere, and the verification gate is the
 * worst place for it to differ.
 */
export function streamRange(bytes: Uint8Array): { start: number; end: number } | undefined {
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString(LATIN1)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(LATIN1);
  const marker = text.match(/stream\r?\n/);
  if (!marker || marker.index === undefined) return undefined;
  const start = marker.index + marker[0].length;
  const end = text.lastIndexOf("\nendstream");
  // No endstream, or one at or before the payload began, means this is not a stream we
  // can measure rather than an empty one. A zero-length payload is legal and yields
  // start === end.
  if (end < start) return undefined;
  return { start, end };
}

/** Decompressed payload of a FlateDecode stream object, if that is what it is. */
export function inflatedStream(o: Obj, inflate: (b: Buffer) => Buffer): Buffer | undefined {
  const range = streamRange(o.bytes);
  if (!range) return undefined;
  try {
    return inflate(o.bytes.subarray(range.start, range.end));
  } catch {
    return undefined;
  }
}

/**
 * The dictionary half of a stream object, up to the `stream` keyword.
 *
 * Masked, for the same reason as dictOf: a dictionary carrying `/Producer (upstream)`
 * ends at the word inside the string, and every key after it becomes invisible.
 */
export function streamDict(o: Obj): string {
  const text = maskStrings(o.bytes.toString(LATIN1));
  const marker = text.match(/stream\r?\n/);
  return text.slice(0, marker?.index ?? text.length);
}