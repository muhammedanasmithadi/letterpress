import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  dictCode,
  dictOf,
  insertIntoDict,
  kidsOf,
  maskStrings,
  streamDict,
  streamRange,
  structElementsInOrder,
  trySplit,
  join as joinParts,
  LATIN1,
  type Obj,
} from '../src/pdfparts.ts';
import { contentPayloads, verify } from '../src/verify.ts';

function build(contents: string, compress = true): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  const len = () => chunks.reduce((a, b) => a + b.length, 0);
  const add = (body: string) => {
    offsets.push(len());
    chunks.push(Buffer.from(body, LATIN1));
  };

  chunks.push(Buffer.from('%PDF-1.4\n', LATIN1));
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n');

  const raw = Buffer.from(contents, LATIN1);
  const payload = compress ? deflateSync(raw) : raw;
  offsets.push(len());
  chunks.push(Buffer.from(`4 0 obj\n<< /Length ${payload.length} >>\nstream\n`, LATIN1));
  chunks.push(payload);
  chunks.push(Buffer.from('\nendstream\nendobj\n', LATIN1));
  add('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  const xrefAt = len();
  const n = offsets.length + 1;
  let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
  chunks.push(Buffer.from(table, LATIN1));
  chunks.push(
    Buffer.from(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, LATIN1),
  );
  return Buffer.concat(chunks);
}

function measuredLength(pdf: Buffer): { declared: number; measured: number } {
  const parts = trySplit(pdf);
  const streamObj = parts?.objs.find((o) => o.bytes.includes('stream'));
  const range = streamObj ? streamRange(streamObj.bytes) : undefined;
  return {
    declared: Number(/\/Length\s+(\d+)/.exec(streamObj?.bytes.toString(LATIN1) ?? '')?.[1] ?? -1),
    measured: range ? range.end - range.start : -1,
  };
}

const PLAIN = 'BT /F1 12 Tf 10 100 Td (plain) Tj ET';

describe('streamRange', () => {
  test('agrees with the declared length on an ordinary stream', () => {
    const { declared, measured } = measuredLength(build(PLAIN));
    expect(measured).toBe(declared);
    expect(verify(build(PLAIN)).ok).toBe(true);
  });

  test.each([
    ['names it once', `${PLAIN}\nendstream\nmore text`],
    ['names it twice', `${PLAIN}\n% endstream\nmore\nendstream\nstill going`],
    ['ends with the bytes', `${PLAIN}\nendstream`],
  ])('agrees with the declared length when the payload %s', (_label, contents) => {
    for (const compress of [false, true]) {
      const pdf = build(contents, compress);
      const { declared, measured } = measuredLength(pdf);
      expect(measured, `compress=${compress}`).toBe(declared);
      expect(verify(pdf).ok, `compress=${compress}`).toBe(true);
    }
  });

  test('reports no range for an object with no stream', () => {
    const parts = trySplit(build(PLAIN))!;
    const catalog = parts.objs.find((o) => /\/Type \/Catalog/.test(dictOf(o)))!;
    expect(streamRange(catalog.bytes)).toBeUndefined();
  });

  test('a zero-length payload is a range, not a missing one', () => {
    const empty = Buffer.from('7 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n', LATIN1);
    const range = streamRange(empty);
    expect(range).toBeDefined();
    expect(range!.end - range!.start).toBe(0);
  });
});

describe('kidsOf', () => {
  test('a bare reference', () => {
    expect(kidsOf('<</Type /StructElem /K 15 0 R>>')).toEqual([15]);
  });

  test('an array of references and MCIDs, with an object reference dictionary', () => {
    expect(
      kidsOf('<</Type /StructElem /K [13 0 R <</Type /OBJR /Obj 5 0 R /Pg 2 0 R>> 19 0 R]>>'),
    ).toEqual([13, 19]);
  });

  test('a nested dictionary is skipped to its matching close, not the first one', () => {
    expect(kidsOf('<</K [4 0 R <</A <</B 1 0 R>> /Obj 9 0 R>> 5 0 R]>>')).toEqual([4, 5]);
  });

  test('a bare integer is an MCID, not a child', () => {
    expect(kidsOf('<</Type /StructElem /Pg 2 0 R /K 19>>')).toEqual([]);
  });

  test('no /K at all', () => {
    expect(kidsOf('<</Type /StructElem>>')).toEqual([]);
  });

  test('a nested array is descended into, not cut at its first bracket', () => {
    expect(kidsOf('<</K [[1 0 R] [2 0 R]]>>')).toEqual([1, 2]);
    expect(kidsOf('<</K [1 0 R [2 0 R] 3 0 R]>>')).toEqual([1, 2, 3]);
    expect(kidsOf('<</K [[[3 0 R]]]>>')).toEqual([3]);
  });

  test('an inline dictionary inside a nested array is still skipped', () => {
    expect(kidsOf('<</K [[1 0 R <</Type /OBJR /Obj 7 0 R /Pg 2 0 R>>] [3 0 R]]>>')).toEqual([1, 3]);
  });

  test('unbalanced brackets yield nothing rather than a partial answer', () => {
    expect(kidsOf('<</K [1 0 R [2 0 R>>')).toEqual([]);
    expect(kidsOf('<</K [[[[1 0 R]>>')).toEqual([]);
    expect(kidsOf('<</K [1 0 R')).toEqual([]);
  });

  test('nesting deeper than the bound terminates and returns nothing', () => {
    expect(kidsOf('<</K ' + '['.repeat(200) + '1 0 R' + ']'.repeat(200) + '>>')).toEqual([]);

    expect(kidsOf('<</K ' + '['.repeat(16) + '1 0 R' + ']'.repeat(16) + '>>')).toEqual([1]);
  });
});

describe('structElementsInOrder', () => {
  function tree(bodies: Record<number, string>): Buffer {
    const parts: string[] = ['%PDF-1.4\n'];
    const offsets: number[] = [];
    let at = parts[0]!.length;
    const add = (body: string) => {
      offsets.push(at);
      at += body.length;
      parts.push(body);
    };
    add('1 0 obj\n<< /Type /Catalog /StructTreeRoot 2 0 R >>\nendobj\n');
    add('2 0 obj\n<< /Type /StructTreeRoot /K 3 0 R >>\nendobj\n');
    for (const [num, body] of Object.entries(bodies)) add(`${num} 0 obj\n${body}\nendobj\n`);
    const xrefAt = at;
    const n = offsets.length + 1;
    let table = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
    parts.push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.from(parts.join(''), LATIN1);
  }

  test('document order, not the order objects are written in', () => {
    const pdf = tree({
      3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
      4: '<</Type /StructElem /S /Figure /K 5 0 R>>',
      5: '<</Type /StructElem /S /Figure /K 6 0 R>>',
      6: '<</Type /StructElem /S /Figure>>',
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, 'Figure')).toEqual([4, 5, 6]);
  });

  test('matches only the role asked for, with the slash', () => {
    const pdf = tree({
      3: '<</Type /StructElem /S /Document /K [4 0 R 5 0 R]>>',
      4: '<</Type /StructElem /S /Figure>>',
      5: '<</Type /StructElem /S /Caption>>',
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, 'Figure')).toEqual([4]);
    expect(structElementsInOrder(parts, 'Caption')).toEqual([5]);
    expect(structElementsInOrder(parts, 'Sect')).toEqual([]);
  });

  test('a cycle does not hang the walk', () => {
    const pdf = tree({
      3: '<</Type /StructElem /S /Document /K [4 0 R]>>',
      4: '<</Type /StructElem /S /Figure /K [3 0 R 4 0 R]>>',
    });
    const parts = trySplit(pdf)!;
    expect(structElementsInOrder(parts, 'Figure')).toEqual([4]);
  });

  test('an untagged file yields nothing rather than throwing', () => {
    expect(structElementsInOrder(trySplit(build(PLAIN))!, 'Figure')).toEqual([]);
  });
  void joinParts;
});

describe('insertIntoDict', () => {
  test('inserts before the outer close, not a nested one', async () => {
    const { insertIntoDict } = await import('../src/pdfparts.ts');
    const obj =
      '5 0 obj\n<</Type /Annot\n/A <</S /URI\n/URI (https://x.example/)>>\n/StructParent 1>>\nendobj';
    const out = insertIntoDict(obj, '/Contents (hello)');
    const nestedClose =
      out.indexOf('/URI (https://x.example/)>>') + '/URI (https://x.example/)>>'.length;
    const at = out.indexOf('/Contents (hello)');
    expect(at).toBeGreaterThan(nestedClose);
    expect(at).toBeLessThan(out.lastIndexOf('>>'));
  });
});

describe('maskStrings', () => {
  const O = (bytes: string) => ({ num: 1, bytes: Buffer.from(bytes, LATIN1) }) as Obj;

  test('blanks the contents and preserves every offset and length', () => {
    const src = '<< /Alt (hello) /K [1 0 R] >>';
    const masked = maskStrings(src);
    expect(masked).not.toContain('hello');
    expect(masked.length).toBe(src.length);

    const at = masked.indexOf('/K');
    expect(src.slice(at)).toBe(masked.slice(at));
  });

  test("keeps the delimiters, so a caller's own match on a parenthesis still works", () => {
    expect(maskStrings('(abc)')).toBe('(   )');
  });

  test('an escaped close parenthesis does not end the string', () => {
    const masked = maskStrings(String.raw`<</A (a \) b) /K [9 0 R]>>`);
    expect(masked).toContain(String.raw`\)`);
    expect(masked).not.toContain(' b)');
    expect(masked).toContain('/K [9 0 R]');
  });

  test('an escaped open parenthesis is not an open', () => {
    expect(maskStrings(String.raw`<< /A (a \( b) /K [9 0 R]>>`)).not.toContain('( b');
  });

  test('an unterminated string does not throw', () => {
    expect(() => maskStrings('<< /A (unterminated')).not.toThrow();
    expect(maskStrings('<< /A (unterminated')).not.toContain('unterminated');
  });

  test('a hex string is left alone, because a caller may need to read it', () => {
    expect(maskStrings('<</Alt <00480065006C006C006F> /K [1 0 R]>>')).toContain(
      '<00480065006C006C006F>',
    );
  });

  test('dictOf reads values; dictCode hides them', () => {
    const o = O('<< /URI (https://x.example/stream/) /Contents (a) >>');
    expect(dictOf(o)).toContain('https://x.example/stream/');
    expect(dictCode(o)).not.toContain('https://x.example/stream/');
    expect(dictCode(o)).toContain('/Contents');
  });

  test('dictCode does not stop at the word stream inside a string', () => {
    const o = O('<< /Alt (a stream of revenue) /K [15 0 R] >>');
    expect(dictCode(o)).toContain('/K [15 0 R]');
  });

  test('streamDict does not stop at a string carrying the keyword and a newline', () => {
    const o = O('<< /Alt (foo stream\nbar) /Length 99 >> stream\nxxxx\nendstream');
    expect(/\/Length\s+(\d+)/.exec(streamDict(o))?.[1]).toBe('99');
  });

  test('kidsOf does not read a reference out of an /Alt', () => {
    expect(kidsOf('<</S /Figure /Alt (/K 99 0 R) /K [15 0 R]>>')).toEqual([15]);
  });

  test('insertIntoDict is not derailed by an unbalanced << inside a string', () => {
    expect(insertIntoDict('<< /URI (a << b) >>', '/Contents (x)')).toContain('/Contents (x)');

    expect(insertIntoDict('<< /URI (a << b) >>', '/Contents (x)')).toBe(
      '<< /URI (a << b) /Contents (x)\n>>',
    );
  });
});

describe('streamDict', () => {
  test('cuts at the keyword, leaving the payload out', () => {
    const o = {
      num: 1,
      bytes: Buffer.from('<< /Length 5 >> stream\nhello\nendstream', LATIN1),
    } as Obj;
    expect(streamDict(o).trim()).toBe('<< /Length 5 >>');
  });
});

function fileWithObject4(body: string): Buffer {
  const bodies = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n${body}\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const head = Buffer.from('%PDF-1.4\n', LATIN1);
  const chunks: Buffer[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (const b of bodies) {
    offsets.push(at);
    at += b.length;
    chunks.push(Buffer.from(b, LATIN1));
  }
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
  chunks.push(Buffer.from(table, LATIN1));
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
      LATIN1,
    ),
  );
  return Buffer.concat(chunks);
}

describe('split keeps a stream object whole', () => {
  const CONTENT = 'BT /F1 12 Tf (page one) Tj ET';
  const cases: Array<[string, string, string]> = [
    ['plain', `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`, CONTENT],
    [
      'endobj in the dictionary',
      `<< /Producer (endobj) /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
      CONTENT,
    ],
    [
      'endobj in the payload',
      `<< /Length ${7 + CONTENT.length} >>\nstream\nendobj ${CONTENT}\nendstream`,
      `endobj ${CONTENT}`,
    ],
  ];

  for (const [name, body, payload] of cases) {
    test(name, () => {
      const pdf = fileWithObject4(body);
      const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
      const range = streamRange(o.bytes);
      expect(range).toBeDefined();

      expect(o.bytes.subarray(range!.start, range!.end).toString(LATIN1)).toBe(payload);

      expect(o.bytes.toString(LATIN1).endsWith('\nendstream\nendobj')).toBe(true);
      expect(contentPayloads(pdf)).toEqual([payload]);
      expect(verify(pdf).ok).toBe(true);
    });
  }

  test('a string carrying the keyword does not make a plain object a stream', () => {
    const pdf = fileWithObject4('<< /Alt (a stream\nof text) >>');
    const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
    expect(streamRange(o.bytes)).toBeUndefined();
    expect(o.bytes.toString(LATIN1)).toBe('4 0 obj\n<< /Alt (a stream\nof text) >>\nendobj');
  });
});

describe('split when a non-stream object carries the keyword', () => {
  const body = (extra: string) => `<< ${extra} /Type /Free >>`;

  const cases: Array<[string, string]> = [
    ['inside a literal string', '/A (endobj)'],
    ['as the prefix of a longer word', '/A (endobject)'],
    ['inside an array', '/A [endobj]'],
    ['with no parens at all', '/A endobj'],
    ['and then a real reference after it', '/A (endobj) /Ref 99 0 R'],
  ];

  for (const [name, extra] of cases) {
    test(name, () => {
      const pdf = fileWithObject4(body(extra));
      const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
      expect(o.bytes.toString(LATIN1)).toBe(`4 0 obj\n${body(extra)}\nendobj`);

      const dangling = fileWithObject4(body('/A (endobj) /Ref 99 0 R'));
      expect(verify(dangling).ok).toBe(false);
    });
  }

  test('the keyword still ends the object when it is the real one', () => {
    const pdf = fileWithObject4('<< /A (nothing here) >>');
    const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;
    expect(o.bytes.toString(LATIN1)).toBe('4 0 obj\n<< /A (nothing here) >>\nendobj');
    expect(verify(pdf).ok).toBe(true);
  });
});

describe('maskStrings and comments', () => {
  test('an unbalanced parenthesis inside a comment does not swallow the rest', () => {
    const body = '<< /A % a comment ( unbalanced\n/Length 140 >> carrying';
    const masked = maskStrings(body);
    expect(masked.length).toBe(body.length);

    expect(masked).not.toContain('comment');
    expect(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe('140');
  });

  test('a comment holding a closing parenthesis does not close a real string early', () => {
    const body = '<< /Alt (real) % ) \n/Next 1 0 R >>';
    expect(maskStrings(body)).toContain('/Next 1 0 R');
  });

  test('a percent sign inside a literal string is not a comment', () => {
    const masked = maskStrings('<< /Alt (100% (secret)) /Next 1 0 R >>');
    expect(masked).not.toContain('secret');
    expect(masked).toContain('/Next 1 0 R');
  });

  test('a carriage return ends a comment too', () => {
    const masked = maskStrings('<< /A % ( unbalanced\r/Length 140 >>');
    expect(/\/Length\s+(\d+)/.exec(masked)?.[1]).toBe('140');
  });

  test('insertIntoDict still finds the dictionary past a comment', () => {
    const out = insertIntoDict('<< /A % ( unbalanced\n/B 1 >>', '/Contents (x)');
    expect(out).toContain('/Contents (x)');
  });
});

describe('split when a dictionary spells an object header', () => {
  test('a string naming a header does not invent an object', () => {
    const pdf = fileWithObject4('<< /Alt (2 0 obj) /P 9 0 R >>');
    const parts = trySplit(pdf)!;
    expect(parts.objs.map((o) => o.num)).toEqual([1, 2, 3, 4, 5]);
    const o = parts.objs.find((x) => x.num === 4)!;

    expect(o.bytes.toString(LATIN1)).toBe('4 0 obj\n<< /Alt (2 0 obj) /P 9 0 R >>\nendobj');
    expect(verify(pdf).ok).toBe(false);
  });

  test('a real header still found at the start of a line', () => {
    const pdf = fileWithObject4('<< /A 1 >>');
    expect(
      trySplit(pdf)!
        .objs.find((x) => x.num === 4)!
        .bytes.toString(LATIN1),
    ).toBe('4 0 obj\n<< /A 1 >>\nendobj');
    expect(verify(pdf).ok).toBe(true);
  });

  test('a header after a stream payload is found, which a masked scan would miss', () => {
    const payload = 'x'.repeat(400) + '(not a paren';
    const pdf = fileWithObject4(`<< /Length ${payload.length} >>\nstream\n${payload}\nendstream`);
    const parts = trySplit(pdf)!;
    expect(parts.objs.map((o) => o.num)).toEqual([1, 2, 3, 4, 5]);
    const o = parts.objs.find((x) => x.num === 4)!;
    expect(streamRange(o.bytes)!.end - streamRange(o.bytes)!.start).toBe(payload.length);
    expect(verify(pdf).ok).toBe(true);
  });
});

describe("split when a dictionary ends a line with the keyword's spelling", () => {
  const cases: Array<[string, string]> = [
    ['a bare name at end of line', '<< /A endobj\n/Foo 1 >>'],
    ['a name used as a title', '<< /Title /endobj\n/Foo 1 >>'],
    ['a name inside an array', '<< /A [endobj]\n/Foo 1 >>'],
    ['nested dictionaries closing', '<< /A << /B 1 >>\n/C 2 >>'],
    ['and the plain case still works', '<< /A 1 >>'],
  ];

  for (const [name, body] of cases) {
    test(name, () => {
      const pdf = fileWithObject4(body);
      const o = trySplit(pdf)!.objs.find((x) => x.num === 4)!;

      expect(o.bytes.toString(LATIN1)).toBe(`4 0 obj\n${body}\nendobj`);
      expect(trySplit(pdf)!.objs.map((x) => x.num)).toEqual([1, 2, 3, 4, 5]);
    });
  }

  test('an object with no dictionary is still delimited', () => {
    const pdf = fileWithObject4('<< /A 1 >>');
    const rejoined = trySplit(fileWithObject4('<< /A 1 >>'))!;
    expect(rejoined.objs.find((x) => x.num === 4)!.bytes.toString(LATIN1)).toBe(
      '4 0 obj\n<< /A 1 >>\nendobj',
    );
    expect(verify(pdf).ok).toBe(true);
  });
});
