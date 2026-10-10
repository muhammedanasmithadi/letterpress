/**
 * Fold per-glyph positioning into `TJ` arrays, the way a TeX engine writes text.
 *
 * Chromium emits one glyph per text-showing operator, each preceded by its own relative
 * `Td`. Measured on a ten-line paragraph: 822 `Tj`, zero `TJ`, about 82 show operations per
 * line. A pdfTeX-produced PDF writes a handful of `TJ` arrays per line instead, each
 * carrying many glyphs with the kerning as numbers between them.
 *
 * That difference is not cosmetic. A reader that builds a selection rectangle per
 * show-operation gets 82 boxes for a line rather than a few, and a reader that has to group
 * them has to guess. Merging states the run structure.
 *
 * The arithmetic. `Td` is relative to the *line* matrix, so the pen position for glyph N is
 * the running sum of the deltas. Showing a string advances the pen by the glyph widths; a
 * number `n` inside `TJ` shifts it by `-n/1000 * Tfs`. To land glyph N+1 where `Td` put it:
 *
 *     n_N = -(delta_N - width_N/1000 * Tfs) * 1000 / Tfs
 *
 * An adjustment is emitted to six decimals and the rounding residue is carried into the
 * next one, so a line of any length accumulates no drift and no adjustment is silently
 * discarded. Dropping every small number instead would push the error past the tolerance
 * on a long line and make the proof reject the whole block -- safe, but the feature would
 * quietly stop applying to the longest lines in a document.
 *
 * Two things in the input decide whether this can be done at all rather than merely done
 * right, and both were found by a reader disagreeing with the arithmetic rather than by
 * the arithmetic being wrong. Chromium wraps a ligature in a marked-content span carrying
 * `/ActualText`, inside the text object; rebuilding the block from tokens drops it, and the
 * two characters go with it. And the merge turns absolute positions into width-relative
 * adjustments, so a width read wrongly -- `/W` has two forms and reading one leaves the
 * other as absent -- shifts every glyph after it while leaving the characters and the
 * pixels exactly where they were.
 *
 * Correctness is checked, not argued: `mergeTextRuns` replays the original stream and the
 * rewritten one and compares every glyph's position. If any glyph moves beyond the
 * tolerance, the input is returned untouched. That replay is necessary and not sufficient:
 * it uses the same width table the merge does, so a table read wrongly agrees with itself.
 * The word boxes poppler reports are the independent check, and they live in the test.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { LATIN1, dictOf, join, streamRange, trySplit, type Obj, type Parts } from './pdfparts.ts';

/** Where a glyph was drawn, in text space. */
type Placed = { x: number; y: number; cid: number };

/** Advance widths per page font resource, keyed by resource name. */
type Widths = Map<string, (cid: number) => number>;

/** How far a glyph may move, in text-space units, before the rewrite is refused. */
const EPSILON = 1e-4;

/** Decimal places kept in an emitted adjustment. */
const PLACES = 6;

/** What the merge did, for the finding that reports it. */
export type MergeStats = {
  blocks: number;
  merged: number;
  refused: number;
};

/** The body of the `/Font` dictionary, to its matching `>>`. */
function fontDictOf(dict: string): string {
  const at = /\/Font\s*<</.exec(dict);
  if (!at) return '';
  let depth = 0;
  for (let i = at.index + at[0].length - 2; i < dict.length - 1; i++) {
    const pair = dict.slice(i, i + 2);
    if (pair === '<<') {
      depth++;
      i++;
      continue;
    }
    if (pair === '>>') {
      depth--;
      i++;
      if (depth === 0) return dict.slice(at.index + at[0].length, i - 1);
    }
  }
  return '';
}

/**
 * Advance widths per page font resource, keyed by resource name.
 *
 * A `/Type0` font is a parent: it names a descendant through `/DescendantFonts`, and the
 * widths live on the descendant. Reading the parent finds nothing, which looks like a font
 * with no metrics rather than one indirection away.
 */
function widthsByResource(parts: Parts): Widths {
  const out: Widths = new Map();
  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  for (const page of parts.objs) {
    const dict = dictOf(page);
    if (!/\/Type\s*\/Page\b/.test(dict)) continue;
    // A non-greedy search for the next ">>" lands inside whatever dictionary precedes
    // /Font -- /Resources carries /ExtGState <</G3 3 0 R>> first -- and reads a font
    // dictionary that is not there.
    let resDict = fontDictOf(dict);
    const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
    if (ref) resDict = fontDictOf(dictOf(byNum.get(Number(ref))!)) || resDict;
    for (const m of resDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const target = byNum.get(Number(m[2]));
      if (!target) continue;
      let font = dictOf(target);
      const descendant = byNum.get(
        Number(/\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(font)?.[1]),
      );
      if (descendant) font = dictOf(descendant);
      if (!/\/Subtype\s*\/CIDFontType2/.test(font)) continue;
      const dw = Number(/\/DW\s+(-?[\d.]+)/.exec(font)?.[1] ?? 1000);
      const widths = new Map(parseW(font));
      out.set(m[1]!, (cid: number) => widths.get(cid) ?? dw);
    }
  }
  return out;
}

/**
 * The `/W` array, read with balanced brackets.
 *
 * The grammar has two forms and taking only the first is a quiet way to move text:
 *
 *     /W [ 0 [600 0 0 260] 15 17 250 38 [614] ]
 *              ^^^^^^^^^   ^^^^^^^^^^^
 *              c [w...]    cFirst cLast w
 *
 * Reading `15 17 250` as three unrelated numbers leaves CIDs 15 to 17 with no width, they
 * fall back to `/DW`, and every adjustment computed from them is short by the difference.
 * The page still rasterises identically and still extracts the right characters, so only
 * the word boxes move -- and the reader that has to live with that is the one copying the
 * text.
 */
function parseW(dict: string): Map<number, number> {
  const at = /\/(?:W|w)\s*\[/.exec(dict);
  if (!at) return new Map();
  let depth = 0;
  let end = -1;
  for (let i = at.index + at[0].length - 1; i < dict.length; i++) {
    if (dict[i] === '[') depth++;
    else if (dict[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return new Map();

  const out = new Map<number, number>();
  const toks = dict
    .slice(at.index + at[0].length, end)
    .replace(/[[\]]/g, ' $& ')
    .split(/\s+/)
    .filter(Boolean);

  let cid: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === '[') {
      const from = cid;
      let j = i + 1;
      for (; j < toks.length && toks[j] !== ']'; j++) {
        const w = Number(toks[j]);
        if (from !== null && Number.isFinite(w)) out.set(from + (j - i - 1), w);
      }
      cid = last = null;
      i = j;
      continue;
    }
    const n = Number(tok);
    if (!Number.isFinite(n)) continue;
    if (cid === null) cid = n;
    else if (last === null) last = n;
    else {
      for (let c = cid; c <= last; c++) out.set(c, n);
      cid = last = null;
    }
  }
  return out;
}

/**
 * The CIDs in a hex string.
 *
 * Every font this handles is a `/Type0` with an `/Identity-H` encoding over a
 * `CIDFontType2` descendant, so each glyph is two bytes. Chromium shows a whole string of
 * them in one `Tj` -- `<337D34C45836>` is three CJK glyphs, not one -- and reading it as a
 * single number puts the whole run at the wrong advance. An odd digit count is a code that
 * is not two bytes, which is not a shape this handles.
 */
function cidsOf(hex: string): number[] | null {
  if (hex.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 4) out.push(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/**
 * Replay a text block, recording where each glyph lands.
 *
 * Only the operators Chromium emits are handled. Anything else marks the block
 * untransformable rather than being interpreted, because a wrong reading of an operator
 * would move a glyph and the proof would be comparing two wrong answers.
 */
function replay(block: string, widths: Widths): { placed: Placed[]; simple: boolean } {
  const placed: Placed[] = [];
  let x = 0;
  let y = 0;
  let lx = 0;
  let ly = 0;
  let simple = true;
  let size = 0;
  let widthOf: (cid: number) => number = () => 1000;

  const show = (hex: string): boolean => {
    const cids = cidsOf(hex);
    if (!cids) {
      simple = false;
      return false;
    }
    for (const cid of cids) {
      placed.push({ x, y, cid });
      x += (widthOf(cid) / 1000) * size;
    }
    return true;
  };

  const tok =
    /\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|\[([^\]]*)\]\s*TJ|\b(TZ|TC|TW|TL|TQ|T\*|Ts)\b/g;

  for (let m = tok.exec(block); m; m = tok.exec(block)) {
    if (m[1] !== undefined) {
      size = Number(m[2]);
      const found = widths.get(m[1]!);
      if (!found) simple = false;
      else widthOf = found;
      continue;
    }
    if (m[3] !== undefined) {
      // A rotated or scaled text matrix is not the case this handles.
      // Only the untransformed shape this handles: a b c d = 1 0 0 +/-1. Any shear,
      // rotation or mirror changes what a `Td` does to the origin, and reading it as a
      // plain horizontal move puts glyphs somewhere the proof cannot see, because the
      // proof walks the same mistake.
      if (Number(m[3]) !== 1 || Number(m[4]) !== 0 || Number(m[5]) !== 0) simple = false;
      if (Number(m[6]) !== 1 && Number(m[6]) !== -1) simple = false;
      x = lx = Number(m[7]);
      y = ly = Number(m[8]);
      continue;
    }
    if (m[9] !== undefined) {
      lx += Number(m[9]);
      ly += Number(m[10]);
      x = lx;
      y = ly;
      continue;
    }
    if (m[11] !== undefined) {
      show(m[11]!);
      continue;
    }
    if (m[12] !== undefined) {
      // A TJ array: strings and numbers interleaved, a number shifting the pen back.
      for (const piece of m[12]!.split(/\s+/)) {
        if (!piece) continue;
        const hex = /^<([0-9A-Fa-f]*)>$/.exec(piece);
        if (hex) {
          if (!show(hex[1]!)) break;
          continue;
        }
        const num = Number(piece);
        if (Number.isFinite(num)) x -= (num / 1000) * size;
      }
      continue;
    }
    if (m[13] !== undefined) simple = false;
  }
  return { placed, simple };
}

/** The `BT`/`ET` blocks in a stream, paired with what the replay made of them. */
function blocksOf(stream: string): string[] {
  return [...stream.matchAll(/BT[\s\S]*?ET/g)].map((m) => m[0]);
}

/** One thing inside a text block: a marked-content span, or a string of glyphs to show. */
type Item = { raw: string } | { cids: number[]; dx: number; moved: boolean };

/** Rewrite one text block, or return null when it is not the shape handled. */
function mergeBlock(block: string, widths: Widths): string | null {
  const text = block.trim();
  if (!text.startsWith('BT') || !text.endsWith('ET')) return null;

  // Chromium marks a ligature as its own run for accessibility:
  //
  //     /Span<</ActualText (fi) >> BDC
  //     <0047> Tj
  //     EMC
  //
  // Dropping that loses the two characters a screen reader and a text extractor are given,
  // so the span is kept and the array is split around it: several TJ arrays in one text
  // object cost the pen nothing, since the text matrix survives between show operators.
  //
  // Tokenize rather than match one anchored pattern: the shape Chromium emits is small,
  // and a single regex over it is easy to get subtly wrong. Any text not covered by a token
  // refuses the block, because a rebuild from tokens silently loses whatever it skipped --
  // which is how the ligature span went missing the first time.
  const tok =
    /\bBT\b|\bET\b|\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|([^\n]*\bBDC\b[^\n]*)|\bEMC\b/g;

  let tf = '';
  let size = 0;
  let tm = '';
  let open = false;
  let closed = false;
  let dx = 0;
  let dy = 0;
  let moved = false;
  let at = 0;
  const items: Item[] = [];

  for (let m = tok.exec(text); m; m = tok.exec(text)) {
    if (text.slice(at, m.index).trim() !== '') return null;
    at = m.index + m[0].length;

    if (m[0] === 'BT') {
      if (open || items.length) return null;
      open = true;
      continue;
    }
    if (m[0] === 'ET') {
      if (!open || closed) return null;
      closed = true;
      continue;
    }
    if (m[12] !== undefined) {
      items.push({ raw: m[12] });
      continue;
    }
    if (m[0] === 'EMC') {
      items.push({ raw: m[0] });
      continue;
    }
    if (closed) return null;
    if (m[1] !== undefined) {
      // A second Tf means two runs in one block, which this does not merge.
      if (items.some((i) => 'cids' in i)) return null;
      tf = `/${m[1]} ${Number(m[2])} Tf`;
      size = Number(m[2]);
      continue;
    }
    if (m[3] !== undefined) {
      if (items.some((i) => 'cids' in i)) return null;
      // `Td tx ty` moves the origin to (e + tx*a + ty*c, f + tx*b + ty*d). Folding a
      // leading `Td` into `e` is the same move only when a is 1 and b is 0, so anything
      // with a shear, a rotation or a mirror is refused rather than rewritten.
      if (Number(m[3]) !== 1 || Number(m[4]) !== 0 || Number(m[5]) !== 0) return null;
      if (Number(m[6]) !== 1 && Number(m[6]) !== -1) return null;
      tm = `${m[3]} ${m[4]} ${m[5]} ${m[6]} ${m[7]} ${m[8]} Tm`;
      continue;
    }
    if (m[9] !== undefined) {
      dx = Number(m[9]);
      dy = Number(m[10]);
      moved = true;
      continue;
    }
    if (m[11] === undefined) return null;
    // A glyph that moves the pen vertically is not a run.
    if (dy !== 0) return null;
    const cids = cidsOf(m[11]!);
    if (!cids) return null;
    items.push({ cids, dx, moved });
    moved = false;
    dx = dy = 0;
  }
  if (text.slice(at).trim() !== '') return null;
  if (!open || !closed) return null;
  if (!items.some((i) => 'cids' in i)) return null;

  const widthOf = widths.get(tf.slice(1, tf.indexOf(' ')));
  if (!widthOf || size <= 0) return null;

  // `Td` positions the pen against the *line* matrix, so what a run of text costs the pen
  // is the sum of every advance in it, not the width of its last glyph. Chromium writes Latin
  // one glyph per string, where the two coincide, and CJK several per string, where using
  // only the last one puts every following word out by the width of the text before it.
  const advanceOf = (cids: number[]): number =>
    cids.reduce((sum, cid) => sum + (widthOf(cid) / 1000) * size, 0);

  const out: string[] = [];
  let entries: string[] = [];
  let residue = 0;
  let pending = 0;
  let first = true;

  const flush = (): void => {
    if (!entries.length) return;
    out.push(`[${entries.join(' ')}] TJ`);
    entries = [];
  };

  for (const item of items) {
    if ('raw' in item) {
      flush();
      out.push(item.raw);
      continue;
    }
    const sum = advanceOf(item.cids);
    if (item.moved) {
      if (first) {
        // The first `Td` in a block moves the line matrix before anything is shown, and a
        // TJ array cannot express that: it has no position of its own. Folding it into the
        // text matrix is exactly equivalent, since `Td tx ty` sets Tlm to
        // [1 0 0 1 tx ty] x Tlm and the shape checked above gives an origin of e + tx. A
        // block with no Tm at all starts from the identity matrix, so the shift is written
        // out whole.
        if (item.dx !== 0) {
          if (!tm) tm = `1 0 0 -1 ${item.dx} 0 Tm`;
          else {
            const m = tm.split(' ');
            tm = `${m[0]} ${m[1]} ${m[2]} ${m[3]} ${Number(m[4]) + item.dx} ${m[5]} Tm`;
          }
        }
      } else {
        const exact = -((item.dx - pending) * 1000) / size + residue;
        const rounded = Math.round(exact * 10 ** PLACES) / 10 ** PLACES;
        residue = exact - rounded;
        if (rounded !== 0) entries.push(String(rounded));
      }
      pending = sum;
    } else {
      pending += sum;
    }
    first = false;
    for (const cid of item.cids)
      entries.push(`<${cid.toString(16).toUpperCase().padStart(4, '0')}>`);
  }
  flush();
  return `BT ${tf} ${tm} ${out.join(' ')} ET`;
}

/** Every glyph position in a whole content stream, or null if any block is unfamiliar. */
function streamPlaced(stream: string, widths: Widths): Placed[] | null {
  const out: Placed[] = [];
  for (const block of blocksOf(stream)) {
    const { placed, simple } = replay(block, widths);
    if (!simple) return null;
    out.push(...placed);
  }
  return out;
}

/** Whether every glyph kept its position. */
function sameGlyphs(before: Placed[], after: Placed[] | null): boolean {
  if (!after || after.length !== before.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (after[i]!.cid !== before[i]!.cid) return false;
    if (Math.abs(after[i]!.x - before[i]!.x) > EPSILON) return false;
    if (Math.abs(after[i]!.y - before[i]!.y) > EPSILON) return false;
  }
  return true;
}

/** The decoded text of a stream object, or null when it is not one. */
function decodeStream(o: Obj): { text: string; compressed: boolean } | null {
  const dict = dictOf(o);
  const range = streamRange(o.bytes);
  if (!range) return null;
  const compressed = /FlateDecode/.test(dict);
  const raw = o.bytes.subarray(range.start, range.end);
  try {
    return {
      text: (compressed ? inflateSync(raw) : Buffer.from(raw)).toString(LATIN1),
      compressed,
    };
  } catch {
    return null;
  }
}

export function mergeTextRuns(pdf: Uint8Array): { pdf: Uint8Array; stats: MergeStats } {
  const stats: MergeStats = { blocks: 0, merged: 0, refused: 0 };
  const parts = trySplit(pdf);
  if (!parts) return { pdf, stats };
  const widths = widthsByResource(parts);
  if (!widths.size) return { pdf, stats };

  let changed = 0;
  const objs: Obj[] = parts.objs.map((o) => {
    const decoded = decodeStream(o);
    if (!decoded || !/\bBT\b/.test(decoded.text)) return o;
    const blocks = blocksOf(decoded.text);
    stats.blocks += blocks.length;
    const before = streamPlaced(decoded.text, widths);

    let rewritten = decoded.text;
    let merged = 0;
    for (const block of blocks) {
      const run = before ? mergeBlock(block, widths) : null;
      if (run) {
        rewritten = rewritten.replace(block, run);
        merged++;
      }
    }
    if (rewritten === decoded.text) {
      stats.refused += before ? blocks.length - merged : blocks.length;
      return o;
    }

    // The proof: every glyph must land where it did.
    if (!sameGlyphs(before!, streamPlaced(rewritten, widths))) {
      stats.refused += blocks.length;
      return o;
    }

    stats.merged += merged;
    changed++;
    const payload = Buffer.from(rewritten, LATIN1);
    const body = decoded.compressed ? deflateSync(payload) : payload;
    // dictOf already includes the "N 0 obj" header, so it is not written again -- doing so
    // produced two headers per object, which rendered blank and extracted as nothing while
    // still passing verify(), because the gate compares streams and not the header above
    // them. The dictionary is also not truncated: cutting it at a fixed length loses its
    // tail, and for a content stream holding a Type 3 font that tail is the resource dict.
    const head = dictOf(o)
      .replace(/\/Length\s+\d+/, `/Length ${body.length}`)
      .trim();
    return {
      num: o.num,
      bytes: Buffer.concat([
        Buffer.from(`${head}\nstream\n`, LATIN1),
        body,
        Buffer.from('\nendstream\nendobj\n', LATIN1),
      ]),
    };
  });

  if (!changed) return { pdf, stats };
  return { pdf: new Uint8Array(join(parts.head, objs, parts.trailer)), stats };
}

/** Glyphs, `TJ` runs, and show operations in the file. */
export function textRunProfile(pdf: Uint8Array): { glyphs: number; tj: number; showOps: number } {
  const parts = trySplit(pdf);
  const profile = { glyphs: 0, tj: 0, showOps: 0 };
  if (!parts) return profile;
  for (const o of parts.objs) {
    const decoded = decodeStream(o);
    if (!decoded || !/\bBT\b/.test(decoded.text)) continue;
    profile.glyphs += (decoded.text.match(/<[0-9A-Fa-f]+>/g) ?? []).length;
    profile.tj += (decoded.text.match(/\bTJ\b/g) ?? []).length;
    profile.showOps +=
      (decoded.text.match(/\bTj\b/g) ?? []).length + (decoded.text.match(/\bTJ\b/g) ?? []).length;
  }
  return profile;
}
