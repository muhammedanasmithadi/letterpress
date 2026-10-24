"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redundantFigures = redundantFigures;
exports.fixRedundantFigures = fixRedundantFigures;
exports.redundantFigureCount = redundantFigureCount;
const pdfparts_ts_1 = require("./pdfparts.ts");
function hasDescription(text) {
    return /\/(?:Alt|ActualText)\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)/.test(text);
}
function rolePattern(role) {
    return new RegExp(`/S(\\s*)/${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}
function redundantFigures(parts) {
    const byNum = new Map(parts.objs.map((o) => [o.num, (0, pdfparts_ts_1.dictCode)(o)]));
    const figures = (0, pdfparts_ts_1.structElementsInOrder)(parts, 'Figure');
    if (figures.length === 0)
        return [];
    const described = new Set();
    for (const n of figures)
        if (hasDescription(byNum.get(n) ?? ''))
            described.add(n);
    const out = [];
    const guard = new Set();
    const hasDescribedDescendant = (num, depth) => {
        if (depth > 64 || guard.has(num))
            return false;
        guard.add(num);
        const text = byNum.get(num);
        if (text === undefined)
            return false;
        for (const child of (0, pdfparts_ts_1.kidsOf)(text)) {
            if (described.has(child))
                return true;
            if (hasDescribedDescendant(child, depth + 1))
                return true;
        }
        return false;
    };
    for (const n of figures) {
        const text = byNum.get(n) ?? '';
        if (hasDescription(text))
            continue;
        guard.clear();
        if (hasDescribedDescendant(n, 0))
            out.push(n);
    }
    return out;
}
function fixRedundantFigures(pdf) {
    if ((0, pdfparts_ts_1.isEncrypted)(pdf))
        return pdf;
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return pdf;
    const targets = redundantFigures(parts);
    if (targets.length === 0)
        return pdf;
    const byNum = new Map(parts.objs.map((o) => [o.num, o]));
    let changed = 0;
    for (const num of targets) {
        const obj = byNum.get(num);
        if (!obj)
            continue;
        const text = obj.bytes.toString(pdfparts_ts_1.LATIN1);
        if (!rolePattern('Figure').test(text))
            continue;
        obj.bytes = Buffer.from(text.replace(rolePattern('Figure'), '/S$1/Div'), pdfparts_ts_1.LATIN1);
        changed++;
    }
    if (changed === 0)
        return pdf;
    return new Uint8Array((0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer));
}
function redundantFigureCount(pdf) {
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    return parts ? redundantFigures(parts).length : 0;
}
//# sourceMappingURL=figrole.js.map