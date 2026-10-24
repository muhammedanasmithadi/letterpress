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
exports.REPAIRS = void 0;
exports.ghostscriptOk = ghostscriptOk;
exports.exoticCorpus = exoticCorpus;
exports.fuzzExoticFile = fuzzExoticFile;
exports.mutate = mutate;
exports.fuzzRepair = fuzzRepair;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fontdesc_ts_1 = require("../src/fontdesc.ts");
const figrole_ts_1 = require("../src/figrole.ts");
const linkdesc_ts_1 = require("../src/linkdesc.ts");
const meta_ts_1 = require("../src/meta.ts");
const tjmerge_ts_1 = require("../src/tjmerge.ts");
const spans_ts_1 = require("../src/spans.ts");
const tounicode_ts_1 = require("../src/tounicode.ts");
const verify_ts_1 = require("../src/verify.ts");
const fuzz_ts_1 = require("./fuzz.ts");
exports.REPAIRS = [
    { name: 'fixToUnicode', run: (p) => (0, tounicode_ts_1.fixToUnicode)(p) },
    { name: 'fixFontDescriptors', run: (p) => (0, fontdesc_ts_1.fixFontDescriptors)(p) },
    { name: 'mergeTextRuns', run: (p) => (0, tjmerge_ts_1.mergeTextRuns)(p).pdf },
    { name: 'stripRedundantSpans', run: (p) => (0, spans_ts_1.stripRedundantSpans)(p).pdf },
    { name: 'fixRedundantFigures', run: (p) => (0, figrole_ts_1.fixRedundantFigures)(p) },
    { name: 'fixLinkDescs', run: (p) => (0, linkdesc_ts_1.fixLinkDescs)(p, ['a description']) },
    { name: 'addMetadata', run: (p) => (0, meta_ts_1.addMetadata)(p, {}) },
    { name: 'setDocTitle', run: (p) => (0, meta_ts_1.setDocTitle)(p, 'Fuzz') },
];
async function ghostscriptOk() {
    try {
        const proc = Bun.spawn(['gs', '--version'], { stdout: 'ignore', stderr: 'ignore' });
        return (await proc.exited) === 0;
    }
    catch {
        return false;
    }
}
async function exoticCorpus(bases, dir) {
    const out = [];
    const run = async (args, input, output) => {
        const proc = Bun.spawn(['gs', '-q', '-dBATCH', '-dNOPAUSE', ...args, `-sOutputFile=${output}`, input], {
            stdout: 'ignore',
            stderr: 'ignore',
        });
        const code = await proc.exited;
        try {
            const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
            return code === 0 && bytes.length > 100 ? bytes : undefined;
        }
        catch {
            return undefined;
        }
    };
    let n = 0;
    for (const base of bases) {
        const input = (0, node_path_1.join)(dir, `base-${n}.pdf`);
        await (0, promises_1.writeFile)(input, base);
        const lin = await run(['-dFastWebView', '-sDEVICE=pdfwrite'], input, (0, node_path_1.join)(dir, `base-${n}-linear.pdf`));
        if (lin)
            out.push({ kind: 'linearized', detail: `fastwebview base-${n}`, bytes: lin });
        const variants = [
            ['r2-40', ['-sDEVICE=pdfwrite', '-sOwnerPassword=o123', '-dEncryptionR=2', '-dKeyLength=40']],
            [
                'r3-128-user',
                [
                    '-sDEVICE=pdfwrite',
                    '-sOwnerPassword=o123',
                    '-sUserPassword=u123',
                    '-dEncryptionR=3',
                    '-dKeyLength=128',
                ],
            ],
            [
                'r3-128-empty',
                ['-sDEVICE=pdfwrite', '-sOwnerPassword=o123', '-dEncryptionR=3', '-dKeyLength=128'],
            ],
        ];
        for (const [detail, args] of variants) {
            const enc = await run(args, input, (0, node_path_1.join)(dir, `base-${n}-${detail}.pdf`));
            if (enc)
                out.push({ kind: 'encrypted', detail: `${detail} base-${n}`, bytes: enc });
        }
        n++;
    }
    return out;
}
function fuzzExoticFile(file, repairs = exports.REPAIRS) {
    const failures = [];
    const notes = [];
    const v = (0, verify_ts_1.verify)(file.bytes);
    notes.push(`verify(input)=${v.ok}`);
    for (const repair of repairs) {
        let out;
        try {
            out = repair.run(file.bytes);
        }
        catch (e) {
            failures.push(`${repair.name} threw: ${e instanceof Error ? e.message : String(e)}`);
            continue;
        }
        if (out.length === 0 && file.bytes.length !== 0) {
            failures.push(`${repair.name} emptied the file`);
            continue;
        }
        if (!same(out, file.bytes)) {
            failures.push(`${repair.name} rewrote a ${file.kind} file (${file.bytes.length} -> ${out.length} bytes)`);
        }
    }
    return { file, failures, notes };
}
function mutate(r, pdf, kind) {
    const pick = (n) => Math.floor(r() * n);
    const buf = Buffer.from(pdf);
    switch (kind % 6) {
        case 0: {
            const n = 1 + pick(8);
            for (let i = 0; i < n; i++)
                buf[pick(buf.length)] = pick(256);
            return { bytes: buf, name: `flip${n}` };
        }
        case 1: {
            if (buf.length < 8)
                return { bytes: buf.subarray(0, 1), name: 'trunc1' };
            return { bytes: buf.subarray(0, 4 + pick(buf.length - 4)), name: 'truncate' };
        }
        case 2: {
            if (buf.length < 16)
                return { bytes: buf.subarray(0, 0), name: 'empty' };
            const at = pick(buf.length);
            const len = 1 + pick(Math.min(400, buf.length - at));
            return { bytes: Buffer.concat([buf.subarray(0, at), buf.subarray(at + len)]), name: 'cut' };
        }
        case 3: {
            if (buf.length < 8)
                return { bytes: Buffer.concat([buf, buf]), name: 'double' };
            const at = pick(buf.length);
            const len = 1 + pick(Math.min(200, buf.length - at));
            const piece = buf.subarray(at, at + len);
            return {
                bytes: Buffer.concat([buf.subarray(0, at), piece, piece, buf.subarray(at + len)]),
                name: 'dup',
            };
        }
        case 4: {
            let s = buf.toString('latin1');
            const which = pick(3);
            if (which === 0)
                s = s.replace(/\/Length\s+\d+/, '/Length 99999999');
            else if (which === 1)
                s = s.replace(/startxref\s+\d+/, 'startxref 3');
            else
                s = s.replace(/(\d{10}) 00000 n/, '9999999999 00000 n');
            return { bytes: Buffer.from(s, 'latin1'), name: 'lie' };
        }
        default: {
            const junk = Buffer.from(`${pick(99)} 0 obj\n<< /Type /Junk >>\nendobj\n`, 'latin1');
            const at = pick(buf.length + 1);
            return {
                bytes: Buffer.concat([buf.subarray(0, at), junk, buf.subarray(at)]),
                name: 'splice',
            };
        }
    }
}
function same(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function fuzzRepair(repair, pdf) {
    let out;
    try {
        out = repair.run(pdf);
    }
    catch (e) {
        return {
            ok: false,
            reason: `${repair.name} threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    if (out.length === 0 && pdf.length !== 0) {
        return { ok: false, reason: `${repair.name} returned empty output` };
    }
    if (!same(out, pdf) && (0, verify_ts_1.verify)(pdf).ok) {
        const v = (0, verify_ts_1.verify)(out);
        if (!v.ok) {
            return {
                ok: false,
                reason: `${repair.name} corrupted a valid file: ${v.failures.join('; ').slice(0, 160)}`,
            };
        }
    }
    return { ok: true, out };
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
    const count = Number(flag('count', '300'));
    const seed = Number(flag('seed', String(Math.floor(Math.random() * 1e9))));
    const outDir = flag('out', '/tmp/opencode/fuzzpdf');
    const { Browser } = await Promise.resolve().then(() => __importStar(require('../src/browser.ts')));
    const { mkdtemp, rm } = await Promise.resolve().then(() => __importStar(require('node:fs/promises')));
    const { tmpdir } = await Promise.resolve().then(() => __importStar(require('node:os')));
    const { render } = await Promise.resolve().then(() => __importStar(require('../src/render.ts')));
    const profile = await mkdtemp((0, node_path_1.join)(tmpdir(), 'letterpress-fuzzpdf-'));
    const browser = await Browser.launch({ profile });
    const failures = [];
    let total = 0;
    try {
        const docs = [
            `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>The official fish fills five.</p>`,
            `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}table,td{border:1pt solid #999}</style><table><tr><td>a</td><td>b</td></tr></table>`,
            `<!doctype html><html lang="ar"><head><meta charset="utf-8"><style>@page{size:A4;margin:15mm}body{direction:rtl}</style></head><body><p>نص تجريبي هنا.</p></body></html>`,
        ];
        const corpus = [];
        for (const html of docs) {
            corpus.push((await render(browser, { html, author: 'fuzz' })).pdf);
        }
        corpus.push(new Uint8Array(0));
        corpus.push(Buffer.from('not a pdf at all, just words', 'latin1'));
        corpus.push(Buffer.from('%PDF-1.4\ntrailer\n', 'latin1'));
        corpus.push(Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
            '10 0 obj\n<< /Type /ObjStm /N 2 /First 12 /Length 40 >>\nstream\n' +
            '1 0 2 10 << /A 1 >> << /B 2 >>\nendstream\nendobj\n' +
            'trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n', 'latin1'));
        corpus.push(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
            'trailer\n<< /Size 2 /Root 1 0 R /Encrypt << /Filter /Standard /V 2 /Length 128 >> >>\n' +
            'startxref\n0\n%%EOF\n', 'latin1'));
        const r = (0, fuzz_ts_1.rng)(seed);
        for (let i = 0; i < count; i++) {
            const src = corpus[Math.floor(r() * corpus.length)];
            const { bytes, name } = mutate(r, src, Math.floor(r() * 6));
            for (const repair of exports.REPAIRS) {
                total++;
                const res = fuzzRepair(repair, bytes);
                if (!res.ok) {
                    failures.push({
                        seed,
                        index: i,
                        repair: repair.name,
                        mutation: name,
                        reason: res.reason,
                        input: bytes,
                    });
                    console.log(`FAIL seed=${seed} #${i} ${repair.name} on ${name}: ${res.reason}`);
                }
            }
            if ((i + 1) % 50 === 0)
                console.log(`…${i + 1}/${count}`);
        }
        console.log(`${total - failures.length}/${total} pass, ${failures.length} failures (seed ${seed})`);
        if (failures.length) {
            await (0, promises_1.mkdir)(outDir, { recursive: true });
            for (const [n, f] of failures.entries()) {
                await (0, promises_1.writeFile)((0, node_path_1.join)(outDir, `seed${f.seed}-${n}-${f.repair}-${f.mutation}.pdf`), f.input);
            }
            console.log(`mutants in ${outDir}`);
            process.exitCode = 1;
        }
        if (argv.includes('--exotic')) {
            if (!(await ghostscriptOk())) {
                console.log('exotic corpus skipped: gs not found (Ghostscript 10+ with pdfwrite)');
            }
            else {
                const exoticDir = (0, node_path_1.join)(outDir, 'exotic');
                await (0, promises_1.mkdir)(exoticDir, { recursive: true });
                const files = await exoticCorpus(corpus.slice(0, 3), exoticDir);
                let exoticFails = 0;
                for (const file of files) {
                    await (0, promises_1.writeFile)((0, node_path_1.join)(exoticDir, `${file.kind}-${file.detail.replace(/[^a-z0-9-]+/gi, '_')}.pdf`), file.bytes);
                    const res = fuzzExoticFile(file);
                    console.log(`${file.kind} ${file.detail}: ${res.failures.length ? 'FAIL' : 'keep'} ${res.notes.join(' ')}`);
                    for (const f of res.failures) {
                        console.log(`  ${f}`);
                        exoticFails++;
                    }
                }
                console.log(`${files.length} exotic files, ${exoticFails} failures`);
                if (exoticFails)
                    process.exitCode = 1;
            }
        }
    }
    finally {
        await browser.close();
        await rm(profile, { recursive: true, force: true }).catch(() => { });
    }
}
//# sourceMappingURL=fuzzpdf.js.map