/**
 * Removing Chromium's /ActualText spans, and only when they say nothing the file does
 * not already say.
 *
 * Chromium wraps every ligature in a marked-content span carrying `/ActualText`:
 *
 *     /Span<</ActualText (fi) >> BDC [-0.000231 <0864>] TJ EMC
 *
 * A reader ends a text item at each one whatever the spacing says, so a page of ordinary
 * prose comes back as sixty text items where the geometry alone gives seven. Dragging a
 * selection across it draws sixty highlight boxes, seventeen of them for gaps that are not
 * there, and the result reads as random rather than as a paragraph.
 *
 * Measured in Firefox on one page: sixty items and seventeen whitespace items as rendered,
 * seven and none with the spans gone. Seven is seven lines. Extraction is byte-identical,
 * because the font's `/ToUnicode` already maps the ligature glyph to the two characters the
 * span names -- the span is saying what the file already says.
 *
 * Which is the whole guard. A span is removed only when the text its `/ActualText` declares
 * is exactly what the glyphs inside it resolve to through `/ToUnicode`. Where the two
 * disagree the span is the only copy of that text and it stays, because removing it would
 * lose a character and leave the PDF quietly wrong. This is why the repair is safe to make
 * the default rather than an option.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { LATIN1, dictOf, join, streamRange, trySplit, type Obj, type Parts } from './pdfparts.ts';
import { cmapStreams, fontsByContent, type FontTable } from './textfont.ts';

export type SpanStats = {
  /** Marked-content spans carrying `/ActualText`, ligature or not. */
  seen: number;
  /** Removed, because `/ToUnicode` already gave the same characters. */
  stripped: number;
  /** Kept, because the span was the only place that text appears. */
  kept: number;
};

const EMPTY: SpanStats = { seen: 0, stripped: 0, kept: 0 };

/**
 * Chromium's own shape: `/Span<</ActualText (fi) >> BDC`.
 *
 * The dictionary body is `[^<>]*` and nothing more. The first version allowed `<<` and `>>`
 * inside it, which is correct PDF and catastrophic here: the body is greedy, so it ran past
 * this span's closing `>>` through the glyph operators and the `EMC`, all the way to a later
 * span's `>> BDC`. The cut then removed everything between, which took the glyphs with it --
 * every "fills" printed as "lls" -- and left the `EMC`s behind, so the content stream no
 * longer balanced. `verify()` passed it. A file missing a letter is still a valid file.
 */
const SPAN_OPEN = /\/Span\s*<<([^<>]*)>>\s*BDC/g;

function unescapePdfString(s: string): string {
  const inner =
    s[0] === '<'
      ? Buffer.from(s.slice(1, -1).replace(/\s/g, ''), 'hex').toString(LATIN1)
      : s.slice(1, -1);
  return inner.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (c >= '0' && c <= '7') return String.fromCharCode(parseInt(c, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c;
  });
}

/** The character codes a TJ or Tj shows, in order. */
function codesIn(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/<([0-9A-Fa-f\s]*)>\s*(?:TJ|Tj)?/g)) {
    const hex = (m[1] ?? '').replace(/\s/g, '');
    if (hex.length % 4 === 0 && hex.length > 0) {
      for (let i = 0; i < hex.length; i += 4) out.push(parseInt(hex.slice(i, i + 4), 16));
    } else if (hex.length % 2 === 0) {
      for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return out;
}

/** The font in force at `at`, from the last `/Name ... Tf` before it. */
function fontBefore(text: string, at: number, fonts: Map<string, FontTable>): FontTable | null {
  let name: string | undefined;
  for (const m of text.slice(0, at).matchAll(/\/(\w+)\s+[\d.]+\s+Tf/g)) name = m[1];
  return name ? (fonts.get(name) ?? null) : null;
}

/**
 * Strip every `/ActualText` span that repeats what `/ToUnicode` already resolves to.
 *
 * Content streams are rewritten in place, so this is the one repair that touches the text a
 * reader sees. It is the same shape of rewrite `mergeTextRuns` does and it goes through the
 * same gate.
 */
export function stripRedundantSpans(pdf: Uint8Array): { pdf: Uint8Array; stats: SpanStats } {
  const stats: SpanStats = { ...EMPTY };
  const parts: Parts | undefined = trySplit(pdf);
  if (!parts) return { pdf, stats };
  const cmaps = cmapStreams(pdf);
  const byContent = fontsByContent(parts, (num) => cmaps.get(num) ?? null);
  const objs = parts.objs.map((o) => stripInStream(o, byContent.get(o.num), stats));
  return { pdf: join(parts.head, objs, parts.trailer), stats };
}

/** The cuts a stream's spans imply, and the counts, without rewriting anything. */
function stripInStream(o: Obj, fonts: Map<string, FontTable> | undefined, stats: SpanStats): Obj {
  const dict = dictOf(o);
  const range = streamRange(o.bytes);
  if (!range) return o;
  const compressed = /FlateDecode/.test(dict);
  let text: string;
  try {
    const raw = o.bytes.subarray(range.start, range.end);
    text = (compressed ? inflateSync(raw) : Buffer.from(raw)).toString(LATIN1);
  } catch {
    return o;
  }
  // Counted before the font check, because this count is what the finding reports. A span in
  // a stream whose fonts cannot be resolved is left alone and not repaired, so a count taken
  // afterwards omitted it: the document carried 36 spans and the finding said "removed 18 of
  // 18" while 18 of them were still in the file.
  stats.seen += (text.match(/\/ActualText/g) ?? []).length;
  if (!/\/ActualText/.test(text)) return o;
  if (!fonts?.size) return o;

  // Replace from the end so an earlier offset stays valid, and emit exactly the region the
  // span covered: the marked-content wrapper goes, the glyph operations stay.
  const cuts: Array<{ start: number; end: number }> = [];
  SPAN_OPEN.lastIndex = 0;
  for (let m = SPAN_OPEN.exec(text); m; m = SPAN_OPEN.exec(text)) {
    const actual = /\/ActualText\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(m[1] ?? '');
    if (!actual) continue;
    const declared = unescapePdfString(actual[1] ?? '');
    if (!declared) continue;

    // The span runs to the next EMC. A span that never closes is not one to reason about.
    const emc = text.indexOf('EMC', SPAN_OPEN.lastIndex);
    if (emc < 0) continue;
    const bodyStart = SPAN_OPEN.lastIndex;
    const body = text.slice(bodyStart, emc);

    const table = fontBefore(text, m.index, fonts);
    const resolved = table
      ? codesIn(body)
          .map((c) => table.unicodeOf(c))
          .join('')
      : '';
    // Not merely equal: the span must have covered something, or a span holding a single
    // glyph that resolves to nothing would compare equal to an empty ActualText.
    if (resolved && resolved === declared) {
      stats.stripped++;
      // Two removals, not one. The first version cut from `/Span` through `EMC` and took
      // the glyph operations with it, so every "fills" printed as "lls" -- and `verify()`
      // passed the result, because a file with a letter missing is still a valid file.
      // Structural validity is not content correctness, and only comparing the extracted
      // text against the original found it.
      cuts.push({ start: m.index, end: bodyStart });
      cuts.push({ start: emc, end: emc + 3 });
    } else {
      stats.kept++;
    }
  }

  if (!cuts.length) return o;

  // Highest offset first, so an earlier cut stays valid.
  cuts.sort((a, b) => b.start - a.start);
  let out = text;
  // Every cut is unconditional. The first version guarded each one with
  // `/ActualText/.test(region)`, which is right for the opening and wrong for the closing:
  // the text of a bare `EMC` contains no `/ActualText`, so all nineteen closings were
  // skipped and the stream was left with one `BDC` against nineteen `EMC`. poppler called
  // it "Mismatched EMC operator" and carried on. A guard that silently drops half the work
  // is worse than no guard.
  for (const c of cuts) out = out.slice(0, c.start) + ' ' + out.slice(c.end);
  if (out === text) return o;

  const payload = Buffer.from(out, LATIN1);
  const bodyBytes = compressed ? deflateSync(payload) : payload;
  const head = dictOf(o)
    .replace(/\/Length\s+\d+/, `/Length ${bodyBytes.length}`)
    .trim();
  return {
    num: o.num,
    bytes: Buffer.concat([
      Buffer.from(`${head}\nstream\n`, LATIN1),
      bodyBytes,
      Buffer.from('\nendstream\nendobj\n', LATIN1),
    ]),
  };
}
