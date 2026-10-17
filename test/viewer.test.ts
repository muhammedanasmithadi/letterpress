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
      'portrait',
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

  test('print settings ride a second toolbar row, always visible', async () => {
    // Eleven controls plus a wordmark never fit one row; the settings wrap
    // onto a full-width second row instead of a dropdown. Every control keeps
    // its id and its label.
    const page = (await html()).replace(/<!--[\s\S]*?-->/g, '');
    expect(page).not.toContain('<details');
    expect(page).toContain('class="settings-row"');
    const row = page.slice(page.indexOf('class="settings-row"'));
    for (const id of [
      'format',
      'portrait',
      'landscape',
      'margin',
      'background',
      'ppi',
      'network',
    ]) {
      expect(row, `#${id} inside the settings row`).toContain(`id="${id}"`);
    }
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(css).toMatch(/\.settings-row\s*\{[^}]*flex:\s*1 1 100%/s);
  });

  test('bare shell: native controls, wired toggle, plain text actions', async () => {
    // Orientation is a two-button native toggle; aria-pressed carries the
    // state and a boolean carries it to the payload (no .checked anywhere).
    const page = await html();
    expect(page).toContain('aria-label="Orientation"');
    expect(page).toContain('id="portrait" aria-pressed="true">Portrait');
    expect(page).toContain('id="landscape" aria-pressed="false">Landscape');
    expect(page).not.toContain('name="orientation"');
    const js = await (await fetch(`${origin}/assets/app.js`)).text();
    expect(js).toContain('landscape: isLandscape()');
    expect(js).not.toContain('el.landscape.checked');
    expect(js).toContain("setAttribute('aria-pressed'");
    // A rejected orientation reverts the toggle to the effective state: the
    // control must not display a request the engine refused.
    expect(js).toContain('orientation-ignored');
    expect(js).toContain('paintOrientation');
    // The pressed button is bold, laid side by side -- the only visual signal,
    // and color-free per the bare shell.
    const sheet = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(sheet).toMatch(/\.segmented\s*\{[^}]*display:\s*flex/s);
    expect(sheet).toMatch(/\.segmented button\[aria-pressed='true'\]\s*\{[^}]*font-weight:\s*700/s);
    // Plain buttons with clear names. The status opens plain.
    expect(page).toContain('id="download"');
    expect(page).toMatch(/>\s*PDF\s*</s);
    expect(page).toContain('Ready to render.');
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(css).not.toContain('text-decoration');
    // Margin re-renders as you type, but only for committable values:
    // intermediates must not flash server rejections.
    expect(js).toContain("el.margin.addEventListener('input'");
    expect(js).toContain('isLengthLike');
  });

  test('nocturne review: pane metadata, quiet icons', async () => {
    // The source head names its line count; it exists nowhere else. Counts
    // also live in the live status line, so pane metadata hides from
    // assistive tech.
    const page = await html();
    expect(page).not.toContain('id="filename"');
    expect(page).not.toContain('class="contextbar"');
    expect(page).toContain('id="source-meta"');
    expect(page).not.toContain('id="preview-meta"');
    expect(page).toContain('aria-hidden="true">HTML<');
    // No svg icons and no dropdown: quiet text throughout, settings always
    // visible. The starter demonstrates print, set in Georgia serif.
    expect(page).not.toContain('<svg');
    expect(page).not.toContain('class="paneltitle"');
    expect(page).toContain('Georgia, serif');
    // No unicode chevrons anywhere in the shell: markers are drawn with
    // borders, and every svg hides itself.
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();
    expect(css).not.toContain('▸');
    expect(css).not.toContain('▾');
    expect(page).toContain('class="chev left"');
    expect(page).toContain('class="chev right"');
    const js = await (await fetch(`${origin}/assets/app.js`)).text();
    expect(js).not.toContain('el.filename');
    expect(js).not.toContain('formatLabel()');
    expect(js).not.toContain('closeOutside');
    expect(js).toContain('el.sourceMeta.textContent = `HTML ·');
    // File import repaints the highlight layer and gutter: a programmatic value
    // set fires no input event, so without the repaint the editor shows the
    // previous document while the value and preview are already the new one.
    // Positioned with indexOf rather than a regex window: a `{0,400}` bound
    // fails the moment an unrelated comment lands inside the handler, which is
    // a false alarm about a real defect. Order is what matters, so order is
    // what is asserted.
    const handler = js.slice(js.indexOf("el.file.addEventListener('change'"));
    expect(js).toContain("el.file.addEventListener('change'");
    expect(handler).toContain('renderHighlight()');
    // The input is released right after the file is captured. A file input only
    // fires `change` when its value differs, so without the reset, re-picking
    // the same file runs no handler at all: no import, no repaint, no status --
    // a viewer that looks frozen. The captured File must outlive the reset,
    // which is why the capture comes first, and the reset precedes the await so
    // a failed read cannot leave the input stuck on a value that will never
    // fire again.
    expect(js).toContain("el.file.value = ''");
    expect(handler.indexOf('const file = el.file.files?.[0]')).toBeLessThan(
      handler.indexOf("el.file.value = ''"),
    );
    expect(handler.indexOf("el.file.value = ''")).toBeLessThan(
      handler.indexOf('await file.text()'),
    );
    // PPI honesty: the server clamps to 1200, so the box caps there natively
    // and the reader reflects the effective value instead of sending a number
    // the engine silently ignores.
    expect(page).toContain('max="1200"');
    expect(js).toContain("el.ppi.value = '1200'");
  });

  test('every control has a label', async () => {
    const page = await html();

    for (const id of ['format', 'margin', 'background', 'ppi', 'network']) {
      const before = page.slice(0, page.indexOf(`id="${id}"`));
      const openTag = before.lastIndexOf('<label');
      const closeTag = before.lastIndexOf('</label>');
      expect(openTag, `#${id} is inside a <label>`).toBeGreaterThan(closeTag);
    }
  });

  test('bare shell: platform paint only, mechanics intact', async () => {
    const css = (await (await fetch(`${origin}/assets/theme.css`)).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).toContain('color-scheme: light dark');
    // The meta sets UA defaults before the stylesheet loads; the CSS alone
    // arrives too late for first-paint form controls and scrollbars.
    expect(await html()).toContain('name="color-scheme" content="light dark"');

    // No authored color anywhere except the error rule: failure must not
    // look like success, so it keeps its pair and is cut out before the scan.
    // Warnings read in the default text -- no second color.
    const unpainted = css.replace(/\.status\[data-level='error'\]\s*\{[^}]*\}/g, '');
    expect(css).not.toMatch(/\.status\[data-level='warn'\]/s);
    const bare = [...unpainted.matchAll(/#[0-9a-f]{3,8}\b/gi)];
    expect(
      bare.map((m) => m[0]),
      'hex colour outside the error rule',
    ).toEqual([]);
    expect(css).not.toContain('@font-face');
    expect(css).not.toContain('box-shadow');
    expect(css).not.toContain('woff2');
    // What stays is mechanics: the overlay cell, the caret that must survive
    // transparent text, the dropdown anchor, the pager hide, keyboard ring.
    expect(css).toMatch(/#highlight,\s*#source\s*\{[^}]*padding:\s*var\(--ed-pad\)/s);
    expect(css).toContain('caret-color: CanvasText');
    // Visible tokens without paint: bold tags, italic strings, dimmed
    // comments -- monochrome emphasis, no colors admitted.
    expect(css).toMatch(/#highlight \.tok-tag\s*\{[^}]*font-weight:\s*700/s);
    expect(css).toMatch(/#highlight \.tok-str\s*\{[^}]*font-style:\s*italic/s);
    expect(css).toMatch(/#highlight \.tok-com\s*\{[^}]*color:\s*color-mix/s);
    expect(css).toMatch(/\.settings-row\s*\{[^}]*flex:\s*1 1 100%/s);
    expect(css).toContain('.pager[hidden]');
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
    // Severity still reads: failure must not look like success.
    expect(css).toMatch(/\.status\[data-level='error'\]/s);
  });

  test('the panes scroll and the window does not', async () => {
    const css = await (await fetch(`${origin}/assets/theme.css`)).text();

    expect(css).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.preview\s*\{[^}]*overflow: auto/s);
  });

  test('the editor and the preview are placed on the flex row, not auto-sized', async () => {
    // Each pane holds three children against three grid tracks, so auto-placement put
    // the textarea in an auto row: measured 57px tall inside a 544px pane, with the
    // flex track going nowhere useful. The editor wrapper holds the row now
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

  test('the editor is labelled', async () => {
    const page = await html();
    expect(page).toContain('aria-label="HTML source"');
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
    // a hairline edge where paper meets pane.
    expect(sheet).toMatch(/#preview iframe\s*\{[^}]*border:\s*1px solid ButtonBorder/s);
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

  test('the severity level lands on the element the css names', async () => {
    // The rules are `.status[data-level=...]` and `.status` is the footer. The
    // level used to be set on the live-region output, which carries no such
    // class, so the colour never applied: measured, an error painted rgb(0,0,0).
    const js = await script();
    expect(js).toContain('el.statusBar.dataset.level');
    expect(js).not.toMatch(/el\.status\.dataset\.level/);
    const page = await shell();
    expect(page).toMatch(/<footer class="status">\s*[\s\S]*?id="status"/);
  });

  test('a clean success does not keep an old failure in the tooltip', async () => {
    const js = await script();
    expect(js).toMatch(/el\.status\.title = ''/);
  });

  test('the preview frame is out of the tab order', async () => {
    // A browser PDF viewer holds its own tab stops; measured, ~16 Tabs were
    // consumed inside the frame before the pager was reached.
    const js = await script();
    expect(js).toContain('iframe.tabIndex = -1');
  });

  test('the toolbar DOM order is the visual order, so focus follows paint', async () => {
    // `order` reorders paint, not the focus sequence. The actions must precede
    // the settings row in the DOM, and no `order` value may put them back.
    const page = await shell();
    expect(page.indexOf('class="group actions"')).toBeLessThan(
      page.indexOf('class="settings-row"'),
    );
    const sheet = await css();
    expect(sheet).not.toMatch(/\.settings-row\s*\{[^}]*\border:/s);
    expect(sheet).not.toMatch(/\.spacer\s*\{[^}]*\border:/s);
  });

  test('the stale note is actually styled', async () => {
    const sheet = await css();
    expect(sheet).toMatch(/\.stale\s*\{[^}]*font-style:\s*italic/s);
  });

  test('an unusable ppi value explains itself instead of going silent', async () => {
    const js = await script();
    expect(js).toContain('el.ppi.title');
  });
});
