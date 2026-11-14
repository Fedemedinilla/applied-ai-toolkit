// Small ports of the n8n nodes whose behavior decides what a template does
// with an item: If and Switch (filter conditions), Edit Fields (Set), Remove
// Duplicates across executions, and HTTP Request JSON bodies. Each port covers
// only the options the templates use and throws on anything else, so a new
// operator fails a test instead of being silently treated as "false".
//
// Read from the published sources of n8n-workflow 2.15.0 (filter-parameter.js,
// type-validation.js), n8n-nodes-base 2.15.1 (Set v3.4, RemoveDuplicates v2)
// and n8n 2.15.0 (deduplication-helper.js). Not checked against a running n8n.

import { z } from 'zod';
import { type Scope, evaluate } from './expressions.ts';
import type { WorkflowNode } from './workflow.ts';

/** The node failed, as it would in n8n (a wrong type in a strict filter, a bad number in Set). */
export class NodeFailure extends Error {
  override name = 'NodeFailure';
}

/** The template uses something these ports do not cover. */
export class NotEmulated extends Error {
  override name = 'NotEmulated';
}

const conditionSchema = z.looseObject({
  leftValue: z.unknown(),
  rightValue: z.unknown(),
  operator: z.looseObject({ type: z.string(), operation: z.string() }),
});

const filterSchema = z.looseObject({
  options: z.looseObject({
    caseSensitive: z.boolean(),
    typeValidation: z.string(),
    version: z.number(),
  }),
  conditions: z.array(conditionSchema).min(1),
  combinator: z.string(),
});

type Filter = z.infer<typeof filterSchema>;

function parseRegexPattern(pattern: string): RegExp {
  const match = pattern.match(/^\/(.*?)\/([gimusy]*)$/);
  return match ? new RegExp(match[1] ?? '', match[2] ?? '') : new RegExp(pattern);
}

function conditionPasses(condition: Filter['conditions'][number], filter: Filter, scope: Scope): boolean {
  const { type, operation } = condition.operator;
  let left = evaluate(condition.leftValue, scope);
  let right = evaluate(condition.rightValue, scope);
  const single = condition.operator.singleValue === true;

  // Strict validation: null and undefined pass, any other value must have the operator's type.
  for (const [side, value] of [
    ['first', left],
    ['second', single ? undefined : right],
  ] as const) {
    if (value === null || value === undefined) continue;
    if (typeof value !== type) {
      throw new NodeFailure(`Wrong type: the ${side} value '${String(value)}' is a ${typeof value}, not a ${type}`);
    }
  }

  if (type === 'string') {
    if (!filter.options.caseSensitive) {
      if (typeof left === 'string') left = left.toLocaleLowerCase();
      if (typeof right === 'string' && operation !== 'regex') right = right.toLocaleLowerCase();
    }
    const l = (left ?? '') as string;
    const r = (right ?? '') as string;
    if (operation === 'equals') return l === r;
    if (operation === 'notEmpty') return l.length !== 0;
    if (operation === 'regex') return parseRegexPattern(r).test(l);
  }
  if (type === 'number' && operation === 'gt') return (left as number) > (right as number);
  if (type === 'boolean' && operation === 'true') return left === true;
  throw new NotEmulated(`filter operator ${type}:${operation}`);
}

function filterPasses(value: unknown, scope: Scope): boolean {
  const filter = filterSchema.parse(value);
  if (filter.options.typeValidation !== 'strict' || filter.options.version !== 2) {
    throw new NotEmulated('only strict filters of version 2 are emulated');
  }
  // Array.every and Array.some stop at the first deciding condition, as n8n does.
  if (filter.combinator === 'and') return filter.conditions.every((c) => conditionPasses(c, filter, scope));
  if (filter.combinator === 'or') return filter.conditions.some((c) => conditionPasses(c, filter, scope));
  throw new NotEmulated(`filter combinator ${filter.combinator}`);
}

function expectType(node: WorkflowNode, type: string): void {
  if (node.type !== type) throw new Error(`"${node.name}" is a ${node.type}, not a ${type}`);
}

/** If node: true when the item leaves through output 0 (true), false for output 1. */
export function ifPasses(node: WorkflowNode, scope: Scope): boolean {
  expectType(node, 'n8n-nodes-base.if');
  return filterPasses(node.parameters.conditions, scope);
}

const switchSchema = z.looseObject({
  mode: z.literal('rules'),
  rules: z.looseObject({ values: z.array(z.looseObject({ conditions: z.unknown() })).min(1) }),
  options: z.looseObject({ fallbackOutput: z.unknown().optional(), allMatchingOutputs: z.boolean().optional() }),
});

/** Switch node in rules mode: index of the output the item leaves through, or undefined when it is dropped. */
export function switchOutput(node: WorkflowNode, scope: Scope): number | undefined {
  expectType(node, 'n8n-nodes-base.switch');
  const params = switchSchema.parse(node.parameters);
  if (params.options.allMatchingOutputs === true) throw new NotEmulated('Switch with allMatchingOutputs');
  const index = params.rules.values.findIndex((rule) => filterPasses(rule.conditions, scope));
  if (index !== -1) return index;
  const fallback = params.options.fallbackOutput;
  if (fallback === undefined || fallback === 'none') return undefined;
  if (typeof fallback === 'number') return fallback;
  throw new NotEmulated(`Switch fallbackOutput ${String(fallback)}`);
}

const setSchema = z.looseObject({
  assignments: z.object({
    assignments: z.array(z.looseObject({ name: z.string().min(1), value: z.unknown(), type: z.string() })).min(1),
  }),
  options: z.record(z.string(), z.unknown()),
});

/**
 * Edit Fields (Set) v3.4 in manual mode without "include other fields": the
 * json of the output item. undefined and null become null; a string field
 * turns objects into JSON and everything else into String(value); a number
 * field accepts numbers and numeric strings and fails on anything else.
 */
export function applySet(node: WorkflowNode, scope: Scope): Record<string, unknown> {
  expectType(node, 'n8n-nodes-base.set');
  const params = setSchema.parse(node.parameters);
  if (node.typeVersion !== 3.4) throw new NotEmulated(`Set v${node.typeVersion}`);
  if (Object.keys(params.options).length > 0 || 'includeOtherFields' in params || 'mode' in params) {
    throw new NotEmulated('Set options, raw mode and includeOtherFields');
  }
  const out: Record<string, unknown> = {};
  for (const { name, value, type } of params.assignments.assignments) {
    const resolved = evaluate(value, scope);
    if (resolved === undefined || resolved === null) {
      out[name] = null;
    } else if (type === 'string') {
      out[name] = typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    } else if (type === 'number') {
      const parsed = typeof resolved === 'number' ? resolved : typeof resolved === 'string' ? Number(resolved) : NaN;
      if (Number.isNaN(parsed) || (typeof resolved === 'string' && resolved.trim() === '')) {
        throw new NodeFailure(`'${name}' expects a number but we got '${String(resolved)}'`);
      }
      out[name] = parsed;
    } else {
      throw new NotEmulated(`Set field type ${type}`);
    }
  }
  return out;
}

/** The key Remove Duplicates stores for an item: the dedupe value as a string, "" when it is missing. */
export function dedupeKey(node: WorkflowNode, scope: Scope): string {
  expectType(node, 'n8n-nodes-base.removeDuplicates');
  const p = node.parameters;
  if (p.operation !== 'removeItemsSeenInPreviousExecutions' || p.logic !== 'removeItemsWithAlreadySeenKeyValues') {
    throw new NotEmulated('only "remove items seen in previous executions" by key value is emulated');
  }
  if (Object.keys((p.options ?? {}) as object).length > 0) throw new NotEmulated('Remove Duplicates options');
  const value = evaluate(p.dedupeValue, scope);
  return value === undefined || value === null ? '' : String(value);
}

/**
 * The history one Remove Duplicates node keeps across executions, with the
 * three behaviors of n8n 2.15 that matter to a template:
 *
 * - A key seen in an earlier execution is dropped.
 * - Items that share a new key inside one execution ALL pass: the node groups
 *   the items by key and lets the whole group through.
 * - The node fails once the stored keys plus the incoming items exceed the
 *   history size (10,000 by default). It does not evict old keys to make room.
 */
export class DedupeHistory {
  readonly #seen = new Set<string>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** One execution: which of these items, given by key, leave the node. */
  execute(keys: string[]): boolean[] {
    if (this.#seen.size + keys.length > this.#maxEntries) {
      throw new NodeFailure('The number of items to be processed exceeds the maximum history size');
    }
    const fresh = new Set(keys.filter((key) => !this.#seen.has(key)));
    for (const key of fresh) this.#seen.add(key);
    return keys.map((key) => fresh.has(key));
  }
}

/** The JSON body an HTTP Request node sends, parsed. Fails when the parameter does not render to valid JSON. */
export function jsonBody(node: WorkflowNode, scope: Scope): unknown {
  expectType(node, 'n8n-nodes-base.httpRequest');
  if (node.parameters.specifyBody !== 'json') throw new NotEmulated('only specifyBody "json"');
  const rendered = evaluate(node.parameters.jsonBody, scope);
  if (typeof rendered !== 'string') throw new NodeFailure(`"${node.name}" body did not render to a string`);
  return JSON.parse(rendered) as unknown;
}
