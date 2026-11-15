// Evaluates n8n expression parameters ("={{ ... }}") outside n8n.
//
// The rules below were read from the published sources of n8n-workflow 2.15.0
// and @n8n/tournament, the engine n8n uses by default. They were not checked
// against a running n8n.
//
// - A parameter is an expression only when it starts with "=".
// - Text between "{{" and the next "}}" is JavaScript. The first "}}" closes
//   the block, even inside an object literal.
// - A parameter that is one block and nothing else yields the block's value
//   with its type. Text mixed with blocks yields a string: each block's value
//   is kept when it is truthy, 0 or false, replaced by "" otherwise, and the
//   parts are joined. A block whose value is a function fails the node when it
//   is the whole parameter, and joins the function's source text otherwise.
// - An error thrown inside a block (reading a field of undefined, calling a
//   missing method) is swallowed and the block yields undefined. Only a
//   syntax error or a reference to a node without data fails the node.
//   Here a name the harness does not define (DateTime, $vars) also fails,
//   with ExpressionHarnessError, because n8n would give it a value.
//
// Emulated globals, each block in a node:vm context frozen to exactly these:
//   $json                      json of the current item
//   $('Node').item.json, .first().json, .last().json, .all()
//   $now.toFormat(fmt)         for the formats in NOW_FORMATS, on a fixed clock
//
// Not emulated: n8n's extension methods on strings, numbers, arrays and dates
// (.isEmail(), .toDateTime() and so on), $if, $ifEmpty, $max, $min, $today,
// Luxon beyond the formats above, $env, $vars, $workflow, $execution,
// $prevNode, $itemIndex, $runIndex, $parameter, $input, $node, $items, $jmespath,
// paired-item resolution across branches and n8n's sandbox restrictions. Tests
// check that the templates use no `$` global outside the emulated list, none of
// n8n's bare globals (N8N_BARE_GLOBALS) and no extension method
// (EXTENSION_METHODS). Here an extension call yields undefined; in n8n it runs,
// and on a null or undefined value it fails the node instead of yielding "".

import vm from 'node:vm';
import { codeOnly } from './js-scan.ts';

export interface Scope {
  /** json of the current item, `$json`. */
  json: unknown;
  /** json of the matching item of earlier nodes, by node name, for `$('Node')`. */
  nodes?: Record<string, unknown>;
  /** The clock, as "yyyy-MM-ddTHH:mm". Defaults to FIXED_NOW. */
  now?: string;
}

/** An error the real engine would raise too, or a feature this harness does not emulate. */
export class ExpressionHarnessError extends Error {
  override name = 'ExpressionHarnessError';
}

export const FIXED_NOW = '2026-01-31T10:00';

export const NOW_FORMATS: Readonly<Record<string, (now: string) => string>> = {
  'yyyy-LL-dd HH:mm': (now) => now.replace('T', ' '),
  'yyyy-LL-dd': (now) => now.slice(0, 10),
};

/** `$name` identifiers an expression may use here. */
export const EXPRESSION_GLOBALS: readonly string[] = ['$json', '$', '$now'];

export interface Chunk {
  type: 'text' | 'code';
  text: string;
}

/** Splits the part after "=" into text and code chunks, closing each block at the first "}}". */
export function splitExpression(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  let rest = body;
  for (;;) {
    const open = rest.indexOf('{{');
    if (open === -1) break;
    const close = rest.indexOf('}}', open + 2);
    if (close === -1) throw new ExpressionHarnessError(`unclosed {{ in: ${body.slice(0, 80)}`);
    if (open > 0) chunks.push({ type: 'text', text: rest.slice(0, open) });
    chunks.push({ type: 'code', text: rest.slice(open + 2, close) });
    rest = rest.slice(close + 2);
  }
  if (rest !== '') chunks.push({ type: 'text', text: rest });
  return chunks;
}

/**
 * Globals n8n 2.15 adds to an expression without a `$`: Luxon's classes and
 * the extended functions (n8n-workflow expression.js and extended-functions.js).
 */
export const N8N_BARE_GLOBALS: readonly string[] = [
  'DateTime',
  'Interval',
  'Duration',
  'min',
  'max',
  'not',
  'average',
  'numberList',
  'zip',
];

const BARE_GLOBAL = new RegExp(`(?<![\\w$.])(?:${N8N_BARE_GLOBALS.join('|')})\\b(?!\\s*:)`, 'g');

/** `$name` identifiers and n8n's bare globals (N8N_BARE_GLOBALS) used inside the code blocks of a parameter. */
export function expressionGlobals(parameter: string): string[] {
  if (!parameter.startsWith('=')) return [];
  const code = splitExpression(parameter.slice(1))
    .filter((c) => c.type === 'code')
    .map((c) => codeOnly(c.text))
    .join('\n');
  const names = [...code.matchAll(/\$[A-Za-z_]+|\$(?=\()/g), ...code.matchAll(BARE_GLOBAL)].map((m) => m[0]);
  return [...new Set(names)].sort();
}

/**
 * n8n's extension methods, from the string, number, date, array, object and
 * boolean extensions of n8n-workflow 2.15.0 plus isEmpty and isNotEmpty.
 * n8n rewrites `x.name(...)` into a call of its own when the name is one of
 * these, and that call fails the node when x is null or undefined.
 */
export const EXTENSION_METHODS: readonly string[] = [
  ...new Set(
    [
      'hash removeMarkdown removeTags toDate toDateTime toBoolean toDecimalNumber toNumber toFloat toInt toWholeNumber',
      'toSentenceCase toSnakeCase toTitleCase urlDecode urlEncode quote replaceSpecialChars length isDomain isEmail',
      'isNumeric isUrl isEmpty isNotEmpty toJsonString extractEmail extractDomain extractUrl extractUrlPath parseJson',
      'base64Encode base64Decode',
      'ceil floor format round abs isInteger isEven isOdd',
      'beginningOf endOfMonth extract isBetween isDst isInLast isWeekend minus plus diffTo diffToNow',
      'removeDuplicates unique first last pluck randomItem sum min max average compact smartJoin chunk renameKeys',
      'merge union difference intersection append',
      'hasField removeField removeFieldsContaining keepFieldsContaining keys values',
    ]
      .join(' ')
      .split(' '),
  ),
];

const BUILT_IN_NAMESPACE = /^(?:Math|Object|JSON|Number|String|Array|Date)$/;

/**
 * Extension methods called inside the code blocks of a parameter. Calls on a
 * built-in namespace (`Math.max`, `Object.keys`) and `$('Node').first()` or
 * `.last()` are left out: n8n runs those as they are.
 */
export function extensionCalls(parameter: string): string[] {
  if (!parameter.startsWith('=')) return [];
  const found = new Set<string>();
  for (const chunk of splitExpression(parameter.slice(1))) {
    if (chunk.type !== 'code') continue;
    const code = codeOnly(chunk.text).replace(/\$\(\s*''\s*\)\s*\.\s*(?:first|last)\s*\(/g, ' ');
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)?\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
      const receiver = m[1] ?? '';
      const name = m[2] ?? '';
      if (BUILT_IN_NAMESPACE.test(receiver)) continue;
      if (EXTENSION_METHODS.includes(name)) found.add(name);
    }
  }
  return [...found].sort();
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function runBlock(code: string, scope: Scope): unknown {
  const nodes = scope.nodes ?? {};
  const now = scope.now ?? FIXED_NOW;
  const item = (name: string) => {
    if (!Object.hasOwn(nodes, name)) {
      throw new ExpressionHarnessError(`expression references node "${name}", which has no data in this test`);
    }
    const entry = Object.freeze({ json: clone(nodes[name]) });
    return Object.freeze({ item: entry, first: () => entry, last: () => entry, all: () => [entry] });
  };
  const context = Object.freeze({
    $json: clone(scope.json),
    $: item,
    $now: Object.freeze({
      toFormat: (format: string) => {
        const render = Object.hasOwn(NOW_FORMATS, format) ? NOW_FORMATS[format] : undefined;
        if (!render) throw new ExpressionHarnessError(`$now.toFormat('${format}') is not emulated`);
        return render(now);
      },
    }),
  });

  let script: vm.Script;
  try {
    // n8n wraps a block that starts with "{" in parentheses; wrapping every block is equivalent.
    script = new vm.Script(`(${code}\n)`, { filename: 'expression.js' });
  } catch (error) {
    throw new ExpressionHarnessError(`invalid syntax in {{${code}}}: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = script.runInContext(vm.createContext(context), { timeout: 1000 });
  } catch (error) {
    if (error instanceof ExpressionHarnessError) throw error;
    // n8n defines every name a template can use, so a ReferenceError here is a gap in the
    // emulation (DateTime, $vars), not the empty value n8n would swallow an error into.
    // The error comes from the context's realm, so it is checked by name.
    if ((error as { name?: unknown } | null)?.name === 'ReferenceError') {
      const name = /^(\S+) is not defined/.exec(String((error as { message?: unknown }).message))?.[1] ?? 'a name';
      throw new ExpressionHarnessError(`${name} is not emulated, in {{${code}}}`);
    }
    return undefined;
  }
  // Objects built inside the context belong to another realm: hand back plain JSON.
  if (value !== null && typeof value === 'object') return JSON.parse(JSON.stringify(value)) as unknown;
  return value;
}

/** The value n8n would hand to the node for this parameter. Non-expressions come back unchanged. */
export function evaluate(parameter: unknown, scope: Scope): unknown {
  if (typeof parameter !== 'string' || !parameter.startsWith('=')) return parameter;
  const chunks = splitExpression(parameter.slice(1));
  const only = chunks[0];
  if (chunks.length === 1 && only?.type === 'code') {
    const value = runBlock(only.text, scope);
    // n8n refuses a parameter whose whole value is a function, such as `$json.name.trim` without ().
    if (typeof value === 'function') throw new ExpressionHarnessError(`this is a function, please add () in: ${parameter.slice(0, 80)}`);
    return value;
  }
  return chunks
    .map((chunk) => {
      if (chunk.type === 'text') return chunk.text;
      const v = runBlock(chunk.text, scope);
      // In mixed text a function is truthy and n8n joins its source text.
      return v || v === 0 || v === false ? String(v) : '';
    })
    .join('');
}

/** `evaluate` for a parameter that must come out as a string. */
export function evaluateString(parameter: unknown, scope: Scope): string {
  const value = evaluate(parameter, scope);
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}: ${String(parameter)}`);
  return value;
}
