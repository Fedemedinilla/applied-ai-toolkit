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
//   parts are joined.
// - An error thrown inside a block (reading a field of undefined, calling a
//   missing method) is swallowed and the block yields undefined. Only a
//   syntax error or a reference to a node without data fails the node.
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
// paired-item resolution across branches and n8n's sandbox restrictions. A test
// checks that the templates use nothing outside the emulated list.

import vm from 'node:vm';

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

/** `$name` identifiers used inside the code blocks of a parameter. */
export function expressionGlobals(parameter: string): string[] {
  if (!parameter.startsWith('=')) return [];
  const code = splitExpression(parameter.slice(1))
    .filter((c) => c.type === 'code')
    .map((c) => c.text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''"))
    .join('\n');
  // "$/" and "$'" end a regex literal such as /^[0-9]+$/, they are not identifiers.
  return [...new Set([...code.matchAll(/\$[A-Za-z_]+|\$(?=\()/g)].map((m) => m[0]))].sort();
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
    return undefined;
  }
  // Objects built inside the context belong to another realm: hand back plain JSON.
  if (value !== null && typeof value === 'object') return JSON.parse(JSON.stringify(value)) as unknown;
  return typeof value === 'function' ? undefined : value;
}

/** The value n8n would hand to the node for this parameter. Non-expressions come back unchanged. */
export function evaluate(parameter: unknown, scope: Scope): unknown {
  if (typeof parameter !== 'string' || !parameter.startsWith('=')) return parameter;
  const chunks = splitExpression(parameter.slice(1));
  const only = chunks[0];
  if (chunks.length === 1 && only?.type === 'code') return runBlock(only.text, scope);
  return chunks
    .map((chunk) => {
      if (chunk.type === 'text') return chunk.text;
      const v = runBlock(chunk.text, scope);
      return v || v === 0 || v === false ? v : '';
    })
    .join('');
}

/** `evaluate` for a parameter that must come out as a string. */
export function evaluateString(parameter: unknown, scope: Scope): string {
  const value = evaluate(parameter, scope);
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}: ${String(parameter)}`);
  return value;
}
