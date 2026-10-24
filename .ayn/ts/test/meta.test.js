"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
const meta_ts_1 = require("../src/meta.ts");
const render_ts_1 = require("../src/render.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const LATIN1 = 'latin1';
function pdfFixture(infoExtra = '') {
    return (0, fixtures_ts_1.assemblePdf)([
        '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Type /MarkInfo /Marked true >> /Lang (en) >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
        `<< /Title (Fixture) /Producer (Skia/PDF m154) /CreationDate (D:20260101120000+00'00') ` +
            `/ModDate (D:20260101120000+00'00')${infoExtra} >>`,
    ], {
        endobj: '\nendobj\n',
        trailer: (size, xrefAt) => `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    });
}
function rootOf(text) {
    const trailer = /trailer([\s\S]*?)startxref/.exec(text)[1];
    return Number(/\/Root (\d+) 0 R/.exec(trailer)[1]);
}
function dictionaries(text) {
    const out = [];
    for (const m of text.matchAll(/(?:^|[^0-9])(\d+) 0 obj([\s\S]*?)endobj/g)) {
        const body = m[2];
        let depth = 0;
        let depthZero = -1;
        let inString = false;
        for (let i = 0; i < body.length - 1; i++) {
            const ch = body[i];
            if (inString) {
                if (ch === '\\')
                    i++;
                else if (ch === ')')
                    inString = false;
                continue;
            }
            if (ch === '(') {
                inString = true;
                continue;
            }
            const pair = body.slice(i, i + 2);
            if (pair === '<<') {
                depth++;
                i++;
            }
            else if (pair === '>>') {
                depth--;
                if (depth === 0)
                    depthZero = i;
                i++;
            }
        }
        out.push({ obj: m[1], body, balanced: depth === 0, depthZero });
    }
    return out;
}
(0, bun_test_1.describe)('pdfString', () => {
    (0, bun_test_1.test)('printable ascii needs no escaping at all', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('Ahammed Sahad')).toBe('Ahammed Sahad');
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('curriculum vitae')).toBe('curriculum vitae');
    });
    (0, bun_test_1.test)('the delimiter and the escape character are escaped', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('a(b)c')).toBe('a\\(b\\)c');
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('back\\slash')).toBe('back\\\\slash');
    });
    (0, bun_test_1.test)('a value that would close the string early cannot', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)(') /Root 9 0 R (')).toBe('\\) /Root 9 0 R \\(');
    });
    (0, bun_test_1.test)('non-ascii becomes a hex string in utf-16be with a byte order mark', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('東')).toBe('<FEFF6771>');
    });
    (0, bun_test_1.test)('the hex replaces the parentheses rather than sitting inside them', () => {
        const encoded = (0, meta_ts_1.pdfString)('東京');
        (0, bun_test_1.expect)(encoded.startsWith('<')).toBe(true);
        (0, bun_test_1.expect)(encoded.endsWith('>')).toBe(true);
        (0, bun_test_1.expect)(encoded.slice(1, -1).startsWith('FEFF')).toBe(true);
    });
    (0, bun_test_1.test)('a character outside the basic plane keeps its surrogate pair', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.pdfString)('\u{1f600}')).toBe('<FEFFD83DDE00>');
    });
});
(0, bun_test_1.describe)('xmlText', () => {
    (0, bun_test_1.test)('the five entities are escaped', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.xmlText)(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    });
    (0, bun_test_1.test)('a value that would close an element or the packet is escaped', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.xmlText)('</rdf:li></dc:creator></rdf:RDF>')).toBe('&lt;/rdf:li&gt;&lt;/dc:creator&gt;&lt;/rdf:RDF&gt;');
        (0, bun_test_1.expect)((0, meta_ts_1.xmlText)(']]>')).toBe(']]&gt;');
    });
    (0, bun_test_1.test)('a control character is dropped, since XML has no way to carry it', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.xmlText)('a\u0000\u0007b')).toBe('ab');
    });
    (0, bun_test_1.test)('tab, newline and carriage return survive', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.xmlText)('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    });
});
(0, bun_test_1.describe)('buildXmp', () => {
    (0, bun_test_1.test)('every field comes from the dictionary it is given', () => {
        const xmp = (0, meta_ts_1.buildXmp)({
            title: 'A Resume',
            author: 'Ahammed Sahad',
            subject: 'Curriculum vitae',
            keywords: 'cv, resume',
            creator: 'Chromium',
            producer: 'Skia/PDF',
            created: "D:20260101120000+00'00'",
            modified: "D:20260101135959+00'00'",
        });
        (0, bun_test_1.expect)(xmp).toContain('<rdf:li xml:lang="x-default">A Resume</rdf:li>');
        (0, bun_test_1.expect)(xmp).toContain('<rdf:li>Ahammed Sahad</rdf:li>');
        (0, bun_test_1.expect)(xmp).toContain('<rdf:li xml:lang="x-default">Curriculum vitae</rdf:li>');
        (0, bun_test_1.expect)(xmp).toContain('<xmp:CreatorTool>Chromium</xmp:CreatorTool>');
        (0, bun_test_1.expect)(xmp).toContain('<pdf:Producer>Skia/PDF</pdf:Producer>');
        (0, bun_test_1.expect)(xmp).toContain('<xmp:CreateDate>2026-01-01T12:00:00</xmp:CreateDate>');
        (0, bun_test_1.expect)(xmp).toContain('<xmp:ModifyDate>2026-01-01T13:59:59</xmp:ModifyDate>');
    });
    (0, bun_test_1.test)('a title is a language alternative and an author is a list', () => {
        const xmp = (0, meta_ts_1.buildXmp)({ title: 'T', author: 'A' });
        (0, bun_test_1.expect)(xmp).toContain('<dc:title><rdf:Alt><rdf:li');
        (0, bun_test_1.expect)(xmp).toContain('<dc:creator><rdf:Bag><rdf:li>A</rdf:li></rdf:Bag>');
    });
    (0, bun_test_1.test)('a field that is absent is left out rather than written empty', () => {
        const xmp = (0, meta_ts_1.buildXmp)({ title: 'Only a title' });
        (0, bun_test_1.expect)(xmp).toContain('dc:title');
        (0, bun_test_1.expect)(xmp).not.toContain('dc:creator');
        (0, bun_test_1.expect)(xmp).not.toContain('dc:description');
        (0, bun_test_1.expect)(xmp).not.toContain('CreateDate');
    });
    (0, bun_test_1.test)('the begin marker carries a real byte order mark', () => {
        const bytes = Buffer.from((0, meta_ts_1.buildXmp)({ title: 'T' }), 'utf8');
        (0, bun_test_1.expect)(bytes.subarray(0, 30).toString('latin1')).toContain('\xef\xbb\xbf');
    });
    (0, bun_test_1.test)('every element the packet opens, it also closes', () => {
        const xmp = (0, meta_ts_1.buildXmp)({ title: 'A & B <c>', author: 'X > Y', created: 'D:20260101120000' });
        const body = xmp.replace(/<\?xpacket[^?]*\?>/g, '');
        let depth = 0;
        for (const m of body.matchAll(/<\/?([A-Za-z_][\w:.-]*)[^>]*?(\/)?>/g)) {
            if (m[0].startsWith('</'))
                depth--;
            else if (!m[2])
                depth++;
            (0, bun_test_1.expect)(depth).toBeGreaterThanOrEqual(0);
        }
        (0, bun_test_1.expect)(depth).toBe(0);
    });
    (0, bun_test_1.test)('a name carrying markup cannot add an element', () => {
        const xmp = (0, meta_ts_1.buildXmp)({ title: '</dc:title><dc:subject>injected' });
        (0, bun_test_1.expect)(xmp.match(/<dc:title>/g)).toHaveLength(1);
        (0, bun_test_1.expect)(xmp).not.toContain('<dc:subject>injected');
        (0, bun_test_1.expect)(xmp).toContain('&lt;/dc:title&gt;');
    });
    (0, bun_test_1.test)('the packet names the pdfua revision it validates against', () => {
        const xmp = (0, meta_ts_1.buildXmp)({ title: 'T' });
        (0, bun_test_1.expect)(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
        (0, bun_test_1.expect)(xmp).toContain('pdfuaid:part="1"');
        (0, bun_test_1.expect)(xmp).toContain('pdfuaid:rev="2020"');
        (0, bun_test_1.expect)(xmp.match(/pdfuaid:part=/g)).toHaveLength(1);
    });
    (0, bun_test_1.test)('a user value cannot add a pdfuaid description', () => {
        const xmp = (0, meta_ts_1.buildXmp)({
            title: '</rdf:Description><rdf:Description rdf:about="" xmlns:pdfuaid="x" pdfuaid:part="999"/>',
        });
        (0, bun_test_1.expect)(xmp.match(/<rdf:Description rdf:about="" xmlns:pdfuaid=/g)).toHaveLength(1);
        (0, bun_test_1.expect)(xmp).not.toContain('pdfuaid:part="999"');
    });
});
(0, bun_test_1.describe)('readDocInfo', () => {
    (0, bun_test_1.test)('reads the values chromium wrote', () => {
        const info = (0, meta_ts_1.readDocInfo)(pdfFixture());
        (0, bun_test_1.expect)(info.title).toBe('Fixture');
        (0, bun_test_1.expect)(info.producer).toBe('Skia/PDF m154');
        (0, bun_test_1.expect)(info.created).toBe("D:20260101120000+00'00'");
        (0, bun_test_1.expect)(info.author).toBeUndefined();
    });
    (0, bun_test_1.test)('reads a hex string back to the same text', () => {
        const info = (0, meta_ts_1.readDocInfo)(pdfFixture(' /Author <FEFF6771> '));
        (0, bun_test_1.expect)(info.author).toBe('東');
    });
    (0, bun_test_1.test)('a pdf with no information dictionary reads as empty', () => {
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(Buffer.from('%PDF-1.4\n'))).toEqual({});
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(Buffer.alloc(0))).toEqual({});
    });
});
(0, bun_test_1.describe)('addMetadata', () => {
    (0, bun_test_1.test)('the author lands in the information dictionary', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), { author: 'Ahammed Sahad' });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBe('Ahammed Sahad');
    });
    (0, bun_test_1.test)('the packet is attached to the catalog', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), { author: 'Ahammed Sahad' });
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(out)).toEqual({ present: true, creator: 'Ahammed Sahad' });
    });
    (0, bun_test_1.test)('the reference goes into the catalog and not into a nested dictionary', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), { author: 'A' });
        const text = Buffer.from(out).toString(LATIN1);
        const catalog = dictionaries(text).find((d) => d.body.includes('/Type /Catalog'));
        const ref = /\/Metadata (\d+) 0 R/.exec(catalog.body);
        (0, bun_test_1.expect)(ref).not.toBeNull();
        (0, bun_test_1.expect)(ref.index).toBeLessThan(catalog.depthZero);
        (0, bun_test_1.expect)(catalog.body).not.toContain('/Marked true/Metadata');
    });
    (0, bun_test_1.test)('every dictionary in the file is still balanced', () => {
        for (const info of [
            { author: 'A' },
            { subject: 'S' },
            { keywords: 'K' },
            { author: 'A', subject: 'S', keywords: 'K' },
        ]) {
            const text = Buffer.from((0, meta_ts_1.addMetadata)(pdfFixture(), info)).toString(LATIN1);
            const found = dictionaries(text);
            (0, bun_test_1.expect)(found.length).toBeGreaterThan(0);
            for (const d of found)
                (0, bun_test_1.expect)(d.balanced).toBe(true);
        }
    });
    (0, bun_test_1.test)('a minimal packet is written even when nothing is declared', () => {
        const input = pdfFixture();
        const out = (0, meta_ts_1.addMetadata)(input, {});
        (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)(out, input)).toBe(false);
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(out).present).toBe(true);
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBeUndefined();
        (0, bun_test_1.expect)((0, meta_ts_1.readXmpPacket)(out)).not.toContain('dc:creator');
        (0, bun_test_1.expect)((0, meta_ts_1.readXmpPacket)((0, meta_ts_1.addMetadata)(input, { author: '  ' }))).not.toContain('dc:creator');
        (0, bun_test_1.expect)((0, meta_ts_1.readXmpPacket)((0, meta_ts_1.addMetadata)(input, { subject: '' }))).not.toContain('dc:description');
    });
    (0, bun_test_1.test)('a document that states no author gets no invented one', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), {});
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBeUndefined();
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(out)).toEqual({ present: true, creator: undefined });
    });
    (0, bun_test_1.test)('an existing author is replaced rather than duplicated', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(' /Author (Previous Name) '), { author: 'New Name' });
        const text = Buffer.from(out).toString(LATIN1);
        (0, bun_test_1.expect)(text.match(/\/Author /g)).toHaveLength(1);
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBe('New Name');
    });
    (0, bun_test_1.test)('a non-ascii author round-trips', () => {
        const name = 'Аhammed ظ Lanzón 東京';
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), { author: name });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBe(name);
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(out).creator).toBe(name);
    });
    (0, bun_test_1.test)('a hostile author cannot break out of the dictionary or the packet', () => {
        const hostile = `A ) >> /Root 9 0 R (evil) ( \\101 & <script> ]]>`;
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), { author: hostile });
        const text = Buffer.from(out).toString(LATIN1);
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(out).author).toBe(hostile);
        for (const d of dictionaries(text))
            (0, bun_test_1.expect)(d.balanced).toBe(true);
        (0, bun_test_1.expect)(rootOf(text)).toBeTypeOf('number');
        (0, bun_test_1.expect)(dictionaries(text).find((d) => d.obj === String(rootOf(text))).body).toContain('/Type /Catalog');
        const trailer = /trailer([\s\S]*?)startxref/.exec(text)[1];
        (0, bun_test_1.expect)(trailer.match(/\/Root /g)).toHaveLength(1);
        const info = dictionaries(text).find((d) => d.body.includes('/Title (Fixture)'));
        (0, bun_test_1.expect)(info.body).toContain('\\) >> /Root 9 0 R \\(');
        (0, bun_test_1.expect)(info.body).not.toContain(') >> /Root 9 0 R (');
    });
    (0, bun_test_1.test)('the packet survives a name that would close an element', () => {
        const out = (0, meta_ts_1.addMetadata)(pdfFixture(), {
            author: '</rdf:li></dc:creator></rdf:RDF></x:xmpmeta>',
        });
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(out).creator).toContain('</rdf:li>');
        const text = (0, meta_ts_1.readXmpPacket)(out);
        (0, bun_test_1.expect)(text.match(/<x:xmpmeta/g)).toHaveLength(1);
    });
    (0, bun_test_1.test)('input that is not a linear pdf is returned untouched', () => {
        for (const junk of [Buffer.alloc(0), Buffer.from('nope'), Buffer.from('%PDF-1.7\n')]) {
            (0, bun_test_1.expect)((0, fixtures_ts_1.sameBytes)((0, meta_ts_1.addMetadata)(junk, { author: 'A' }), junk)).toBe(true);
        }
    });
    (0, bun_test_1.test)('the file is still structurally sound afterwards', () => {
        const text = Buffer.from((0, meta_ts_1.addMetadata)(pdfFixture(), { author: 'Ahammed Sahad' })).toString(LATIN1);
        (0, fixtures_ts_1.expectSoundXref)(text);
    });
    (0, bun_test_1.test)("the packet stream's /Length matches its payload", () => {
        const text = Buffer.from((0, meta_ts_1.addMetadata)(pdfFixture(), { author: 'A' })).toString(LATIN1);
        (0, bun_test_1.expect)((0, fixtures_ts_1.expectSoundLengths)(text)).toBe(1);
    });
});
(0, bun_test_1.describe)('rendered output', () => {
    let browser;
    let profile;
    let dir;
    (0, bun_test_1.beforeAll)(async () => {
        profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-meta-'));
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'letterpress-meta-doc-'));
        browser = await browser_ts_1.Browser.launch({ profile });
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await browser?.close();
        await (0, promises_1.rm)(profile, { recursive: true, force: true }).catch(() => { });
        await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
    });
    (0, bun_test_1.test)('an author the document declares reaches the dictionary', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content="Ahammed Sahad"><title>T</title><p>x</p>`,
        });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBe('Ahammed Sahad');
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(r.pdf)).toEqual({ present: true, creator: 'Ahammed Sahad' });
    });
    (0, bun_test_1.test)('a document declaring nothing still carries an XMP packet', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:15mm}</style><h1>T</h1><p>Body.</p>`,
        });
        const packet = (0, meta_ts_1.readXmpPacket)(r.pdf);
        (0, bun_test_1.expect)(packet, 'no XMP packet without declared metadata').toBeDefined();
        (0, bun_test_1.expect)(packet).toContain('<xmp:CreatorTool>');
        (0, bun_test_1.expect)(packet).toContain('<xmp:CreateDate>');
        (0, bun_test_1.expect)(packet).not.toContain('dc:creator');
        (0, bun_test_1.expect)(packet).not.toContain('dc:description');
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(text).toMatch(/\/Metadata \d+ 0 R/);
    });
    (0, bun_test_1.test)('the packet is generated from the dictionary, so the two agree', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content="Ahammed Sahad">` +
                `<meta name="subject" content="CV"><title>The Title</title><p>x</p>`,
        });
        const info = (0, meta_ts_1.readDocInfo)(r.pdf);
        const xmp = (0, meta_ts_1.readXmp)(r.pdf);
        (0, bun_test_1.expect)(xmp.creator).toBe(info.author);
        (0, bun_test_1.expect)(info.subject).toBe('CV');
        (0, bun_test_1.expect)(info.title).toBe('The Title');
    });
    (0, bun_test_1.test)('the flag overrides the document', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content="From Document"><p>x</p>`,
            author: 'From Flag',
        });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBe('From Flag');
    });
    (0, bun_test_1.test)('a document that declares nothing gets no author, but still gets a packet', async () => {
        const r = await (0, render_ts_1.render)(browser, { html: `<!doctype html><title>T</title><p>x</p>` });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toBeUndefined();
        (0, bun_test_1.expect)((0, meta_ts_1.readXmp)(r.pdf)).toEqual({ present: true, creator: undefined });
    });
    (0, bun_test_1.test)('the finding says where the author came from', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content="Ahammed Sahad"><p>x</p>`,
        });
        const finding = r.findings.find((f) => f.code === 'metadata-authored');
        (0, bun_test_1.expect)(finding).toBeDefined();
        (0, bun_test_1.expect)(finding.message).toContain('Ahammed Sahad');
        const viaFlag = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content="Ahammed Sahad"><p>x</p>`,
            author: 'Override',
        });
        (0, bun_test_1.expect)(viaFlag.findings.find((f) => f.code === 'metadata-authored')).toBeUndefined();
    });
    (0, bun_test_1.test)('the page content is unchanged by any of this', async () => {
        const html = `<!doctype html><style>@page{size:A4;margin:10mm}</style><h1>Heading</h1><p>body text</p>`;
        const plain = await (0, render_ts_1.render)(browser, { html });
        const withMeta = await (0, render_ts_1.render)(browser, { html, author: 'Ahammed Sahad', subject: 'CV' });
        const contentOf = (pdf) => [
            ...Buffer.from(pdf)
                .toString(LATIN1)
                .matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g),
        ]
            .filter((m) => !m[2].includes('/Subtype /XML'))
            .map((m) => `${m[1]}:${(m[2].match(/stream\r?\n([\s\S]*?)\nendstream/)?.[1] ?? '').length}`)
            .join(',');
        (0, bun_test_1.expect)(contentOf(withMeta.pdf)).toBe(contentOf(plain.pdf));
        (0, bun_test_1.expect)(withMeta.info.pages).toBe(plain.info.pages);
        (0, bun_test_1.expect)(withMeta.info.mediaBoxes).toEqual(plain.info.mediaBoxes);
    });
    (0, bun_test_1.test)('a document whose own metadata names a hostile author still yields a valid file', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: `<!doctype html><meta name="author" content=") >> /Root 9 0 R (x"><p>x</p>`,
        });
        (0, bun_test_1.expect)((0, meta_ts_1.readDocInfo)(r.pdf).author).toContain('/Root 9 0 R');
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(dictionaries(text).find((d) => d.obj === String(rootOf(text))).body).toContain('/Type /Catalog');
    });
    (0, bun_test_1.test)('the authored file survives a real reader', async () => {
        const html = (0, node_path_1.join)(dir, 'meta.html');
        await (0, promises_1.writeFile)(html, `<!doctype html><meta charset="utf-8">
      <meta name="author" content="Ahammed Sahad"><meta name="subject" content="Curriculum vitae">
      <title>Metadata Fixture</title><p>text</p>`, 'utf8');
        const r = await (0, render_ts_1.render)(browser, { path: html, author: 'Ahammed Sahad' });
        const text = Buffer.from(r.pdf).toString(LATIN1);
        (0, bun_test_1.expect)(text.match(/\/Metadata \d+ 0 R/g)).toHaveLength(1);
        (0, bun_test_1.expect)((0, meta_ts_1.readXmpPacket)(r.pdf).match(/<x:xmpmeta/g)).toHaveLength(1);
        (0, bun_test_1.expect)(r.info.pages).toBe(1);
    });
});
(0, bun_test_1.describe)('no keys are planted in an encrypted file', () => {
    (0, bun_test_1.test)('no metadata packet is added to it', () => {
        const pdf = (0, fixtures_ts_1.encryptedFixture)();
        (0, bun_test_1.expect)(Buffer.from((0, meta_ts_1.addMetadata)(pdf, { author: 'A' })).equals(Buffer.from(pdf))).toBe(true);
    });
    (0, bun_test_1.test)('no title is written into its ciphertext Info', () => {
        const pdf = (0, fixtures_ts_1.encryptedFixture)();
        (0, bun_test_1.expect)(Buffer.from((0, meta_ts_1.setDocTitle)(pdf, 'Fuzz')).equals(Buffer.from(pdf))).toBe(true);
    });
});
//# sourceMappingURL=meta.test.js.map