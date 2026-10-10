/**
 * Render a set of documents that exercise what the engine does, so the output can be
 * looked at rather than asserted about. Each page is chosen to make a different thing
 * visible: spacing under justification, hairlines in a table, script coverage beyond
 * Latin, page furniture, and the copy-paste path.
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.ts';
import { render } from '../src/render.ts';
import { pdfInfo, pdfText, pdfWords } from '../test/poppler.ts';

const OUT = join(tmpdir(), 'letterpress-samples');

type Doc = { name: string; note: string; html: string };

const SERIF = `'Noto Serif', Georgia, serif`;
const SANS = `'Noto Sans', Helvetica, sans-serif`;

const page = (css: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
     ${css}
   </style></head><body>${body}</body></html>`;

const DOCS: Doc[] = [
  {
    name: '1-typography',
    note: 'justified body at 10.5pt, ligatures, kerning, hanging punctuation, small caps',
    html: page(
      `@page{size:A4;margin:22mm 20mm}
       body{font-family:${SERIF};font-size:10.5pt;line-height:1.55;color:#111}
       p{margin:0 0 .7em;text-align:justify;hyphens:auto}
       p+p{text-indent:1.4em}
       .lead{font-size:12.5pt;line-height:1.45;text-indent:0}
       .lead::first-letter{float:left;font-size:46pt;line-height:.86;padding:.04em .08em 0 0}
       h1{font-size:21pt;line-height:1.15;margin:0 0 .1em;font-weight:600;letter-spacing:-.011em}
       .byline{font-family:${SANS};font-size:9pt;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:0 0 1.8em}
       .sc{font-variant-caps:small-caps;letter-spacing:.04em}
       hr{border:0;border-top:.4pt solid #bbb;margin:1.6em 0}
       .note{font-size:9pt;color:#555;text-align:justify}`,
      `<h1>On the Legibility of Small Type</h1>
       <p class="byline">A specimen &middot; set in Noto Serif</p>
       <p class="lead">Typography is the craft of endowing human language with a durable
       visual form. The typographer must therefore establish a rhythm, a texture, and a
       temperature &mdash; and must do so in a material that does not forgive carelessness.</p>
       <p>WAVE To. Pack my box with five dozen liquor jugs, and consider the office that
       efficient, affluent and difficult people occupy. A well-set page gives the eye a
       path to follow: the measure is short enough that the return sweep is accurate, and
       long enough that the line holds its shape. Justification, the oldest trick in the
       book, works only when the spaces between words are nearly equal.</p>
       <p>Such a page is not made by setting every space to the same width. The intervals
       differ by a fraction, and what the reader perceives as evenness is the eye averaging
       what it cannot measure. The <span class="sc">small capitals</span> of a byline, the
       hyphen that ends a line, the figures that must align in a column &mdash; each is a
       decision with a cost, and each cost is a debt paid by someone reading later.</p>
       <hr>
       <p class="note">This page is rendered by Chromium's print engine and then repaired.
       Its glyph positions are folded into <span class="sc">TJ</span> arrays after the fact,
       with every position verified against the original before the result is kept.</p>`,
    ),
  },
  {
    name: '2-multipage',
    note: 'running header and footer, page numbers, forced breaks, widow and orphan control',
    html: page(
      `@page{size:A4;margin:20mm 18mm}
       @page{@top-center{content:"The Quarterly Review"};@bottom-right{content:counter(page) " / " counter(pages)}}
       body{font-family:${SERIF};font-size:11pt;line-height:1.5}
       h2{font-size:14pt;margin:1.4em 0 .4em;font-weight:600}
       h2:first-of-type{margin-top:0}
       p{margin:0 0 .75em;text-align:justify}
       .page{break-after:page}
       .page:last-child{break-after:auto}`,
      [
        ...Array.from(
          { length: 3 },
          (_, i) => `
        <section class="page">
          <h2>Chapter ${i + 1}</h2>
          <p>${'The reader of a long document should never have to ask where they are. A running head names the work, a folio numbers the leaf, and the margin holds both without intruding on the text. '.repeat(6)}</p>
          <h2>A second heading</h2>
          <p>${'Kerning is the adjustment of the space between two letters so that the pair looks right rather than merely fits. '.repeat(7)}</p>
        </section>`,
        ),
      ].join(''),
    ),
  },
  {
    name: '3-table',
    note: 'hairline rules, right-aligned figures, repeating header row, dense grid',
    html: page(
      `@page{size:A4;margin:18mm}
       body{font-family:${SANS};font-size:8.5pt}
       h1{font-size:15pt;margin:0 0 .3em}
       .sub{color:#666;font-size:9pt;margin:0 0 1.2em}
       table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
       thead{display:table-header-group}
       th{font-weight:600;text-align:left;border-bottom:.6pt solid #333;padding:4pt 6pt}
       td{padding:3.2pt 6pt;border-bottom:.3pt solid #ddd}
       tbody tr:nth-child(even){background:#fafafa}
       .n{text-align:right}
       tfoot td{border-top:.6pt solid #333;border-bottom:0;font-weight:600;padding-top:5pt}`,
      `<h1>Measurements</h1>
       <p class="sub">Averaging five runs, micrometres, 95% interval</p>
       <table>
         <thead><tr><th>Sample</th><th class="n">Mean</th><th class="n">Low</th><th class="n">High</th><th class="n">n</th><th>Note</th></tr></thead>
         <tbody>${Array.from({ length: 34 }, (_, i) => {
           const m = 12 + i * 0.37;
           return `<tr><td>S-${String(i + 1).padStart(3, '0')}</td><td class="n">${m.toFixed(3)}</td><td class="n">${(m - 0.4).toFixed(3)}</td><td class="n">${(m + 0.4).toFixed(3)}</td><td class="n">${1000 + i * 7}</td><td>${['baseline', 'after cut', 're-run', 're-run', 'control'][i % 5]}</td></tr>`;
         }).join('')}</tbody>
         <tfoot><tr><td>Mean</td><td class="n">18.110</td><td class="n">17.710</td><td class="n">18.510</td><td class="n">10453</td><td></td></tr></tfoot>
       </table>`,
    ),
  },
  {
    name: '4-multilingual',
    note: 'CJK, Cyrillic, Greek, Arabic, Devanagari, accents, ligatures',
    html: page(
      `@page{size:A4;margin:20mm}
       body{font-family:${SANS};font-size:13pt;line-height:2}
       h2{font-size:10pt;letter-spacing:.1em;text-transform:uppercase;color:#888;margin:1.2em 0 .2em;font-weight:600}
       p{margin:0}`,
      `<h2>Latin, with the accents the type carries</h2>
       <p>Crème brûlée, naïve piñata, façade, Ångström, Žluťoučký kůň.</p>
       <h2>Ligatures and figures</h2>
       <p>office&nbsp;affluent&nbsp;difficult &mdash; flags, ff fi fl ffi ffl, 1,234,567.89</p>
       <h2>Cyrillic and Greek</h2>
       <p>Съешь же ещё этих мягких французских булок</p>
       <p>Ξεσκεπάζω την ψυχοφθόρα βδελυγμία</p>
       <h2>Arabic</h2>
       <p lang="ar" dir="auto">نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر ومغلف بجلد أزرق</p>
       <h2>Devanagari and Tamil</h2>
       <p>उसने कहा कि यह किताब बहुत अच्छी है</p>
       <p>நான் உங்களுக்கு ஒரு புதிய புத்தகம் தருகிறேன்</p>
       <h2>Japanese</h2>
       <p>吾輩は猫である。名前はまだ無い。</p>
       <p>いろはにほへとちりぬるを わかよたれそつねならむ</p>
       <h2>Korean</h2>
       <p>다람쥐 헌 쳇바퀴에 타고파</p>`,
    ),
  },
  {
    name: '5-web-page',
    note: 'an ordinary styled HTML page: nav, cards, code, links, lists',
    html: page(
      `@page{size:A4;margin:16mm}
       *{box-sizing:border-box}
       body{font-family:${SANS};font-size:10.5pt;line-height:1.6;color:#16181d;margin:0}
       nav{display:flex;gap:18px;align-items:center;border-bottom:.5pt solid #e3e5ea;padding-bottom:10px;margin-bottom:18px}
       nav b{font-size:13pt;letter-spacing:-.02em}
       nav a{color:#5b6472;text-decoration:none;font-size:9.5pt}
       nav .pill{margin-left:auto;background:#16181d;color:#fff;border-radius:999px;padding:3px 10px;font-size:9pt}
       h1{font-size:24pt;letter-spacing:-.02em;line-height:1.15;margin:0 0 .3em}
       .lede{font-size:12.5pt;color:#5b6472;margin:0 0 1.5em}
       .cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 18px}
       .card{border:.5pt solid #e3e5ea;border-radius:8px;padding:11px 13px}
       .card h3{margin:0 0 .25em;font-size:11.5pt}
       .card p{margin:0;color:#5b6472;font-size:9.5pt}
       code{font-family:'Noto Sans Mono',monospace;font-size:9pt;background:#f4f5f7;padding:1px 4px;border-radius:3px}
       pre{font-family:'Noto Sans Mono',monospace;font-size:9pt;background:#f4f5f7;border-left:2pt solid #16181d;padding:9px 12px;overflow:hidden}
       ul{margin:.3em 0 1em;padding-left:1.2em}
       li{margin:.15em 0}
       a{color:#1a56c4}
       table{width:100%;border-collapse:collapse;font-size:9.5pt;margin:0 0 1.2em}
       td,th{padding:5px 8px;border-bottom:.3pt solid #e3e5ea;text-align:left}
       th{font-weight:600}`,
      `<nav><b>Letterpress</b><a href="#a">Overview</a><a href="#b">API</a><a href="#c">Limits</a><a href="#d">Source</a><span class="pill">v1.0</span></nav>
       <h1>HTML to PDF, with the text left intact</h1>
       <p class="lede">Chromium lays the page out. Everything after that is a repair pass, each one proved against the bytes it started from.</p>
       <div class="cards">
         <div class="card"><h3>Fonts stay embedded</h3><p>Every font referenced by the page travels inside the file, subset to the glyphs actually used, with a ToUnicode map so copy-paste returns the original characters.</p></div>
         <div class="card"><h3>Links stay clickable</h3><p>Anchor targets become real link annotations with the correct rectangles, rather than blue underlines that go nowhere.</p></div>
         <div class="card"><h3>Text stays selectable</h3><p>Glyph positions are verified after every rewrite. A repair that would move a glyph is discarded rather than shipped.</p></div>
         <div class="card"><h3>The document stays tagged</h3><p>Structure and language survive the round trip, which is what a screen reader needs and what most converters throw away.</p></div>
       </div>
       <h3 id="b">Calling it</h3>
       <pre>letterpress --in page.html --out page.pdf --title "Report"</pre>
       <table><tr><th>Option</th><th>Meaning</th></tr>
       <tr><td><code>--root</code></td><td>the directory assets may be read from</td></tr>
       <tr><td><code>--timeout</code></td><td>how long the browser gets, in milliseconds</td></tr>
       <tr><td><code>--landscape</code></td><td>swap the page dimensions</td></tr></table>
       <ul><li>Relative images resolve against the document.</li>
       <li>Stylesheet <code>@import</code> and module imports are followed.</li>
       <li>A path outside <code>--root</code> is refused and reported.</li></ul>`,
    ),
  },
];

await rm(OUT, { recursive: true, force: true }).catch(() => {});
await mkdir(OUT, { recursive: true });
const profile = join(tmpdir(), `letterpress-samples-${Date.now()}`);
const browser = await Browser.launch({ profile });

console.log(`\n  writing to ${OUT}\n`);
for (const doc of DOCS) {
  const r = await render(browser, {
    html: doc.html,
    author: 'letterpress samples',
    title: doc.note,
    subject: 'rendered with src/render.ts',
  });
  const path = join(OUT, `${doc.name}.pdf`);
  await Bun.write(path, r.pdf);
  await Bun.$`pdftoppm -png -r 96 -f 1 -l 1 ${path} ${join(OUT, doc.name)}`.quiet();
  const info = await pdfInfo(r.pdf);
  const words = (await pdfWords(r.pdf)).length;
  const chars = (await pdfText(r.pdf)).replace(/\s+/g, '').length;
  const notes = r.findings.length === 0 ? 'no findings' : r.findings.map((f) => f.code).join(' ');
  console.log(
    `  ${doc.name.padEnd(17)} ${String(info.pages).padStart(2)}p  ` +
      `${String(Math.round(r.pdf.byteLength / 1024)).padStart(4)}KB  ` +
      `${String(words).padStart(4)} words  ${String(chars).padStart(5)} chars   ${notes}`,
  );
  console.log(`  ${' '.repeat(17)} ${doc.note}`);
}

await browser.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log('');
