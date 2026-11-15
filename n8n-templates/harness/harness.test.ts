// Tests of the harness itself. A harness that is wrong in a lenient direction
// makes every template test above it pass for the wrong reason, so the rules
// it claims to emulate are pinned here against known inputs.

import { describe, expect, it } from 'vitest';
import { CODE_NODE_GLOBALS, dollarGlobals, runCodeNode } from './code-node.ts';
import {
  EXPRESSION_GLOBALS,
  ExpressionHarnessError,
  evaluate,
  expressionGlobals,
  splitExpression,
} from './expressions.ts';
import { DedupeHistory, NodeFailure, NotEmulated, applySet, dedupeKey, ifPasses, jsonBody, switchOutput } from './nodes.ts';
import { type WorkflowNode, codeNodes, loadTemplates, strings, workingNodes } from './workflow.ts';

const item = (json: Record<string, unknown>) => ({ json });

describe('runCodeNode', () => {
  it('gives the code $input, items and $json, and returns JSON items', async () => {
    const code = `return $input.all().map((i, n) => ({ json: { n, v: i.json.v, same: items[n] === i, first: $json.v, gone: undefined } }));`;
    await expect(runCodeNode(code, { items: [item({ v: 'a' }), item({ v: 'b' })] })).resolves.toEqual([
      { json: { n: 0, v: 'a', same: true, first: 'a' } },
      { json: { n: 1, v: 'b', same: true, first: 'a' } },
    ]);
  });

  it('answers $input.first(), last() and item, and undefined on no input', async () => {
    const code = `return [{ json: { first: $input.first()?.json.v ?? null, last: $input.last()?.json.v ?? null, item: $input.item?.json.v ?? null } }];`;
    await expect(runCodeNode(code, { items: [item({ v: 1 }), item({ v: 2 })] })).resolves.toEqual([
      { json: { first: 1, last: 2, item: 1 } },
    ]);
    await expect(runCodeNode(code, { items: [] })).resolves.toEqual([{ json: { first: null, last: null, item: null } }]);
  });

  it("reads other nodes through $('Node') and $node, and fails on a node without data", async () => {
    const code = `return [{ json: { a: $('Earlier').first().json.x, b: $node['Earlier'].json.x, n: $('Earlier').all().length } }];`;
    const nodes = { Earlier: [item({ x: 7 })] };
    await expect(runCodeNode(code, { items: [], nodes })).resolves.toEqual([{ json: { a: 7, b: 7, n: 1 } }]);
    await expect(runCodeNode(code, { items: [] })).rejects.toThrow(/Referenced node "Earlier"/);
  });

  it('exposes only the $env variables it was given, read-only', async () => {
    const code = `'use strict'; let frozen = false; try { $env.A = 'x'; } catch { frozen = true; } return [{ json: { a: $env.A, b: $env.PATH ?? null, frozen } }];`;
    await expect(runCodeNode(code, { items: [], env: { A: '1' } })).resolves.toEqual([
      { json: { a: '1', b: null, frozen: true } },
    ]);
  });

  it('allows require("crypto") and node:crypto, and nothing else', async () => {
    const ok = `return [{ json: { a: typeof require('crypto').createHmac, b: typeof require('node:crypto').timingSafeEqual } }];`;
    await expect(runCodeNode(ok, { items: [] })).resolves.toEqual([{ json: { a: 'function', b: 'function' } }]);
    for (const name of ['fs', 'node:child_process', 'constructor', '__proto__']) {
      await expect(runCodeNode(`require('${name}'); return [];`, { items: [] })).rejects.toThrow(/Cannot find module/);
    }
  });

  it('fails like a self-hosted n8n without NODE_FUNCTION_ALLOW_BUILTIN when given no modules', async () => {
    await expect(runCodeNode(`require('crypto'); return [];`, { items: [], modules: {} })).rejects.toThrow(
      /Cannot find module 'crypto'/,
    );
  });

  it('has no process, fetch or timers, its globals cannot be replaced, and nothing survives a run', async () => {
    const code = `
      const names = ['process', 'fetch', 'setTimeout', 'setInterval', 'XMLHttpRequest', '$execution', '$workflow', '$vars', '$now'];
      const present = names.filter((n) => n in globalThis);
      globalThis.$input = null;
      globalThis.leak = 1;
      return [{ json: { present, stillThere: typeof $input.all } }];`;
    await expect(runCodeNode(code, { items: [] })).resolves.toEqual([{ json: { present: [], stillThere: 'function' } }]);
    // Each run gets a new context, so a global one run adds is gone in the next.
    await expect(runCodeNode(`return [{ json: { leaked: 'leak' in globalThis } }];`, { items: [] })).resolves.toEqual([
      { json: { leaked: false } },
    ]);
    await expect(runCodeNode(`return [{ json: { v: $execution.id } }];`, { items: [] })).rejects.toThrow(
      /\$execution is not defined/,
    );
  });

  it('does not let the code change the caller’s input', async () => {
    const input = [item({ list: [1] })];
    await runCodeNode(`$input.first().json.list.push(2); return [];`, { items: input });
    expect(input).toEqual([{ json: { list: [1] } }]);
  });

  it('rejects when the code throws, loops forever or returns the wrong shape', async () => {
    await expect(runCodeNode(`throw new Error('boom');`, { items: [] })).rejects.toThrow('boom');
    await expect(runCodeNode(`for (;;) {}`, { items: [], timeoutMs: 50 })).rejects.toThrow(/timed out/);
    await expect(runCodeNode(`return { json: {} };`, { items: [] })).rejects.toThrow(/array of items/);
    await expect(runCodeNode(`return [{ v: 1 }];`, { items: [] })).rejects.toThrow(/\{ json: \{ \.\.\. \} \}/);
    await expect(runCodeNode(`return [{ json: [1] }];`, { items: [] })).rejects.toThrow(/\{ json/);
  });

  it('awaits asynchronous code', async () => {
    await expect(runCodeNode(`const v = await Promise.resolve(3); return [{ json: { v } }];`, { items: [] })).resolves.toEqual([
      { json: { v: 3 } },
    ]);
  });
});

describe('dollarGlobals', () => {
  it('finds the $ identifiers in code, not the ones in strings, comments or regex ends', () => {
    const code = "// uses $vars in a comment\nconst a = $input.first(); const b = '$env'; const c = `${$json.x} $workflow`; /^[0-9]+$/.test(a);";
    // The "$" that ends /^[0-9]+$/ is part of a regex literal, not a call to $('Node').
    expect(dollarGlobals(code)).toEqual(['$input', '$json']);
    expect(dollarGlobals(`${code} $('Node').first();`)).toEqual(['$', '$input', '$json']);
  });

  it('still sees a $ global after a URL string or a regex literal with a quote', () => {
    expect(dollarGlobals("const u = 'https://api.example'; const v = $vars.token;")).toEqual(['$vars']);
    expect(dollarGlobals('const r = /["]/; const v = $vars.a; const s = "x";')).toEqual(['$vars']);
    expect(dollarGlobals("const r = /[/']/g; /* $env */ const w = `a${'}'}b${$workflow.id}`;")).toEqual(['$workflow']);
    expect(dollarGlobals('const half = total / 2; const v = $vars.a / 3;')).toEqual(['$vars']);
  });

  it('every Code node in the templates reads only globals the harness defines', () => {
    const nodes = loadTemplates().flatMap((t) => codeNodes(t.workflow));
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.parameters.mode, node.name).toBe('runOnceForAllItems');
      expect(node.parameters.language ?? 'javaScript', node.name).toBe('javaScript');
      for (const name of dollarGlobals(String(node.parameters.jsCode))) {
        expect(CODE_NODE_GLOBALS, `${node.name} reads ${name}`).toContain(name);
      }
    }
  });
});

describe('evaluate', () => {
  const scope = { json: { body: { email: ' A@B.co ', n: 0, flag: false, list: [1, 2] }, id: 42 }, nodes: { Earlier: { name: 'Ana' } } };

  it('returns a non-expression unchanged', () => {
    expect(evaluate('plain {{ text }}', scope)).toBe('plain {{ text }}');
    expect(evaluate(5, scope)).toBe(5);
    expect(evaluate(undefined, scope)).toBeUndefined();
  });

  it('keeps the type of a parameter that is a single block', () => {
    expect(evaluate('={{ $json.id }}', scope)).toBe(42);
    expect(evaluate('={{ $json.body.flag }}', scope)).toBe(false);
    expect(evaluate('={{ $json.body.list.concat([3]) }}', scope)).toEqual([1, 2, 3]);
    expect(evaluate('={{ { a: $json.id } }}', scope)).toEqual({ a: 42 });
    expect(evaluate('={{ $json.body.missing }}', scope)).toBeUndefined();
  });

  it('joins text and blocks into a string, keeping 0 and false and dropping other falsy values', () => {
    expect(evaluate('=id {{ $json.id }}:{{ $json.body.n }}:{{ $json.body.flag }}:{{ $json.nope }}:{{ null }}.', scope)).toBe(
      'id 42:0:false::.',
    );
    expect(evaluate('={{ $json.id }} ', scope)).toBe('42 ');
    expect(evaluate('=no blocks', scope)).toBe('no blocks');
  });

  it('swallows an error inside a block, as the real engine does, and yields undefined', () => {
    expect(evaluate('={{ $json.payer.identification.type }}', scope)).toBeUndefined();
    expect(evaluate('=Hi {{ $json.payer.name.trim() }}!', scope)).toBe('Hi !');
    expect(evaluate('={{ $json.id.nope() }}', scope)).toBeUndefined();
  });

  it('fails on a name n8n defines but the harness does not, instead of yielding an empty value', () => {
    expect(() => evaluate("=Sent {{ DateTime.now().toFormat('yyyy') }}", scope)).toThrow(/DateTime is not emulated/);
    expect(() => evaluate("={{ /'/.test($json.id) ? $vars.x : 'no' }}", { json: { id: "'" } })).toThrow(ExpressionHarnessError);
  });

  it('fails on a syntax error and on a node without data', () => {
    expect(() => evaluate('={{ $json. }}', scope)).toThrow(ExpressionHarnessError);
    expect(() => evaluate("={{ $('Missing').item.json.x }}", scope)).toThrow(/references node "Missing"/);
    expect(() => evaluate('={{ $json.id ', scope)).toThrow(/unclosed/);
  });

  it('fails on a single block that is a function and prints its source in mixed text, like n8n', () => {
    expect(() => evaluate('={{ (() => 1) }}', scope)).toThrow(/this is a function, please add \(\)/);
    expect(() => evaluate('={{ $json.body.email.trim }}', scope)).toThrow(ExpressionHarnessError);
    expect(evaluate('=a{{ (()=>1) }}b', scope)).toBe('a()=>1b');
    expect(evaluate('=Hi {{ $json.body.email.trim }}', scope)).toBe('Hi function trim() { [native code] }');
  });

  it("reads earlier nodes through $('Node')", () => {
    for (const access of ['item', 'first()', 'last()', 'all()[0]']) {
      expect(evaluate(`={{ $('Earlier').${access}.json.name }}`, scope)).toBe('Ana');
    }
  });

  it('closes a block at the first }}, like n8n', () => {
    expect(splitExpression('a {{ {x:{y:1}}.x }} b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: ' {x:{y:1' },
      { type: 'text', text: '.x }} b' },
    ]);
  });

  it('formats $now on a fixed clock for the two formats the templates use, and refuses others', () => {
    expect(evaluate("={{ $now.toFormat('yyyy-LL-dd HH:mm') }}", scope)).toBe('2026-01-31 10:00');
    expect(evaluate("={{ $now.toFormat('yyyy-LL-dd') }}", { ...scope, now: '2026-12-01T08:00' })).toBe('2026-12-01');
    expect(() => evaluate("={{ $now.toFormat('dd/MM') }}", scope)).toThrow(/not emulated/);
  });

  it('has no globals beyond the emulated ones, they are read-only, and nothing survives a block', () => {
    for (const name of ['$env', '$vars', '$input', '$node', '$workflow', '$execution', 'process', 'require', 'fetch']) {
      expect(evaluate(`={{ typeof ${name} }}`, scope), name).toBe('undefined');
    }
    expect(evaluate('={{ (globalThis.$json = { id: 1 }, globalThis.x = 2, $json.id) }}', scope)).toBe(42);
    expect(evaluate('={{ typeof x }}', scope)).toBe('undefined');
  });

  it('does not let a block change the scope it was given', () => {
    evaluate('={{ $json.body.list.push(9) }}', scope);
    expect(scope.json.body.list).toEqual([1, 2]);
  });
});

describe('expressionGlobals', () => {
  it('lists the $ identifiers of the code blocks only', () => {
    const text = "=Total $5 {{ $json.a + $('N').item.json.b + $now.toFormat('yyyy') + '$vars' + /^[0-9]+$/.test($json.c) }}";
    expect(expressionGlobals(text)).toEqual(['$', '$json', '$now']);
    expect(expressionGlobals('$json outside an expression')).toEqual([]);
  });

  it("lists n8n's globals without a $, and $ names after a regex literal with a quote", () => {
    expect(expressionGlobals("=Sent {{ DateTime.now().toFormat('yyyy') }}")).toEqual(['DateTime']);
    expect(expressionGlobals('={{ Duration.fromObject({ days: 1 }) && max(1, 2) }}')).toEqual(['Duration', 'max']);
    expect(expressionGlobals('={{ Math.max($json.a, 1) + { min: 1 }.min }}')).toEqual(['$json']);
    expect(expressionGlobals("={{ /'/.test($json.a) ? $vars.x : '' }}")).toEqual(['$json', '$vars']);
  });

  it('every expression in the templates uses only globals the harness emulates', () => {
    let blocks = 0;
    for (const { file, workflow } of loadTemplates()) {
      for (const node of workingNodes(workflow)) {
        for (const { path, value } of strings(node.parameters)) {
          if (path.at(-1) === 'jsCode') continue;
          for (const name of expressionGlobals(value)) {
            blocks++;
            expect(EXPRESSION_GLOBALS, `${file} / ${node.name} / ${path.join('.')} uses ${name}`).toContain(name);
          }
        }
      }
    }
    expect(blocks).toBeGreaterThan(100);
  });
});

const fakeNode = (type: string, parameters: Record<string, unknown>, typeVersion = 1): WorkflowNode => ({
  id: 'test',
  name: 'Test node',
  type,
  typeVersion,
  position: [0, 0],
  parameters,
});

const filter = (conditions: unknown[], combinator = 'and', caseSensitive = true) => ({
  options: { caseSensitive, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions,
  combinator,
});
const cond = (leftValue: unknown, type: string, operation: string, rightValue: unknown = '', singleValue = false) => ({
  leftValue,
  rightValue,
  operator: singleValue ? { type, operation, singleValue } : { type, operation },
});
const ifNode = (conditions: unknown[], combinator = 'and', caseSensitive = true) =>
  fakeNode('n8n-nodes-base.if', { conditions: filter(conditions, combinator, caseSensitive), options: {} }, 2.2);

describe('ifPasses', () => {
  it('compares strings with equals, notEmpty and regex', () => {
    const scope = { json: { s: 'Abc', empty: '' } };
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'equals', 'Abc')]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'equals', 'abc')]), scope)).toBe(false);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'notEmpty', '', true)]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.empty }}', 'string', 'notEmpty', '', true)]), scope)).toBe(false);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'regex', '^[A-Z]bc$')]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'regex', '/^abc$/i')]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'regex', '^abc$')]), scope)).toBe(false);
  });

  it('lowercases both sides of equals when the filter is case-insensitive, but never a regex', () => {
    const scope = { json: { s: 'SALES' } };
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'equals', 'Sales')], 'and', false), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.s }}', 'string', 'regex', '^[A-Z]+$')], 'and', false), scope)).toBe(false);
  });

  it('treats a missing left value as the empty string, without failing', () => {
    const scope = { json: {} };
    expect(ifPasses(ifNode([cond('={{ $json.nope }}', 'string', 'equals', 'x')]), scope)).toBe(false);
    expect(ifPasses(ifNode([cond('={{ $json.a.b.c }}', 'string', 'regex', '^$')]), scope)).toBe(true);
  });

  it('fails the node on a value of the wrong type, because the filters are strict', () => {
    const scope = { json: { n: 5, s: '5', list: ['a'] } };
    expect(() => ifPasses(ifNode([cond('={{ $json.n }}', 'string', 'equals', '5')]), scope)).toThrow(NodeFailure);
    expect(() => ifPasses(ifNode([cond('={{ $json.list }}', 'string', 'equals', 'a')]), scope)).toThrow(NodeFailure);
    expect(() => ifPasses(ifNode([cond('={{ $json.s }}', 'number', 'gt', 0)]), scope)).toThrow(NodeFailure);
    expect(() => ifPasses(ifNode([cond('={{ $json.s }}', 'boolean', 'true', '', true)]), scope)).toThrow(NodeFailure);
  });

  it('compares numbers with gt and booleans with true', () => {
    const scope = { json: { n: 5, yes: true, no: false } };
    expect(ifPasses(ifNode([cond('={{ $json.n }}', 'number', 'gt', 4)]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.n }}', 'number', 'gt', 5)]), scope)).toBe(false);
    expect(ifPasses(ifNode([cond('={{ $json.yes }}', 'boolean', 'true', '', true)]), scope)).toBe(true);
    expect(ifPasses(ifNode([cond('={{ $json.no }}', 'boolean', 'true', '', true)]), scope)).toBe(false);
    expect(ifPasses(ifNode([cond('={{ $json.nope }}', 'boolean', 'true', '', true)]), scope)).toBe(false);
  });

  it('combines conditions with and / or, stopping at the first that decides', () => {
    const scope = { json: { a: 'x', n: 1 } };
    const yes = cond('={{ $json.a }}', 'string', 'equals', 'x');
    const no = cond('={{ $json.a }}', 'string', 'equals', 'y');
    const wrongType = cond('={{ $json.n }}', 'string', 'equals', '1');
    expect(ifPasses(ifNode([yes, no]), scope)).toBe(false);
    expect(ifPasses(ifNode([yes, no], 'or'), scope)).toBe(true);
    expect(ifPasses(ifNode([no, wrongType]), scope)).toBe(false);
    expect(() => ifPasses(ifNode([yes, wrongType]), scope)).toThrow(NodeFailure);
  });

  it('refuses operators, combinators and validation modes it does not emulate', () => {
    const scope = { json: { a: 'x' } };
    expect(() => ifPasses(ifNode([cond('={{ $json.a }}', 'string', 'contains', 'x')]), scope)).toThrow(NotEmulated);
    expect(() => ifPasses(ifNode([cond('={{ $json.a }}', 'string', 'equals', 'x')], 'xor'), scope)).toThrow(NotEmulated);
    const loose = fakeNode('n8n-nodes-base.if', {
      conditions: { ...filter([cond('x', 'string', 'equals', 'x')]), options: { caseSensitive: true, typeValidation: 'loose', version: 2 } },
    });
    expect(() => ifPasses(loose, scope)).toThrow(NotEmulated);
    expect(() => ifPasses(fakeNode('n8n-nodes-base.set', {}), scope)).toThrow(/not a n8n-nodes-base.if/);
  });
});

describe('switchOutput', () => {
  const rule = (value: string) => ({ conditions: filter([cond('={{ $json.c }}', 'string', 'equals', value)]) });
  const node = (options: Record<string, unknown>) =>
    fakeNode('n8n-nodes-base.switch', { mode: 'rules', rules: { values: [rule('a'), rule('b')] }, options }, 3.2);

  it('returns the first matching rule, the fallback output, or undefined when the item is dropped', () => {
    expect(switchOutput(node({}), { json: { c: 'b' } })).toBe(1);
    expect(switchOutput(node({ fallbackOutput: 1 }), { json: { c: 'z' } })).toBe(1);
    expect(switchOutput(node({}), { json: { c: 'z' } })).toBeUndefined();
    expect(switchOutput(node({ fallbackOutput: 'none' }), { json: { c: 'z' } })).toBeUndefined();
    expect(() => switchOutput(node({ fallbackOutput: 'extra' }), { json: { c: 'z' } })).toThrow(NotEmulated);
  });
});

describe('applySet', () => {
  const set = (assignments: unknown[], extra: Record<string, unknown> = {}) =>
    fakeNode('n8n-nodes-base.set', { assignments: { assignments }, options: {}, ...extra }, 3.4);
  const field = (name: string, value: unknown, type = 'string') => ({ id: name, name, value, type });

  it('keeps only the assigned fields and converts them to the field type', () => {
    const scope = { json: { n: 12, s: '3.5', o: { a: 1 }, other: 'dropped' } };
    const node = set([
      field('asString', '={{ $json.n }}'),
      field('object', '={{ $json.o }}'),
      field('fixed', 'text'),
      field('number', '={{ $json.n }}', 'number'),
      field('parsed', '={{ $json.s }}', 'number'),
      field('missing', '={{ $json.nope }}'),
      field('deepMissing', '={{ $json.a.b.c }}', 'number'),
    ]);
    expect(applySet(node, scope)).toEqual({
      asString: '12',
      object: '{"a":1}',
      fixed: 'text',
      number: 12,
      parsed: 3.5,
      missing: null,
      deepMissing: null,
    });
  });

  it('fails on a number field that is not numeric', () => {
    for (const json of [{ v: 'abc' }, { v: '' }, { v: {} }]) {
      expect(() => applySet(set([field('amount', '={{ $json.v }}', 'number')]), { json })).toThrow(NodeFailure);
    }
  });

  it('refuses what it does not emulate', () => {
    expect(() => applySet(set([field('a', 'x')], { includeOtherFields: true }), { json: {} })).toThrow(NotEmulated);
    expect(() => applySet(set([field('a', 'x', 'boolean')]), { json: {} })).toThrow(NotEmulated);
    expect(() => applySet({ ...set([field('a', 'x')]), typeVersion: 3.3 }, { json: {} })).toThrow(NotEmulated);
  });
});

describe('dedupeKey and DedupeHistory', () => {
  const dedupe = (dedupeValue: string, extra: Record<string, unknown> = {}) =>
    fakeNode(
      'n8n-nodes-base.removeDuplicates',
      { operation: 'removeItemsSeenInPreviousExecutions', logic: 'removeItemsWithAlreadySeenKeyValues', dedupeValue, options: {}, ...extra },
      2,
    );

  it('turns the dedupe value into a string key, and a missing value into the empty key', () => {
    expect(dedupeKey(dedupe('={{ $json.id }}'), { json: { id: 123 } })).toBe('123');
    expect(dedupeKey(dedupe('={{ $json.id }}:{{ $json.status }}'), { json: { id: 1, status: 'approved' } })).toBe('1:approved');
    expect(dedupeKey(dedupe('={{ $json.id }}'), { json: {} })).toBe('');
    expect(dedupeKey(dedupe('={{ $json.a.b }}'), { json: {} })).toBe('');
  });

  it('refuses other operations', () => {
    expect(() => dedupeKey(dedupe('x', { operation: 'removeDuplicateInputItems' }), { json: {} })).toThrow(NotEmulated);
    expect(() => dedupeKey(dedupe('x', { options: { scope: 'workflow' } }), { json: {} })).toThrow(NotEmulated);
  });

  it('drops a key seen in an earlier execution', () => {
    const history = new DedupeHistory();
    expect(history.execute(['a'])).toEqual([true]);
    expect(history.execute(['a'])).toEqual([false]);
    expect(history.execute(['b', 'a'])).toEqual([true, false]);
  });

  it('lets every item through when a new key repeats inside one execution, as n8n does', () => {
    const history = new DedupeHistory();
    expect(history.execute(['a', 'a', 'b'])).toEqual([true, true, true]);
    expect(history.execute(['a', 'a'])).toEqual([false, false]);
  });

  it('fails instead of evicting once the history is full', () => {
    const history = new DedupeHistory(3);
    expect(history.execute(['a', 'b'])).toEqual([true, true]);
    expect(history.execute(['c'])).toEqual([true]);
    expect(() => history.execute(['d'])).toThrow(/maximum history size/);
    // A repeat fails too: the check counts incoming items, not new keys.
    expect(() => history.execute(['a'])).toThrow(NodeFailure);
    expect(history.size).toBe(3);
  });
});

describe('jsonBody', () => {
  const http = (body: string) => fakeNode('n8n-nodes-base.httpRequest', { specifyBody: 'json', jsonBody: body }, 4.2);

  it('renders and parses the body, with quotes and line breaks intact', () => {
    const node = http('={{ JSON.stringify({ text: $json.t, n: 1 }) }}');
    expect(jsonBody(node, { json: { t: 'a "quoted"\nline' } })).toEqual({ text: 'a "quoted"\nline', n: 1 });
  });

  it('fails on a body that is not valid JSON once rendered', () => {
    expect(() => jsonBody(http('={"text": "{{ $json.t }}"}'), { json: { t: 'a "quote"' } })).toThrow(SyntaxError);
    expect(() => jsonBody(http('={{ $json.nope.x }}'), { json: {} })).toThrow(NodeFailure);
  });
});
