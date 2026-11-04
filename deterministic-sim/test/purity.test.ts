// The core (src/) must be a pure function of its inputs. This test parses every source file with the
// TypeScript compiler and fails on anything that would make a run depend on the machine, the clock,
// the engine's float functions, or code outside src/. Working on the syntax tree, not on lines of
// text, means a `**` inside a string or a "Date" in a comment is not a violation, and a call split
// across lines is still one.
//
// The guard hook in .claude/ protects this file: weakening the rules needs a person's approval.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;
const SRC_ROOT = resolve(SRC);
const FIXTURE = join(SRC_ROOT, 'tournament', 'fixture.ts');

const GLOBALS = new Map<string, string>([
  ['Date', 'no clock in the core'],
  ['performance', 'no clock in the core'],
  ['setTimeout', 'no timers in the core'],
  ['setInterval', 'no timers in the core'],
  ['queueMicrotask', 'no scheduling in the core'],
  ['crypto', 'randomness and hashing come from the core itself'],
  ['process', 'no process access in the core'],
  ['require', 'no CommonJS loading in the core'],
  ['globalThis', 'no global object in the core'],
  ['window', 'no DOM in the core'],
  ['document', 'no DOM in the core'],
  ['navigator', 'no DOM in the core'],
  ['localStorage', 'no DOM in the core'],
  ['sessionStorage', 'no DOM in the core'],
  ['indexedDB', 'no DOM in the core'],
  ['fetch', 'no network in the core'],
  ['self', 'no worker scope in the core'],
  ['structuredClone', 'states are built, not cloned'],
  ['Intl', 'no locale-dependent formatting in the core'],
  ['Function', 'no code built from strings in the core'],
  ['eval', 'no code built from strings in the core'],
  ['Worker', 'no threads in the core'],
]);

// Math is allowed only as a direct property access to one of these integer-safe members, so an
// alias (`const M = Math`, `const { random } = Math`) or a computed access is a violation.
const MATH_ALLOWED = new Set(['floor', 'ceil', 'trunc', 'round', 'abs', 'sign', 'min', 'max', 'imul', 'clz32']);

// Methods whose result depends on the machine's locale.
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleUpperCase', 'toLocaleLowerCase', 'localeCompare']);

export interface Violation {
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** Whether an identifier is a reference to a binding, as opposed to a property name or a declaration. */
function isReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === node) return false;
  if (ts.isQualifiedName(p) && p.right === node) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  return true;
}

function isNumericLiteral(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && isNumericLiteral(node.operand);
}

export function scan(fileName: string, source: string): Violation[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: Violation[] = [];
  const report = (node: ts.Node, rule: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, rule, text: node.getText(file).split('\n')[0] ?? '' });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!spec.startsWith('./') && !spec.startsWith('../')) report(node, `imports "${spec}": the core imports only its own files`);
      else if (!resolve(dirname(fileName), spec).startsWith(SRC_ROOT + sep)) report(node, `imports "${spec}", which is outside src/`);
    }
    if (ts.isImportEqualsDeclaration(node)) report(node, 'import = require: the core imports only its own files');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, 'dynamic import()');
    if (ts.isIdentifier(node) && node.text === 'Math' && isReference(node)) {
      const p = node.parent;
      if (!ts.isPropertyAccessExpression(p) || p.expression !== node) report(node, 'Math used other than as Math.<member>: no aliases or computed access');
      else if (!MATH_ALLOWED.has(p.name.text)) report(p, `Math.${p.name.text}: no float transcendental or Math.random; use integer products and the core's RNG`);
    }
    if (ts.isPropertyAccessExpression(node) && LOCALE_METHODS.has(node.name.text)) report(node, `${node.name.text}: no locale-dependent formatting in the core`);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AsteriskAsteriskToken || op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) report(node, 'the ** operator: use integer products');
      if ((op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) && isNumericLiteral(node.right)) {
        report(node, 'a fallback number: a missing value must throw, not read as a number');
      }
    }
    if (ts.isIdentifier(node) && GLOBALS.has(node.text) && isReference(node)) report(node, `${node.text}: ${GLOBALS.get(node.text) ?? ''}`);
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'the any type');
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.UnknownKeyword && ts.isAsExpression(node.parent)) {
      report(node.parent, 'as unknown as');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Directives live in comments, which the tree does not visit.
  source.split('\n').forEach((line, i) => {
    if (/@ts-(?:ignore|expect-error|nocheck)/u.test(line)) found.push({ line: i + 1, rule: 'a @ts- directive', text: line.trim() });
  });
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

describe('purity of src/', () => {
  const files = sources(SRC);

  it('scans every source file of the core', () => {
    expect(files.map((f) => relative(SRC, f))).toEqual(
      expect.arrayContaining(['index.ts', 'rng.ts', 'xoshiro.ts', 'sha256.ts', 'tournament/advance.ts', 'tournament/rules-v1.ts']),
    );
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('has no nondeterministic, environment or framework code', () => {
    const violations = files.flatMap((f) => scan(f, readFileSync(f, 'utf8')).map((v) => `${relative(SRC, f)}:${v.line}: ${v.rule}\n    ${v.text}`));
    expect(violations).toEqual([]);
  });
});

describe('the scanner itself', () => {
  const caught: Array<[string, string]> = [
    ['const x = Math.random();', 'Math.random'],
    ['const t = Date.now();', 'Date'],
    ['const d = new Date();', 'Date'],
    ['const t = performance.now();', 'performance'],
    ['const y = Math.pow(2, 3);', 'Math.pow'],
    ['const y = Math\n  .sqrt(2);', 'Math.sqrt'],
    ['const y = 2 ** 3;', '**'],
    ['let y = 2; y **= 3;', '**'],
    ["import React from 'react';", 'imports "react"'],
    ["import { readFileSync } from 'node:fs';", 'imports "node:fs"'],
    ["export { z } from 'zod';", 'imports "zod"'],
    ["const m = await import('./x.ts');", 'dynamic import()'],
    ['const e = process.env.SEED;', 'process'],
    ['document.title = "x";', 'DOM'],
    ['const s = window.localStorage;', 'DOM'],
    ['const r = crypto.getRandomValues(new Uint32Array(1));', 'crypto'],
    ['setTimeout(() => 1, 0);', 'timers'],
    ['const base = table[i] ?? 8;', 'fallback number'],
    ['const base = table[i] ?? -1;', 'fallback number'],
    ['const base = table[i] || 0;', 'fallback number'],
    ['let v: any = 1;', 'any'],
    ['const v = x as unknown as number;', 'as unknown as'],
    ['// @ts-ignore\nconst v = 1;', '@ts-'],
    ['const M = Math; const r = M.random();', 'Math used other than'],
    ['const { random } = Math;', 'Math used other than'],
    ["const r = Math['random']();", 'Math used other than'],
    ['const pi = Math.PI;', 'Math.PI'],
    ["const f = Function('return 1');", 'Function'],
    ["const f = new Function('return 1');", 'Function'],
    ["const v = eval('1');", 'eval'],
    ['const s = (1234).toLocaleString();', 'toLocaleString'],
    ["const c = 'a'.localeCompare('b');", 'localeCompare'],
    ["import { runBatch } from '../../batch.ts';", 'outside src/'],
    ["export * from '../../test/helpers/x.ts';", 'outside src/'],
  ];

  it.each(caught)('catches %j', (code, rule) => {
    const v = scan(FIXTURE, code);
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.rule).join(' | ')).toContain(rule);
  });

  it('does not flag strings, comments, property names or relative imports inside src/', () => {
    const clean = [
      "const s = 'a ** b, Date and Math.random in a string';",
      '/** Uses no Date. 2 ** 3 is written as 2 * 2 * 2. */\nconst x = 8;',
      '// Math.pow is forbidden here\nconst y = 1;',
      'const o = { Date: 1, process: 2 }; const p = o.Date + o.process;',
      "import { start } from './tournament/advance.ts';",
      "import { divRound } from '../fixed.ts';",
      'const name = table[i] ?? DEFAULT_NAME;',
      'const n = Math.floor(7 / 2) + Math.max(1, 2) + Math.imul(3, 4);',
    ];
    for (const code of clean) expect(scan(FIXTURE, code)).toEqual([]);
  });
});
