"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsageError = void 0;
exports.formatBytes = formatBytes;
class UsageError extends Error {
}
exports.UsageError = UsageError;
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
}
//# sourceMappingURL=report.js.map