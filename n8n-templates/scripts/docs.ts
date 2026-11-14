// Writes everything in this folder's docs that is derived from the workflow
// files: the two generated tables in README.md and one Mermaid diagram per
// workflow under diagrams/. The output depends only on the JSON files, so
// test/docs.test.ts can fail when a table or a diagram is out of date.
//
//   node n8n-templates/scripts/docs.ts          rewrite README.md and diagrams/
//
// Offline: it reads templates/ and writes inside this folder, nothing else.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, STICKY, type Template, type WorkflowNode, codeNodes, loadTemplates, workingNodes } from '../harness/workflow.ts';

export const README_PATH = join(ROOT, 'README.md');
export const DIAGRAMS_DIR = join(ROOT, 'diagrams');

const SERVICE_BY_TYPE: Readonly<Record<string, string>> = {
  'n8n-nodes-base.googleSheets': 'Google Sheets',
  'n8n-nodes-base.gmail': 'Gmail',
  'n8n-nodes-base.gmailTrigger': 'Gmail',
  'n8n-nodes-base.telegram': 'Telegram',
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': 'Anthropic API',
};

const SERVICE_BY_HOST: Readonly<Record<string, string>> = {
  'api.mercadopago.com': 'MercadoPago API',
  'api.tiendanube.com': 'Tiendanube API',
  'graph.facebook.com': 'WhatsApp Cloud API',
  'api.hubapi.com': 'HubSpot API',
  'hooks.slack.com': 'Slack incoming webhook',
};

function httpService(node: WorkflowNode): string {
  const url = String(node.parameters.url).replace(/^=/, '').replace(/\{\{.*$/s, '');
  const host = new URL(url).hostname;
  if (host.endsWith('.example')) return 'your own API (placeholder host)';
  const service = Object.hasOwn(SERVICE_BY_HOST, host) ? SERVICE_BY_HOST[host] : undefined;
  if (!service) throw new Error(`"${node.name}" calls ${host}: add it to SERVICE_BY_HOST in scripts/docs.ts`);
  return service;
}

/** External services a workflow calls, in node order, without repeats. */
export function services(template: Template): string[] {
  const found: string[] = [];
  for (const node of workingNodes(template.workflow)) {
    const service =
      node.type === 'n8n-nodes-base.httpRequest'
        ? httpService(node)
        : Object.hasOwn(SERVICE_BY_TYPE, node.type)
          ? SERVICE_BY_TYPE[node.type]
          : undefined;
    if (service && !found.includes(service)) found.push(service);
  }
  return found;
}

/** How a workflow starts, one entry per trigger node. */
export function triggers(template: Template): string[] {
  const found: string[] = [];
  for (const node of workingNodes(template.workflow)) {
    if (node.type === 'n8n-nodes-base.webhook') {
      found.push(`\`${String(node.parameters.httpMethod)} /${String(node.parameters.path)}\``);
    } else if (node.type === 'n8n-nodes-base.gmailTrigger') {
      found.push('Gmail Trigger (polling)');
    } else if (node.type === 'n8n-nodes-base.scheduleTrigger') {
      found.push('Schedule Trigger');
    } else if (/trigger/i.test(node.type)) {
      throw new Error(`"${node.name}" is a trigger scripts/docs.ts does not describe: ${node.type}`);
    }
  }
  return found;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** The README table with one row per workflow. */
export function workflowTable(templates: Template[]): string {
  const rows = templates.map((t) => {
    const code = codeNodes(t.workflow).map((n) => n.name);
    return [
      `\`${t.file}\``,
      t.workflow.name,
      triggers(t).join(', '),
      services(t).join(', '),
      code.length > 0 ? code.join(', ') : 'none',
      `[\`test/${t.base}.test.ts\`](test/${t.base}.test.ts)`,
      `[diagram](diagrams/${t.base}.md)`,
    ]
      .map(cell)
      .join(' | ');
  });
  return [
    '| Workflow file | What it does | Trigger | External services | Code nodes | Test file | Graph |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

/** The README table of node types with the typeVersion the files pin. */
export function versionTable(templates: Template[]): string {
  const byType = new Map<string, { versions: Set<number>; files: Set<string> }>();
  for (const t of templates) {
    for (const node of t.workflow.nodes) {
      const entry = byType.get(node.type) ?? { versions: new Set<number>(), files: new Set<string>() };
      entry.versions.add(node.typeVersion);
      entry.files.add(t.file);
      byType.set(node.type, entry);
    }
  }
  const rows = [...byType.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, { versions, files }]) => {
      const list = [...versions].sort((a, b) => a - b).join(', ');
      return `| \`${type}\` | ${list} | ${files.size} |`;
    });
  return ['| Node type | typeVersion | Workflows that use it |', '|---|---|---|', ...rows].join('\n');
}

const label = (text: string): string => `"${text.replace(/"/g, '#quot;')}"`;

function shape(node: WorkflowNode, id: string): string {
  if (/trigger|webhook$/i.test(node.type)) return `${id}([${label(node.name)}])`;
  if (node.type === 'n8n-nodes-base.if' || node.type === 'n8n-nodes-base.switch') return `${id}{${label(node.name)}}`;
  return `${id}[${label(node.name)}]`;
}

function outputLabel(node: WorkflowNode, output: number): string | undefined {
  if (node.type === 'n8n-nodes-base.if') return output === 0 ? 'true' : 'false';
  if (node.type === 'n8n-nodes-base.switch') {
    const rules = (node.parameters.rules as { values?: { outputKey?: string }[] } | undefined)?.values ?? [];
    return rules[output]?.outputKey ?? `output ${output}`;
  }
  return undefined;
}

const AI_LABELS: Readonly<Record<string, string>> = { ai_languageModel: 'model', ai_outputParser: 'output parser' };

/** The Markdown file with the Mermaid graph of one workflow: nodes in file order, then edges. */
export function diagram(template: Template): string {
  const nodes = template.workflow.nodes.filter((n) => n.type !== STICKY);
  const ids = new Map(nodes.map((n, i) => [n.name, `n${i}`]));
  const idOf = (name: string): string => {
    const id = ids.get(name);
    if (!id) throw new Error(`${template.file}: connection names "${name}", which is not a working node`);
    return id;
  };
  const lines = ['flowchart LR', ...nodes.map((n) => `  ${shape(n, idOf(n.name))}`)];
  for (const node of nodes) {
    const byType = template.workflow.connections[node.name] ?? {};
    for (const type of Object.keys(byType).sort()) {
      (byType[type] ?? []).forEach((targets, output) => {
        for (const target of targets) {
          const from = idOf(node.name);
          const to = idOf(target.node);
          if (type === 'main') {
            const text = outputLabel(node, output);
            lines.push(text === undefined ? `  ${from} --> ${to}` : `  ${from} -- ${text} --> ${to}`);
          } else {
            lines.push(`  ${from} -. ${AI_LABELS[type] ?? type} .-> ${to}`);
          }
        }
      });
    }
  }
  return [
    `# ${template.workflow.name}`,
    '',
    `Graph of \`templates/${template.file}\`, written by \`scripts/docs.ts\`. Do not edit it by hand.`,
    '',
    '```mermaid',
    ...lines,
    '```',
    '',
  ].join('\n');
}

export const BLOCKS = ['workflows', 'versions'] as const;
export type Block = (typeof BLOCKS)[number];

export function block(name: Block, templates: Template[]): string {
  return name === 'workflows' ? workflowTable(templates) : versionTable(templates);
}

const markers = (name: Block): [string, string] => [`<!-- generated:${name} -->`, `<!-- /generated:${name} -->`];

/** The text between the markers of a generated block, or undefined when the markers are missing. */
export function readBlock(readme: string, name: Block): string | undefined {
  const [open, close] = markers(name);
  const start = readme.indexOf(open);
  const end = readme.indexOf(close);
  if (start === -1 || end === -1 || end < start) return undefined;
  return readme.slice(start + open.length, end).trim();
}

function writeBlock(readme: string, name: Block, content: string): string {
  const [open, close] = markers(name);
  const start = readme.indexOf(open);
  const end = readme.indexOf(close);
  if (start === -1 || end === -1 || end < start) throw new Error(`README.md has no ${open} ... ${close} block`);
  return `${readme.slice(0, start)}${open}\n${content}\n${readme.slice(end)}`;
}

function main(): void {
  const templates = loadTemplates();
  let readme = readFileSync(README_PATH, 'utf8');
  for (const name of BLOCKS) readme = writeBlock(readme, name, block(name, templates));
  writeFileSync(README_PATH, readme);

  mkdirSync(DIAGRAMS_DIR, { recursive: true });
  const wanted = new Set(templates.map((t) => `${t.base}.md`));
  for (const file of readdirSync(DIAGRAMS_DIR)) {
    if (!wanted.has(file)) rmSync(join(DIAGRAMS_DIR, file));
  }
  for (const t of templates) writeFileSync(join(DIAGRAMS_DIR, `${t.base}.md`), diagram(t));
  console.log(`README.md: ${BLOCKS.length} tables. diagrams/: ${templates.length} files.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
