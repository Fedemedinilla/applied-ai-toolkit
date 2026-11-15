// Runs the JavaScript of an n8n Code node outside n8n, in a node:vm context
// that holds only the globals listed below. The context object is frozen, so
// code under test cannot replace one of them, and each run gets a new context,
// so a global the code adds does not reach the next run. There is no
// `process`, `fetch`, `setTimeout` or module loader.
//
// Emulated, for the mode "Run Once for All Items":
//   $input.all(), $input.first(), $input.last(), $input.item
//   items                    the input items, as in n8n's legacy API
//   $json                    json of the first input item
//   $('Node').all(), .first(), .last(), .item    for the nodes passed in `nodes`
//   $node['Node'].json       json of that node's first item
//   $env                     only the variables passed in `env`, frozen
//   require(name)            only the modules in `modules`; by default `crypto`,
//                            which is what NODE_FUNCTION_ALLOW_BUILTIN=crypto allows
//   Buffer, console          console is silent
//
// Not emulated: "Run Once for Each Item" mode, $execution, $workflow, $vars,
// $now and $today (Luxon), $jmespath, $getWorkflowStaticData, this.helpers,
// binary data, paired items, Python, n8n's task runner limits and its
// conversion of a returned plain object into an item. A node that reads one of
// these fails here with a ReferenceError instead of passing by accident.
//
// node:vm is not a security boundary. The harness runs the repository's own
// templates, never code from elsewhere.

import * as crypto from 'node:crypto';
import vm from 'node:vm';
import { codeOnly } from './js-scan.ts';

export interface Item {
  json: Record<string, unknown>;
}

export interface CodeNodeOptions {
  /** Input items of the node. */
  items: Item[];
  /** Output items of other nodes, by node name, for $('Node') and $node['Node']. */
  nodes?: Record<string, Item[]>;
  /** Environment variables visible as $env. None by default. */
  env?: Record<string, string>;
  /** Modules `require` may return, by name without the `node:` prefix. Default: crypto. */
  modules?: Record<string, unknown>;
  /** Milliseconds before a synchronous loop is stopped. */
  timeoutMs?: number;
}

/** Globals the harness defines. A test checks that no Code node reads another `$name`. */
export const CODE_NODE_GLOBALS: readonly string[] = [
  '$input',
  'items',
  '$json',
  '$',
  '$node',
  '$env',
  'require',
  'Buffer',
  'console',
];

function accessor(list: Item[]) {
  return Object.freeze({
    all: () => list,
    first: () => list[0],
    last: () => list[list.length - 1],
    get item() {
      return list[0];
    },
  });
}

/**
 * Runs `code` and returns its items, serialized the way n8n hands them to the
 * next node (JSON only, `undefined` fields dropped). Rejects when the code
 * throws or returns something that is not a list of `{ json: {...} }` items.
 */
export async function runCodeNode(code: string, options: CodeNodeOptions): Promise<Item[]> {
  const items = structuredClone(options.items);
  const nodes = structuredClone(options.nodes ?? {});
  const modules: Record<string, unknown> = options.modules ?? { crypto };

  const lookup = (name: string): Item[] => {
    const found = Object.hasOwn(nodes, name) ? nodes[name] : undefined;
    if (!found) throw new Error(`Referenced node "${name}" has no data in this test`);
    return found;
  };

  const context = Object.freeze({
    $input: accessor(items),
    items,
    $json: items[0]?.json,
    $: (name: string) => accessor(lookup(name)),
    $node: new Proxy(
      {},
      { get: (_target, name) => (typeof name === 'string' ? { json: lookup(name)[0]?.json } : undefined) },
    ),
    $env: Object.freeze({ ...(options.env ?? {}) }),
    require: (name: string): unknown => {
      const key = name.replace(/^node:/, '');
      if (!Object.hasOwn(modules, key)) throw new Error(`Cannot find module '${name}'`);
      return modules[key];
    },
    Buffer,
    console: Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }),
  });

  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'code-node.js' });
  const result: unknown = await script.runInContext(vm.createContext(context), {
    timeout: options.timeoutMs ?? 1000,
  });

  if (!Array.isArray(result)) throw new Error('Code node must return an array of items');
  const out = JSON.parse(JSON.stringify(result)) as unknown[];
  for (const item of out) {
    const json = (item as { json?: unknown } | null)?.json;
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('Every returned item must be { json: { ... } }');
    }
  }
  return out as Item[];
}

/** `$name` identifiers that a piece of Code node JavaScript reads, for the coverage check. */
export function dollarGlobals(code: string): string[] {
  return [...new Set([...codeOnly(code).matchAll(/\$[A-Za-z_]*/g)].map((m) => m[0]))].sort();
}
