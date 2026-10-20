import * as ts from 'typescript-api';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'test'];
const EXT = new Set(['.ts', '.mts', '.cts']);
const MARKERS = ['todo', 'fixme', 'hack', 'xxx'];
const DOM_GLOBAL = /\b(?:document|window|navigator|location|history)\s*\.[A-Za-z_$]/;
const problems = [];

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

function commentsOf(sf, text) {
  const found = [];
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
      found.push({ text: r, pos: sf.getLineAndCharacterOfPosition(r.pos) });
    for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? [])
      found.push({ text: r, pos: sf.getLineAndCharacterOfPosition(r.pos) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

for (const f of ROOTS.flatMap(files)) {
  const text = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ESNext, true);
  if (sf.parseDiagnostics.length > 0) {
    problems.push(`${f}: unparseable by TS 5.9 grammar`);
    continue;
  }
  const visit = (node) => {
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword)
      fail(f, node, 'as any');
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'console')
      fail(f, node, 'console.*');
    if (node.kind === ts.SyntaxKind.DebuggerStatement) fail(f, node, 'debugger');

    if (isPageExpression(node)) {
      const init = node.initializer;
      if (init && ts.isTemplateExpression(init) && DOM_GLOBAL.test(init.getText(sf)))
        fail(f, init, 'interpolated page-side code: move it to src/pageside.ts');
    }
    const declared = ts.isVariableDeclaration(node) ? node.initializer : undefined;
    if (declared && ts.isTemplateExpression(declared) && DOM_GLOBAL.test(declared.getText(sf)))
      fail(f, declared, 'interpolated page-side code: move it to src/pageside.ts');

    ts.forEachChild(node, visit);
  };

  function isPageExpression(node) {
    if (
      !ts.isPropertyAssignment(node) ||
      node.name.getText(sf).replace(/["']/g, '') !== 'expression'
    )
      return false;
    const obj = node.parent;
    if (!ts.isObjectLiteralExpression(obj) || obj.parent.kind !== ts.SyntaxKind.CallExpression)
      return false;
    const call = obj.parent;
    return (
      call.arguments.length > 1 &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === 'Runtime.evaluate'
    );
  }
  const fail = (file, node, what) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    problems.push(`${file}:${line + 1}: ${what}`);
  };
  visit(sf);
  for (const c of commentsOf(sf, text)) {
    const low = text.slice(c.text.pos, c.text.end).toLowerCase();
    if (MARKERS.some((m) => low.includes(m)))
      problems.push(`${f}:${c.pos.line + 1}: marker comment`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint-ts ok (as any, console, debugger, markers, interpolated page-side code: 0)');
