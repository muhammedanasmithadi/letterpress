"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveChromium = resolveChromium;
function resolveChromium() {
    const name = process.env.HTML2PDF_CHROMIUM ?? 'chromium';
    try {
        return Bun.which(name) ?? name;
    }
    catch {
        throw new Error(`cannot find "${name}" on PATH. Install Chromium, or set HTML2PDF_CHROMIUM to its absolute path.`);
    }
}
//# sourceMappingURL=chromium.js.map