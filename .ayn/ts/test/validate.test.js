"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const render_ts_1 = require("../src/render.ts");
const validate_ts_1 = require("../src/validate.ts");
const fixtures_ts_1 = require("./fixtures.ts");
const browser_ts_1 = require("./browser.ts");
function fixture(opts) {
    const content = opts.stream
        .map((m) => `/P << /MCID ${m} /S /P >> BDC BT (x) Tj ET EMC`)
        .join('\n');
    const objs = [
        `<< /Type /Catalog /Pages 2 0 R${opts.tagged === false ? '' : ' /StructTreeRoot 6 0 R'} >>`,
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        { dict: `<< /Length ${content.length} >>`, payload: Buffer.from(content, 'latin1') },
    ];
    if (opts.tagged !== false) {
        const k = opts.named.map((m) => `<< /MCID ${m} >>`).join(' ');
        objs.push(`<< /Type /StructElem /S /Document /P 6 0 R /K [${k}] >>`);
        objs.push('<< /Type /StructTreeRoot /K 5 0 R >>');
    }
    return (0, fixtures_ts_1.assemblePdf)(objs);
}
const codes = (r) => r.findings.map((f) => f.code);
(0, bun_test_1.describe)('checking a pdf that already exists', () => {
    let browser;
    (0, bun_test_1.beforeAll)(async () => {
        ({ browser } = await (0, browser_ts_1.launchTestBrowser)('validate'));
    }, 60_000);
    (0, bun_test_1.afterAll)(async () => {
        await (0, browser_ts_1.closeTestBrowser)({ browser, profile: '' });
    }, 60_000);
    (0, bun_test_1.test)('a tagged document whose halves agree has nothing to say', () => {
        const pdf = fixture({ stream: [0, 1, 2], named: [0, 1, 2] });
        (0, bun_test_1.expect)(codes((0, validate_ts_1.validate)(pdf))).toEqual([]);
        (0, bun_test_1.expect)((0, validate_ts_1.validate)(pdf).ok).toBe(true);
    });
    (0, bun_test_1.test)('a block in the stream that no structure element names is reported', () => {
        const pdf = fixture({ stream: [0, 5], named: [0] });
        const f = (0, validate_ts_1.validate)(pdf).findings.find((x) => x.code === 'structure-orphan-mcid');
        (0, bun_test_1.expect)(f).toBeDefined();
        (0, bun_test_1.expect)(f.severity).toBe('warn');
        (0, bun_test_1.expect)(f.message).toContain('5');
    });
    (0, bun_test_1.test)('a block the tree names that is not in any stream is reported', () => {
        const pdf = fixture({ stream: [0], named: [0, 7] });
        const f = (0, validate_ts_1.validate)(pdf).findings.find((x) => x.code === 'structure-ghost-mcid');
        (0, bun_test_1.expect)(f).toBeDefined();
        (0, bun_test_1.expect)(f.message).toContain('7');
        (0, bun_test_1.expect)(f.message).toContain('Document');
    });
    (0, bun_test_1.test)('a document with no structure tree is reported as untagged, not as broken', () => {
        const pdf = fixture({ stream: [0], named: [], tagged: false });
        const found = (0, validate_ts_1.validate)(pdf);
        (0, bun_test_1.expect)(codes(found)).toEqual(['untagged-document']);
        (0, bun_test_1.expect)(found.findings[0].severity).toBe('info');
        (0, bun_test_1.expect)(found.ok).toBe(true);
    });
    (0, bun_test_1.test)('a file that is not a pdf is refused rather than half-read', () => {
        const found = (0, validate_ts_1.validate)(new TextEncoder().encode('this is not a pdf'));
        (0, bun_test_1.expect)(codes(found)).toEqual(['not-a-pdf']);
        (0, bun_test_1.expect)(found.ok).toBe(false);
    });
    (0, bun_test_1.test)('an encrypted file says so instead of reporting what it cannot read', () => {
        const found = (0, validate_ts_1.validate)((0, fixtures_ts_1.encryptedFixture)());
        (0, bun_test_1.expect)(codes(found)).toEqual(['encrypted-document']);
        (0, bun_test_1.expect)(found.ok).toBe(false);
    });
    (0, bun_test_1.test)('the census reads both ends of the file', () => {
        const pdf = fixture({ stream: [3, 1], named: [1, 2] });
        const census = (0, validate_ts_1.mcidCensus)(pdf);
        (0, bun_test_1.expect)(census.present).toEqual(['1', '3']);
        (0, bun_test_1.expect)([...census.named].sort()).toEqual(['1', '2']);
        (0, bun_test_1.expect)(census.role.get('1')).toBe('Document');
    });
    (0, bun_test_1.test)('a structure tree that points at itself does not hang', () => {
        const objs = (0, fixtures_ts_1.assemblePdf)([
            '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R >>',
            '<< /Type /StructTreeRoot /K 4 0 R >>',
        ]);
        (0, bun_test_1.expect)(() => (0, validate_ts_1.validate)(objs)).not.toThrow();
        (0, bun_test_1.expect)((0, validate_ts_1.mcidCensus)(objs).named.size).toBe(0);
    });
    (0, bun_test_1.test)('a pdf this tool rendered passes its own checks', async () => {
        const r = await (0, render_ts_1.render)(browser, {
            html: '<html lang="en"><body><h1>A</h1><p>text</p><ul><li>x</li></ul></body></html>',
        });
        const found = (0, validate_ts_1.validate)(r.pdf);
        (0, bun_test_1.expect)(codes(found)).toEqual([]);
        (0, bun_test_1.expect)(found.ok).toBe(true);
    }, 60_000);
});
//# sourceMappingURL=validate.test.js.map