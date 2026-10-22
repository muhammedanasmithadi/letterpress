import { deflateSync } from 'node:zlib';
import {
  LATIN1,
  dictOf,
  hasPostTrailerObjects,
  isEncrypted,
  join,
  streamRange,
  trySplit,
  type Obj,
  type Parts,
  cappedInflate,
} from './pdfparts.ts';
import { cmapStreams, fontsByContent, type FontTable } from './textfont.ts';

type SpanStats = {
  seen: number;
  stripped: number;
  kept: number;
};

const EMPTY: SpanStats = { seen: 0, stripped: 0, kept: 0 };

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

function fontBefore(text: string, at: number, fonts: Map<string, FontTable>): FontTable | null {
  let name: string | undefined;
  for (const m of text.slice(0, at).matchAll(/\/(\w+)\s+[\d.]+\s+Tf/g)) name = m[1];
  return name ? (fonts.get(name) ?? null) : null;
}

export function stripRedundantSpans(pdf: Uint8Array): { pdf: Uint8Array; stats: SpanStats } {
  const stats: SpanStats = { ...EMPTY };
  if (hasPostTrailerObjects(pdf)) return { pdf, stats };
  if (isEncrypted(pdf)) return { pdf, stats };
  const parts: Parts | undefined = trySplit(pdf);
  if (!parts) return { pdf, stats };
  const cmaps = cmapStreams(pdf);
  const byContent = fontsByContent(parts, (num) => cmaps.get(num) ?? null);
  const objs = parts.objs.map((o) => stripInStream(o, byContent.get(o.num), stats));
  return { pdf: join(parts.head, objs, parts.trailer), stats };
}

function stripInStream(o: Obj, fonts: Map<string, FontTable> | undefined, stats: SpanStats): Obj {
  const dict = dictOf(o);
  const range = streamRange(o.bytes);
  if (!range) return o;
  const compressed = /FlateDecode/.test(dict);
  let text: string;
  try {
    const raw = o.bytes.subarray(range.start, range.end);
    text = (compressed ? cappedInflate(raw) : Buffer.from(raw)).toString(LATIN1);
  } catch {
    return o;
  }
  stats.seen += (text.match(/\/ActualText/g) ?? []).length;
  if (!/\/ActualText/.test(text)) return o;
  if (!fonts?.size) return o;

  const cuts: Array<{ start: number; end: number }> = [];
  SPAN_OPEN.lastIndex = 0;
  for (let m = SPAN_OPEN.exec(text); m; m = SPAN_OPEN.exec(text)) {
    const actual = /\/ActualText\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.exec(m[1] ?? '');
    if (!actual) continue;
    const declared = unescapePdfString(actual[1] ?? '');
    if (!declared) continue;

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
    if (resolved && resolved === declared) {
      stats.stripped++;
      cuts.push({ start: m.index, end: bodyStart });
      cuts.push({ start: emc, end: emc + 3 });
    } else {
      stats.kept++;
    }
  }

  if (!cuts.length) return o;

  cuts.sort((a, b) => b.start - a.start);
  let out = text;
  for (const c of cuts) out = out.slice(0, c.start) + ' ' + out.slice(c.end);
  if (out === text) return o;

  const payload = Buffer.from(out, LATIN1);
  const bodyBytes = compressed ? deflateSync(payload) : payload;
  const head = dictOf(o)
    .replace(/\/Length\s+(?:\d+\s+0\s+R|\d+)/, `/Length ${bodyBytes.length}`)
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
