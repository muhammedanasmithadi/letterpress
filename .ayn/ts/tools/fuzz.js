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
exports.rng = rng;
exports.document = document;
exports.checkFindings = checkFindings;
exports.fuzzOne = fuzzOne;
exports.shrink = shrink;
const promises_1 = require("node:fs/promises");
const render_ts_1 = require("../src/render.ts");
const verify_ts_1 = require("../src/verify.ts");
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const WORDS = [
    'lorem',
    'ipsum',
    'dolor',
    'official',
    'efficient',
    'fills',
    'office',
    'affluent',
    'report',
    'section',
    'table',
    'figure',
    'page',
    'document',
    'render',
    'engine',
];
const SPECIAL = [
    'fi',
    'fl',
    'ffi',
    'Ångström',
    'naïve',
    'façade',
    '∑',
    '∫',
    '→',
    '€',
    'نص',
    'עברית',
    '你好',
    '😀',
    'a b',
    'a​b',
    'extra­ordinary',
    '{{leftover}}',
    '{"json": true}',
    '<b>bold</b>',
    '&amp;',
    'AT&T',
];
const FONTS = ['serif', 'sans-serif', 'monospace', 'Georgia, serif', '"DejaVu Sans", sans-serif'];
const SIZES = ['A4', 'A5', 'letter'];
const ALIGNS = ['left', 'justify', 'center', 'right'];
function pick(r, xs) {
    return xs[Math.floor(r() * xs.length)];
}
function words(r, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(r() < 0.82 ? pick(r, WORDS) : pick(r, SPECIAL));
    }
    return out.join(' ');
}
function block(r, depth) {
    const kind = r();
    const text = words(r, 3 + Math.floor(r() * 25));
    if (kind < 0.3)
        return `<p>${text}</p>`;
    if (kind < 0.4)
        return `<h${1 + Math.floor(r() * 5)}>${words(r, 4)}</h${1 + Math.floor(r() * 5)}>`;
    if (kind < 0.5) {
        const cols = 1 + Math.floor(r() * 4);
        const rows = 1 + Math.floor(r() * 6);
        let t = '<table>';
        for (let i = 0; i < rows; i++) {
            t += '<tr>';
            for (let j = 0; j < cols; j++) {
                const span = r() < 0.08 ? ' colspan="2"' : '';
                t += `<t${i === 0 && r() < 0.5 ? 'h' : 'd'}${span}>${words(r, 4)}</t${i === 0 && r() < 0.5 ? 'h' : 'd'}>`;
            }
            t += '</tr>';
        }
        return t + '</table>';
    }
    if (kind < 0.58) {
        const n = 1 + Math.floor(r() * 5);
        let items = '';
        for (let i = 0; i < n; i++) {
            items += `<li>${words(r, 6)}${depth < 2 && r() < 0.25 ? `<ul><li>${words(r, 5)}</li></ul>` : ''}</li>`;
        }
        const tag = r() < 0.5 ? 'ul' : 'ol';
        const close = r() < 0.5 ? 'ul' : 'ol';
        return `<${tag}>${items}</${close}>`;
    }
    if (kind < 0.64) {
        const href = pick(r, ['#sec', 'https://example.com/x', 'missing-page.html', '']);
        return `<p><a${href ? ` href="${href}"` : ''}>${words(r, 3)}</a> ${text}</p>`;
    }
    if (kind < 0.7) {
        const src = pick(r, [
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'does-not-exist.png',
            'https://example.com/x.png',
        ]);
        const alt = r() < 0.7 ? ` alt="${words(r, 4)}"` : '';
        return `<figure><img src="${src}"${alt}><figcaption>${words(r, 5)}</figcaption></figure>`;
    }
    if (kind < 0.76)
        return `<blockquote>${text}</blockquote>`;
    if (kind < 0.8)
        return `<pre><code>${text} --flag value</code></pre>`;
    if (kind < 0.84)
        return '<hr>';
    if (kind < 0.88)
        return `<div>${depth < 3 ? block(r, depth + 1) : text}</div>`;
    if (kind < 0.9)
        return `<p dir="${r() < 0.5 ? 'rtl' : 'ltr'}">${text}</p>`;
    if (kind < 0.93) {
        const style = pick(r, [
            'color:red;float:left;width:40%',
            'position:absolute;top:0;left:0',
            'font-size:200pt;line-height:1',
            'margin:-50px 0 0 -50px',
            'transform:rotate(3deg)',
        ]);
        return `<p style="${style}">${text}</p>`;
    }
    if (kind < 0.95)
        return `<div><span><p><table><tr><td>${text}`;
    if (kind < 0.97)
        return `<!-- <div class="ghost">${text}</div> --><p>${words(r, 5)}</p>`;
    return `<p>${text}<br>${words(r, 8)}</p>`;
}
function document(seed, index) {
    const r = rng(seed * 100003 + index * 101);
    const size = pick(r, SIZES);
    const landscape = r() < 0.2 ? ' landscape' : '';
    const align = pick(r, ALIGNS);
    const font = pick(r, FONTS);
    const rtl = r() < 0.12;
    const css = `@page{size:${size}${landscape};margin:${pick(r, ['10mm', '15mm', '20mm'])}}` +
        `body{font-family:${font}} p{text-align:${align}}` +
        (r() < 0.3 ? 'table{border-collapse:collapse}td,th{border:1pt solid #999;padding:2pt}' : '') +
        (r() < 0.15 ? 'div{float:left;width:45%}' : '');
    const n = 2 + Math.floor(r() * 10);
    const blocks = [];
    for (let i = 0; i < n; i++)
        blocks.push(block(r, 0));
    if (r() < 0.1)
        blocks.length = 0;
    const html = `<!doctype html><html${rtl ? ' lang="ar"' : ''}><head><meta charset="utf-8">` +
        `<style>${css}</style></head><body${rtl ? ' dir="rtl"' : ''}>` +
        `<h1 id="sec">${words(r, 3)}</h1>`;
    const tail = `</body></html>`;
    return { html: html + blocks.join('\n') + tail, head: html, tail, blocks };
}
function checkFindings(findings) {
    for (const f of findings) {
        if (!f.code || !f.message)
            return `malformed finding: ${JSON.stringify(f).slice(0, 120)}`;
        if (f.severity !== 'error' && f.severity !== 'warn' && f.severity !== 'info') {
            return `unknown severity ${JSON.stringify(f.severity)} on ${f.code}`;
        }
    }
    return undefined;
}
async function fuzzOne(browser, seed, index, html) {
    const base = { seed, index, ok: false, pages: 0, bytes: 0, findings: 0 };
    const r = rng(seed * 100003 + index * 101 + 7);
    let out;
    try {
        out = await (0, render_ts_1.render)(browser, {
            html,
            ...(r() < 0.2 ? {} : { author: 'fuzz' }),
            ...(r() < 0.15 ? { format: 'a4', landscape: r() < 0.5 } : {}),
            ...(r() < 0.1 ? { pageRanges: '1-1' } : {}),
            timeoutMs: 20_000,
        });
    }
    catch (e) {
        return { ...base, reason: `render threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    const text = Buffer.from(out.pdf).toString('latin1');
    if (!text.startsWith('%PDF-'))
        return { ...base, reason: 'output is not a PDF' };
    const v = (0, verify_ts_1.verify)(out.pdf);
    if (!v.ok)
        return { ...base, reason: `verify refused: ${v.failures.join('; ').slice(0, 200)}` };
    const bad = checkFindings(out.findings);
    if (bad)
        return { ...base, reason: bad };
    return {
        ...base,
        ok: true,
        pages: out.info.pages,
        bytes: out.pdf.byteLength,
        findings: out.findings.length,
    };
}
async function shrink(browser, seed, index, head, tail, blocks, reason) {
    const attempt = (bs) => fuzzOne(browser, seed, index, head + bs.join('\n') + tail);
    let cur = blocks;
    for (let round = 0; round < 6 && cur.length > 1; round++) {
        const half = cur.filter((_, i) => i % 2 === 0);
        const probe = await attempt(half);
        if (!probe.ok && probe.reason === reason)
            cur = half;
        else {
            const other = cur.filter((_, i) => i % 2 === 1);
            const probe2 = await attempt(other);
            if (!probe2.ok && probe2.reason === reason)
                cur = other;
            else
                break;
        }
    }
    return head + cur.join('\n') + tail;
}
if (import.meta.main) {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
        const eq = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
        if (eq !== undefined)
            return eq;
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
    };
    const count = Number(flag('count', '200'));
    const seed = Number(flag('seed', String(Math.floor(Math.random() * 1e9))));
    const outDir = flag('out', '/tmp/opencode/fuzz');
    const { Browser } = await Promise.resolve().then(() => __importStar(require('../src/browser.ts')));
    const { mkdtemp, rm } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
    const { tmpdir } = await Promise.resolve().then(() => __importStar(require('node:os')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    const profile = await mkdtemp(join(tmpdir(), 'letterpress-fuzz-'));
    const browser = await Browser.launch({ profile });
    let pass = 0;
    const failures = [];
    try {
        for (let i = 0; i < count; i++) {
            const { html, head, tail, blocks } = document(seed, i);
            const res = await fuzzOne(browser, seed, i, html);
            if (res.ok) {
                pass++;
            }
            else {
                const shrunk = await shrink(browser, seed, i, head, tail, blocks, res.reason);
                failures.push({ seed, index: i, html, shrunk, reason: res.reason });
                console.log(`FAIL seed=${seed} doc=${i}: ${res.reason}`);
            }
            if ((i + 1) % 25 === 0)
                console.log(`…${i + 1}/${count} (${pass} pass)`);
        }
        console.log(`${pass}/${count} pass, ${failures.length} failures (seed ${seed})`);
        if (failures.length) {
            await (0, promises_1.mkdir)(outDir, { recursive: true });
            for (const f of failures) {
                await (0, promises_1.writeFile)(join(outDir, `seed${f.seed}-doc${f.index}.html`), f.shrunk, 'utf8');
            }
            console.log(`repros in ${outDir}`);
            process.exitCode = 1;
        }
    }
    finally {
        await browser.close();
        await rm(profile, { recursive: true, force: true }).catch(() => { });
    }
}
//# sourceMappingURL=fuzz.js.map