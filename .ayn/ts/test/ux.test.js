"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const render_ts_1 = require("../src/render.ts");
const cli_ts_1 = require("../src/cli.ts");
const template_ts_1 = require("../src/template.ts");
const poppler_ts_1 = require("./poppler.ts");
let browser;
let profile;
let dir;
async function renderError(req) {
    try {
        await (0, render_ts_1.render)(browser, req);
    }
    catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
    return '';
}
async function cli(argv) {
    const out = [];
    const err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk) => {
        out.push(String(chunk));
        return true;
    });
    process.stderr.write = ((chunk) => {
        err.push(String(chunk));
        return true;
    });
    try {
        const code = await (0, cli_ts_1.main)(argv);
        return { code, out: out.join(''), err: err.join('') };
    }
    finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
    }
}
(0, bun_test_1.beforeAll)(async () => {
    profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-ux-'));
    dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-ux-doc-'));
    browser = await browser_ts_1.Browser.launch({ profile });
}, 60_000);
(0, bun_test_1.afterAll)(async () => {
    await browser?.close();
    await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
}, 20_000);
const DOC = `<!doctype html><style>@page{size:A4;margin:9mm}</style><h1>Real</h1>`;
(0, bun_test_1.describe)('input that is not html', () => {
    (0, bun_test_1.test)('binary files are refused by signature', async () => {
        const files = {
            'photo.jpg': Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
                'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
                'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'),
            'logo.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM' +
                'IQAAAABJRU5ErkJggg==', 'base64'),
        };
        for (const [name, bytes] of Object.entries(files)) {
            const p = (0, node_path_1.join)(dir, name);
            await (0, promises_1.writeFile)(p, bytes);
            const message = await renderError({ path: p });
            (0, bun_test_1.expect)(message, name).toMatch(/not HTML/);
            (0, bun_test_1.expect)(message, name).toMatch(/wrong file extension/);
        }
    });
    (0, bun_test_1.test)('a pdf fed as html is refused', async () => {
        const p = (0, node_path_1.join)(dir, 'already.pdf');
        await (0, promises_1.writeFile)(p, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
        const message = await renderError({ path: p });
        (0, bun_test_1.expect)(message).toMatch(/it is a PDF/);
    });
    (0, bun_test_1.test)('random binary is refused', async () => {
        const p = (0, node_path_1.join)(dir, 'blob.dat');
        await (0, promises_1.writeFile)(p, Buffer.from(Array.from({ length: 512 }, (_, i) => (i % 7 === 0 ? 0 : 65 + (i % 26)))));
        const message = await renderError({ path: p });
        (0, bun_test_1.expect)(message).toMatch(/null byte/);
    });
    (0, bun_test_1.test)('a binary magic header without a NUL byte is refused', async () => {
        const p = (0, node_path_1.join)(dir, 'header-only.png');
        await (0, promises_1.writeFile)(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const message = await renderError({ path: p });
        (0, bun_test_1.expect)(message).toMatch(/it is a PNG/);
    });
    (0, bun_test_1.test)('the message tells the user what to do, not just what happened', async () => {
        const p = (0, node_path_1.join)(dir, 'doc.jpg');
        await (0, promises_1.writeFile)(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
        const message = await renderError({ path: p });
        (0, bun_test_1.expect)(message).toContain('check the path');
    });
});
(0, bun_test_1.describe)('empty input', () => {
    (0, bun_test_1.test)('an empty document is an error, not a blank page', async () => {
        for (const html of ['', '   \n\t  ']) {
            const message = await renderError({ html });
            (0, bun_test_1.expect)(message, JSON.stringify(html)).toMatch(/input is empty/);
        }
    });
    (0, bun_test_1.test)('the message names both likely causes', async () => {
        const message = await renderError({ html: '' });
        (0, bun_test_1.expect)(message).toContain('stdout');
    });
    (0, bun_test_1.test)('a url that fails to load keeps its own diagnosis', async () => {
        const message = await renderError({
            url: 'https://this-host-does-not-exist-uxq9.invalid/',
            allowNetwork: true,
            timeoutMs: 20_000,
        });
        (0, bun_test_1.expect)(message).toMatch(/could not load|ERR_|HTTP \d\d\d/);
        (0, bun_test_1.expect)(message).not.toContain('input is empty');
    }, 40_000);
    (0, bun_test_1.test)('a real document is unaffected', async () => {
        (0, bun_test_1.expect)((await (0, render_ts_1.render)(browser, { html: DOC })).info.pages).toBe(1);
        (0, bun_test_1.expect)((await (0, render_ts_1.render)(browser, { html: '<!-- lead comment --><!doctype html><p>x</p>' })).info.pages).toBe(1);
        (0, bun_test_1.expect)((await (0, render_ts_1.render)(browser, { html: '   <p>leading whitespace</p>' })).info.pages).toBe(1);
    }, 60_000);
});
(0, bun_test_1.describe)('numeric flags are validated', () => {
    (0, bun_test_1.test)('a non-numeric timeout names the flag, not the protocol', async () => {
        const p = (0, node_path_1.join)(dir, 't.html');
        await (0, promises_1.writeFile)(p, DOC);
        const r = await cli([p, '--timeout', 'abc', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(2);
        (0, bun_test_1.expect)(r.err).toContain('--timeout needs at least 1000ms');
        (0, bun_test_1.expect)(r.err).toContain('got "abc"');
        (0, bun_test_1.expect)(r.err).not.toContain('cdp socket');
    }, 20_000);
    (0, bun_test_1.test)('a timeout below the floor is refused', async () => {
        const p = (0, node_path_1.join)(dir, 't.html');
        await (0, promises_1.writeFile)(p, DOC);
        for (const v of ['0', '1', '999', '-1', '1.5', '1e9', '']) {
            const r = await cli([p, '--timeout', v, '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
            (0, bun_test_1.expect)(r.code, `--timeout ${v}`).toBe(2);
            (0, bun_test_1.expect)(r.err).toContain('--timeout');
        }
    }, 30_000);
    (0, bun_test_1.test)('a non-numeric settle is refused', async () => {
        const p = (0, node_path_1.join)(dir, 't.html');
        await (0, promises_1.writeFile)(p, DOC);
        const r = await cli([p, '--settle', 'abc', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(2);
        (0, bun_test_1.expect)(r.err).toContain('--settle needs a whole number');
    }, 20_000);
    (0, bun_test_1.test)('settle 0 is allowed, because not waiting is a decision', async () => {
        const p = (0, node_path_1.join)(dir, 't.html');
        await (0, promises_1.writeFile)(p, DOC);
        const r = await cli([p, '--settle', '0', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(0);
    }, 60_000);
    (0, bun_test_1.test)('a negative margin is a value, not a missing argument', async () => {
        const p = (0, node_path_1.join)(dir, 't.html');
        await (0, promises_1.writeFile)(p, DOC);
        const r = await cli([p, '--format', 'a4', '--margin', '-5mm', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.err).not.toContain('needs a value');
    }, 60_000);
});
(0, bun_test_1.describe)('an error finding is not success', () => {
    (0, bun_test_1.test)('an unrotatable --landscape exits non-zero', async () => {
        const p = (0, node_path_1.join)(dir, 'psize.html');
        await (0, promises_1.writeFile)(p, `<!doctype html><style>@page{size:auto;margin:8mm}</style><p>x</p>`);
        const r = await cli([p, '--landscape', '--json', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('--landscape had no effect');
        (0, bun_test_1.expect)(r.err).toContain('the pdf was written, but a finding above is an error');
        const parsed = JSON.parse(r.out);
        (0, bun_test_1.expect)(parsed.ok).toBe(false);
        (0, bun_test_1.expect)(parsed.path).toContain('.pdf');
        (0, bun_test_1.expect)(parsed.findings.map((f) => f.code)).toContain('orientation-ignored');
        (0, bun_test_1.expect)(await Bun.file(parsed.path).exists()).toBe(true);
    }, 60_000);
    (0, bun_test_1.test)('a landscape that works exits 0', async () => {
        const p = (0, node_path_1.join)(dir, 'psize.html');
        const r = await cli([p, '--format', 'a4', '--landscape', '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(0);
        (0, bun_test_1.expect)(r.err).not.toContain('error:');
    }, 60_000);
    (0, bun_test_1.test)('--landscape under a declared page exits 0, and the paper is wide', async () => {
        const p = (0, node_path_1.join)(dir, 'declared.html');
        const out = (0, node_path_1.join)(dir, 'declared.pdf');
        await (0, promises_1.writeFile)(p, `<!doctype html><style>@page{size:a5;margin:8mm}</style><p>x</p>`);
        const r = await cli([p, '--landscape', '--json', '-o', out]);
        (0, bun_test_1.expect)(r.code).toBe(0);
        const parsed = JSON.parse(r.out);
        (0, bun_test_1.expect)(parsed.ok).toBe(true);
        const finding = parsed.findings.find((f) => f.code === 'orientation-overridden');
        (0, bun_test_1.expect)(finding.severity).toBe('info');
        const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
        const box = new TextDecoder('latin1').decode(bytes).match(/MediaBox\s*\[([^\]]*)\]/g)[0];
        const [x0, y0, x1, y1] = [...box.matchAll(/[\d.]+/g)].map((m) => Number(m[0]));
        (0, bun_test_1.expect)(x1 - x0).toBeGreaterThan(y1 - y0);
    }, 60_000);
    (0, bun_test_1.test)('a plain render with no findings exits 0', async () => {
        const p = (0, node_path_1.join)(dir, 'plain.html');
        await (0, promises_1.writeFile)(p, DOC);
        (0, bun_test_1.expect)((await cli([p, '-o', (0, node_path_1.join)(dir, 'o.pdf')])).code).toBe(0);
    }, 60_000);
});
(0, bun_test_1.describe)('a raw token given an array does not print commas', () => {
    (0, bun_test_1.test)('an array joins with newlines, not commas', () => {
        const tpl = '<table><tbody>{{{rows}}}</tbody></table>';
        const out = (0, template_ts_1.render)(tpl, { rows: ['<tr><td>a</td></tr>', '<tr><td>b</td></tr>'] });
        (0, bun_test_1.expect)(out).not.toContain(',');
        (0, bun_test_1.expect)(out).toContain('<tr><td>a</td></tr>');
        (0, bun_test_1.expect)(out).toContain('<tr><td>b</td></tr>');
    });
    (0, bun_test_1.test)('a string still passes through unchanged', () => {
        (0, bun_test_1.expect)((0, template_ts_1.render)('{{{rows}}}', { rows: '<tr><td>x</td></tr>' })).toBe('<tr><td>x</td></tr>');
    });
    (0, bun_test_1.test)('commas inside a description are not touched', () => {
        const out = (0, template_ts_1.render)('{{{rows}}}', { rows: ['<tr><td>Sensor, fused silica</td></tr>'] });
        (0, bun_test_1.expect)(out).toContain('Sensor, fused silica');
    });
    (0, bun_test_1.test)('a number still renders', () => {
        (0, bun_test_1.expect)((0, template_ts_1.render)('{{{rows}}}', { rows: 42 })).toBe('42');
    });
});
(0, bun_test_1.describe)('the template says what is wrong', () => {
    (0, bun_test_1.test)('a rejected value is not reported as a missing one', async () => {
        const p = (0, node_path_1.join)(dir, 'bad.json');
        await (0, promises_1.writeFile)(p, JSON.stringify({
            paper: 'A4',
            accent: '#1f4e79',
            font: 'sans-serif',
            company: 'Northwind',
            company_lines: ['Manchester'],
            invoice_no: '1',
            issued: '2026-10-03',
            due: '2026-11-02',
            bill_to_name: 'Halcyon',
            bill_to_lines: ['Lyon'],
            items: [{ description: 'x', qty: 1, unit: 10 }],
            currency: 'GBP',
            note: 'n',
            vat_rate: 'twenty',
        }));
        const r = await cli(['-t', 'invoice', '-d', p, '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('vat_rate must be a number between 0 and 1');
        (0, bun_test_1.expect)(r.err).not.toContain('missing values for');
    }, 20_000);
    (0, bun_test_1.test)('a genuinely missing value still says missing', () => {
        let message = '';
        try {
            (0, template_ts_1.render)('<p>{{needed}}</p>', {});
        }
        catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        (0, bun_test_1.expect)(message).toContain('missing values for');
        (0, bun_test_1.expect)(message).toContain('needed');
    });
});
(0, bun_test_1.describe)('invoice data is checked before it is printed', () => {
    const ITEMS = [
        { description: 'Replacement sensor window', qty: 4, unit: 96.4 },
        { description: 'Vacuum gauge', qty: 2, unit: 512 },
    ];
    const base = {
        paper: 'A4',
        accent: '#1f4e79',
        font: 'sans-serif',
        company: 'Northwind',
        company_lines: ['Manchester'],
        invoice_no: '2026-014',
        issued: '2026-10-03',
        due: '2026-11-02',
        bill_to_name: 'Halcyon Labs',
        bill_to_lines: ['Lyon'],
        items: ITEMS,
        currency: 'GBP',
        note: 'Within 30 days.',
    };
    const write = async (name, extra = {}) => {
        const p = (0, node_path_1.join)(dir, `${name}.json`);
        await (0, promises_1.writeFile)(p, JSON.stringify({ ...base, ...extra }));
        return p;
    };
    const invoiceResult = async (name, extra = {}) => {
        const p = await write(name, extra);
        return cli(['-t', 'invoice', '-d', p, '-o', (0, node_path_1.join)(dir, 'o.pdf')]);
    };
    (0, bun_test_1.test)('a subtotal that disagrees with the items is refused', async () => {
        const r = await invoiceResult('wrong_sub', { subtotal: '1' });
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('1,409.60');
    }, 20_000);
    (0, bun_test_1.test)('a matching total with separators is accepted', async () => {
        const r = await invoiceResult('match', {
            subtotal: '1,409.60',
            vat: '281.92',
            total: '1,691.52',
        });
        (0, bun_test_1.expect)(r.code).toBe(0);
    }, 60_000);
    (0, bun_test_1.test)('a non-numeric total says so, rather than reporting a mismatch', async () => {
        const r = await invoiceResult('nan_sub', { subtotal: 'abc' });
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('not a number');
    }, 20_000);
    (0, bun_test_1.test)('an empty items array is refused', async () => {
        const r = await invoiceResult('no_items', { items: [] });
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('items is empty');
    }, 20_000);
    (0, bun_test_1.test)('a vat rate that is not a fraction is refused', async () => {
        for (const vat_rate of [150, 'twenty', -0.2, 2]) {
            const r = await invoiceResult(`vat_${String(vat_rate)}`, { vat_rate });
            (0, bun_test_1.expect)(r.code, String(vat_rate)).toBe(1);
            (0, bun_test_1.expect)(r.err).toContain('between 0 and 1');
        }
    }, 40_000);
    (0, bun_test_1.test)('pre-built rows cannot bypass the totals check', async () => {
        const r = await invoiceResult('rows_only', {
            rows: '<tr><td>x</td></tr>',
            subtotal: '1',
            items: undefined,
        });
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('rows is pre-built table markup');
        (0, bun_test_1.expect)(r.err).toContain('items');
    }, 20_000);
    (0, bun_test_1.test)('a line item with a non-numeric price is refused', async () => {
        const r = await invoiceResult('bad_unit', {
            items: [{ description: 'x', qty: 1, unit: 'free' }],
        });
        (0, bun_test_1.expect)(r.code).toBe(1);
        (0, bun_test_1.expect)(r.err).toContain('not a number');
    }, 20_000);
});
(0, bun_test_1.describe)('the rendered invoice is what a customer would expect', () => {
    (0, bun_test_1.test)('totals are computed, formatted and correct', async () => {
        const p = (0, node_path_1.join)(dir, 'final.json');
        await (0, promises_1.writeFile)(p, JSON.stringify({
            paper: 'A4',
            accent: '#1f4e79',
            font: 'sans-serif',
            company: 'Northwind',
            company_lines: ['Manchester'],
            invoice_no: '2026-014',
            issued: '2026-10-03',
            due: '2026-11-02',
            bill_to_name: 'Halcyon Labs',
            bill_to_lines: ['Lyon'],
            items: [
                { description: 'Replacement sensor window', qty: 4, unit: 96.4 },
                { description: 'Vacuum gauge', qty: 2, unit: 512 },
            ],
            currency: 'GBP',
            note: 'Within 30 days.',
        }));
        const out = (0, node_path_1.join)(dir, 'final.pdf');
        const r = await cli(['-t', 'invoice', '-d', p, '-o', out]);
        (0, bun_test_1.expect)(r.code, r.err).toBe(0);
        const text = await (0, poppler_ts_1.pdfText)(new Uint8Array(await Bun.file(out).arrayBuffer()));
        (0, bun_test_1.expect)(text).toContain('1,409.60');
        (0, bun_test_1.expect)(text).toContain('281.92');
        (0, bun_test_1.expect)(text).toContain('1,691.52');
        (0, bun_test_1.expect)(text).toContain('20%');
        (0, bun_test_1.expect)(text).toContain('Replacement sensor window');
        (0, bun_test_1.expect)(text).not.toMatch(/^\s*,\s*$/m);
    }, 90_000);
});
(0, bun_test_1.describe)('ctrl-c cancels', () => {
    (0, bun_test_1.test)('SIGINT ends the run at once, with the conventional exit code', async () => {
        const { readdir } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
        const big = (0, node_path_1.join)(dir, 'huge.html');
        await (0, promises_1.writeFile)(big, `<!doctype html><style>@page{size:A4;margin:8mm}</style>${Array.from({ length: 60_000 }, (_, i) => `<p>line ${i} of a long document</p>`).join('')}`);
        const { readdirSync: readSync } = await Promise.resolve().then(() => __importStar(require('node:fs')));
        const profileDirsBefore = new Set(readSync((0, node_os_1.tmpdir)()).filter((n) => n.startsWith('letterpress-cli-') || n.startsWith('letterpress-server-')));
        const before = (await readdir((0, node_os_1.tmpdir)())).length;
        const child = Bun.spawn([
            'bun',
            (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts'),
            big,
            '--timeout',
            '300000',
            '-o',
            (0, node_path_1.join)(dir, 'cancelled.pdf'),
        ], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        await Bun.sleep(9_000);
        const chromiumForRun = async () => (await Bun.$ `ps -eo args`.text()).split('\n').filter((l) => l.includes('letterpress-cli-'))
            .length;
        const alive = await chromiumForRun();
        (0, bun_test_1.expect)(alive, 'chromium should be running before the signal').toBeGreaterThan(2);
        (0, bun_test_1.expect)(child.killed).toBe(false);
        (0, bun_test_1.expect)(child.signalCode).toBeNull();
        const sentAt = Date.now();
        child.kill('SIGINT');
        const code = await child.exited;
        const elapsed = Date.now() - sentAt;
        (0, bun_test_1.expect)(code).toBe(130);
        (0, bun_test_1.expect)(elapsed, `took ${elapsed}ms after the signal`).toBeLessThan(15_000);
        (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(dir, 'cancelled.pdf')).exists()).toBe(false);
        const dirsNow = readSync((0, node_os_1.tmpdir)()).filter((n) => n.startsWith('letterpress-cli-') || n.startsWith('letterpress-server-'));
        (0, bun_test_1.expect)(dirsNow.filter((n) => !profileDirsBefore.has(n)), 'left behind by this run').toEqual([]);
        let remaining = await chromiumForRun();
        for (let waited = 0; waited < 40_000 && remaining > 0; waited += 500) {
            await Bun.sleep(500);
            remaining = await chromiumForRun();
        }
        (0, bun_test_1.expect)(remaining, 'chromium processes for this run after the signal').toBe(0);
        void before;
    }, 120_000);
});
(0, bun_test_1.describe)('stdin is bounded by the deadline', () => {
    (0, bun_test_1.test)('a pipe that never closes is given up on', async () => {
        const fifo = (0, node_path_1.join)(dir, 'fifo');
        await Bun.$ `mkfifo ${fifo}`.quiet();
        const held = Bun.spawn([
            'sh',
            '-c',
            `exec 3> ${fifo}; printf '<!doctype html><p>partial' >&3; sleep 60`,
        ]);
        let child;
        let elapsed = 0;
        let err = '';
        try {
            await Bun.sleep(400);
            const { openSync } = await Promise.resolve().then(() => __importStar(require('node:fs')));
            const started = Date.now();
            const spawned = Bun.spawn([
                'bun',
                (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts'),
                '-',
                '--timeout',
                '5000',
                '-o',
                (0, node_path_1.join)(dir, 's.pdf'),
            ], { stdin: openSync(fifo, 'r'), stdout: 'pipe', stderr: 'pipe' });
            child = spawned;
            err = await new Response(spawned.stderr).text();
            await spawned.exited;
            elapsed = Date.now() - started;
        }
        finally {
            child?.kill('SIGKILL');
            held.kill('SIGKILL');
        }
        (0, bun_test_1.expect)(err).toContain('stdin was still open after 5s');
        (0, bun_test_1.expect)(elapsed, `took ${elapsed}ms`).toBeLessThan(20_000);
        (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(dir, 's.pdf')).exists()).toBe(false);
    }, 90_000);
    (0, bun_test_1.test)('a pipe that closes normally is unaffected', async () => {
        const child = Bun.spawn([
            'bun',
            (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts'),
            '-',
            '--timeout',
            '30000',
            '-o',
            (0, node_path_1.join)(dir, 'ok.pdf'),
        ], { stdin: Buffer.from(DOC), stdout: 'pipe', stderr: 'pipe' });
        await child.exited;
        (0, bun_test_1.expect)(await Bun.file((0, node_path_1.join)(dir, 'ok.pdf')).exists()).toBe(true);
        const bytes = new Uint8Array(await Bun.file((0, node_path_1.join)(dir, 'ok.pdf')).arrayBuffer());
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(bytes)).toContain('Real');
    }, 60_000);
    (0, bun_test_1.test)('a slow trickle that finishes is still accepted', async () => {
        const child = Bun.spawn(['sh', '-c', `printf '<!doctype html><p>Slow</p>'; sleep 3`], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const pump = Bun.spawn([
            'bun',
            (0, node_path_1.join)(import.meta.dir, '..', 'src', 'cli.ts'),
            '-',
            '--timeout',
            '30000',
            '-o',
            (0, node_path_1.join)(dir, 'slow.pdf'),
        ], { stdin: child.stdout, stdout: 'pipe', stderr: 'pipe' });
        await pump.exited;
        const bytes = new Uint8Array(await Bun.file((0, node_path_1.join)(dir, 'slow.pdf')).arrayBuffer());
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(bytes)).toContain('Slow');
    }, 60_000);
});
(0, bun_test_1.describe)('the pdf title is not a loopback port', () => {
    (0, bun_test_1.test)('a document with no title is titled after its file', async () => {
        const p = (0, node_path_1.join)(dir, 'notitle.html');
        await (0, promises_1.writeFile)(p, `<!doctype html><style>@page{size:A4;margin:9mm}</style><h1>No title</h1>`);
        for (const out of ['a.pdf', 'b.pdf']) {
            await cli([p, '-o', (0, node_path_1.join)(dir, out)]);
            const info = await (0, poppler_ts_1.pdfInfo)(new Uint8Array(await Bun.file((0, node_path_1.join)(dir, out)).arrayBuffer()));
            (0, bun_test_1.expect)(info.title.trim(), out).toBe('notitle.html');
        }
    }, 150_000);
    (0, bun_test_1.test)('a document that declares a title keeps it', async () => {
        const p = (0, node_path_1.join)(dir, 'titled.html');
        await (0, promises_1.writeFile)(p, `<!doctype html><title>My Real Title</title><p>x</p>`);
        await cli([p, '-o', (0, node_path_1.join)(dir, 't.pdf')]);
        const info = await (0, poppler_ts_1.pdfInfo)(new Uint8Array(await Bun.file((0, node_path_1.join)(dir, 't.pdf')).arrayBuffer()));
        (0, bun_test_1.expect)(info.title.trim()).toBe('My Real Title');
    }, 60_000);
    (0, bun_test_1.test)('the title is stable across runs without SOURCE_DATE_EPOCH', async () => {
        const p = (0, node_path_1.join)(dir, 'stable.html');
        await (0, promises_1.writeFile)(p, `<!doctype html><p>x</p>`);
        const titles = new Set();
        for (const out of ['1.pdf', '2.pdf', '3.pdf']) {
            await cli([p, '-o', (0, node_path_1.join)(dir, out)]);
            const info = await (0, poppler_ts_1.pdfInfo)(new Uint8Array(await Bun.file((0, node_path_1.join)(dir, out)).arrayBuffer()));
            titles.add(info.title.trim());
        }
        (0, bun_test_1.expect)(titles.size).toBe(1);
    }, 120_000);
    (0, bun_test_1.test)('a long filename does not corrupt the pdf', async () => {
        const name = `${'n'.repeat(120)}.html`;
        const p = (0, node_path_1.join)(dir, name);
        await (0, promises_1.writeFile)(p, `<!doctype html><p>long</p>`);
        const out = (0, node_path_1.join)(dir, 'long.pdf');
        (0, bun_test_1.expect)((await cli([p, '-o', out])).code).toBe(0);
        const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
        (0, bun_test_1.expect)((await (0, poppler_ts_1.pdfInfo)(bytes)).pages).toBe(1);
        (0, bun_test_1.expect)(await (0, poppler_ts_1.pdfText)(bytes)).toContain('long');
    }, 60_000);
});
//# sourceMappingURL=ux.test.js.map