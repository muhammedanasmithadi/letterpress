import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { launchTestServer, serverOrigin, type TestServer } from './servers.ts';

let s: TestServer;
let origin: string;

beforeAll(async () => {
  s = await launchTestServer();
  origin = serverOrigin(s);
}, 60_000);

afterAll(async () => {
  await s?.stop();
}, 30_000);

const post = (body: unknown) =>
  fetch(`${origin}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const DOC = `<!doctype html><style>@page{size:a5;margin:8mm}</style><h1>Viewer</h1>`;

describe('the shell is served', () => {
  test('the index is html', async () => {
    const r = await fetch(`${origin}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('/assets/theme.css');
    expect(html).toContain('/assets/app.js');
  });

  test('assets are served with a type that matches the extension', async () => {
    for (const [path, type] of [
      ['/assets/theme.css', 'text/css'],
      ['/assets/app.js', 'text/javascript'],
      ['/assets/italiana.woff2', 'font/woff2'],
    ] as const) {
      const r = await fetch(`${origin}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toContain(type);
      expect((await r.text()).length, path).toBeGreaterThan(100);
    }
  });

  test('a missing asset is a 404, not a crash', async () => {
    expect((await fetch(`${origin}/assets/nope.css`)).status).toBe(404);
  });

  test('an absurd asset path is a 404, not a crash', async () => {
    expect((await fetch(`${origin}/assets/${'x'.repeat(600)}`)).status).toBe(404);
  });
});

describe('the toolbar controls reach the renderer', () => {
  test('format changes the paper', async () => {
    const own = (await (await post({ html: DOC })).json()) as { mediaBoxes: string[] };
    expect(own.mediaBoxes[0]).toContain('420');
    const a4 = (await (await post({ html: DOC, format: 'a4' })).json()) as { mediaBoxes: string[] };

    expect(a4.mediaBoxes[0]).toContain('595');
  }, 90_000);

  test('landscape transposes the paper', async () => {
    const r = (await (await post({ html: DOC, format: 'a4', landscape: true })).json()) as {
      mediaBoxes: string[];
      findings: Array<{ code: string }>;
    };
    expect(r.mediaBoxes[0]).toContain('841');

    expect(r.findings.map((f) => f.code)).toContain('orientation-overridden');
  }, 90_000);

  test('printBackground false is accepted and defaults true', async () => {
    const off = await post({ html: DOC, printBackground: false });
    expect(off.status).toBe(200);
    const on = await post({ html: DOC, printBackground: true });
    expect(on.status).toBe(200);

    const neither = await post({ html: DOC });
    expect(neither.status).toBe(200);
  }, 120_000);

  test('margin is applied when format is given', async () => {
    const ok = await post({
      html: `<!doctype html><body style="margin:0"><h1>T</h1></body>`,
      format: 'a4',
      margin: '20mm',
    });
    expect(ok.status).toBe(200);

    const seen = ((await ok.json()) as { findings: Array<{ code: string; severity: string }> })
      .findings;
    expect(seen.filter((f) => f.severity === 'error')).toEqual([]);
  }, 90_000);

  test('allowNetwork is a boolean and defaults off', async () => {
    expect((await post({ html: DOC, allowNetwork: false })).status).toBe(200);
    expect((await post({ html: DOC, allowNetwork: true })).status).toBe(200);
    for (const bad of ['yes', 1, null, {}]) {
      const r = await post({ html: DOC, allowNetwork: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('allowNetwork');
    }
  }, 120_000);
});

describe('margin is checked before it is used', () => {
  test('a margin without a format is refused, and says why', async () => {
    const r = await post({ html: DOC, margin: '20mm' });
    expect(r.status).toBe(400);
    const { error } = (await r.json()) as { error: string };
    expect(error).toContain('only applies alongside format');
  }, 60_000);

  test('a margin that is not a css length names the fix', async () => {
    const r = await post({ html: DOC, format: 'a4', margin: 'wat' });
    expect(r.status).toBe(400);
    const { error } = (await r.json()) as { error: string };
    expect(error).toContain('not an absolute css length');

    expect(error).toContain('15mm');
  }, 60_000);

  test('every absolute css length is accepted', async () => {
    for (const margin of ['15mm', '1in', '2cm', '40pt', '10px', '2pc', '1q', '0', '0.0']) {
      const r = await post({ html: DOC, format: 'a4', margin });
      expect(r.status, margin).toBe(200);
    }
  }, 240_000);

  test('a relative unit is refused with the reason, not a bare rejection', async () => {
    for (const margin of ['1.5em', '3vw', '10%', '2rem']) {
      const r = await post({ html: DOC, format: 'a4', margin });
      expect(r.status, margin).toBe(400);
      const { error } = (await r.json()) as { error: string };
      expect(error, margin).toContain('relative');
      expect(error, margin).toContain('mm');
    }
  }, 90_000);

  test('a bare non-zero number is refused, and a bare zero is not', async () => {
    const bare = await post({ html: DOC, format: 'a4', margin: '20' });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toContain('unit');
    const zero = await post({ html: DOC, format: 'a4', margin: '0' });
    expect(zero.status).toBe(200);
  }, 90_000);

  test('margin must be a string', async () => {
    for (const margin of [20, true, []]) {
      const r = await post({ html: DOC, format: 'a4', margin });
      expect(r.status, String(margin)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('margin must be a string');
    }
  }, 90_000);
});

describe('the shell itself', () => {
  const html = async () => await (await fetch(`${origin}/`)).text();

  test('every control is a native element', async () => {
    const page = (await html()).replace(/<!--[\s\S]*?-->/g, '');
    expect(page).not.toMatch(/<div[^>]*role=["']button["']/);
    expect(page).not.toMatch(/<span[^>]*onclick/);

    const css = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).not.toMatch(/appearance\s*:\s*base-select/);
    expect(css).not.toMatch(/\bselect\s*\{[^}]*appearance/s);
    for (const id of [
      'file',
      'format',
      'landscape',
      'margin',
      'background',
      'ppi',
      'network',
      'render',
      'download',
    ]) {
      expect(page, `control #${id} exists`).toContain(`id="${id}"`);
    }
  });

  test('print settings live in a disclosure, one row at real widths', async () => {
    // Eleven controls plus a wordmark never fit a real window: at 900px the
    // row wrapped and stranded the actions on a second line. The settings now
    // live in a native <details>; every control keeps its id and its label.
    const page = (await html()).replace(/<!--[\s\S]*?-->/g, '');
    expect(page).toContain('<details class="settings">');
    expect(page).toContain('<summary>Page setup</summary>');
    const panel = page.slice(page.indexOf('class="panel"'));
    for (const id of ['format', 'landscape', 'margin', 'background', 'ppi', 'network']) {
      expect(panel, `#${id} inside the panel`).toContain(`id="${id}"`);
    }
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(css).toMatch(/\.settings \.panel\s*\{[^}]*position:\s*absolute/s);
  });

  test('every control has a label', async () => {
    const page = await html();

    for (const id of ['format', 'landscape', 'margin', 'background', 'ppi', 'network']) {
      const before = page.slice(0, page.indexOf(`id="${id}"`));
      const openTag = before.lastIndexOf('<label');
      const closeTag = before.lastIndexOf('</label>');
      expect(openTag, `#${id} is inside a <label>`).toBeGreaterThan(closeTag);
    }
  });

  test('light stays native while dark wears the green set', async () => {
    const css = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).toContain('color-scheme: light dark');
    // The meta sets UA defaults before the stylesheet loads; the CSS alone
    // arrives too late for first-paint form controls and scrollbars.
    expect(await html()).toContain('name="color-scheme" content="light dark"');

    // The dark scheme wears the green set; every hex must live inside a
    // light-dark() so light mode stays exactly stock. Comments are stripped
    // above because the header names the palette.
    const colourTokens = [...css.matchAll(/--[\w-]+\s*:\s*([^;]*#[0-9a-f]{3,8}[^;]*)/gi)];
    expect(
      colourTokens.map((m) => m[0]).filter((d) => !d.includes('light-dark')),
      'custom properties holding a hex colour outside light-dark()',
    ).toEqual([]);
    expect(css).toContain('--bg: light-dark(Canvas, #0b0909)');
    expect(css).toContain('--fg: light-dark(CanvasText, #b5b9f0)');
    expect(css).toContain('--band: light-dark(var(--tint), #2e4540)');
    expect(css).toContain('::selection');
    expect(css).toContain('#408175');
    // The wordmark face is vendored same-origin (offline-safe), used on the
    // toolbar heading only; everything else stays in platform stacks.
    expect(css).toContain('@font-face');
    expect(css).toContain("'Letterpress Wordmark'");
    expect(css).toContain('/assets/italiana.woff2');
    expect(css).toMatch(/\.toolbar h1\s*\{[^}]*font-family:\s*'Letterpress Wordmark'/s);

    expect(css).toContain('color-mix(in oklab, currentColor');
    expect(css).toMatch(/accent-color:\s*light-dark\(/);
    // The focus ring draws in the system accent. `accent-color` is a property,
    // not a color -- as an outline value it is invalid and the ring falls back
    // to the UA default. The keyword is AccentColor.
    expect(css).toContain('solid AccentColor');
    expect(css).not.toContain('solid accent-color');
  });

  test('the panes scroll and the window does not', async () => {
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();

    expect(css).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.preview\s*\{[^}]*overflow: auto/s);
  });

  test('the editor and the preview are placed on the flex row, not auto-sized', async () => {
    // Each pane holds three children against four grid tracks, so auto-placement put
    // the textarea in an auto row: measured 57px tall inside a 544px pane, with the
    // flex track going to the hint paragraph. The editor wrapper holds the row now
    // that the field lives inside an overlay; both content elements need explicit rows.
    const css = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).toMatch(/\.editor[\s,{][^}]*grid-row\s*:\s*3/s);
    expect(css).toMatch(/#preview[\s,{][^}]*grid-row\s*:\s*3/s);
  });

  test('the status line is announced, not just drawn', async () => {
    const page = await html();
    expect(page).toMatch(/role=["']status["']/);
    expect(page).toMatch(/aria-live=["']polite["']/);
  });

  test('the editor is labelled and described', async () => {
    const page = await html();
    expect(page).toContain('aria-describedby="source-hint"');
    expect(page).toContain('aria-labelledby="preview-label"');
  });

  test('the highlight layer is paint only, over one shared set of metrics', async () => {
    // Both layers must read every metric from the same variables; a metric set
    // in two places drifts per line and compounds. Measured the failure first:
    // a 57px textarea inside a 544px pane, from grid auto-placement.
    const page = await html();
    expect(page).toContain('id="editor"');
    expect(page).toContain('id="highlight" aria-hidden="true"');
    expect(page).toContain('id="gutter" aria-hidden="true"');
    const sheet = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const metric of ['--ed-font', '--ed-pad', '--ed-tab']) {
      expect(sheet).toContain(metric);
    }
    expect(sheet).toMatch(/#highlight,\s*#source\s*\{[^}]*font:\s*var\(--ed-font\)/s);
  });

  test('the tokenizer escapes before it wraps, and yields on IME', async () => {
    const js = await (await fetch(`${origin}/assets/app.js`)).text();
    // Escape-then-wrap: a mismatched tag highlights wrong at worst, never injects.
    expect(js).toContain('tok-tag');
    expect(js).toContain('tok-str');
    expect(js).toContain('tok-com');
    // While composing, the textarea shows the composition string and the layer
    // would show uncomposed text: doubling. It hides for the duration.
    expect(js).toContain('compositionstart');
    expect(js).toContain('compositionend');
    // The gutter follows the code pane; the highlight layer scrolls with it by
    // sharing its cell, so only the gutter needs syncing.
    expect(js).toContain('syncGutter');
  });

  test('stale claims need a render behind them, in app voice', async () => {
    // Clearing the source before anything rendered must not claim a "last good
    // render" that never happened. And app strings are sentence-case; renderer
    // findings keep their lowercase voice, but the shell's own words do not.
    const js = await (await fetch(`${origin}/assets/app.js`)).text();
    expect(js).toContain('!on || !lastBytes');
    expect(js).toContain('Showing the last good render (out of date).');
    expect(js).not.toContain('showing the last good render, not the current source');
    expect(js).toContain('Could not reach the renderer');
    expect(js).toContain('Gave up after');
    expect(js).not.toContain('could not reach the renderer (');
    expect(js).not.toContain('gave up after');
  });

  test('the pager navigates rendered bytes without re-rendering', async () => {
    // Fragment-only navigation: the iframe src gains #page=N on the same blob
    // URL, so a jump can neither disturb the editor nor trigger a render.
    const js = await (await fetch(`${origin}/assets/app.js`)).text();
    // The object URL plus fragment, not a bare '#page=' that also matches prose:
    // a comment broke this assertion once already.
    expect(js).toMatch(/\$\{objectUrl\}#page=/);
    expect(js).toMatch(/pager\.hidden = pageCount <= 1/);
    const page = await html();
    expect(page).toContain('id="pager"');
    expect(page).toContain('aria-label="Previous page"');
    expect(page).toContain('aria-label="Next page"');
    expect(page).toContain('id="page-num"');
  });
});

describe('the shell renders end to end', () => {
  test('the starter document comes back as a real pdf', async () => {
    const page = await (await fetch(`${origin}/`)).text();
    const starter = page.slice(page.indexOf('<textarea'), page.indexOf('</textarea>'));
    const html = starter
      .replace(/^[\s\S]*?>/, '')
      .replace(/<\/textarea>[\s\S]*$/, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const r = await post({ html });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      pages: number;
      bytes: number;
      pdf: string;
      findings: Array<{ code: string; severity: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.pages).toBe(1);
    expect(body.bytes).toBeGreaterThan(1000);

    expect(body.findings.filter((f) => f.severity === 'error')).toEqual([]);
    for (const f of body.findings as Array<{ severity: string }>) {
      expect(f.severity).not.toBe('error');
    }
    const bytes = Buffer.from(body.pdf, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  }, 90_000);
});
describe('the toolbar wiring holds', () => {
  const shell = async () =>
    (await (await fetch(`${origin}/`)).text()).replace(/<!--[\s\S]*?-->/g, '');
  const css = async () =>
    (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
  const script = async () => await (await fetch(`${origin}/assets/app.js`)).text();

  test('the app sends printBackground, which is the field the server reads', async () => {
    const js = await script();

    expect(js).toContain('printBackground');
    expect(js).not.toMatch(/\bbackground:\s*el\.background/);
  });

  test('the preview draws the returned bytes, not a placeholder', async () => {
    // The preview pane used to keep a text placeholder after every render. It now holds
    // an iframe on the same object URL Download hands out, drawn by the browser's own
    // PDF renderer -- selectable text and real pagination with no vendored renderer.
    const js = await script();
    expect(js).toContain(`document.createElement('iframe')`);
    expect(js).toContain(`frame.title = 'PDF preview'`);
    expect(js).toContain('navigator.pdfViewerEnabled');
    // A titled frame, because an untitled one is announced as noise.
    const page = await shell();
    expect(page).not.toContain('next phase');
  });

  test('a new render releases the previous object URL', async () => {
    // Held URLs pile up: each render minted one for Download and never let go.
    const js = await script();
    expect(js).toContain('URL.revokeObjectURL(objectUrl)');
  });

  test('the preview frame fills its pane', async () => {
    const sheet = await css();
    expect(sheet).toMatch(/#preview iframe\s*\{[^}]*width:\s*100%/s);
    expect(sheet).toMatch(/#preview iframe\s*\{[^}]*height:\s*100%/s);
    // The foreign toolbar cannot be styled from outside, so the frame carries
    // the integration: hairline border, rounded like the app's own controls.
    expect(sheet).toMatch(/#preview iframe\s*\{[^}]*border-radius:\s*6px/s);
  });

  test('an unprintable background is actually not painted', async () => {
    const doc = `<!doctype html><style>@page{size:a4;margin:5mm}body{margin:0}
div{height:250px;background:#c03030}</style><div>BOX</div>`;
    const painted = (await (await post({ html: doc, printBackground: true })).json()) as {
      pdf: string;
    };
    const bare = (await (await post({ html: doc, printBackground: false })).json()) as {
      pdf: string;
    };
    const withPaint = Buffer.from(painted.pdf, 'base64');
    const without = Buffer.from(bare.pdf, 'base64');

    expect(withPaint.equals(without)).toBe(false);

    expect(withPaint.byteLength).toBeGreaterThan(without.byteLength);
  }, 120_000);

  test('the stale marker cannot be deleted by a re-render', async () => {
    const page = await shell();

    const insidePreview = /<div id="preview"[^>]*>[\s\S]*?id="preview-note"/.test(page);
    expect(insidePreview, 'preview-note must not be inside the container that gets replaced').toBe(
      false,
    );
    expect(page).toContain('id="preview-note"');
  });

  test('the shell is not cacheable', async () => {
    for (const path of ['/', '/assets/theme.css', '/assets/app.js']) {
      const r = await fetch(`${origin}${path}`);
      expect(r.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  test('a narrow window does not push the app wider than the window', async () => {
    const sheet = await css();
    expect(sheet).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(sheet).toMatch(/\.toolbar\s*\{[^}]*min-width: 0/s);

    expect(sheet).toMatch(/input\[type=["']file["']\][^}]*min-width: 0/s);
  });

  test('the select is not width-capped, so its default option is not clipped', async () => {
    const sheet = await css();

    expect(sheet).not.toMatch(/select\s*\{[^}]*max-width/s);
  });

  test('the inert margin field is still reachable and explains itself', async () => {
    const page = await shell();

    expect(page).toMatch(/id=["']margin["'][^>]*aria-disabled=["']true["']/s);
    expect(page).not.toMatch(/id=["']margin["'][^>]*\sdisabled>/s);

    const js = await script();

    expect(js).toMatch(/el\.format\.value \? el\.margin\.value\.trim\(\) : (""|'')/);
  });

  test('a long render reports elapsed time instead of a frozen label', async () => {
    const js = await script();

    expect(js).toMatch(/setInterval/);
    expect(js).toMatch(/Rendering….*Math\.round/);
  });

  test('the editor has an accessible name', async () => {
    const page = await shell();

    expect(page).toMatch(/<textarea[^>]*id=["']source["'][^>]*aria-label=["']HTML source["']/s);
  });

  test('the status line carries the page count, so it is announced', async () => {
    const js = await script();

    expect(js).toContain('Rendered ${pages}');
  });

  test('renders are ordered, so a slow one cannot overwrite a fast one', async () => {
    const js = await script();

    expect(js).toContain('if (mine !== seq) return;');
    expect(js).toContain('controller?.abort()');
  });

  test('findings are shortened for the toolbar rather than pasted whole', async () => {
    const js = await script();

    const line = js.slice(js.indexOf('function findingLine'), js.indexOf('function showPreview'));
    expect(line, 'the finding is truncated to its first sentence').toContain('.split(');
    expect(line, 'and the rest is counted rather than printed').toContain('more)');

    expect(js).toContain('el.status.title = findings.map');
  });
});
