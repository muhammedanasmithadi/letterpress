"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FINDING_CODES = exports.FINDINGS = void 0;
exports.codesAt = codesAt;
exports.FINDINGS = {
    'asset-outside-root': {
        severity: 'warn',
        summary: 'the document references a path outside its own directory, which was not read; pass `--root`',
    },
    'asset-overwrites-document': {
        severity: 'warn',
        summary: 'the document references a file named `input.html` or `override.html`, which was not staged because it would replace the page',
    },
    'audit-failed': {
        severity: 'warn',
        summary: 'the document checks could not run at all; a bug in letterpress, not in the document',
    },
    'audit-partial': {
        severity: 'warn',
        summary: 'the document checks stopped part way; findings above the failure were measured, the rest were not',
    },
    'content-overflows-page': {
        severity: 'warn',
        summary: 'an element is wider than the printable area, measured in screen layout',
    },
    'dialog-dismissed': {
        severity: 'warn',
        summary: 'the document opened an `alert`/`confirm`/`prompt` mid-render and it was refused, so a blocked script never finished',
    },
    'empty-alt': {
        severity: 'warn',
        summary: '`alt=""` on an image that is not marked decorative: a screen reader announces an empty label, which is worse than silence',
    },
    'encrypted-document': {
        severity: 'error',
        summary: 'the file is encrypted, so none of the checks below can decompress anything; an error',
    },
    'figure-role-corrected': {
        severity: 'info',
        summary: 'a grouping `Figure` around a described inner figure was re-tagged `Div`',
    },
    'figure-uncaptioned': {
        severity: 'warn',
        summary: 'a `<figure>` has no `<figcaption>` and nothing else names it: alt text on the image alone makes the pdf name that image a Figure',
    },
    'font-fallback': {
        severity: 'warn',
        summary: 'the document asks for a family this machine does not have; the finding names the substitute Chromium printed instead',
    },
    'font-metrics': {
        severity: 'warn',
        summary: 'a font descriptor still carries a negative cap height, which a viewer may refuse to render text over',
    },
    'glyphs-skipped': {
        severity: 'info',
        summary: 'further characters with no glyph are invisible formatting, so they are counted, not listed',
    },
    'image-downsampled': {
        severity: 'info',
        summary: 'an image was downsampled to the PPI cap; pass `--max-image-ppi 0` to disable',
    },
    'js-error': {
        severity: 'warn',
        summary: 'the document threw an uncaught error while being printed, and the pdf was produced anyway. Exceptions only: a failed asset or a `console.error` is a different fact, reported by `subresource-failed` and not here',
    },
    'json-rendered': { severity: 'error', summary: 'a data file was printed as a document' },
    'lang-undeclared': {
        severity: 'warn',
        summary: "the document names no language, so Chromium stamped the pdf with the browser's locale instead",
    },
    'ligature-spans': {
        severity: 'info',
        summary: 'redundant `/ActualText` spans around ligatures were removed; extraction verified unchanged',
    },
    'link-descriptions-skipped': {
        severity: 'warn',
        summary: 'the links could not be matched one for one with the text that describes them, so none of them was described',
    },
    'margin-ignored': {
        severity: 'warn',
        summary: '`--margin` was dropped: the document declares `@page margin`',
    },
    'metadata-authored': {
        severity: 'info',
        summary: 'the document\'s own `<meta name="author">` was written as the pdf author',
    },
    'metadata-subject': {
        severity: 'info',
        summary: 'the document\'s own `<meta name="subject">` was written as the pdf subject',
    },
    'missing-alt': {
        severity: 'warn',
        summary: 'an image has no `alt` at all, so nothing describes it; `empty-alt` covers `alt=""` on an image that is not marked decorative',
    },
    'missing-glyph': {
        severity: 'warn',
        summary: 'a character no installed font covers, so it prints as a blank box',
    },
    'network-blocked': { severity: 'warn', summary: 'a remote request was blocked, with its URL' },
    'content-unreadable': {
        severity: 'error',
        summary: "a page's content stream cannot be decoded, so the page is blank or wrong in every reader",
    },
    'not-a-pdf': {
        severity: 'error',
        summary: 'the file has no `%PDF-` header in its first thousand and twenty-four bytes; an error, and nothing else is reported',
    },
    'orientation-ignored': {
        severity: 'error',
        summary: '`--landscape` cannot apply: the declaration names no paper to transpose, so there is nothing to turn',
    },
    'orientation-overridden': {
        severity: 'info',
        summary: "the paper was transposed against the document's `@page size`, which keeps its own size and margin",
    },
    'output-unverified': {
        severity: 'error',
        summary: 'the finished file failed the structural check; an error, never a warning',
    },
    'page-probe-failed': {
        severity: 'warn',
        summary: 'a page-side probe threw, so its measurement is absent',
    },
    'page-size-override': {
        severity: 'info',
        summary: "`--format` disagrees with the document's `@page`; the declaration is stripped and the request applied",
    },
    'repair-rejected': {
        severity: 'warn',
        summary: 'a repair was discarded because it did not leave a valid pdf; the file is unchanged',
    },
    'role-mapped': {
        severity: 'info',
        summary: 'non-standard structure types emitted by chromium (Aside) were mapped to their ' +
            'standard equivalents through the structure tree RoleMap, because pdf/ua requires ' +
            'every structure type to be a standard type or a mapped one',
    },
    'role-retagged': {
        severity: 'info',
        summary: 'structure containers for nav/section/main/header/footer and definition lists were ' +
            'given their semantic structure types; the page stream is byte-identical',
    },
    'rtl-digit-run': {
        severity: 'warn',
        summary: '`2026-10-03` after Arabic prints as `03-10-2026`; wrap it in `<bdi dir="ltr">`',
    },
    'rtl-page-counter': {
        severity: 'warn',
        summary: 'a page counter in an `@page` margin box is laid out right-to-left, so page one of two prints `2 / 1`; set `direction: ltr` on the box',
    },
    'scripts-disabled': {
        severity: 'warn',
        summary: "the document's JavaScript did not run because `--no-script` was given; anything the document computes at load time is absent from the PDF",
    },
    'selection-fragmented': {
        severity: 'warn',
        summary: 'a word gap is wider than 0.6 em, so a browser will break the selection into separate boxes at it',
    },
    'structure-ghost-mcid': {
        severity: 'warn',
        summary: 'the structure tree names a block that is in no page stream, so navigating to it lands on nothing',
    },
    'structure-orphan-mcid': {
        severity: 'warn',
        summary: 'a marked-content block in a page stream that no structure element names: the text draws, and a reader walks past it',
    },
    'stylesheet-unreadable': {
        severity: 'warn',
        summary: 'a cross-origin stylesheet could not be read, so layout findings cover only this origin',
    },
    'subresource-failed': {
        severity: 'warn',
        summary: 'a referenced asset did not load, so the pdf will not look like the source',
    },
    'text-runs-merged': {
        severity: 'info',
        summary: 'per-glyph text positioning folded into TJ arrays, so a reader can select a paragraph; ' +
            "a reader that measures the font's own advance may draw a glyph a fraction of a point " +
            'from where the document put it; also reports any block left alone',
    },
    'unfilled-placeholder': { severity: 'error', summary: 'the document still contains `{{token}}`' },
    'unsupported-paged-media': {
        severity: 'error',
        summary: 'a CSS paged-media function Chromium silently discards',
    },
    'untagged-document': {
        severity: 'info',
        summary: 'the file has no structure tree, so a screen reader has no headings or lists to navigate by; `info`, not a fault',
    },
    'url-render-blocked': {
        severity: 'error',
        summary: 'a remote URL needs `allowNetwork`; without it its subresource loads and usually the document itself is blocked',
    },
};
exports.FINDING_CODES = Object.keys(exports.FINDINGS).sort();
function codesAt(severity) {
    return exports.FINDING_CODES.filter((c) => exports.FINDINGS[c].severity === severity);
}
//# sourceMappingURL=findings.js.map