"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pdfInfo = pdfInfo;
exports.pdfText = pdfText;
exports.pdfFonts = pdfFonts;
exports.pdfWords = pdfWords;
exports.pdfImages = pdfImages;
exports.pdfToPng = pdfToPng;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const TMP = process.env.TMPDIR ?? '/tmp';
let counter = 0;
async function withPdf(bytes, fn) {
    const path = `${TMP}/letterpress-verify-${process.pid}-${counter++}.pdf`;
    await Bun.write(path, bytes);
    try {
        return await fn(path);
    }
    finally {
        await (0, promises_1.rm)(path, { force: true }).catch(() => { });
    }
}
async function pdfInfo(bytes) {
    return withPdf(bytes, async (path) => {
        const out = await Bun.$ `pdfinfo ${path}`.quiet().text();
        return {
            pages: Number(out.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0),
            pageSize: out.match(/^Page size:\s+(.+)$/m)?.[1]?.trim() ?? '',
            encrypted: /^Encrypted:\s+yes/m.test(out),
            title: out.match(/^Title:\s+(.*)$/m)?.[1] ?? '',
        };
    });
}
async function pdfText(bytes) {
    return withPdf(bytes, async (path) => {
        const proc = Bun.spawn(['pdftotext', '-layout', path, '-'], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return out;
    });
}
async function pdfFonts(bytes) {
    return withPdf(bytes, async (path) => await Bun.$ `pdffonts ${path}`.quiet().text());
}
async function pdfWords(bytes) {
    const xml = await withPdf(bytes, async (path) => {
        const proc = Bun.spawn(['pdftotext', '-bbox', path, '-'], { stdout: 'pipe', stderr: 'ignore' });
        const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return out;
    });
    return [
        ...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g),
    ].map((m) => ({
        xMin: Number(m[1]),
        yMin: Number(m[2]),
        xMax: Number(m[3]),
        yMax: Number(m[4]),
        text: m[5],
    }));
}
async function pdfImages(bytes) {
    return withPdf(bytes, async (path) => {
        const out = await Bun.$ `pdfimages -list ${path}`.quiet().text();
        const rows = out.split('\n').slice(2);
        const images = [];
        for (const row of rows) {
            const m = row.trim().match(/^(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s+(\d+)\s/);
            if (m) {
                images.push({
                    page: Number(m[1]),
                    type: m[3],
                    width: Number(m[4]),
                    height: Number(m[5]),
                });
            }
        }
        return images;
    });
}
async function pdfToPng(bytes, { dpi = 110, prefix } = {}) {
    const base = prefix ?? `${TMP}/letterpress-png-${process.pid}-${counter++}`;
    return withPdf(bytes, async (path) => {
        await Bun.$ `pdftoppm -png -r ${dpi} ${path} ${base}`.quiet();
        const dir = (0, node_path_1.dirname)(base);
        const stem = (0, node_path_1.basename)(base);
        const entries = await (0, promises_1.readdir)(dir).catch(() => []);
        const pages = [];
        for (const name of entries) {
            if (!name.startsWith(`${stem}-`))
                continue;
            const m = /^(\d+)\.png$/.exec(name.slice(stem.length + 1));
            if (m)
                pages.push({ page: Number(m[1]), path: (0, node_path_1.join)(dir, name) });
        }
        return pages.sort((a, b) => a.page - b.page).map((x) => x.path);
    });
}
//# sourceMappingURL=poppler.js.map