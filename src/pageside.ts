type ImageMeasurement = {
  at: number;
  from: number;
  to: number;
  ppi: number;
  url: string;
};

type ImageReplacement = { at: number; url: string };

export function measureImages(MAX: number): string {
  const report: ImageMeasurement[] = [];
  for (let i = 0; i < document.images.length; i++) {
    const img = document.images[i];
    if (!img || !img.naturalWidth) continue;
    const wIn = img.getBoundingClientRect().width / 96;
    if (!wIn) continue;
    const ppi = img.naturalWidth / wIn;
    if (ppi <= MAX) continue;
    const targetW = Math.max(1, Math.round(wIn * MAX));
    const scale = targetW / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    report.push({
      at: i,
      from: img.naturalWidth,
      to: canvas.width,
      ppi: Math.round(ppi),
      url: canvas.toDataURL('image/jpeg', 0.9),
    });
  }
  return JSON.stringify(report);
}

export function applyImageReplacements(swaps: ImageReplacement[]): boolean {
  for (const e of swaps) {
    const img = document.images[e.at];
    if (img) img.src = e.url;
  }
  return true;
}

export type WideGap = {
  selector: string;
  text: string;
  em: number;
  top: number;
  cause: 'flex-gap' | 'grid-gap' | 'margin' | 'space-between' | 'table-cell' | 'unknown';
};

export function wideGaps(limitEm = 0.6): WideGap[] {
  const shortSelector = (el: Element): string => {
    if (el.id) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 3 && node.nodeType === 1; depth++) {
      let part = node.tagName.toLowerCase();
      const cls = (node.getAttribute('class') ?? '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^(?:ng|css|sc)-/.test(c))
        .slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      parts.unshift(part);
      node = node.parentElement;
      if (node && node.tagName === 'BODY') {
        parts.unshift('body');
        break;
      }
    }
    return parts.join(' > ');
  };

  type Run = {
    left: number;
    right: number;
    top: number;
    height: number;
    el: Element;
    text: string;
  };
  const runs: Run[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    const text = node;
    node = walker.nextNode();
    const parent = text.parentElement;
    if (!parent || /^(?:SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
    if (!text.nodeValue || !text.nodeValue.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0 && r.height > 0)
        runs.push({
          left: r.left,
          right: r.right,
          top: r.top,
          height: r.height,
          el: parent,
          text: (text.nodeValue ?? '').trim().slice(0, 40),
        });
    }
    range.detach?.();
  }

  runs.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));

  const found = new Map<string, WideGap>();
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!;
    const cur = runs[i]!;
    if (Math.abs(cur.top - prev.top) > Math.max(2, prev.height / 2)) continue;
    if (prev.el === cur.el) continue;
    const gap = cur.left - prev.right;
    if (gap <= 0) continue;

    const size = parseFloat(getComputedStyle(cur.el).fontSize) || 16;
    const em = gap / size;
    if (em <= limitEm) continue;

    const prevStyle = getComputedStyle(prev.el);
    const curStyle = getComputedStyle(cur.el);
    const ownMargin =
      (parseFloat(prevStyle.marginRight) || 0) + (parseFloat(curStyle.marginLeft) || 0);

    let container: Element = prev.el;
    let spaced = false;
    for (let n = prev.el.parentElement; n; n = n.parentElement) {
      const d = getComputedStyle(n).display;
      if (d.includes('flex') || d.includes('grid') || /^(?:TD|TH)$/.test(n.tagName)) {
        container = n;
        spaced = /space-(?:between|around|evenly)/.test(getComputedStyle(n).justifyContent);
        break;
      }
      if (n.tagName === 'BODY') break;
    }
    const style = getComputedStyle(container);
    const display = style.display;
    const columnGap = parseFloat(style.columnGap || '0') || 0;
    const cause: WideGap['cause'] = /^(?:TD|TH)$/.test(container.tagName)
      ? 'table-cell'
      : spaced
        ? 'space-between'
        : ownMargin > 0.5
          ? 'margin'
          : display.includes('grid')
            ? columnGap > 0
              ? 'grid-gap'
              : 'unknown'
            : display.includes('flex')
              ? columnGap > 0
                ? 'flex-gap'
                : 'unknown'
              : 'unknown';

    const key = `${cause}:${shortSelector(cur.el)}:${Math.round(cur.top / 8)}`;
    if (found.has(key)) continue;
    found.set(key, {
      selector: `${shortSelector(prev.el)} -> ${shortSelector(cur.el)}`,
      text: cur.text,
      em: Math.round(em * 100) / 100,
      top: Math.round(cur.top),
      cause,
    });
  }
  return [...found.values()].sort((a, b) => b.em - a.em).slice(0, 20);
}

export async function collectLinkedCss(): Promise<number> {
  const urls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .map((l) => (l as HTMLLinkElement).href)
    .filter((h) => h && !h.startsWith('data:'))
    .slice(0, 8);
  const out: string[] = [];
  for (const u of urls) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(u, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      out.push((await res.text()).slice(0, 262144));
    } catch {
      continue;
    }
  }
  (globalThis as Record<string, unknown>).__letterpressLinkedCss = out;
  return out.length;
}

export type PageSideReport = {
  lang: string;
  imagesWithoutAlt: number;
  imagesEmptyAlt: number;
  imagesDecorative: number;
  figuresWithoutCaption: number;
  overflowing: Array<{ what: string; widthPx: number }>;
};

export function pageSideReport(printableWidthPx: number): PageSideReport {
  const scanOverflow = (): Array<{ what: string; widthPx: number }> => {
    const found: Array<{ what: string; widthPx: number }> = [];
    if (printableWidthPx <= 0) return found;
    const pageBox = document.body.getBoundingClientRect().width;
    const seen = new Set<string>();
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = el.getBoundingClientRect();
      const fixed = el.style.width.endsWith('px');
      const limit = fixed ? printableWidthPx : pageBox;
      if (rect.width <= limit) continue;
      if (Math.abs(rect.width - limit) < 0.5) continue;
      const what = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
      if (seen.has(el.tagName)) continue;
      seen.add(el.tagName);
      found.push({ what, widthPx: Math.round(rect.width * 10) / 10 });
      if (found.length >= 5) break;
    }
    return found;
  };

  const lang = document.documentElement.getAttribute('lang') ?? '';
  let imagesWithoutAlt = 0;
  let imagesEmptyAlt = 0;
  let imagesDecorative = 0;
  for (const img of Array.from(document.images)) {
    const role = img.getAttribute('role') ?? '';
    if (role === 'presentation' || role === 'none') {
      imagesDecorative++;
    } else if (!img.hasAttribute('alt')) {
      imagesWithoutAlt++;
    } else if (!img.getAttribute('alt')!.trim()) {
      imagesEmptyAlt++;
    }
  }

  let figuresWithoutCaption = 0;
  for (const fig of Array.from(document.querySelectorAll('figure'))) {
    if (fig.querySelector('figcaption')) continue;
    const named = Array.from(fig.querySelectorAll('img')).some(
      (img) => (img.getAttribute('alt') ?? '').trim() !== '',
    );
    if (named) continue;
    figuresWithoutCaption++;
  }

  return {
    lang,
    imagesWithoutAlt,
    imagesEmptyAlt,
    imagesDecorative,
    figuresWithoutCaption,
    overflowing: scanOverflow(),
  };
}

export function fontProbe(): Array<{ family: string; elements: number }> {
  const generic =
    /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-|math|emoji|fangsong|inherit|initial)$/i;
  const drawsText = (el: Element): boolean => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && (node.textContent ?? '').trim()) return true;
    }
    return false;
  };

  const wanted = (el: Element): string => {
    const want = getComputedStyle(el)
      .fontFamily.split(',')[0]!
      .trim()
      .replace(/^["']|["']$/g, '');
    return generic.test(want) ? '' : want;
  };

  const asks: CSSStyleRule[] = [];
  const seen = new Set<StyleSheet>();
  const collect = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.style?.fontFamily) asks.push(rule);
      const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
      if (nested && nested.length) collect(nested);
      if (rule instanceof CSSImportRule && rule.styleSheet && !seen.has(rule.styleSheet)) {
        seen.add(rule.styleSheet);
        try {
          collect(rule.styleSheet.cssRules);
        } catch {
          continue;
        }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      continue;
    }
  }

  const memo = new Map<Element, boolean>();
  const askOn = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      let hit = memo.get(n);
      if (hit === undefined) {
        const inline = (n as { style?: { fontFamily?: string } }).style?.fontFamily ?? '';
        hit = inline !== '';
        if (!hit) {
          for (const rule of asks) {
            if (n.matches(rule.selectorText)) {
              hit = true;
              break;
            }
          }
        }
        memo.set(n, hit);
      }
      if (hit) return true;
    }
    return false;
  };

  const counts = new Map<string, number>();
  const first = new Map<string, HTMLElement>();
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    if (!drawsText(el)) continue;
    const want = wanted(el);
    if (!want || !askOn(el)) continue;
    counts.set(want, (counts.get(want) ?? 0) + 1);
    if (!first.has(want)) first.set(want, el);
  }
  if (!counts.size) return [];

  const loaded = new Set<string>();
  for (const face of Array.from(document.fonts as unknown as Iterable<FontFace>)) {
    if (face.status === 'loaded') loaded.add(face.family);
  }

  const found: Array<{ family: string; elements: number }> = [];
  for (const [family, elements] of counts) {
    if (loaded.has(family)) continue;
    first.get(family)!.setAttribute('data-lp-font', String(found.length));
    found.push({ family, elements });
  }
  return found.slice(0, 20);
}

export function roleCensus(): string {
  const tags = new Set(['nav', 'main', 'section', 'header', 'footer', 'dl', 'dt', 'dd']);
  const els = Array.from(
    document.querySelectorAll('nav, main, section, header, footer, dl, dt, dd'),
  );
  for (const el of els) if (!tags.has(el.tagName.toLowerCase())) return '';
  const index = new Map<Element, number>();
  els.forEach((el, i) => index.set(el, i));
  const out: Array<{ tag: string; text: string; owner: number }> = [];
  els.forEach((el) => {
    let owner = -1;
    let p = el.parentElement;
    while (p) {
      if (index.has(p)) {
        owner = index.get(p)!;
        break;
      }
      p = p.parentElement;
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').replace(/\s+/g, ''),
      owner,
    });
  });
  return JSON.stringify(out);
}
