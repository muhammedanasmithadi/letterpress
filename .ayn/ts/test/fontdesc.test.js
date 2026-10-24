"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const fontdesc_ts_1 = require("../src/fontdesc.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const poppler_ts_1 = require("./poppler.ts");
const render_ts_1 = require("../src/render.ts");
function descriptors(pdf) {
    const text = Buffer.from(pdf).toString(LATIN1);
    const out = [];
    for (const m of text.matchAll(/\/Type \/FontDescriptor([\s\S]*?)>>/g)) {
        const flags = m[1].match(/\/Flags (\d+)/);
        const cap = m[1].match(/\/CapHeight (-?\d+)/);
        out.push({
            flags: flags ? Number(flags[1]) : null,
            cap: cap ? Number(cap[1]) : null,
            hasProgram: /\/FontFile\d? \d+ 0 R/.test(m[1]),
        });
    }
    return out;
}
function sfnt(tables, version = 0x00010000) {
    const num = tables.length;
    let power = 1;
    while (power * 2 <= num)
        power *= 2;
    const dir = Buffer.alloc(12 + num * 16);
    dir.writeUInt32BE(version, 0);
    dir.writeUInt16BE(num, 4);
    dir.writeUInt16BE(power * 16, 6);
    dir.writeUInt16BE(Math.log2(power), 8);
    dir.writeUInt16BE(num * 16 - power * 16, 10);
    const chunks = [];
    let at = dir.length;
    tables.forEach((t, i) => {
        const rec = 12 + i * 16;
        dir.write(t.tag.padEnd(4, ' ').slice(0, 4), rec, LATIN1);
        dir.writeUInt32BE(0, rec + 4);
        dir.writeUInt32BE(at, rec + 8);
        dir.writeUInt32BE(t.data.length, rec + 12);
        const padded = Buffer.alloc(Math.ceil(t.data.length / 4) * 4);
        t.data.copy(padded);
        chunks.push(padded);
        at += padded.length;
    });
    return Buffer.concat([dir, ...chunks]);
}
const LATIN1 = 'latin1';
function head(unitsPerEm, macStyle) {
    const b = Buffer.alloc(54);
    b.writeUInt32BE(0x00010000, 0);
    b.writeUInt16BE(unitsPerEm, 18);
    b.writeUInt16BE(macStyle, 44);
    return { tag: 'head', data: b };
}
function os2(version, fsSelection, sCapHeight) {
    const b = Buffer.alloc(96);
    b.writeUInt16BE(version, 0);
    b.writeUInt16BE(fsSelection, 62);
    if (version >= 2)
        b.writeInt16BE(sCapHeight, 86);
    return { tag: 'OS/2', data: b };
}
function post(italicAngle, isFixedPitch) {
    const b = Buffer.alloc(32);
    b.writeInt32BE(Math.round(italicAngle * 65536), 4);
    b.writeUInt32BE(isFixedPitch, 12);
    return { tag: 'post', data: b };
}
function cmap(platform, encoding) {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(0, 0);
    b.writeUInt16BE(1, 2);
    b.writeUInt16BE(platform, 4);
    b.writeUInt16BE(encoding, 6);
    b.writeUInt32BE(12, 8);
    return { tag: 'cmap', data: b };
}
const notoSans = () => sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(0, 0), cmap(3, 1)]);
const notoSansBold = () => sfnt([head(1000, 0x01), os2(4, 0x00a0, 546), post(0, 0), cmap(3, 1)]);
function pdfWith(fileKey, font, overrides) {
    const body = (0, fixtures_ts_1.deflated)(font);
    const descriptorBody = '<< /Type /FontDescriptor /FontName /BAAAAA+NotoSans-Regular ' +
        `/Flags ${overrides.Flags ?? '4'} /FontBBox [-1000 -300 2000 900] /ItalicAngle 0 ` +
        `/Ascent 900 /Descent -300 /CapHeight ${overrides.CapHeight ?? '-714'} ` +
        `/StemV 80 /${fileKey} 6 0 R >>`;
    return (0, fixtures_ts_1.assemblePdf)([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
        descriptorBody,
        '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BAAAAA+NotoSans-Regular /FontDescriptor 4 0 R ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
        {
            dict: `<< /Length1 ${font.length} /Filter /FlateDecode /Length ${body.length} >>`,
            payload: body,
        },
    ]);
}
(0, bun_test_1.describe)('parseSfnt', () => {
    (0, bun_test_1.test)("reads cap height from the font's own OS/2 table", () => {
        const s = (0, fontdesc_ts_1.parseSfnt)(notoSans());
        (0, bun_test_1.expect)(s.unitsPerEm).toBe(1000);
        (0, bun_test_1.expect)(s.os2Version).toBe(4);
        (0, bun_test_1.expect)(s.sCapHeight).toBe(536);
        (0, bun_test_1.expect)(s.macStyle).toBe(0);
        (0, bun_test_1.expect)(s.unicodeCmap).toBe(true);
    });
    (0, bun_test_1.test)('a different font yields a different cap height, so the value is read not assumed', () => {
        const scaled = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(700, 0), os2(4, 0x00c0, 370), post(0, 0), cmap(3, 1)]));
        (0, bun_test_1.expect)(Math.round((scaled.sCapHeight / scaled.unitsPerEm) * 1000)).toBe(529);
    });
    (0, bun_test_1.test)('an OS/2 older than version 2 reports no cap height rather than reading past its end', () => {
        const s = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(1, 0x0040, 536), post(0, 0), cmap(3, 1)]));
        (0, bun_test_1.expect)(s.os2Version).toBe(1);
        (0, bun_test_1.expect)(s.sCapHeight).toBe(0);
    });
    (0, bun_test_1.test)('a CFF or Type 1 face has no table directory and is refused', () => {
        (0, bun_test_1.expect)((0, fontdesc_ts_1.parseSfnt)(Buffer.from('00010000', 'hex'))).toBeUndefined();
        (0, bun_test_1.expect)((0, fontdesc_ts_1.parseSfnt)(Buffer.from('%!PS-AdobeFont', LATIN1))).toBeUndefined();
        (0, bun_test_1.expect)((0, fontdesc_ts_1.parseSfnt)(Buffer.alloc(4))).toBeUndefined();
    });
    (0, bun_test_1.test)('a font with only a symbol cmap is not a Unicode text font', () => {
        const s = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x0040, 536), post(0, 0), cmap(3, 0)]));
        (0, bun_test_1.expect)(s.unicodeCmap).toBe(false);
    });
    (0, bun_test_1.test)('a proportional font reports fixedPitch false, not unknown', () => {
        const s = (0, fontdesc_ts_1.parseSfnt)(notoSans());
        (0, bun_test_1.expect)(s.fixedPitch).toBe(false);
    });
    (0, bun_test_1.test)('the legacy monospaced marker counts as monospaced', () => {
        const legacy = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(0, 0xffff_ffff), cmap(3, 1)]));
        (0, bun_test_1.expect)(legacy.fixedPitch).toBe(true);
    });
    (0, bun_test_1.test)('a short post table leaves fixedPitch unknown', () => {
        const b = Buffer.alloc(12);
        b.writeInt32BE(0, 4);
        const s = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x00c0, 536), { tag: 'post', data: b }, cmap(3, 1)]));
        (0, bun_test_1.expect)(s.fixedPitch).toBeUndefined();
    });
});
(0, bun_test_1.describe)('flagsFrom', () => {
    const base = (0, fontdesc_ts_1.parseSfnt)(notoSans());
    (0, bun_test_1.test)('a Unicode upright proportional face is non-symbolic', () => {
        (0, bun_test_1.expect)((0, fontdesc_ts_1.flagsFrom)(base, 4)).toBe(32);
    });
    (0, bun_test_1.test)('italic is set from the font, whichever of the three tables declares it', () => {
        const byMacStyle = (0, fontdesc_ts_1.flagsFrom)((0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0x02), os2(4, 0x00c0, 536), post(0, 0), cmap(3, 1)])), 4);
        const byAngle = (0, fontdesc_ts_1.flagsFrom)((0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(-11, 0), cmap(3, 1)])), 4);
        const byFsSelection = (0, fontdesc_ts_1.flagsFrom)((0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x00c1, 536), post(0, 0), cmap(3, 1)])), 4);
        (0, bun_test_1.expect)(byMacStyle & 64).toBe(64);
        (0, bun_test_1.expect)(byAngle & 64).toBe(64);
        (0, bun_test_1.expect)(byFsSelection & 64).toBe(64);
    });
    (0, bun_test_1.test)('a bold upright face is not italic', () => {
        (0, bun_test_1.expect)((0, fontdesc_ts_1.flagsFrom)((0, fontdesc_ts_1.parseSfnt)(notoSansBold()), 4) & 64).toBe(0);
    });
    (0, bun_test_1.test)('a monospaced face is marked FixedPitch', () => {
        const mono = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(0, 1), cmap(3, 1)]));
        (0, bun_test_1.expect)((0, fontdesc_ts_1.flagsFrom)(mono, 4) & 1).toBe(1);
        (0, bun_test_1.expect)((0, fontdesc_ts_1.flagsFrom)(base, 4) & 1).toBe(0);
    });
    (0, bun_test_1.test)('a symbol-only font keeps the symbolic bit', () => {
        const sym = (0, fontdesc_ts_1.parseSfnt)(sfnt([head(1000, 0), os2(4, 0x0040, 536), post(0, 0), cmap(3, 0)]));
        const flags = (0, fontdesc_ts_1.flagsFrom)(sym, 4);
        (0, bun_test_1.expect)(flags & 4).toBe(4);
        (0, bun_test_1.expect)(flags & 32).toBe(0);
    });
    (0, bun_test_1.test)('bits that cannot be derived are left as the producer wrote them', () => {
        const flags = (0, fontdesc_ts_1.flagsFrom)(base, 4 | 2 | 8);
        (0, bun_test_1.expect)(flags & 2).toBe(2);
        (0, bun_test_1.expect)(flags & 8).toBe(8);
        (0, bun_test_1.expect)(flags & 4).toBe(0);
        (0, bun_test_1.expect)(flags & 32).toBe(32);
    });
});
(0, bun_test_1.describe)('fixFontDescriptors', () => {
    (0, bun_test_1.test)("rewrites the negative cap height to the font's own value", () => {
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(pdfWith('FontFile2', notoSans(), {}));
        (0, bun_test_1.expect)(descriptors(out)).toEqual([{ flags: 32, cap: 536, hasProgram: true }]);
    });
    (0, bun_test_1.test)('the rewritten file is still a valid pdf', () => {
        const out = Buffer.from((0, fontdesc_ts_1.fixFontDescriptors)(pdfWith('FontFile2', notoSans(), {})));
        const text = out.toString(LATIN1);
        (0, bun_test_1.expect)(text.match(/startxref/g)).toHaveLength(1);
        const at = Number(text.match(/startxref\s+(\d+)/)[1]);
        (0, bun_test_1.expect)(text.slice(at, at + 4)).toBe('xref');
        const size = Number(text.slice(at).match(/xref\s+0\s+(\d+)/)[1]);
        const header = /xref\s+0\s+\d+\s*\n/.exec(text.slice(at))[0];
        const body = text.slice(at + header.length);
        let checked = 0;
        for (let n = 1; n < size; n++) {
            const entry = body.slice(n * 20, n * 20 + 20);
            if (entry[17] !== 'n')
                continue;
            checked++;
            (0, bun_test_1.expect)(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + 20)).toStartWith(`${n} 0 obj`);
        }
        (0, bun_test_1.expect)(checked, 'no in-use xref entries were examined').toBeGreaterThan(0);
        (0, bun_test_1.expect)(text).not.toContain('endobjxref');
        (0, bun_test_1.expect)(text).toMatch(/\/Size 7/);
    });
    (0, bun_test_1.test)('a CFF font is left exactly as it was', () => {
        const input = pdfWith('FontFile3', notoSans(), { Flags: '4', CapHeight: '-714' });
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(input);
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)(out, input)).toBe(true);
    });
    (0, bun_test_1.test)('a font with no usable sCapHeight keeps the cap height it arrived with', () => {
        const old = sfnt([head(1000, 0), os2(1, 0x0040, 0), post(0, 0), cmap(3, 1)]);
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(pdfWith('FontFile2', old, {}));
        (0, bun_test_1.expect)(descriptors(out)).toEqual([{ flags: 32, cap: -714, hasProgram: true }]);
    });
    (0, bun_test_1.test)('a descriptor with no CapHeight key is given one', () => {
        const bare = Buffer.from(Buffer.from(pdfWith('FontFile2', notoSans(), {}))
            .toString(LATIN1)
            .replace(' /CapHeight -714', ''), LATIN1);
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(bare);
        const fields = descriptors(out);
        (0, bun_test_1.expect)(fields).toEqual([{ flags: 32, cap: 536, hasProgram: true }]);
        const text = Buffer.from(out).toString(LATIN1);
        (0, bun_test_1.expect)(text).toMatch(/\/Type \/FontDescriptor[^\n]*\/CapHeight 536/);
    });
    (0, bun_test_1.test)('a descriptor with no Flags key is still corrected', () => {
        const bare = Buffer.from(Buffer.from(pdfWith('FontFile2', notoSans(), {}))
            .toString(LATIN1)
            .replace(' /Flags 4', ''), LATIN1);
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(bare);
        const fields = descriptors(out);
        (0, bun_test_1.expect)(fields[0].cap).toBe(536);
        const text = Buffer.from(out).toString(LATIN1);
        (0, bun_test_1.expect)(text).toMatch(/\/Flags 32/);
        (0, bun_test_1.expect)(text).toMatch(/\/CapHeight 536/);
        (0, bun_test_1.expect)(text).toContain('/StemV 80');
    });
    (0, bun_test_1.test)('a positive cap height already in place is left alone', () => {
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(pdfWith('FontFile2', notoSans(), { CapHeight: '700' }));
        (0, bun_test_1.expect)(descriptors(out)).toEqual([{ flags: 32, cap: 700, hasProgram: true }]);
    });
    (0, bun_test_1.test)('only Flags and CapHeight change; every other descriptor field survives', () => {
        const input = pdfWith('FontFile2', notoSans(), {});
        const out = (0, fontdesc_ts_1.fixFontDescriptors)(input);
        const fields = (pdf) => {
            const t = Buffer.from(pdf).toString(LATIN1);
            return {
                name: t.match(/\/FontName (\S+)/)[1],
                bbox: t.match(/\/FontBBox (\[[^\]]+\])/)[1],
                ascent: t.match(/\/Ascent (-?\d+)/)[1],
                descent: t.match(/\/Descent (-?\d+)/)[1],
                angle: t.match(/\/ItalicAngle (-?[\d.]+)/)[1],
                stem: t.match(/\/StemV (\d+)/)[1],
            };
        };
        (0, bun_test_1.expect)(fields(out)).toEqual(fields(input));
    });
    (0, bun_test_1.test)('input that is not a linear pdf is returned untouched', () => {
        for (const junk of [
            Buffer.alloc(0),
            Buffer.from('not a pdf at all'),
            Buffer.from('%PDF-1.7\n'),
        ]) {
            (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, fontdesc_ts_1.fixFontDescriptors)(junk), junk)).toBe(true);
        }
    });
    (0, bun_test_1.test)('a pdf with nothing to correct comes back byte for byte', () => {
        const good = pdfWith('FontFile3', notoSans(), { Flags: '32', CapHeight: '536' });
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, fontdesc_ts_1.fixFontDescriptors)(good), good)).toBe(true);
    });
    (0, bun_test_1.test)('a value already matching the font does not rewrite the file', () => {
        const input = pdfWith('FontFile2', notoSans(), { Flags: '32', CapHeight: '536' });
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, fontdesc_ts_1.fixFontDescriptors)(input), input)).toBe(true);
    });
    (0, bun_test_1.test)('a Uint8Array that is not a Buffer is still read as bytes', () => {
        const input = pdfWith('FontFile2', notoSans(), {});
        const asView = new Uint8Array(input);
        (0, bun_test_1.expect)(asView).not.toBeInstanceOf(Buffer);
        (0, bun_test_1.expect)(descriptors((0, fontdesc_ts_1.fixFontDescriptors)(asView))).toEqual([
            { flags: 32, cap: 536, hasProgram: true },
        ]);
    });
    (0, bun_test_1.test)('a null byte cannot truncate the scan', () => {
        const input = Buffer.concat([pdfWith('FontFile2', notoSans(), {}), Buffer.from([0])]);
        (0, bun_test_1.expect)(descriptors((0, fontdesc_ts_1.fixFontDescriptors)(input))).toEqual([
            { flags: 32, cap: 536, hasProgram: true },
        ]);
    });
});
(0, bun_test_1.describe)('unresolvedFontMetrics', () => {
    const barePdf = (fontObj) => Buffer.from([
        '%PDF-1.4',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R >>',
        'endobj',
        ...fontObj,
        '4 0 obj',
        '<< /Type /FontDescriptor /FontName /TestFace /CapHeight -100 >>',
        'endobj',
        'trailer',
        '<< /Root 1 0 R >>',
        'startxref',
        '999',
        '%%EOF',
    ].join('\n'), LATIN1);
    (0, bun_test_1.test)('a negative CapHeight without an embedded program is reported', () => {
        const pdf = barePdf([
            '3 0 obj',
            '<< /Type /Font /Subtype /TrueType /BaseFont /TestFace /FontDescriptor 4 0 R >>',
            'endobj',
        ]);
        (0, bun_test_1.expect)((0, fontdesc_ts_1.unresolvedFontMetrics)(pdf)).toEqual([
            { fontName: 'TestFace', capHeight: -100, subtype: 'TrueType' },
        ]);
    });
    (0, bun_test_1.test)('a descriptor with no owning font is reported with an unknown subtype', () => {
        (0, bun_test_1.expect)((0, fontdesc_ts_1.unresolvedFontMetrics)(barePdf([]))).toEqual([
            { fontName: 'TestFace', capHeight: -100, subtype: 'unknown' },
        ]);
    });
});
(0, bun_test_1.describe)('rendered output', () => {
    let browser;
    let profile;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-fontdesc-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
    });
    const threeFaces = `<!doctype html><meta charset="utf-8">
    <style>@page{size:A4;margin:10mm}body{font-family:"Noto Sans",sans-serif}</style>
    <p style="font-weight:400">Regular face text</p>
    <p style="font-weight:700">Bold face text</p>
    <p style="font-style:italic">Italic face text</p>`;
    (0, bun_test_1.test)('every descriptor with an embedded font gets a positive cap height', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const withProgram = descriptors(r.pdf).filter((d) => d.hasProgram);
        (0, bun_test_1.expect)(withProgram.length).toBeGreaterThan(0);
        for (const d of withProgram)
            (0, bun_test_1.expect)(d.cap).toBeGreaterThan(0);
    });
    (0, bun_test_1.test)('the symbolic bit is replaced by non-symbolic on every embedded face', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const withProgram = descriptors(r.pdf).filter((d) => d.hasProgram);
        (0, bun_test_1.expect)(withProgram.length).toBeGreaterThan(0);
        const flagged = withProgram.filter((d) => d.flags !== null);
        (0, bun_test_1.expect)(flagged.length, 'a rendered descriptor carries no /Flags').toBe(withProgram.length);
        for (const d of flagged) {
            (0, bun_test_1.expect)(d.flags & 4).toBe(0);
            (0, bun_test_1.expect)(d.flags & 32).toBe(32);
        }
    });
    (0, bun_test_1.test)('an italic face is marked italic and an upright one is not', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><p>upright</p><p><i>italic text</i></p>`,
        });
        const faces = descriptors(r.pdf).filter((d) => d.hasProgram);
        (0, bun_test_1.expect)(faces.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(faces.filter((d) => d.flags !== null).length).toBe(faces.length);
        const italic = faces.filter((d) => d.flags & 64);
        const upright = faces.filter((d) => !(d.flags & 64));
        (0, bun_test_1.expect)(italic.length).toBeGreaterThan(0);
        (0, bun_test_1.expect)(upright.length).toBeGreaterThan(0);
    });
    (0, bun_test_1.test)('serif-ness survives while the italic bit is added', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><style>body{font-family:"DejaVu Serif",serif}</style><p><i>italic</i></p>`,
        });
        const italic = descriptors(r.pdf).filter((d) => d.hasProgram && d.flags !== null && d.flags & 64);
        (0, bun_test_1.expect)(italic.length).toBeGreaterThan(0);
        for (const d of italic)
            (0, bun_test_1.expect)(d.flags & 2).toBe(2);
    });
    (0, bun_test_1.test)('a face the font calls monospaced is marked FixedPitch', async () => {
        const embedded = descriptors((0, fontdesc_ts_1.fixFontDescriptors)(pdfWith('FontFile2', sfnt([head(1000, 0), os2(4, 0x00c0, 536), post(0, 1), cmap(3, 1)]), {})));
        (0, bun_test_1.expect)(embedded[0].flags).not.toBeNull();
        (0, bun_test_1.expect)(embedded[0].flags & 1).not.toBe(0);
    });
    (0, bun_test_1.test)('cap heights differ between faces, so they are read per font', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const caps = new Set(descriptors(r.pdf)
            .filter((d) => d.hasProgram)
            .map((d) => d.cap));
        (0, bun_test_1.expect)(caps.has(null), 'a rendered descriptor carries no /CapHeight').toBe(false);
        (0, bun_test_1.expect)(caps.size).toBeGreaterThan(1);
    });
    (0, bun_test_1.test)('a descriptor with no embedded font is reported, not invented', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const gaps = (0, fontdesc_ts_1.unresolvedFontMetrics)(r.pdf);
        const leftover = descriptors(r.pdf).filter((d) => d.cap !== null && d.cap <= 0);
        (0, bun_test_1.expect)(leftover.length).toBe(gaps.length);
        for (const g of gaps) {
            (0, bun_test_1.expect)(g.capHeight).toBeLessThan(0);
            (0, bun_test_1.expect)(g.fontName).not.toBe('');
        }
        const finding = r.findings.find((f) => f.code === 'font-metrics');
        if (leftover.length) {
            (0, bun_test_1.expect)(finding).toBeDefined();
            (0, bun_test_1.expect)(finding.severity).toBe('warn');
            for (const g of gaps)
                (0, bun_test_1.expect)(finding.message).toContain(g.capHeight < 0 ? String(g.capHeight) : '');
        }
    });
    (0, bun_test_1.test)('a document whose faces all embed has nothing left to report', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><style>body{font-family:"DejaVu Serif",serif}</style><p>Serif <b>bold</b></p>`,
        });
        (0, bun_test_1.expect)((0, fontdesc_ts_1.unresolvedFontMetrics)(r.pdf)).toEqual([]);
        (0, bun_test_1.expect)(r.findings.find((f) => f.code === 'font-metrics')).toBeUndefined();
        for (const d of descriptors(r.pdf))
            (0, bun_test_1.expect)(d.cap).toBeGreaterThan(0);
    });
    (0, bun_test_1.test)('the text still extracts, and reads the same as the source', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const text = await (0, poppler_ts_1.pdfText)(r.pdf);
        for (const word of ['Regular', 'face', 'text', 'Bold', 'Italic']) {
            (0, bun_test_1.expect)(text).toContain(word);
        }
        (0, bun_test_1.expect)(text).not.toContain('\ufffd');
    });
    (0, bun_test_1.test)('the file is still a readable pdf with the expected page geometry', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const info = await (0, poppler_ts_1.pdfInfo)(r.pdf);
        (0, bun_test_1.expect)(info.pages).toBe(1);
        const [, w, h] = r.info.mediaBoxes[0].match(/([\d.]+) ([\d.]+)\]$/);
        (0, bun_test_1.expect)(Number(w)).toBeCloseTo(595.28, 0);
        (0, bun_test_1.expect)(Number(h)).toBeCloseTo(841.89, 0);
    });
    (0, bun_test_1.test)('the cross-reference table survives the rebuild', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(text.match(/startxref/g)).toHaveLength(1);
        const at = Number(text.match(/startxref\s+(\d+)/)[1]);
        (0, bun_test_1.expect)(text.slice(at, at + 4)).toBe('xref');
        const header = text.slice(at).match(/^xref\s+0\s+(\d+)\s/);
        const size = Number(header[1]);
        const table = text.slice(at + header[0].length);
        let checked = 0;
        for (let n = 1; n < size; n++) {
            const entry = table.slice(n * 20, n * 20 + 20);
            if (entry.length < 20 || entry[17] !== 'n')
                continue;
            const off = Number(entry.slice(0, 10));
            checked++;
            (0, bun_test_1.expect)(text.slice(off, off + 24)).toStartWith(`${n} 0 obj`);
        }
        (0, bun_test_1.expect)(checked).toBeGreaterThan(0);
        (0, bun_test_1.expect)(text).not.toContain('endobjxref');
        (0, bun_test_1.expect)(text).not.toContain('endobjtrailer');
    });
    (0, bun_test_1.test)('every indirect reference in the file resolves to a defined object', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: threeFaces });
        const text = Buffer.from(r.pdf).toString(LATIN1);
        const defined = new Set([...text.matchAll(/(?:^|[^0-9])(\d+) \d+ obj\b/g)].map((m) => Number(m[1])));
        const referenced = new Set([...text.matchAll(/(?:^|[^0-9])(\d+) 0 R\b/g)].map((m) => Number(m[1])));
        (0, bun_test_1.expect)(referenced.size).toBeGreaterThan(0);
        for (const n of referenced)
            (0, bun_test_1.expect)(defined.has(n)).toBe(true);
    });
    (0, bun_test_1.test)('a document with no fonts is left alone', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: '<!doctype html><p>no text</p>' });
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
    });
});
//# sourceMappingURL=fontdesc.test.js.map