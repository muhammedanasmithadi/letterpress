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
exports.DIRECTIVE = void 0;
exports.commentRanges = commentRanges;
exports.literalComments = literalComments;
exports.commentsIn = commentsIn;
const ts = __importStar(require("typescript-api"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const BASELINE = new URL('../waivers/baseline.comments.json', import.meta.url);
const ROOTS = ['src', 'test', 'viewer', 'tools'];
const EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
exports.DIRECTIVE = /(?:\/\/|\/\*)\s*(?:noqa\b|eslint-disable|eslint-enable|oxlint-disable(?:-next-line|-line)?|prettier-ignore|@ts-|nosemgrep|cspell:|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|go:|fmt:|isort:|#\s*(?:noqa|pragma|type:|fmt:|isort:))/;
function files(dir) {
    const out = [];
    for (const entry of (0, node_fs_1.readdirSync)(dir)) {
        const path = (0, node_path_1.join)(dir, entry);
        if ((0, node_fs_1.statSync)(path).isDirectory())
            out.push(...files(path));
        else if (EXT.has(path.slice(path.lastIndexOf('.'))))
            out.push(path);
    }
    return out;
}
function commentRanges(file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found = new Map();
    const visit = (node) => {
        for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
            found.set(r.pos, [r.pos, r.end]);
        }
        for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) {
            found.set(r.pos, [r.pos, r.end]);
        }
        for (const child of node.getChildren(sf))
            visit(child);
    };
    visit(sf);
    return [...found.values()].sort((a, b) => a[0] - b[0]);
}
function literalComments(file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node) => {
        if (ts.isNoSubstitutionTemplateLiteral(node) && isCode(node.text)) {
            count += countInLiteral(node.text);
        }
        for (const child of node.getChildren(sf))
            visit(child);
    };
    visit(sf);
    return count;
}
function isCode(literal) {
    return /(^|\n)\s*(const|let|var|function|return|if|for|while|class|try|catch|throw|switch|do)\b/.test(literal);
}
function countInLiteral(literal) {
    let count = 0;
    let i = 0;
    while (i < literal.length) {
        const ch = literal[i];
        if (ch === '/' && literal[i + 1] === '/') {
            const end = literal.indexOf('\n', i);
            count++;
            i = end === -1 ? literal.length : end + 1;
            continue;
        }
        if (ch === '/' && literal[i + 1] === '*') {
            const end = literal.indexOf('*/', i + 2);
            count++;
            i = end === -1 ? literal.length : end + 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipQuoted(literal, i);
            continue;
        }
        i++;
    }
    return count;
}
function skipQuoted(text, at) {
    const quote = text[at];
    let i = at + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === quote)
            return i + 1;
        i++;
    }
    return i;
}
function commentsIn(file, text) {
    let count = 0;
    for (const [start, end] of commentRanges(file, text)) {
        if (!exports.DIRECTIVE.test(text.slice(start, end)))
            count++;
    }
    return count;
}
function main() {
    const base = JSON.parse((0, node_fs_1.readFileSync)(BASELINE, 'utf8'));
    const current = {};
    let total = 0;
    const literals = {};
    let literalTotal = 0;
    for (const root of ROOTS) {
        for (const file of files(root)) {
            const text = (0, node_fs_1.readFileSync)(file, 'utf8');
            const n = commentsIn(file, text);
            if (n > 0) {
                current[file] = n;
                total += n;
            }
            const inLiterals = literalComments(file, text);
            if (inLiterals > 0) {
                literals[file] = inLiterals;
                literalTotal += inLiterals;
            }
        }
    }
    if (process.argv.includes('--write')) {
        (0, node_fs_1.writeFileSync)(BASELINE, JSON.stringify({ files: current, total, literals, literalTotal }, null, 2) + '\n');
        console.log(`comments: ${total} across ${Object.keys(current).length} files, ` +
            `${literalTotal} in template literals across ${Object.keys(literals).length} files ` +
            `(baseline written)`);
        return;
    }
    const problems = [];
    for (const [file, n] of Object.entries(current)) {
        const was = base.files[file] ?? 0;
        if (n > was)
            problems.push(`${file}: ${n} comments, was ${was}`);
    }
    for (const [file, n] of Object.entries(base.files)) {
        if (!(file in current))
            problems.push(`${file}: ${n} comments, now 0 -- lower the baseline`);
    }
    if (total > base.total) {
        problems.push(`total: ${total} comments, baseline ${base.total}`);
    }
    const baseLiterals = base.literals ?? {};
    const baseLiteralTotal = base.literalTotal ?? 0;
    for (const [file, n] of Object.entries(literals)) {
        const was = baseLiterals[file] ?? 0;
        if (n > was)
            problems.push(`${file}: ${n} comments in template literals, was ${was}`);
    }
    for (const [file, n] of Object.entries(baseLiterals)) {
        if (!(file in literals)) {
            problems.push(`${file}: ${n} comments in template literals, now 0 -- lower the baseline`);
        }
    }
    if (literalTotal > baseLiteralTotal) {
        problems.push(`total: ${literalTotal} comments in template literals, baseline ${baseLiteralTotal}`);
    }
    console.log(`comments: ${total} across ${Object.keys(current).length} files (baseline ${base.total}), ` +
        `${literalTotal} in template literals across ${Object.keys(literals).length} files ` +
        `(baseline ${baseLiteralTotal})`);
    if (problems.length > 0) {
        console.error('new comments in code:\n' + problems.join('\n'));
        console.error('move the rationale into docs/, and lower waivers/baseline.comments.json');
        process.exit(1);
    }
}
if (import.meta.main)
    main();
//# sourceMappingURL=lint-comments.js.map