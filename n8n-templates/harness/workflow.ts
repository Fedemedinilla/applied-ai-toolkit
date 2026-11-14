// Loads the workflow files in ../templates and answers questions about their
// graph. Shared by the per-workflow tests, the structural tests and the script
// that writes the README tables and the diagrams.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const ROOT = join(import.meta.dirname, '..');
export const TEMPLATES_DIR = join(ROOT, 'templates');

const nodeSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  typeVersion: z.number(),
  position: z.tuple([z.number(), z.number()]),
  parameters: z.record(z.string(), z.unknown()),
});

const connectionSchema = z.object({ node: z.string(), type: z.string(), index: z.number().int().min(0) });

const workflowSchema = z.looseObject({
  name: z.string().min(1),
  nodes: z.array(nodeSchema).min(1),
  connections: z.record(z.string(), z.record(z.string(), z.array(z.array(connectionSchema)))),
  active: z.literal(false),
  settings: z.looseObject({ executionOrder: z.literal('v1') }),
});

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;

export interface Template {
  /** File name inside templates/, for example `lead-capture-to-google-sheets.json`. */
  file: string;
  /** File name without `.json`. Test files and diagrams use the same base name. */
  base: string;
  raw: unknown;
  workflow: Workflow;
}

export const STICKY = 'n8n-nodes-base.stickyNote';
export const WEBHOOK = 'n8n-nodes-base.webhook';
export const CODE = 'n8n-nodes-base.code';

/** Node types that write, send, call out or cost money. A noOp, If, Set or Code node is not one. */
export const SIDE_EFFECT_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.googleSheets',
  'n8n-nodes-base.telegram',
  '@n8n/n8n-nodes-langchain.chainLlm',
]);

export function templateFiles(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

export function loadTemplate(file: string): Template {
  const raw: unknown = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8'));
  return { file, base: file.replace(/\.json$/, ''), raw, workflow: workflowSchema.parse(raw) };
}

export function loadTemplates(): Template[] {
  return templateFiles().map(loadTemplate);
}

/** The node with this name. Throws when it is missing, so a rename fails the test that names it. */
export function nodeNamed(workflow: Workflow, name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node "${name}" in "${workflow.name}"`);
  return found;
}

/** A string parameter of a node. Throws when it is missing or not a string. */
export function stringParam(node: WorkflowNode, key: string): string {
  const value = node.parameters[key];
  if (typeof value !== 'string') throw new Error(`node "${node.name}" has no string parameter "${key}"`);
  return value;
}

export function workingNodes(workflow: Workflow): WorkflowNode[] {
  return workflow.nodes.filter((n) => n.type !== STICKY);
}

export function codeNodes(workflow: Workflow): WorkflowNode[] {
  return workflow.nodes.filter((n) => n.type === CODE);
}

/** Names of the nodes wired to one main output of `from`. */
export function mainTargets(workflow: Workflow, from: string, output = 0): string[] {
  return (workflow.connections[from]?.main?.[output] ?? []).map((t) => t.node);
}

/**
 * Nodes reachable from `start` over main connections. `cut` removes edges:
 * return true for an output of a node that the walk must not follow.
 */
export function reachable(
  workflow: Workflow,
  start: string,
  cut: (from: string, output: number) => boolean = () => false,
): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let from = queue.shift(); from !== undefined; from = queue.shift()) {
    const current = from;
    (workflow.connections[current]?.main ?? []).forEach((targets, output) => {
      if (cut(current, output)) return;
      for (const { node } of targets) {
        if (!seen.has(node)) {
          seen.add(node);
          queue.push(node);
        }
      }
    });
  }
  return seen;
}

/** Side-effect nodes reachable from `start`, with the same `cut` rule as `reachable`. */
export function reachableSideEffects(
  workflow: Workflow,
  start: string,
  cut: (from: string, output: number) => boolean = () => false,
): string[] {
  return [...reachable(workflow, start, cut)].filter(
    (name) => name !== start && SIDE_EFFECT_TYPES.has(nodeNamed(workflow, name).type),
  );
}

/** Every string in a JSON value, with the key path that leads to it. */
export function strings(value: unknown, path: string[] = []): { path: string[]; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, String(i)]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  }
  return [];
}
