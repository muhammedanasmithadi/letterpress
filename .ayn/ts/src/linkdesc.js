"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINK_DESC_JS = void 0;
exports.parseLinkDescs = parseLinkDescs;
exports.linkOrder = linkOrder;
exports.linkAnnotations = linkAnnotations;
exports.linkDescPairing = linkDescPairing;
exports.fixLinkDescs = fixLinkDescs;
const pdfparts_ts_1 = require("./pdfparts.ts");
const meta_ts_1 = require("./meta.ts");
exports.LINK_DESC_JS = `(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const painted = [...a.getClientRects()].some((r) => r.width > 0 && r.height > 0);
    if (!painted) continue;
    let text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text) {
      const img = a.querySelector('img[alt]');
      text = img ? (img.getAttribute('alt') || '').trim() : '';
    }
    if (!text) {
      try { text = new URL(a.getAttribute('href'), document.baseURI).href; } catch { text = a.getAttribute('href') || ''; }
    }
    out.push(text);
  }
  return JSON.stringify(out);
})()`;
function parseLinkDescs(returned) {
    if (typeof returned !== 'string')
        return null;
    let value;
    try {
        value = JSON.parse(returned);
    }
    catch {
        return null;
    }
    if (!Array.isArray(value))
        return null;
    for (const v of value)
        if (typeof v !== 'string')
            return null;
    return value;
}
function linkOrder(parts) {
    return (0, pdfparts_ts_1.structElementsInOrder)(parts, 'Link');
}
function linkAnnotations(parts, linkNum) {
    const byNum = (0, pdfparts_ts_1.objsByNum)(parts);
    const link = byNum.get(linkNum);
    if (!link)
        return [];
    const text = (0, pdfparts_ts_1.dictCode)(link);
    const out = [];
    for (const m of text.matchAll(/<<([\s\S]*?)>>/g)) {
        const body = m[1];
        if (!/\/Type\s*\/OBJR\b/.test(body))
            continue;
        const obj = /\/Obj\s+(\d+) 0 R/.exec(body)?.[1];
        if (obj)
            out.push(Number(obj));
    }
    return out;
}
function linkDescPairing(pdf, descs) {
    if (descs.length === 0)
        return { ok: true, why: 'none', links: 0, descs: 0 };
    if ((0, pdfparts_ts_1.isEncrypted)(pdf))
        return { ok: false, why: 'encrypted', links: 0, descs: descs.length };
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return { ok: false, why: 'unreadable', links: 0, descs: descs.length };
    const links = linkOrder(parts).length;
    return {
        ok: links === descs.length,
        why: links === descs.length ? 'paired' : 'count',
        links,
        descs: descs.length,
    };
}
function fixLinkDescs(pdf, descs) {
    if (descs.length === 0)
        return pdf;
    if ((0, pdfparts_ts_1.isEncrypted)(pdf))
        return pdf;
    const parts = (0, pdfparts_ts_1.trySplit)(pdf);
    if (!parts)
        return pdf;
    const links = linkOrder(parts);
    if (links.length !== descs.length)
        return pdf;
    const byNum = (0, pdfparts_ts_1.objsByNum)(parts);
    let changed = 0;
    links.forEach((linkNum, index) => {
        const desc = (descs[index] ?? '').trim();
        if (!desc)
            return;
        const annots = linkAnnotations(parts, linkNum);
        if (annots.length === 0) {
            const link = byNum.get(linkNum);
            if (link && !/\/Alt\b/.test((0, pdfparts_ts_1.dictCode)(link))) {
                const next = Buffer.from((0, pdfparts_ts_1.insertIntoDict)(link.bytes.toString(pdfparts_ts_1.LATIN1), `/Alt ${(0, meta_ts_1.pdfValue)(desc)}`), pdfparts_ts_1.LATIN1);
                if (!next.equals(link.bytes)) {
                    link.bytes = next;
                    changed++;
                }
            }
            return;
        }
        for (const annotNum of annots) {
            const obj = byNum.get(annotNum);
            if (!obj)
                continue;
            const text = obj.bytes.toString(pdfparts_ts_1.LATIN1);
            if (/\/Subtype\s*\/Link\b/.test(text) === false)
                continue;
            if (/\/Contents\b/.test((0, pdfparts_ts_1.dictCode)(obj)))
                continue;
            const next = Buffer.from((0, pdfparts_ts_1.insertIntoDict)(text, `/Contents ${(0, meta_ts_1.pdfValue)(desc)}`), pdfparts_ts_1.LATIN1);
            if (next.equals(obj.bytes))
                continue;
            obj.bytes = next;
            changed++;
        }
    });
    if (changed === 0)
        return pdf;
    return new Uint8Array((0, pdfparts_ts_1.join)(parts.head, parts.objs, parts.trailer));
}
//# sourceMappingURL=linkdesc.js.map