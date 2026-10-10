/**
 * How a browser will group this file's text for selection.
 *
 * Firefox's PDF.js does not draw one highlight per line. It draws one per *text item*, and
 * it decides where one item ends and the next begins from the geometry: a gap between two
 * visible glyphs is kept inside the current item only when it falls in a narrow band
 * relative to the font size, and outside that band the item is ended and the gap becomes a
 * whitespace item of its own. The visible result is a highlight broken at every word, and
 * one DOM span per break to lay out on every selection.
 *
 * The band, from `src/core/evaluator.js` in pdf.js:
 *
 *     const TRACKING_SPACE_FACTOR = 0.102;   // narrower than this is tracking, not a space
 *     const NEGATIVE_SPACE_FACTOR = -0.2;    // moving backwards ends the item
 *     const SPACE_IN_FLOW_MIN_FACTOR = 0.102;
 *     const SPACE_IN_FLOW_MAX_FACTOR = 0.6;  // wider than this ends the item
 *     const VERTICAL_SHIFT_RATIO = 0.25;     // a move of this much vertically ends it too
 *
 * Justified text lands outside it: on a measured page, changing `text-align` from
 * `justify` to `left` took the gaps that break a run from 10 to 1 and the longest line from
 * 19 items to 9, with nothing else changed. A gap wider than 0.6 em is a stretched word
 * space; a gap narrower than 0.102 em is a word space squeezed by letter-spacing.
 *
 * Nothing in the file can change what those gaps are. The geometry is the layout's, and a
 * reader measures it correctly. So the useful thing to do is measure it and say so, rather
 * than let the reader of the PDF find out by dragging a cursor over it.
 *
 * Positions are held in text space throughout. A reader measures in device space and
 * divides by the CTM scale to arrive at the same place; dividing a text-space difference
 * by that scale as well shrinks every gap by it, and it was doing exactly that: the page
 * Firefox reports 14 breaks on came out at 48. Removing the second division takes it to 9,
 * and the gutter count on the table page, which was already right, stays at 179 against the
 * 180 the reader produces.
 *
 * What the reader adds on top of this arithmetic is not modelled: it also ends an item at a
 * font change, at a marked-content boundary, and when a chunk's accumulated width goes
 * negative, which inverts the sign of the band tests. So `breaks` is an upper estimate and
 * `widest` is the number to act on.
 */
import { inflateSync } from 'node:zlib';
import { LATIN1, dictOf, maskStrings, streamRange, trySplit, type Parts } from './pdfparts.ts';
import { cmapStreams, fontsByContent, type FontTable } from './textfont.ts';

/** pdf.js `TRACKING_SPACE_FACTOR` and `SPACE_IN_FLOW_MIN_FACTOR`. */
const MIN_FLOW = 0.102;
/** pdf.js `SPACE_IN_FLOW_MAX_FACTOR`. */
const MAX_FLOW = 0.6;
/** pdf.js `NEGATIVE_SPACE_FACTOR`. */
const NEGATIVE = -0.2;
/** pdf.js `VERTICAL_SHIFT_RATIO`. */
const VERTICAL = 0.25;

export type TextFlow = {
  glyphs: number;
  /** Gaps between two visible glyphs that did not move to another line. */
  gaps: number;
  /** Of those, the ones a reader will end a text item on. */
  breaks: number;
  /** Gaps past the band but no larger than this, which is what a stretched word space looks like. */
  tooWide: number;
  /** Gaps larger than that, which are jumps between blocks rather than between words. */
  jump: number;
  tooThin: number;
  backwards: number;
  lines: number;
  /** The widest word-sized gap, in em, which is the one worth acting on. */
  widest: number;
  /**
   * The widest gap of any size, jumps included. Every other counter here is a category or
   * a minimum, and a width read from the wrong page moves none of them: both the right and
   * the wrong advance can land in the same bucket, and the smallest gap is whichever page
   * happened to read correctly. This is the quantity that changes.
   */
  widestAll: number;
  /** The narrowest gap of any kind, in em, including the negative ones a kern produces. */
  narrowest: number;
  /** Text streams this walked. */
  streams: number;
  /**
   * How many of those it could read. A stream is dropped when it will not inflate, when
   * its page binds no font under the name the stream uses, or when it sets a text matrix
   * this cannot interpret -- and a dropped stream takes its glyphs out of every count above
   * while the counts still read as a document total.
   */
  read: number;
};

/**
 * Above this the gap is not a word space any more. A stretched word runs to roughly an em;
 * anything several times that is the reader moving from one block, column or cell to the
 * next, which ends a text item just the same but has nothing to do with justification.
 */
const WORD_GAP_MAX = 3;

const EMPTY: TextFlow = {
  glyphs: 0,
  gaps: 0,
  breaks: 0,
  tooWide: 0,
  jump: 0,
  tooThin: 0,
  backwards: 0,
  lines: 0,
  widest: 0,
  widestAll: 0,
  narrowest: Number.POSITIVE_INFINITY,
  streams: 0,
  read: 0,
};

/** Whether a CID stands for a character no reader draws. */
function invisible(table: FontTable, cid: number): boolean {
  const u = table.unicodeOf(cid);
  if (u === '') return false;
  for (const ch of u) {
    if (ch !== ' ' && ch !== '\u00a0' && ch !== '\u2009' && ch !== '\u202f') return false;
  }
  return true;
}

type Placed = {
  x: number;
  y: number;
  size: number;
  table: FontTable;
  cid: number;
  blank: boolean;
};

/**
 * Every glyph in a content stream, in order, or null when it uses something this does not
 * read.
 *
 * The walk covers the whole stream rather than one text object at a time because that is
 * what a reader does: `BT` resets the text matrix, not the item being built, so the gap
 * from the last cell of a table row to the first cell of the next column is measured like
 * any other. Measuring per text object misses exactly the gaps a table is made of.
 *
 * Only the operators Chromium emits are handled. A wrong reading of an operator would invent
 * gaps that are not there, which is the one thing a report about gaps cannot afford.
 */
function glyphsOf(stream: string, fonts: Map<string, FontTable>): Placed[] | null {
  const out: Placed[] = [];
  let size = 0;
  let table: FontTable | null = null;
  let x = 0;
  let y = 0;
  let lx = 0;
  let ly = 0;

  // `Tz`, `Tc`, `Tw`, `TL` and `T*` all move the pen, and a pre-existing `TJ` arrives
  // already shaped. Skipping any of them would measure gaps the reader does not see, so
  // meeting one refuses the stream rather than passing over it.
  const tok =
    /\b(BT|ET|Tz|Tc|Tw|TL|T\*|TJ)\b|\/(\w+)\s+([-\d.eE]+)\s+Tf|([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+Tm|([-\d.eE]+)\s+([-\d.eE]+)\s+Td|<([0-9A-Fa-f]*)>\s*Tj|\[([^\]]*)\]\s*TJ/g;

  const show = (hex: string): void => {
    if (hex.length % 4 !== 0 || !table) return;
    for (let i = 0; i < hex.length; i += 4) {
      const cid = parseInt(hex.slice(i, i + 4), 16);
      // A reader folds an invisible glyph into the pen advance instead of placing one, but
      // it still remembers that a space came by, which is what decides whether a following
      // narrow gap ends the item.
      out.push({ x, y, size, table, cid, blank: invisible(table, cid) });
      x += (table.widthOf(cid) / 1000) * size;
    }
  };

  for (let m = tok.exec(stream); m; m = tok.exec(stream)) {
    if (m[0] === 'BT') {
      x = lx = y = ly = 0;
      size = 0;
      table = null;
      continue;
    }
    if (m[0] === 'ET') continue;
    // Tz, Tc, Tw, TL, T* and a pre-existing TJ all move the pen in ways this does not read.
    if (m[1] !== undefined) return null;
    if (m[2] !== undefined) {
      size = Number(m[3]);
      table = fonts.get(m[2]!) ?? null;
      if (!table) return null;
      continue;
    }
    if (m[4] !== undefined) {
      // `b` and `c` decide where a `Td` puts the pen, so a sheared matrix cannot be read
      // as a plain move or every gap on the line is invented.
      if (Number(m[4]) !== 1 || Number(m[5]) !== 0 || Number(m[6]) !== 0) return null;
      if (Number(m[7]) !== 1 && Number(m[7]) !== -1) return null;
      x = lx = Number(m[8]);
      y = ly = Number(m[9]);
      continue;
    }
    if (m[10] !== undefined) {
      lx += Number(m[10]);
      ly += Number(m[11]);
      x = lx;
      y = ly;
      continue;
    }
    if (m[12] !== undefined) show(m[12]!);
    else if (m[13] !== undefined) {
      for (const piece of m[13]!.split(/\s+/)) {
        if (!piece) continue;
        const hex = /^<([0-9A-Fa-f]*)>$/.exec(piece);
        if (hex) show(hex[1]!);
        else {
          const n = Number(piece);
          // A literal string inside TJ shows glyphs through an encoding this does not
          // read. Passing over it leaves the pen where it was and shifts every gap after
          // it, which is the one failure a report about gaps cannot have.
          if (!Number.isFinite(n)) return null;
          x -= (n / 1000) * size;
        }
      }
    } else return null;
  }
  return out;
}

/** pdf.js `NOT_A_SPACE_FACTOR`: tighter than this and a reader forgets the space before it. */
const NOT_A_SPACE = 0.03;

/** pdf.js's two-character window, which decides whether a thin gap ends an item. */
class LastChars {
  private two = [' ', ' '];
  private pos = 0;

  reset(): void {
    this.two = [' ', ' '];
    this.pos = 0;
  }

  /** Mirrors `shouldAddWhitespace`: a space, then a non-space, then this thin gap. */
  due(): boolean {
    return this.two[this.pos] !== ' ' && this.two[(this.pos + 1) % 2] === ' ';
  }

  save(ch: string): void {
    const next = (this.pos + 1) % 2;
    this.two[this.pos] = ch;
    this.pos = next;
  }
}

/**
 * Whether a document's word gaps fall outside the band, with the widest one measured.
 *
 * Returns null for a file whose text it cannot read, which is a different answer from a
 * file with no gaps.
 */
export function textFlow(pdf: Uint8Array): TextFlow | null {
  const parts: Parts | undefined = trySplit(pdf);
  if (!parts) return null;
  const cmaps = cmapStreams(pdf);
  const fonts = fontsByContent(parts, (num) => cmaps.get(num) ?? null);
  if (!fonts.size) return null;

  const flow: TextFlow = { ...EMPTY };

  for (const o of parts.objs) {
    const dict = dictOf(o);
    const range = streamRange(o.bytes);
    if (!range) continue;
    let text: string;
    try {
      const raw = o.bytes.subarray(range.start, range.end);
      text = (/FlateDecode/.test(dict) ? inflateSync(raw) : Buffer.from(raw)).toString(LATIN1);
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(text)) continue;
    flow.streams++;

    const pageFonts = fonts.get(o.num);
    if (!pageFonts) continue;
    // Mask first: without it an `ET`, a `Td` or a `TJ` inside a literal string is an
    // operator, and the block it ends is text this has not measured.
    const glyphs = glyphsOf(maskStrings(text), pageFonts);
    if (!glyphs) continue;
    flow.read++;
    flow.lines++;

    // One item spans the stream, as it does in a reader: a new text object does not end it.
    const last = new LastChars();
    let prev: Placed | null = null;
    for (const g of glyphs) {
      if (g.blank) {
        flow.glyphs++;
        last.save(' ');
        continue;
      }
      flow.glyphs++;
      if (prev) {
        const size = prev.size;
        // Text space throughout: `Tm` and `Td` operands are text space and a glyph
        // advance is width/1000 * size, all of which is the same space the font size is
        // in. A reader measures in device space and divides by the CTM scale to get here,
        // so dividing again would shrink every gap by that scale and make each threshold
        // behave as if the font were scale times larger.
        const gap = g.x - (prev.x + (prev.table.widthOf(prev.cid) / 1000) * prev.size);
        const rise = Math.abs(g.y - prev.y);

        // A move to another line is not a word gap, and Chromium writes the whole line from
        // its left margin, so at a line break the pen also jumps backwards. Testing the
        // horizontal move first books every line break as a backwards move and leaves
        // `lines` counting nothing, which is how a document with four hundred line breaks
        // reported thirty-nine.
        if (rise > VERTICAL * size) {
          flow.lines++;
          last.reset();
          prev = null;
          continue;
        }
        if (gap < NEGATIVE * size) {
          // Moving back within a line ends the item. That is a layout shape rather than a
          // word gap, so it is reported apart from them.
          flow.breaks++;
          flow.backwards++;
          last.reset();
        } else {
          flow.gaps++;
          const em = gap / size;
          // Only a gap that could be a word space is worth quoting: the widest one on a
          // table is the jump to the next column, and naming that as a stretched word
          // space would send whoever reads the finding to the wrong CSS property.
          if (em > flow.widest && em <= WORD_GAP_MAX) flow.widest = em;
          if (em > flow.widestAll) flow.widestAll = em;
          if (em < flow.narrowest) flow.narrowest = em;
          if (em <= NOT_A_SPACE) last.reset();
          if (em <= MIN_FLOW) {
            // Narrower than a tracking space. On its own that is absorbed into the run;
            // it only ends the item when a space glyph came just before it, because then
            // the reader would rather split than leave the layer misaligned.
            if (last.due()) {
              flow.breaks++;
              flow.tooThin++;
              last.reset();
            }
          } else if (em > MAX_FLOW) {
            flow.breaks++;
            if (em <= WORD_GAP_MAX) flow.tooWide++;
            else flow.jump++;
          }
        }
      }
      last.save(glyphText(g));
      prev = g;
    }
  }
  if (flow.narrowest === Number.POSITIVE_INFINITY) flow.narrowest = 0;
  // A document where not one stream could be read has no measurement to report, and a row
  // of zeroes read as "this document has no wide gaps" is the opposite of the truth.
  if (flow.read === 0) return null;
  return flow;
}

/** The character a placed glyph stands for, for the two-character window. */
function glyphText(g: Placed): string {
  const u = g.table.unicodeOf(g.cid);
  return u === '' ? ' ' : u[0]!;
}
