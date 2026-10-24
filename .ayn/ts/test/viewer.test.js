"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const servers_ts_1 = require("./servers.ts");
const server = (0, servers_ts_1.useTestServer)();
const post = (body) => fetch(`${server.origin}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});
const DOC = `<!doctype html><style>@page{size:a5;margin:8mm}</style><h1>Viewer</h1>`;
(0, bun_test_1.describe)('the shell is served', () => {
    (0, bun_test_1.test)('the index is html', async () => {
        const r = await fetch(`${server.origin}/`);
        (0, bun_test_1.expect)(r.status).toBe(200);
        (0, bun_test_1.expect)(r.headers.get('content-type')).toContain('text/html');
        const html = await r.text();
        (0, bun_test_1.expect)(html).toContain('<!doctype html>');
        (0, bun_test_1.expect)(html).toContain('/assets/theme.css');
        (0, bun_test_1.expect)(html).toContain('/assets/app.js');
    });
    (0, bun_test_1.test)('assets are served with a type that matches the extension', async () => {
        for (const [path, type] of [
            ['/assets/theme.css', 'text/css'],
            ['/assets/app.js', 'text/javascript'],
        ]) {
            const r = await fetch(`${server.origin}${path}`);
            (0, bun_test_1.expect)(r.status, path).toBe(200);
            (0, bun_test_1.expect)(r.headers.get('content-type'), path).toContain(type);
            (0, bun_test_1.expect)((await r.text()).length, path).toBeGreaterThan(100);
        }
    });
    (0, bun_test_1.test)('a missing asset is a 404, not a crash', async () => {
        (0, bun_test_1.expect)((await fetch(`${server.origin}/assets/nope.css`)).status).toBe(404);
    });
    (0, bun_test_1.test)('an absurd asset path is a 404, not a crash', async () => {
        (0, bun_test_1.expect)((await fetch(`${server.origin}/assets/${'x'.repeat(600)}`)).status).toBe(404);
    });
});
(0, bun_test_1.describe)('the toolbar controls reach the renderer', () => {
    (0, bun_test_1.test)('format changes the paper', async () => {
        const own = (await (await post({ html: DOC })).json());
        (0, bun_test_1.expect)(own.mediaBoxes[0]).toContain('420');
        const a4 = (await (await post({ html: DOC, format: 'a4' })).json());
        (0, bun_test_1.expect)(a4.mediaBoxes[0]).toContain('594.9');
    }, 90_000);
    (0, bun_test_1.test)('landscape transposes the paper', async () => {
        const r = (await (await post({ html: DOC, format: 'a4', landscape: true })).json());
        (0, bun_test_1.expect)(r.mediaBoxes[0]).toContain('841');
        (0, bun_test_1.expect)(r.findings.map((f) => f.code)).toContain('orientation-overridden');
    }, 90_000);
    (0, bun_test_1.test)('landscape works with no format, which is what the toolbar sends', async () => {
        const r = (await (await post({ html: DOC, landscape: true })).json());
        const box = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(r.mediaBoxes[0]);
        const w = Number(box[3]);
        const h = Number(box[4]);
        (0, bun_test_1.expect)(w).toBeGreaterThan(h);
        const codes = r.findings.map((f) => f.code);
        (0, bun_test_1.expect)(codes).not.toContain('orientation-ignored');
        (0, bun_test_1.expect)(codes).toContain('orientation-overridden');
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'orientation-overridden').severity).toBe('info');
    }, 90_000);
    (0, bun_test_1.test)('printBackground false is accepted and defaults true', async () => {
        const off = await post({ html: DOC, printBackground: false });
        (0, bun_test_1.expect)(off.status).toBe(200);
        const on = await post({ html: DOC, printBackground: true });
        (0, bun_test_1.expect)(on.status).toBe(200);
        const neither = await post({ html: DOC });
        (0, bun_test_1.expect)(neither.status).toBe(200);
    }, 120_000);
    (0, bun_test_1.test)('margin is applied when format is given', async () => {
        const ok = await post({
            html: `<!doctype html><body style="margin:0"><h1>T</h1></body>`,
            format: 'a4',
            margin: '20mm',
        });
        (0, bun_test_1.expect)(ok.status).toBe(200);
        const seen = (await ok.json())
            .findings;
        (0, bun_test_1.expect)(seen.filter((f) => f.severity === 'error')).toEqual([]);
    }, 90_000);
    (0, bun_test_1.test)('allowNetwork is a boolean and defaults off', async () => {
        (0, bun_test_1.expect)((await post({ html: DOC, allowNetwork: false })).status).toBe(200);
        (0, bun_test_1.expect)((await post({ html: DOC, allowNetwork: true })).status).toBe(200);
        for (const bad of ['yes', 1, null, {}]) {
            const r = await post({ html: DOC, allowNetwork: bad });
            (0, bun_test_1.expect)(r.status, String(bad)).toBe(400);
            (0, bun_test_1.expect)((await r.json()).error).toContain('allowNetwork');
        }
    }, 120_000);
});
(0, bun_test_1.describe)('margin is checked before it is used', () => {
    (0, bun_test_1.test)('a margin without a format is refused, and says why', async () => {
        const r = await post({ html: DOC, margin: '20mm' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const { error } = (await r.json());
        (0, bun_test_1.expect)(error).toContain('only applies alongside format');
    }, 60_000);
    (0, bun_test_1.test)('a margin that is not a css length names the fix', async () => {
        const r = await post({ html: DOC, format: 'a4', margin: 'wat' });
        (0, bun_test_1.expect)(r.status).toBe(400);
        const { error } = (await r.json());
        (0, bun_test_1.expect)(error).toContain('not an absolute css length');
        (0, bun_test_1.expect)(error).toContain('15mm');
    }, 60_000);
    (0, bun_test_1.test)('every absolute css length is accepted', async () => {
        for (const margin of ['15mm', '1in', '2cm', '40pt', '10px', '2pc', '1q', '0', '0.0']) {
            const r = await post({ html: DOC, format: 'a4', margin });
            (0, bun_test_1.expect)(r.status, margin).toBe(200);
        }
    }, 240_000);
    (0, bun_test_1.test)('a relative unit is refused with the reason, not a bare rejection', async () => {
        for (const margin of ['1.5em', '3vw', '10%', '2rem']) {
            const r = await post({ html: DOC, format: 'a4', margin });
            (0, bun_test_1.expect)(r.status, margin).toBe(400);
            const { error } = (await r.json());
            (0, bun_test_1.expect)(error, margin).toContain('relative');
            (0, bun_test_1.expect)(error, margin).toContain('mm');
        }
    }, 90_000);
    (0, bun_test_1.test)('a bare non-zero number is refused, and a bare zero is not', async () => {
        const bare = await post({ html: DOC, format: 'a4', margin: '20' });
        (0, bun_test_1.expect)(bare.status).toBe(400);
        (0, bun_test_1.expect)((await bare.json()).error).toContain('unit');
        const zero = await post({ html: DOC, format: 'a4', margin: '0' });
        (0, bun_test_1.expect)(zero.status).toBe(200);
    }, 90_000);
    (0, bun_test_1.test)('margin must be a string', async () => {
        for (const margin of [20, true, []]) {
            const r = await post({ html: DOC, format: 'a4', margin });
            (0, bun_test_1.expect)(r.status, String(margin)).toBe(400);
            (0, bun_test_1.expect)((await r.json()).error).toContain('margin must be a string');
        }
    }, 90_000);
});
(0, bun_test_1.describe)('the shell itself', () => {
    const html = async () => await (await fetch(`${server.origin}/`)).text();
    (0, bun_test_1.test)('every control is a native element', async () => {
        const page = (await html()).replace(/<!--[\s\S]*?-->/g, '');
        (0, bun_test_1.expect)(page).not.toMatch(/<div[^>]*role=["']button["']/);
        (0, bun_test_1.expect)(page).not.toMatch(/<span[^>]*onclick/);
        const css = (await (await fetch(`${server.origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
        (0, bun_test_1.expect)(css).not.toMatch(/appearance\s*:\s*base-select/);
        (0, bun_test_1.expect)(css).not.toMatch(/\bselect\s*\{[^}]*appearance/s);
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
            (0, bun_test_1.expect)(page, `control #${id} exists`).toContain(`id="${id}"`);
        }
    });
    (0, bun_test_1.test)('print settings ride a second toolbar row, always visible', async () => {
        const page = (await html()).replace(/<!--[\s\S]*?-->/g, '');
        (0, bun_test_1.expect)(page).not.toContain('<details');
        (0, bun_test_1.expect)(page).toContain('class="settings-row"');
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
            (0, bun_test_1.expect)(row, `#${id} inside the settings row`).toContain(`id="${id}"`);
        }
        const css = await (await fetch(`${server.origin}/assets/theme.css`)).text();
        (0, bun_test_1.expect)(css).toMatch(/\.settings-row\s*\{[^}]*flex:\s*1 1 100%/s);
    });
    (0, bun_test_1.test)('bare shell: native controls, wired toggle, plain text actions', async () => {
        const page = await html();
        (0, bun_test_1.expect)(page).toContain('aria-label="Orientation"');
        (0, bun_test_1.expect)(page).toContain('id="portrait" aria-pressed="true">Portrait');
        (0, bun_test_1.expect)(page).toContain('id="landscape" aria-pressed="false">Landscape');
        (0, bun_test_1.expect)(page).not.toContain('name="orientation"');
        const js = await (await fetch(`${server.origin}/assets/app.js`)).text();
        (0, bun_test_1.expect)(js).toContain('landscape: landscapeOn');
        (0, bun_test_1.expect)(js).not.toContain('el.landscape.checked');
        (0, bun_test_1.expect)(js).toContain("setAttribute('aria-pressed'");
        (0, bun_test_1.expect)(js).toContain('orientation-ignored');
        (0, bun_test_1.expect)(js).toContain('paintOrientation');
        const sheet = await (await fetch(`${server.origin}/assets/theme.css`)).text();
        (0, bun_test_1.expect)(sheet).toMatch(/\.segmented\s*\{[^}]*display:\s*flex/s);
        (0, bun_test_1.expect)(sheet).toMatch(/\.segmented button\[aria-pressed='true'\]\s*\{[^}]*font-weight:\s*700/s);
        (0, bun_test_1.expect)(page).toContain('id="download"');
        (0, bun_test_1.expect)(page).toMatch(/>\s*PDF\s*</s);
        (0, bun_test_1.expect)(page).toContain('Ready to render.');
        const css = await (await fetch(`${server.origin}/assets/theme.css`)).text();
        (0, bun_test_1.expect)(css).not.toContain('text-decoration');
        (0, bun_test_1.expect)(js).toContain("el.margin.addEventListener('input'");
        (0, bun_test_1.expect)(js).toContain('isLengthLike');
    });
    (0, bun_test_1.test)('nocturne review: pane metadata, quiet icons', async () => {
        const page = await html();
        (0, bun_test_1.expect)(page).not.toContain('id="filename"');
        (0, bun_test_1.expect)(page).not.toContain('class="contextbar"');
        (0, bun_test_1.expect)(page).toContain('id="source-meta"');
        (0, bun_test_1.expect)(page).not.toContain('id="preview-meta"');
        (0, bun_test_1.expect)(page).toContain('aria-hidden="true">HTML<');
        (0, bun_test_1.expect)(page).not.toContain('<svg');
        (0, bun_test_1.expect)(page).not.toContain('class="paneltitle"');
        (0, bun_test_1.expect)(page).toContain('Georgia, serif');
        const css = await (await fetch(`${server.origin}/assets/theme.css`)).text();
        (0, bun_test_1.expect)(css).not.toContain('▸');
        (0, bun_test_1.expect)(css).not.toContain('▾');
        (0, bun_test_1.expect)(page).toContain('class="chev left"');
        (0, bun_test_1.expect)(page).toContain('class="chev right"');
        const js = await (await fetch(`${server.origin}/assets/app.js`)).text();
        (0, bun_test_1.expect)(js).not.toContain('el.filename');
        (0, bun_test_1.expect)(js).not.toContain('formatLabel()');
        (0, bun_test_1.expect)(js).not.toContain('closeOutside');
        (0, bun_test_1.expect)(js).toContain('el.sourceMeta.textContent = `HTML ·');
        const handler = js.slice(js.indexOf("el.file.addEventListener('change'"));
        (0, bun_test_1.expect)(js).toContain("el.file.addEventListener('change'");
        (0, bun_test_1.expect)(handler).toContain('renderHighlight()');
        (0, bun_test_1.expect)(js).toContain("el.file.value = ''");
        (0, bun_test_1.expect)(handler.indexOf('const file = el.file.files?.[0]')).toBeLessThan(handler.indexOf("el.file.value = ''"));
        (0, bun_test_1.expect)(handler.indexOf("el.file.value = ''")).toBeLessThan(handler.indexOf('await file.text()'));
        (0, bun_test_1.expect)(page).toContain('max="1200"');
        (0, bun_test_1.expect)(js).toContain("el.ppi.value = '1200'");
    });
    (0, bun_test_1.test)('every control has a label', async () => {
        const page = await html();
        for (const id of ['format', 'margin', 'background', 'ppi', 'network']) {
            const before = page.slice(0, page.indexOf(`id="${id}"`));
            const openTag = before.lastIndexOf('<label');
            const closeTag = before.lastIndexOf('</label>');
            (0, bun_test_1.expect)(openTag, `#${id} is inside a <label>`).toBeGreaterThan(closeTag);
        }
    });
    (0, bun_test_1.test)('bare shell: platform paint only, mechanics intact', async () => {
        const css = (await (await fetch(`${server.origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
        (0, bun_test_1.expect)(css).toContain('color-scheme: light dark');
        (0, bun_test_1.expect)(await html()).toContain('name="color-scheme" content="light dark"');
        const unpainted = css.replace(/\.status\[data-level='error'\]\s*\{[^}]*\}/g, '');
        (0, bun_test_1.expect)(css).not.toMatch(/\.status\[data-level='warn'\]/s);
        const bare = [...unpainted.matchAll(/#[0-9a-f]{3,8}\b/gi)];
        (0, bun_test_1.expect)(bare.map((m) => m[0]), 'hex colour outside the error rule').toEqual([]);
        (0, bun_test_1.expect)(css).not.toContain('@font-face');
        (0, bun_test_1.expect)(css).not.toContain('box-shadow');
        (0, bun_test_1.expect)(css).not.toContain('woff2');
        (0, bun_test_1.expect)(css).toMatch(/#highlight,\s*#source\s*\{[^}]*padding:\s*var\(--ed-pad\)/s);
        (0, bun_test_1.expect)(css).toContain('caret-color: CanvasText');
        (0, bun_test_1.expect)(css).toMatch(/#highlight \.tok-tag\s*\{[^}]*font-weight:\s*700/s);
        (0, bun_test_1.expect)(css).toMatch(/#highlight \.tok-str\s*\{[^}]*font-style:\s*italic/s);
        (0, bun_test_1.expect)(css).toMatch(/#highlight \.tok-com\s*\{[^}]*color:\s*color-mix/s);
        (0, bun_test_1.expect)(css).toMatch(/\.settings-row\s*\{[^}]*flex:\s*1 1 100%/s);
        (0, bun_test_1.expect)(css).toContain('.pager[hidden]');
        (0, bun_test_1.expect)(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/s);
        (0, bun_test_1.expect)(css).toMatch(/\.status\[data-level='error'\]/s);
    });
    (0, bun_test_1.test)('the panes scroll and the window does not', async () => {
        const css = await (await fetch(`${server.origin}/assets/theme.css`)).text();
        (0, bun_test_1.expect)(css).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto/);
        (0, bun_test_1.expect)(css).toMatch(/\.preview\s*\{[^}]*overflow: auto/s);
    });
    (0, bun_test_1.test)('the editor and the preview are placed on the flex row, not auto-sized', async () => {
        const css = (await (await fetch(`${server.origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
        (0, bun_test_1.expect)(css).toMatch(/\.editor[\s,{][^}]*grid-row\s*:\s*3/s);
        (0, bun_test_1.expect)(css).toMatch(/#preview[\s,{][^}]*grid-row\s*:\s*3/s);
    });
    (0, bun_test_1.test)('the status line is announced, not just drawn', async () => {
        const page = await html();
        (0, bun_test_1.expect)(page).toMatch(/role=["']status["']/);
        (0, bun_test_1.expect)(page).toMatch(/aria-live=["']polite["']/);
    });
    (0, bun_test_1.test)('the editor is labelled', async () => {
        const page = await html();
        (0, bun_test_1.expect)(page).toContain('aria-label="HTML source"');
        (0, bun_test_1.expect)(page).toContain('aria-labelledby="preview-label"');
    });
    (0, bun_test_1.test)('the highlight layer is paint only, over one shared set of metrics', async () => {
        const page = await html();
        (0, bun_test_1.expect)(page).toContain('id="editor"');
        (0, bun_test_1.expect)(page).toContain('id="highlight" aria-hidden="true"');
        (0, bun_test_1.expect)(page).toContain('id="gutter" aria-hidden="true"');
        const sheet = (await (await fetch(`${server.origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const metric of ['--ed-font', '--ed-pad', '--ed-tab']) {
            (0, bun_test_1.expect)(sheet).toContain(metric);
        }
        (0, bun_test_1.expect)(sheet).toMatch(/#highlight,\s*#source\s*\{[^}]*font:\s*var\(--ed-font\)/s);
    });
    (0, bun_test_1.test)('the tokenizer escapes before it wraps, and yields on IME', async () => {
        const js = await (await fetch(`${server.origin}/assets/app.js`)).text();
        (0, bun_test_1.expect)(js).toContain('tok-tag');
        (0, bun_test_1.expect)(js).toContain('tok-str');
        (0, bun_test_1.expect)(js).toContain('tok-com');
        (0, bun_test_1.expect)(js).toContain('compositionstart');
        (0, bun_test_1.expect)(js).toContain('compositionend');
        (0, bun_test_1.expect)(js).toContain('syncGutter');
    });
    (0, bun_test_1.test)('stale claims need a render behind them, in app voice', async () => {
        const js = await (await fetch(`${server.origin}/assets/app.js`)).text();
        (0, bun_test_1.expect)(js).toContain('!on || !lastBytes');
        (0, bun_test_1.expect)(js).toContain('Showing the last good render (out of date).');
        (0, bun_test_1.expect)(js).not.toContain('showing the last good render, not the current source');
        (0, bun_test_1.expect)(js).toContain('Could not reach the renderer');
        (0, bun_test_1.expect)(js).toContain('Gave up after');
        (0, bun_test_1.expect)(js).not.toContain('could not reach the renderer (');
        (0, bun_test_1.expect)(js).not.toContain('gave up after');
    });
    (0, bun_test_1.test)('the pager navigates rendered bytes without re-rendering', async () => {
        const js = await (await fetch(`${server.origin}/assets/app.js`)).text();
        (0, bun_test_1.expect)(js).toMatch(/\$\{objectUrl\}#page=/);
        (0, bun_test_1.expect)(js).toMatch(/pager\.hidden = pageCount <= 1/);
        const page = await html();
        (0, bun_test_1.expect)(page).toContain('id="pager"');
        (0, bun_test_1.expect)(page).toContain('aria-label="Previous page"');
        (0, bun_test_1.expect)(page).toContain('aria-label="Next page"');
        (0, bun_test_1.expect)(page).toContain('id="page-num"');
    });
});
(0, bun_test_1.describe)('the shell renders end to end', () => {
    (0, bun_test_1.test)('the starter document comes back as a real pdf', async () => {
        const page = await (await fetch(`${server.origin}/`)).text();
        const starter = page.slice(page.indexOf('<textarea'), page.indexOf('</textarea>'));
        const html = starter
            .replace(/^[\s\S]*?>/, '')
            .replace(/<\/textarea>[\s\S]*$/, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        const r = await post({ html });
        (0, bun_test_1.expect)(r.status).toBe(200);
        const body = (await r.json());
        (0, bun_test_1.expect)(body.ok).toBe(true);
        (0, bun_test_1.expect)(body.pages).toBe(1);
        (0, bun_test_1.expect)(body.bytes).toBeGreaterThan(1000);
        (0, bun_test_1.expect)(body.findings.filter((f) => f.severity === 'error')).toEqual([]);
        for (const f of body.findings) {
            (0, bun_test_1.expect)(f.severity).not.toBe('error');
        }
        const bytes = Buffer.from(body.pdf, 'base64');
        (0, bun_test_1.expect)(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    }, 90_000);
});
(0, bun_test_1.describe)('the toolbar wiring holds', () => {
    const shell = async () => (await (await fetch(`${server.origin}/`)).text()).replace(/<!--[\s\S]*?-->/g, '');
    const css = async () => (await (await fetch(`${server.origin}/assets/theme.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
    const script = async () => await (await fetch(`${server.origin}/assets/app.js`)).text();
    (0, bun_test_1.test)('the app sends printBackground, which is the field the server reads', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('printBackground');
        (0, bun_test_1.expect)(js).not.toMatch(/\bbackground:\s*el\.background/);
    });
    (0, bun_test_1.test)('the preview draws the returned bytes, not a placeholder', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain(`document.createElement('iframe')`);
        (0, bun_test_1.expect)(js).toContain(`frame.title = 'PDF preview'`);
        (0, bun_test_1.expect)(js).toContain('navigator.pdfViewerEnabled');
        const page = await shell();
        (0, bun_test_1.expect)(page).not.toContain('next phase');
    });
    (0, bun_test_1.test)('a new render releases the previous object URL', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('URL.revokeObjectURL(objectUrl)');
    });
    (0, bun_test_1.test)('the preview frame fills its pane', async () => {
        const sheet = await css();
        (0, bun_test_1.expect)(sheet).toMatch(/#preview iframe\s*\{[^}]*width:\s*100%/s);
        (0, bun_test_1.expect)(sheet).toMatch(/#preview iframe\s*\{[^}]*height:\s*100%/s);
        (0, bun_test_1.expect)(sheet).toMatch(/#preview iframe\s*\{[^}]*border:\s*1px solid ButtonBorder/s);
    });
    (0, bun_test_1.test)('an unprintable background is actually not painted', async () => {
        const doc = `<!doctype html><style>@page{size:a4;margin:5mm}body{margin:0}
div{height:250px;background:#c03030}</style><div>BOX</div>`;
        const painted = (await (await post({ html: doc, printBackground: true })).json());
        const bare = (await (await post({ html: doc, printBackground: false })).json());
        const withPaint = Buffer.from(painted.pdf, 'base64');
        const without = Buffer.from(bare.pdf, 'base64');
        (0, bun_test_1.expect)(withPaint.equals(without)).toBe(false);
        (0, bun_test_1.expect)(withPaint.byteLength).toBeGreaterThan(without.byteLength);
    }, 120_000);
    (0, bun_test_1.test)('the stale marker cannot be deleted by a re-render', async () => {
        const page = await shell();
        const insidePreview = /<div id="preview"[^>]*>[\s\S]*?id="preview-note"/.test(page);
        (0, bun_test_1.expect)(insidePreview, 'preview-note must not be inside the container that gets replaced').toBe(false);
        (0, bun_test_1.expect)(page).toContain('id="preview-note"');
    });
    (0, bun_test_1.test)('the shell is not cacheable', async () => {
        for (const path of ['/', '/assets/theme.css', '/assets/app.js']) {
            const r = await fetch(`${server.origin}${path}`);
            (0, bun_test_1.expect)(r.headers.get('cache-control'), path).toBe('no-store');
        }
    });
    (0, bun_test_1.test)('a narrow window does not push the app wider than the window', async () => {
        const sheet = await css();
        (0, bun_test_1.expect)(sheet).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
        (0, bun_test_1.expect)(sheet).toMatch(/\.toolbar\s*\{[^}]*min-width: 0/s);
        (0, bun_test_1.expect)(sheet).toMatch(/input\[type=["']file["']\][^}]*min-width: 0/s);
    });
    (0, bun_test_1.test)('the select is not width-capped, so its default option is not clipped', async () => {
        const sheet = await css();
        (0, bun_test_1.expect)(sheet).not.toMatch(/select\s*\{[^}]*max-width/s);
    });
    (0, bun_test_1.test)('the inert margin field is still reachable and explains itself', async () => {
        const page = await shell();
        (0, bun_test_1.expect)(page).toMatch(/id=["']margin["'][^>]*aria-disabled=["']true["']/s);
        (0, bun_test_1.expect)(page).not.toMatch(/id=["']margin["'][^>]*\sdisabled>/s);
        const js = await script();
        (0, bun_test_1.expect)(js).toMatch(/el\.format\.value \? el\.margin\.value\.trim\(\) : (""|'')/);
    });
    (0, bun_test_1.test)('a long render reports elapsed time instead of a frozen label', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toMatch(/setInterval/);
        (0, bun_test_1.expect)(js).toMatch(/Rendering….*Math\.round/);
    });
    (0, bun_test_1.test)('the editor has an accessible name', async () => {
        const page = await shell();
        (0, bun_test_1.expect)(page).toMatch(/<textarea[^>]*id=["']source["'][^>]*aria-label=["']HTML source["']/s);
    });
    (0, bun_test_1.test)('the status line carries the page count, so it is announced', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('Rendered ${pages}');
    });
    (0, bun_test_1.test)('renders are ordered, so a slow one cannot overwrite a fast one', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('if (mine !== seq) return');
        (0, bun_test_1.expect)(js).toContain('controller?.abort()');
    });
    (0, bun_test_1.test)('findings are shortened for the toolbar rather than pasted whole', async () => {
        const js = await script();
        const line = js.slice(js.indexOf('function findingLine'), js.indexOf('function showPreview'));
        (0, bun_test_1.expect)(line, 'the finding is truncated to its first sentence').toContain('.split(');
        (0, bun_test_1.expect)(line, 'and the rest is counted rather than printed').toContain('more)');
        (0, bun_test_1.expect)(js).toContain('el.status.title = findings.map');
    });
    (0, bun_test_1.test)('the severity level lands on the element the css names', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('el.statusBar.dataset.level');
        (0, bun_test_1.expect)(js).not.toMatch(/el\.status\.dataset\.level/);
        const page = await shell();
        (0, bun_test_1.expect)(page).toMatch(/<footer class="status">\s*[\s\S]*?id="status"/);
    });
    (0, bun_test_1.test)('a clean success does not keep an old failure in the tooltip', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toMatch(/el\.status\.title = ''/);
    });
    (0, bun_test_1.test)('the preview frame is out of the tab order', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('iframe.tabIndex = -1');
    });
    (0, bun_test_1.test)('the toolbar DOM order is the visual order, so focus follows paint', async () => {
        const page = await shell();
        (0, bun_test_1.expect)(page.indexOf('class="group actions"')).toBeLessThan(page.indexOf('class="settings-row"'));
        const sheet = await css();
        (0, bun_test_1.expect)(sheet).not.toMatch(/\.settings-row\s*\{[^}]*\border:/s);
        (0, bun_test_1.expect)(sheet).not.toMatch(/\.spacer\s*\{[^}]*\border:/s);
    });
    (0, bun_test_1.test)('the stale note is actually styled', async () => {
        const sheet = await css();
        (0, bun_test_1.expect)(sheet).toMatch(/\.stale\s*\{[^}]*font-style:\s*italic/s);
    });
    (0, bun_test_1.test)('an unusable ppi value explains itself instead of going silent', async () => {
        const js = await script();
        (0, bun_test_1.expect)(js).toContain('el.ppi.title');
    });
});
//# sourceMappingURL=viewer.test.js.map