/**
 * Reads what a JavaScript or TypeScript file imports, from the TypeScript AST. Comments and strings
 * that look like imports are not imports, and an AST walk does not confuse them the way a regex does.
 */
import ts from 'typescript';

export type RefKind =
  /** import ... from 'x', import 'x' */
  | 'import'
  /** export ... from 'x', export * from 'x' */
  | 'export'
  /** import('x') in code */
  | 'dynamic'
  /** require('x'), anywhere in the file, inside a function or not */
  | 'require'
  /** import x = require('x') */
  | 'import-equals'
  /** typeof import('x'), import('x').T in a type position */
  | 'import-type'
  /** new URL('x', import.meta.url): bundlers emit the file as an asset or a worker */
  | 'url'
  /** import.meta.glob(...): every file matching a pattern */
  | 'glob';

export interface ModuleRef {
  readonly kind: RefKind;
  /** The literal text, or null when the argument is computed (a variable, a template with ${}). */
  readonly specifier: string | null;
  /** Erased by the compiler: brings no code at runtime. */
  readonly typeOnly: boolean;
  /** `import { type A }`: the module runs, but every binding is a type (see hasOnlyInlineTypes). */
  readonly inlineTypesOnly: boolean;
  readonly line: number;
  readonly column: number;
}

export interface Located {
  readonly line: number;
  readonly column: number;
  /** A short excerpt of the code, for the report. */
  readonly text: string;
}

const KIND_BY_EXTENSION: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

export const CODE_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION);

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function parse(path: string, content: string): ts.SourceFile {
  const ext = CODE_EXTENSIONS.find((e) => path.endsWith(e)) ?? '.ts';
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, KIND_BY_EXTENSION[ext]);
}

function position(file: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { line: line + 1, column: character + 1 };
}

function excerpt(file: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(file).replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The text of a string literal or a template without ${}; null when the value is computed. */
function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function isImportMeta(node: ts.Node): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
}

/**
 * `import type ...` (TypeScript 5.9 reports it in phaseModifier; isTypeOnly is deprecated since
 * `import defer`) or `export type ...`. Only these are erased. `import { type A }` and
 * `export { type A } from 'x'` keep the module: under verbatimModuleSyntax tsc emits
 * `import {} from 'x'`, and Node's type stripping keeps the import, so the module runs.
 */
export function isTypeOnlyDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  return node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/**
 * Bindings exist and every one is marked `type`: `import { type A, type B } from 'x'`. The module
 * still runs, but no value crosses; `import type` says the same thing and is erased.
 */
export function hasOnlyInlineTypes(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (isTypeOnlyDeclaration(node)) return false;
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  const clause = node.importClause;
  const bindings = clause?.namedBindings;
  return (
    clause !== undefined &&
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((e) => e.isTypeOnly)
  );
}

/** Every module reference in the file, in source order. */
export function moduleRefs(file: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];
  const add = (kind: RefKind, node: ts.Node, arg: ts.Node | undefined, typeOnly: boolean, inlineTypesOnly = false) => {
    refs.push({ kind, specifier: literalText(arg), typeOnly, inlineTypesOnly, ...position(file, node) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add('import', node, node.moduleSpecifier, isTypeOnlyDeclaration(node), hasOnlyInlineTypes(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add('export', node, node.moduleSpecifier, isTypeOnlyDeclaration(node), hasOnlyInlineTypes(node));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add('import-equals', node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const arg = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      add('import-type', node, arg, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add('dynamic', node, node.arguments[0], false);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length > 0) {
      add('require', node, node.arguments[0], false);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[1] !== undefined &&
      ts.isPropertyAccessExpression(node.arguments[1]) &&
      isImportMeta(node.arguments[1].expression) &&
      node.arguments[1].name.text === 'url'
    ) {
      add('url', node, node.arguments[0], false);
    } else if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression) && node.name.text === 'glob') {
      refs.push({ kind: 'glob', specifier: null, typeOnly: false, inlineTypesOnly: false, ...position(file, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return refs;
}

/** The leftmost identifier of `a`, `a.b.c` or `a['b']`; undefined for anything else. */
function rootIdentifier(node: ts.Expression | undefined): string | undefined {
  let current = node;
  while (current !== undefined && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  return current !== undefined && ts.isIdentifier(current) ? current.text : undefined;
}

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

/** `require('x')`, possibly behind a member access: `require('x').Client`. */
function requiredSpecifier(node: ts.Expression | undefined): string | null {
  let current = node;
  while (current !== undefined && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  if (current === undefined || !ts.isCallExpression(current) || !ts.isIdentifier(current.expression) || current.expression.text !== 'require') return null;
  return literalText(current.arguments[0]);
}

/** The expression a class extends, if any. */
function superclass(node: ts.ClassLikeDeclaration): ts.Expression | undefined {
  const clause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  return clause?.types[0]?.expression;
}

/** `module.exports`, `module.exports.x`, `exports.x`. */
function isCommonJsExport(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const object = node.expression;
    if (ts.isIdentifier(object) && object.text === 'exports') return true;
    if (ts.isIdentifier(object) && object.text === 'module' && ts.isPropertyAccessExpression(node) && node.name.text === 'exports') return true;
    return isCommonJsExport(object);
  }
  return false;
}

/**
 * Where the file hands values of a target module to its own importers. Re-export statements:
 * `export * from`, `export * as ns from`, `export { x } from`. A value bound from the target
 * (by `import`, `import x = require()` or `const x = require()` at the top level), or a top-level
 * alias of one (`const k = x`, `class K extends x {}`, followed to any depth), that leaves through
 * `export { }`, `export default`, `export =`, an exported `const`, an exported class that extends
 * it, or `module.exports` / `exports.y`. Member access (`x.Client`) counts too. Types may leave:
 * they create nothing at runtime. A function that returns the value is not followed.
 */
export function reexports(file: ts.SourceFile, isTarget: (specifier: string) => boolean): Located[] {
  const bound = new Set<string>();
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isTarget(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      if (clause.name !== undefined) bound.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) bound.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) for (const e of bindings.elements) if (!e.isTypeOnly) bound.add(e.name.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isTarget(literalText(node.moduleReference.expression) ?? '')
    ) {
      bound.add(node.name.text);
    }
  }
  const leaks = (expression: ts.Expression | undefined): boolean => {
    const required = requiredSpecifier(expression);
    if (required !== null) return isTarget(required);
    const root = rootIdentifier(expression);
    return root !== undefined && bound.has(root);
  };
  // Local aliases, until nothing new is bound: `const k = Client`, `class K extends Client {}`.
  for (let grew = true; grew; ) {
    grew = false;
    const bind = (name: string) => {
      if (!bound.has(name)) {
        bound.add(name);
        grew = true;
      }
    };
    for (const node of file.statements) {
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!leaks(d.initializer)) continue;
          if (ts.isIdentifier(d.name)) bind(d.name.text);
          else for (const element of d.name.elements) if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) bind(element.name.text);
        }
      } else if (ts.isClassDeclaration(node) && node.name !== undefined && leaks(superclass(node))) {
        bind(node.name.text);
      }
    }
  }
  const found: Located[] = [];
  const at = (node: ts.Node) => ({ ...position(file, node), text: excerpt(file, node) });
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        if (isTarget(node.moduleSpecifier.text) && !isTypeOnlyDeclaration(node) && !hasOnlyInlineTypes(node)) found.push(at(node));
      } else if (!node.isTypeOnly && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const e of node.exportClause.elements) {
          if (!e.isTypeOnly && bound.has((e.propertyName ?? e.name).getText(file))) found.push(at(e));
        }
      }
    } else if (ts.isExportAssignment(node) && (leaks(node.expression) || (ts.isClassExpression(node.expression) && leaks(superclass(node.expression))))) {
      found.push(at(node));
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) if (leaks(declaration.initializer)) found.push(at(declaration));
    } else if (ts.isClassDeclaration(node) && isExported(node) && leaks(superclass(node))) {
      found.push(at(node));
    } else if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isCommonJsExport(node.expression.left) &&
      leaks(node.expression.right)
    ) {
      found.push(at(node));
    }
  }
  return found;
}

/**
 * Every place that names an environment variable: an identifier with its name (`process.env.X`,
 * `import.meta.env.X`, `const { X } = process.env`, `import { X } from 'astro:env/server'`) or a
 * string that is exactly its name (`process.env['X']`, `getSecret('X')`, `const k = 'X'`).
 * A comment, or a message that mentions the name among other words, does not count.
 */
export function namesOf(file: ts.SourceFile, name: string): Located[] {
  const found: Located[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === name) {
      const shown = node.parent !== undefined && (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) ? node.parent : node;
      found.push({ ...position(file, node), text: excerpt(file, shown) });
    } else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** String and template literals whose text contains the needle. Comments are not literals. */
export function stringsContaining(file: ts.SourceFile, needle: string): Located[] {
  const found: Located[] = [];
  const visit = (node: ts.Node): void => {
    const isString =
      ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isString && (node as ts.LiteralLikeNode).text.includes(needle)) found.push({ ...position(file, node), text: excerpt(file, node) });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
