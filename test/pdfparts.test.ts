import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { dictCode, dictOf, insertIntoDict, kidsOf, maskStrings, streamDict, streamRange, structElementsInOrder, trySplit, join as joinParts, LATIN1, type Obj } from "../src/pdfparts.ts";
import { contentPayloads, verify } from "../src/verify.ts";

/**
 * The whole-file helpers, tested against the inputs that make each one look wrong.
 *
 * Every case here is one where the obvious implementation returns something plausible
 * and incorrect. The parsers are the part of this codebase that no amount of reading
 * convinces you about: `lastIndexOf` on a delimiter looks reckless, and here it is
 * right, and the reason is not obvious from the code.
 */

/**
 * A linear PDF whose one content stream holds `contents`, compressed or not.
 *
 * Offsets are derived from the accumulated bytes rather than tracked by hand. The first
 * version of this fixture did the arithmetic by hand, recorded the file header as if it
 * were an object, and produced a file whose cross-reference table pointed nowhere --
 * which `verify()` reported before the question this file exists to answer was ever
 * asked.
 */
function build(contents: string, compress = true): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  const len = () => chunks.reduce((a, b) => a + b.length, 0);
  const add = (body: string) => {
    offsets.push(len());
    chunks.push(Buffer.from(body, LATIN1));
  };

  chunks.push(Buffer.from("%PDF-1.4\n", LATIN1));
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  add("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n");

  const raw = Buffer.from(contents, LATIN1);
  const payload = compress ? deflateSync(raw) : raw;
  offsets.push(len());
  chunks.push(Buffer.from(`4 0 obj\n<< /Length ${payload.length} >>\nstream\n`, LATIN1));
  chunks.push(payload);
  chunks.push(Buffer.from("\nendstream\nendobj\n", LATIN1));
  add("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  const xrefAt = len();
  const n = offsets.length + 1;
  let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
  chunks.push(Buffer.from(table, LATIN1));
  chunks.push(Buffer.from(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, LATIN1));
  return Buffer.concat(chunks);
}

function measuredLength(pdf: Buffer): { declared: number; measured: number } {
  const parts = trySplit(pdf);
  const streamObj = parts?.objs.find((o) => o.bytes.includes("stream"));
  const range = streamObj ? streamRange(streamObj.bytes) : undefined;
  return {
    declared: Number(/\/Length\s+(\d+)/.exec(streamObj?.bytes.toString(LATIN1) ?? "")?.[1] ?? -1),
    measured: range ? range.end - range.start : -1,
  };
}

const PLAIN = "BT /F1 12 Tf 10 100 Td (plain) Tj ET";

describe("streamRange", () => {
  test("agrees with the declared length on an ordinary stream", () => {
    const { declared, measured } = measuredLength(build(PLAIN));
    expect(measured).toBe(declared);
    expect(verify(build(PLAIN)).ok).toBe(true);
  });

  // streamRange ends a payload with lastIndexOf("\nendstream"), which looks reckless
  // and is correct: the terminator is always written after the payload, so the last
  // occurrence inside the object is the real one. split() excludes anything past
  // endobj, which is what makes "last" mean "the terminator" rather than "some later
  // decoy".
  //
  // Measured, because this is the reasoning most likely to be undone by a reader who
  // decides the lastIndexOf is a bug:
  //
  //   payload names endstream once, uncompressed     agrees
  //   payload names it twice, uncompressed            agrees
  //   payload ENDS with the bytes, uncompressed       agrees
  //   the same three, compressed                      agrees
  test.each([
    ["names it once", `${PLAIN}\nendstream\nmore text`],
    ["names it twice", `${PLAIN}\n% endstream\nmore\nendstream\nstill going`],
    ["ends with the bytes", `${PLAIN}\nendstream`],
  ])("agrees with the declared length when the payload %s", (_label, contents) => {
    for (const compress of [false, true]) {
      const pdf = build(contents, compress);
      const { declared, measured } = measuredLength(pdf);
      expect(measured, `compress=${compress}`).toBe(declared);
      expect(verify(pdf).ok, `compress=${compress}`).toBe(true);
    }
  });

  test("reports no range for an object with no stream", () => {
    const parts = trySplit(build(PLAIN))!;
    const catalog = parts.objs.find((o) => /\/Type \/Catalog/.test(dictOf(o)))!;
    expect(streamRange(catalog.bytes)).toBeUndefined();
  });

  test("a zero-length payload is a range, not a missing one", () => {
    // start === end is legal, and returning undefined here would make a reader treat an
    // empty stream as an unreadable object.
    const empty = Buffer.from("7 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n", LATIN1);
    const range = streamRange(empty);
    expect(range).toBeDefined();
    expect(range!.end - range!.start).toBe(0);
  });
});

describe("kidsOf", () => {
  // The three shapes /K takes. A bare integer is an MCID resolved against the element's
  // /Pg, so treating it as a reference would walk to whichever unrelated object happens
  // to share that number.
  test("a bare reference", () => {
    expect(kidsOf("<</Type /StructElem /K 15 0 R>>")).toEqual([15]);
  });

  test("an array of references and MCIDs, with an object reference dictionary", () => {
    // 13 and 19 are children. The inline dictionary names an annotation (/Obj 5) and a
    // page (/Pg 2) -- neither is a child structure element, and 2 in particular is a page
    // object, which a walk would treat as an element and stop descending inside.
    expect(kidsOf("<</Type /StructElem /K [13 0 R <</Type /OBJR /Obj 5 0 R /Pg 2 0 R>> 19 0 R]>>"))
      .toEqual([13, 19]);
  });

  test("a nested dictionary is skipped to its matching close, not the first one", () => {
    // The inner dictionary's own >> must not be taken for the group's end, or the rest
    // of the array is parsed as though it were still inside it.
    expect(kidsOf("<</K [4 0 R <</A <</B 1 0 R>> /Obj 9 0 R>> 5 0 R]>>")).toEqual([4, 5]);
  });

  test("a bare integer is an MCID, not a child", () => {
    expect(kidsOf("<</Type /StructElem /Pg 2 0 R /K 19>>")).toEqual([]);
  });

  test("no /K at all", () => {
    expect(kidsOf("<</Type /StructElem>>")).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * Arrays nest, and a nested array is descended into
   *
   * The array used to be extracted with a non-greedy `\[([\s\S]*?)\]`, which stops
   * at the first `]`. Measured on these inputs:
   *
   *   /K [[1 0 R] [2 0 R]]   ->  [1]     2 lost
   *   /K [1 0 R [2 0 R] 3 0 R] -> [1, 2] 3 lost
   *
   * A lost child is a missed descendant, which is the same failure the inline-dictionary
   * case above was written for: the walk stops short and the repair decides the figure
   * below is undescribed.
   *
   * Chromium emits no nested arrays -- checked against its own output -- so this is
   * robustness rather than a live defect. A nested array is descended into rather than
   * skipped, because unlike an inline dictionary it holds references and nothing else.
   * ---------------------------------------------------------------- */

  test("a nested array is descended into, not cut at its first bracket", () => {
    expect(kidsOf("<</K [[1 0 R] [2 0 R]]>>")).toEqual([1, 2]);
    expect(kidsOf("<</K [1 0 R [2 0 R] 3 0 R]>>")).toEqual([1, 2, 3]);
    expect(kidsOf("<</K [[[3 0 R]]]>>")).toEqual([3]);
  });

  test("an inline dictionary inside a nested array is still skipped", () => {
    // Nested array holding a child, an object reference dictionary, then a sibling.
    expect(kidsOf("<</K [[1 0 R <</Type /OBJR /Obj 7 0 R /Pg 2 0 R>>] [3 0 R]]>>")).toEqual([1, 3]);
  });

  test("unbalanced brackets yield nothing rather than a partial answer", () => {
    expect(kidsOf("<</K [1 0 R [2 0 R>>")).toEqual([]);
    expect(kidsOf("<</K [[[[1 0 R]>>")).toEqual([]);
    expect(kidsOf("<</K [1 0 R")).toEqual([]);
  });

  test("nesting deeper than the bound terminates and returns nothing", () => {
    // Bounded on purpose: the recursion carries its own limit so a file that opens more
    // brackets than it closes cannot spin. Returning nothing is the safe answer -- it
    // stops the walk short, which under-reports rather than inventing a descendant.
    expect(kidsOf("<</K " + "[".repeat(200) + "1 0 R" + "]".repeat(200) + ">>")).toEqual([]);
    // And the bound is far above anything a producer emits, so real nesting is unaffected.
    expect(kidsOf("<</K " + "[".repeat(16) + "1 0 R" + "]".repeat(16) + ">>")).toEqual([1]);
  });
});

describe("structElementsInOrder", () => {
  /** A structure tree whose nesting and object order disagree, as Chromium's does. */
  function tree(bodies: Record<number, string>): Buffer {
    const parts: string[] = ["%PDF-1.4\n"];
    const offsets: number[] = [];
    let at = parts[0]!.length;
    const add = (body: string) => {
      offsets.push(at);
      at += body.length;
      parts.push(body);
    };
    add("1 0 obj\n<< /Type /Catalog /StructTreeRoot 2 0 R >>\nendobj\n");
    add("2 0 obj\n<< /Type /StructTreeRoot /K 3 0 R >>\nendobj\n");
    for (const [num, body] of Object.entries(bodies)) add(`${num} 0 obj\n${body}\nendobj\n`);
    const xrefAt = at;
    const n = offsets.length + 1;
    let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
    parts.push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.from(parts.join(""), LATIN1);
  }

  test("document order, not the order objects are written in", () => {
    // 4 is the outer Figure and 5 the inner one. The inner is written first, which is
    // how Chromium emits nested structure elements, so a file-order scan reverses them.
    const pdf = tree({
      3: "<</Type /StructElem /S /Document /K [4 0 R]>>",
      4: "<</Type /StructElem /S /Figure /K 5 0 R>>",
      5: "<</Type /StructElem /S /Figure /K 6 0 R>>",
      6: "<</Type /StructElem /S /Figure>>",
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, "Figure")).toEqual([4, 5, 6]);
  });

  test("matches only the role asked for, with the slash", () => {
    // The file holds `/S /Figure`. A pattern of `/S\s*Figure` matches nothing and looks
    // exactly like a document with no figures at all.
    const pdf = tree({
      3: "<</Type /StructElem /S /Document /K [4 0 R 5 0 R]>>",
      4: "<</Type /StructElem /S /Figure>>",
      5: "<</Type /StructElem /S /Caption>>",
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, "Figure")).toEqual([4]);
    expect(structElementsInOrder(parts, "Caption")).toEqual([5]);
    expect(structElementsInOrder(parts, "Sect")).toEqual([]);
  });

  test("a cycle does not hang the walk", () => {
    const pdf = tree({
      3: "<</Type /StructElem /S /Document /K [4 0 R]>>",
      4: "<</Type /StructElem /S /Figure /K [3 0 R 4 0 R]>>",
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, "Figure")).toEqual([4]);
  });

  test("an untagged file yields nothing rather than throwing", () => {
    expect(structElementsInOrder(trySplit(build(PLAIN))!, "Figure")).toEqual([]);
  });
  void joinParts;
});

describe("insertIntoDict", () => {
  test("inserts before the outer close, not a nested one", async () => {
    const { insertIntoDict } = await import("../src/pdfparts.ts");
    const obj = "5 0 obj\n<</Type /Annot\n/A <</S /URI\n/URI (https://x.example/)>>\n/StructParent 1>>\nendobj";
    const out = insertIntoDict(obj, "/Contents (hello)");
    const nestedClose = out.indexOf("/URI (https://x.example/)>>") + "/URI (https://x.example/)>>".length;
    const at = out.indexOf("/Contents (hello)");
    expect(at).toBeGreaterThan(nestedClose);
    expect(at).toBeLessThan(out.lastIndexOf(">>"));
  });
});

/* ------------------------------------------------------------------ *
 * A literal string is arbitrary text sitting inside a dictionary
 *
 * Every one of these found a real defect, and all of them had the same cause: something
 * searching a dictionary for structure found the structure in a string value instead.
 *
 * Measured before the fix:
 *   - alt text reading "see object 999 0 R" made the gate's reference scan find a
 *     reference to an object that does not exist, so every gated repair was rejected and
 *     the document shipped with no author and no XMP packet;
 *   - alt text reading "a stream of monthly revenue" cut the Figure element's dictionary
 *     at the word inside it, so it looked undescribed and the repair silently did nothing;
 *   - a link whose URL contained "stream" was cut before its /Contents, so the
 *     idempotence guard missed and a second pass wrote a duplicate key.
 *
 * Each test below fails with maskStrings neutered. That was checked, not assumed.
 * ------------------------------------------------------------------ */

describe("maskStrings", () => {
  const O = (bytes: string) => ({ num: 1, bytes: Buffer.from(bytes, LATIN1) }) as Obj;

  test("blanks the contents and preserves every offset and length", () => {
    const src = "<< /Alt (hello) /K [1 0 R] >>";
    const masked = maskStrings(src);
    expect(masked).not.toContain("hello");
    expect(masked.length).toBe(src.length);
    // An offset found in the masked text must index into the original.
    const at = masked.indexOf("/K");
    expect(src.slice(at)).toBe(masked.slice(at));
  });

  test("keeps the delimiters, so a caller's own match on a parenthesis still works", () => {
    expect(maskStrings("(abc)")).toBe("(   )");
  });

  test("an escaped close parenthesis does not end the string", () => {
    // The classic failure: `\)` closes the string early, so everything after it is read
    // as code -- and here what follows is a real reference, so it must survive as code
    // while the string's own contents do not.
    const masked = maskStrings(String.raw`<</A (a \) b) /K [9 0 R]>>`);
    expect(masked).toContain(String.raw`\)`);   // the escape is left verbatim
    expect(masked).not.toContain(" b)");        // the rest of the string is blanked
    expect(masked).toContain("/K [9 0 R]");     // and the dictionary after it is intact
  });

  test("an escaped open parenthesis is not an open", () => {
    expect(maskStrings(String.raw`<< /A (a \( b) /K [9 0 R]>>`)).not.toContain("( b");
  });

  test("an unterminated string does not throw", () => {
    expect(() => maskStrings("<< /A (unterminated")).not.toThrow();
    expect(maskStrings("<< /A (unterminated")).not.toContain("unterminated");
  });

  test("a hex string is left alone, because a caller may need to read it", () => {
    // /Alt is written as UTF-16BE hex by some producers. Masking it would stop the value
    // being read, which is the opposite of what this function is for.
    expect(maskStrings("<</Alt <00480065006C006C006F> /K [1 0 R]>>")).toContain("<00480065006C006C006F>");
  });

  test("dictOf reads values; dictCode hides them", () => {
    // The distinction the whole fix rests on: one reads, one searches.
    const o = O("<< /URI (https://x.example/stream/) /Contents (a) >>");
    expect(dictOf(o)).toContain("https://x.example/stream/");
    expect(dictCode(o)).not.toContain("https://x.example/stream/");
    expect(dictCode(o)).toContain("/Contents");
  });

  test("dictCode does not stop at the word stream inside a string", () => {
    const o = O("<< /Alt (a stream of revenue) /K [15 0 R] >>");
    expect(dictCode(o)).toContain("/K [15 0 R]");
  });

  test("streamDict does not stop at a string carrying the keyword and a newline", () => {
    // `(upstream)` alone does not fool streamDict, which needs a newline after the
    // keyword. `(foo stream\nbar)` does, and only masking catches that one.
    const o = O("<< /Alt (foo stream\nbar) /Length 99 >> stream\nxxxx\nendstream");
    expect(/\/Length\s+(\d+)/.exec(streamDict(o))?.[1]).toBe("99");
  });

  test("kidsOf does not read a reference out of an /Alt", () => {
    expect(kidsOf("<</S /Figure /Alt (/K 99 0 R) /K [15 0 R]>>")).toEqual([15]);
  });

  test("insertIntoDict is not derailed by an unbalanced << inside a string", () => {
    // An unbalanced `<<` drove the depth negative, `close` stayed -1, and the function
    // returned the body unchanged -- so the caller believed it had written a key and had
    // not. Chromium percent-encodes `<<` to `%3C%3C`, so this was reachable only through
    // a document whose own text carried the characters.
    expect(insertIntoDict("<< /URI (a << b) >>", "/Contents (x)")).toContain("/Contents (x)");
    // And the entry lands inside the dictionary, not after it.
    expect(insertIntoDict("<< /URI (a << b) >>", "/Contents (x)")).toBe("<< /URI (a << b) /Contents (x)\n>>");
  });
});

describe("streamDict", () => {
  test("cuts at the keyword, leaving the payload out", () => {
    const o = { num: 1, bytes: Buffer.from("<< /Length 5 >> stream\nhello\nendstream", LATIN1) } as Obj;
    expect(streamDict(o).trim()).toBe("<< /Length 5 >>");
  });
});

/* ------------------------------------------------------------------ *
 * An object ends at its own `endobj` -- unless it is a stream
 *
 * `split()` used to search for the first `endobj` after an object's header, which is
 * wrong twice over: the dictionary may carry those bytes as a value, and the payload may
 * start with them. Either way the object came back truncated with no stream at all.
 *
 * The consequence was not just a missed check. The repair layer operates on the bytes
 * `split()` returns and `join()` writes them back, so a repair touching such an object
 * would have written a truncated object and destroyed the payload. And the verification
 * gate, whose whole job is to catch that, saw no payload on either side and compared
 * `[]` to `[]`.
 *
 * Measured on the fixtures below: the gate reports 1 content payload with this fixed and
 * 0 without it, for both the dictionary and the payload case.
 * ------------------------------------------------------------------ */

/** A linear PDF whose object 4 is exactly `body`, everything else boilerplate. */
function fileWithObject4(body: string): Buffer {
  const bodies = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n${body}\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const head = Buffer.from("%PDF-1.4\n", LATIN1);
  const chunks: Buffer[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (const b of bodies) { offsets.push(at); at += b.length; chunks.push(Buffer.from(b, LATIN1)); }
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
  chunks.push(Buffer.from(table, LATIN1));
  chunks.push(Buffer.from(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, LATIN1));
  return Buffer.concat(chunks);
}

describe("split keeps a stream object whole", () => {
  const CONTENT = "BT /F1 12 Tf (page one) Tj ET";
  const cases: Array<[string, string, string]> = [
    ["plain", `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`, CONTENT],
    ["endobj in the dictionary", `<< /Producer (endobj) /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`, CONTENT],
    ["endobj in the payload", `<< /Length ${7 + CONTENT.length} >>\nstream\nendobj ${CONTENT}\nendstream`, `endobj ${CONTENT}`],
  ];

  for (const [name, body, payload] of cases) {
    test(name, () => {
      const pdf = fileWithObject4(body);
      const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
      const range = streamRange(o.bytes);
      expect(range).toBeDefined();
      // The payload is recovered exactly, and it is the payload the page names.
      expect(o.bytes.subarray(range!.start, range!.end).toString(LATIN1)).toBe(payload);
      // And the object ends at its own endobj, not one further along.
      expect(o.bytes.toString(LATIN1).endsWith("\nendstream\nendobj")).toBe(true);
      expect(contentPayloads(pdf)).toEqual([payload]);
      expect(verify(pdf).ok).toBe(true);
    });
  }

  test("a string carrying the keyword does not make a plain object a stream", () => {
    // The keyword is searched for in the masked window. Unmasked, the newline inside the
    // /Alt would match `stream\r?\n` and the object would be measured as a stream with no
    // payload, ending at some other object's endobj.
    const pdf = fileWithObject4("<< /Alt (a stream\nof text) >>");
    const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
    expect(streamRange(o.bytes)).toBeUndefined();
    expect(o.bytes.toString(LATIN1)).toBe("4 0 obj\n<< /Alt (a stream\nof text) >>\nendobj");
  });
});

/* ------------------------------------------------------------------ *
 * The keyword `endobj` appears in ordinary documents
 *
 * Found by an audit subagent reading this file, not by any test: the non-stream branch of
 * split() searched the raw text, while the stream branch had been taught to search the
 * masked window. Same bug, one branch over, and the branch that reached it far more often.
 *
 * A link to https://example.com/docs/endobject.html contains the six letters `endobj` as
 * the *prefix* of `endobject`, so a plain indexOf cut the annotation there:
 *
 *   /URI (https://example.com/docs/endobj
 *   6 0 obj
 *   <</Filter /FlateDecode
 *
 * verify() returned ok with no failures. There were no findings. pdftotext exited 0 while
 * printing three syntax errors, so a caller checking its exit code saw a success.
 *
 * Both halves of the fix are needed and neither is sufficient alone: a word boundary still
 * trips on `/URI (endobj)`, and masking still trips on `endobject`.
 * ------------------------------------------------------------------ */

describe("split when a non-stream object carries the keyword", () => {
  const body = (extra: string) => `<< ${extra} /Type /Free >>`;

  const cases: Array<[string, string]> = [
    ["inside a literal string", "/A (endobj)"],
    ["as the prefix of a longer word", "/A (endobject)"],
    ["inside an array", "/A [endobj]"],
    ["with no parens at all", "/A endobj"],
    ["and then a real reference after it", "/A (endobj) /Ref 99 0 R"],
  ];

  for (const [name, extra] of cases) {
    test(name, () => {
      // The trailing /Ref 99 0 R is the point: if the object is truncated at the
      // keyword, that reference disappears and nothing notices.
      const pdf = fileWithObject4(body(extra));
      const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
      expect(o.bytes.toString(LATIN1)).toBe(`4 0 obj\n${body(extra)}\nendobj`);
      // And the dangling reference the truncation would have hidden is still seen.
      const dangling = fileWithObject4(body("/A (endobj) /Ref 99 0 R"));
      expect(verify(dangling).ok).toBe(false);
    });
  }

  test("the keyword still ends the object when it is the real one", () => {
    const pdf = fileWithObject4("<< /A (nothing here) >>");
    const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
    expect(o.bytes.toString(LATIN1)).toBe("4 0 obj\n<< /A (nothing here) >>\nendobj");
    expect(verify(pdf).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A comment is arbitrary text too
 *
 * ISO 32000-1 §7.2.4: a comment runs to end of line and is not code. maskStrings knew
 * about literal strings and nothing else, so an unbalanced `(` inside a comment opened a
 * string that never closed and every byte after it was blanked.
 *
 * Measured on `<< /A % a comment ( unbalanced` -- entirely legal: the /Length two lines
 * down became invisible to the verification gate, and insertIntoDict returned its input
 * unchanged while reporting that it had written a key.
 * ------------------------------------------------------------------ */

describe("maskStrings and comments", () => {
  test("an unbalanced parenthesis inside a comment does not swallow the rest", () => {
    const body = "<< /A % a comment ( unbalanced\n/Length 140 >> carrying";
    const masked = maskStrings(body);
    expect(masked.length).toBe(body.length);
    // The comment's own text is gone, and what follows it is intact.
    expect(masked).not.toContain("comment");
    expect(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe("140");
  });

  test("a comment holding a closing parenthesis does not close a real string early", () => {
    const body = "<< /Alt (real) % ) \n/Next 1 0 R >>";
    expect(maskStrings(body)).toContain("/Next 1 0 R");
  });

  test("a percent sign inside a literal string is not a comment", () => {
    // Otherwise the string's own contents would stop being masked.
    const masked = maskStrings("<< /Alt (100% (secret)) /Next 1 0 R >>");
    expect(masked).not.toContain("secret");
    expect(masked).toContain("/Next 1 0 R");
  });

  test("a carriage return ends a comment too", () => {
    const masked = maskStrings("<< /A % ( unbalanced\r/Length 140 >>");
    expect(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe("140");
  });

  test("insertIntoDict still finds the dictionary past a comment", () => {
    const out = insertIntoDict("<< /A % ( unbalanced\n/B 1 >>", "/Contents (x)");
    expect(out).toContain("/Contents (x)");
  });
});
