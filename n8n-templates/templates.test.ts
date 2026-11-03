// Static checks for the n8n workflow templates in ./templates.
//
// n8n does not validate an imported workflow beyond parsing it: a connection to
// a renamed node, an expression that names a node that no longer exists, or a
// pasted token all import fine and fail later, at run time or in public.
// These tests catch those before a template is published. They run offline and
// need no n8n instance.

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const DIR = join(import.meta.dirname, 'templates');
const README = readFileSync(join(import.meta.dirname, 'README.md'), 'utf8');

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

type Workflow = z.infer<typeof workflowSchema>;
type WorkflowNode = z.infer<typeof nodeSchema>;

interface Template {
  file: string;
  raw: unknown;
  workflow: Workflow;
}

const templates: Template[] = readdirSync(DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    return { file, raw, workflow: workflowSchema.parse(raw) };
  });

const STICKY = 'n8n-nodes-base.stickyNote';
const SIDE_EFFECT_TYPES = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.googleSheets',
  'n8n-nodes-base.telegram',
]);

/** Every string in a JSON value, with the key path that leads to it. */
function strings(value: unknown, path: string[] = []): { path: string[]; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, String(i)]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  }
  return [];
}

/** Every key anywhere in a JSON value. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
  }
  return [];
}

/** Node names referenced as $('Name'), $node["Name"] or $items('Name'). */
function referencedNodes(text: string): string[] {
  const patterns = [
    /\$\(\s*(['"])(.+?)\1\s*\)/g,
    /\$node\[\s*(['"])(.+?)\1\s*\]/g,
    /\$items\(\s*(['"])(.+?)\1/g,
  ];
  return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[2] ?? ''));
}

/** Inner text of each {{ ... }} block in an n8n expression string. */
function expressionBlocks(text: string): string[] {
  if (!text.startsWith('=')) return [];
  return text
    .split('{{')
    .slice(1)
    .map((part) => part.split('}}')[0] ?? '');
}

function balanced(code: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Nodes reachable from `start` over main connections, skipping the edges in `cut`. */
function reachable(workflow: Workflow, start: string, cut: (from: string, output: number) => boolean): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.shift() as string;
    (workflow.connections[from]?.main ?? []).forEach((targets, output) => {
      if (cut(from, output)) return;
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

const nodeByName = (workflow: Workflow, name: string): WorkflowNode | undefined =>
  workflow.nodes.find((n) => n.name === name);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_PATTERNS: [string, RegExp][] = [
  ['API key (sk-...)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook with ids', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{30,}/],
  ['long hex token', /\b[0-9a-f]{32,}\b/i],
  ['long base64 token', /[A-Za-z0-9+/_-]{40,}={0,2}/],
  // Not inside identifiers such as model ids (claude-haiku-4-5-20251001).
  ['phone number', /(?<![\w-])\+?\d[\d -]{9,}\d(?![\w-])/],
];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

// Hosts a template may call. Anything else must be an .example placeholder.
const ALLOWED_HOSTS = new Set([
  'api.mercadopago.com',
  'api.tiendanube.com',
  'graph.facebook.com',
  'api.hubapi.com',
  'hooks.slack.com',
  'api.telegram.org',
]);

// Words that only show up in Spanish text, matched as whole words.
const SPANISH_WORDS =
  /\b(de|del|para|con|los|las|una|que|por|hola|gracias|mensaje|pago|factura|pedido|cliente|nombre|correo)\b/i;

// Nodes that write to a customer or to another company's system. A retry after a
// timeout the provider already accepted would send or create the same thing twice.
const NO_RETRY_NODES = [
  'Confirm on WhatsApp',
  'WhatsApp to customer',
  'Create contact in HubSpot',
  'Send welcome email',
  'Ask for review (email)',
  'Send receipt',
  'Issue invoice (AFIP)',
];

interface CodeItem {
  json: Record<string, unknown>;
}

/**
 * Runs the JavaScript of an n8n Code node ("Run Once for All Items") with the
 * parts of the sandbox these templates use: $input, require and Buffer.
 */
const nodeRequire = createRequire(import.meta.url);
function runCode(code: string, items: CodeItem[]): CodeItem[] {
  const $input = { first: () => items[0], all: () => items };
  const fn = new Function('$input', 'require', 'Buffer', code) as (...args: unknown[]) => CodeItem[];
  return fn($input, nodeRequire, Buffer);
}

const codeOf = (workflow: Workflow, name: string): string => {
  const code = nodeByName(workflow, name)?.parameters.jsCode;
  if (typeof code !== 'string') throw new Error(`no Code node "${name}"`);
  return code;
};

describe('template set', () => {
  it('has the 13 published templates', () => {
    expect(templates).toHaveLength(13);
  });

  it('uses a different webhook path in every template, so all can be active on one instance', () => {
    const paths = templates.flatMap(({ workflow }) =>
      workflow.nodes
        .filter((n) => n.type === 'n8n-nodes-base.webhook')
        .map((n) => `${String(n.parameters.httpMethod)} ${String(n.parameters.path)}`),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('lists every template file in the README', () => {
    for (const { file } of templates) expect(README).toContain(file);
  });
});

describe.each(templates)('$file', ({ file, raw, workflow }) => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const working = workflow.nodes.filter((n) => n.type !== STICKY);
  const allStrings = strings(raw);

  it('has a kebab-case English file name', () => {
    expect(file).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.json$/);
  });

  it('has unique node names and ids', () => {
    expect(names.size).toBe(workflow.nodes.length);
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(workflow.nodes.length);
  });

  it('has a trigger and connects every working node', () => {
    expect(working.some((n) => /trigger|webhook/i.test(n.type))).toBe(true);
    const connected = new Set<string>();
    for (const [from, byType] of Object.entries(workflow.connections)) {
      connected.add(from);
      for (const outputs of Object.values(byType)) for (const t of outputs.flat()) connected.add(t.node);
    }
    for (const node of working) expect(connected, `${node.name} is not connected`).toContain(node.name);
  });

  it('only connects nodes that exist, with matching connection types', () => {
    for (const [from, byType] of Object.entries(workflow.connections)) {
      expect(names, `connection from missing node "${from}"`).toContain(from);
      for (const [type, outputs] of Object.entries(byType)) {
        for (const target of outputs.flat()) {
          expect(names, `connection to missing node "${target.node}"`).toContain(target.node);
          expect(target.type).toBe(type);
        }
      }
    }
  });

  it('only references existing nodes in expressions and code', () => {
    for (const { path, value } of allStrings) {
      for (const ref of referencedNodes(value)) {
        expect(names, `${path.join('.')} references "${ref}"`).toContain(ref);
      }
    }
  });

  it('has balanced brackets inside every {{ }} expression block', () => {
    for (const { path, value } of allStrings) {
      for (const block of expressionBlocks(value)) {
        expect(balanced(block), `${path.join('.')}: ${block.slice(0, 60)}`).toBe(true);
      }
    }
  });

  it('carries no credentials, webhook ids, instance id or pinned data', () => {
    const allKeys = new Set(keys(raw));
    for (const key of ['credentials', 'webhookId', 'instanceId', 'meta', 'apiKey']) {
      expect(allKeys, `found key "${key}"`).not.toContain(key);
    }
    expect((raw as { pinData?: unknown }).pinData ?? {}).toEqual({});
  });

  it('contains no secret-like strings, phone numbers or real email addresses', () => {
    for (const { path, value } of allStrings) {
      if (UUID.test(value)) continue;
      for (const [label, re] of SECRET_PATTERNS) {
        expect(re.test(value), `${label} in ${path.join('.')}: ${value.slice(0, 80)}`).toBe(false);
      }
      for (const match of value.matchAll(EMAIL)) {
        expect(match[0], `email in ${path.join('.')}`).toMatch(/@example\.com$/);
      }
    }
  });

  it('only calls known API hosts or .example placeholders, with no ids in the URL', () => {
    for (const { path, value } of allStrings) {
      for (const [url] of value.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        const host = new URL(url.replace(/\{\{.*$/, '')).hostname;
        const allowed = ALLOWED_HOSTS.has(host) || host.endsWith('.example');
        expect(allowed, `${path.join('.')}: ${url}`).toBe(true);
        expect(url, `numeric id in ${url}`).not.toMatch(/\/\d{6,}(\/|$)/);
      }
    }
  });

  it('leaves account-specific identifiers as placeholders', () => {
    for (const node of working) {
      const p = node.parameters;
      if (node.type === 'n8n-nodes-base.googleSheets') {
        expect(p.documentId).toMatchObject({ value: '' });
        expect(p.sheetName).toMatchObject({ value: '' });
      }
      if (typeof p.chatId === 'string') expect(p.chatId).toMatch(/^YOUR_/);
      if (typeof p.sendTo === 'string' && !p.sendTo.startsWith('=')) expect(p.sendTo).toMatch(/@example\.com$/);
    }
  });

  it('calls Claude only through the credential-backed model node', () => {
    for (const node of working.filter((n) => n.type === '@n8n/n8n-nodes-langchain.lmChatAnthropic')) {
      // A model id and options, nothing else: the key lives in the n8n credential.
      expect(Object.keys(node.parameters).sort(), node.name).toEqual(['model', 'options']);
      expect(node.parameters.model).toMatchObject({ value: expect.stringMatching(/^claude-/) });
    }
    for (const { value } of allStrings) {
      expect(value).not.toMatch(/api\.anthropic\.com|x-api-key|anthropic-version/i);
    }
  });

  it('wires an output parser to every chain that expects one, with a valid schema', () => {
    for (const chain of working.filter((n) => n.type === '@n8n/n8n-nodes-langchain.chainLlm')) {
      const feeding = (type: string) =>
        Object.entries(workflow.connections).filter(([, byType]) =>
          (byType[type] ?? []).flat().some((t) => t.node === chain.name),
        );
      expect(feeding('ai_languageModel'), `${chain.name} has no model`).toHaveLength(1);
      expect(feeding('ai_outputParser')).toHaveLength(chain.parameters.hasOutputParser === true ? 1 : 0);
    }
    for (const parser of working.filter((n) => n.type === '@n8n/n8n-nodes-langchain.outputParserStructured')) {
      expect(parser.parameters.schemaType).toBe('manual');
      const schema = z
        .object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) })
        .parse(JSON.parse(String(parser.parameters.inputSchema)));
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });

  it('builds JSON request bodies with JSON.stringify, never by quoting interpolated values', () => {
    for (const node of working) {
      const body = node.parameters.jsonBody;
      if (typeof body !== 'string') continue;
      expect(body, node.name).toMatch(/^=\{\{ JSON\.stringify\(/);
      expect(body, node.name).not.toContain('"{{');
    }
  });

  it('stores sheet values as RAW, so submitted text never runs as a formula', () => {
    for (const node of working.filter((n) => n.type === 'n8n-nodes-base.googleSheets')) {
      expect(node.parameters.options, node.name).toMatchObject({ cellFormat: 'RAW' });
      expect(node.parameters.columns, node.name).toMatchObject({ mappingMode: 'autoMapInputData' });
    }
  });

  it('leaves no Spanish characters or common Spanish words from the source templates', () => {
    for (const { path, value } of allStrings) {
      expect(value, path.join('.')).not.toMatch(/[¿¡ñáéíóú]/i);
      expect(value, path.join('.')).not.toMatch(SPANISH_WORDS);
    }
  });

  it('cuts every value it puts into a Claude prompt', () => {
    for (const chain of working.filter((n) => n.type === '@n8n/n8n-nodes-langchain.chainLlm')) {
      const blocks = expressionBlocks(String(chain.parameters.text));
      expect(blocks.length, chain.name).toBeGreaterThan(0);
      for (const block of blocks) expect(block, `${chain.name}: ${block}`).toMatch(/\.slice\(0, \d+\)/);
    }
  });

  it('does not retry nodes that send to a customer or create a record elsewhere', () => {
    for (const node of working.filter((n) => NO_RETRY_NODES.includes(n.name))) {
      expect(node, node.name).not.toHaveProperty('retryOnFail');
    }
  });
});

describe('payment templates', () => {
  const payments = templates.filter(({ file }) => file.startsWith('mercadopago-'));

  it('covers both MercadoPago templates', () => {
    expect(payments).toHaveLength(2);
  });

  it('uses the same signature code in both templates', () => {
    const [a, b] = payments.map(({ workflow }) => codeOf(workflow, 'Verify signature (x-signature)'));
    expect(a).toBe(b);
  });

  describe('signature check, executed', () => {
    const SECRET = 'test-secret-for-the-fixture';
    const template = payments[0];
    if (!template) throw new Error('no MercadoPago template');
    const code = codeOf(template.workflow, 'Verify signature (x-signature)');
    const configured = code.replace("const SECRET = 'YOUR_MERCADOPAGO_WEBHOOK_SECRET'", `const SECRET = '${SECRET}'`);

    const sign = (manifest: string) => createHmac('sha256', SECRET).update(manifest).digest('hex');
    const notification = (opts: { id?: string; requestId?: string; signature?: string; inQuery?: boolean }) => {
      const headers: Record<string, string> = {};
      if (opts.signature !== undefined) headers['x-signature'] = opts.signature;
      if (opts.requestId !== undefined) headers['x-request-id'] = opts.requestId;
      return {
        json: {
          headers,
          query: opts.inQuery ? { 'data.id': opts.id } : {},
          body: opts.inQuery ? { type: 'payment' } : { type: 'payment', data: { id: opts.id } },
        },
      };
    };
    const verify = (source: string, item: CodeItem) => runCode(source, [item])[0]?.json;

    const ts = '1767225600';
    const requestId = 'req-0001';
    const id = '123456789';
    const valid = sign(`id:${id};request-id:${requestId};ts:${ts};`);

    it('accepts a correctly signed notification, with data.id in the body or the query', () => {
      for (const inQuery of [false, true]) {
        const result = verify(configured, notification({ id, requestId, signature: `ts=${ts},v1=${valid}`, inQuery }));
        expect(result).toEqual({ paymentId: id, signatureValid: true });
      }
    });

    it('accepts a notification without x-request-id when the manifest leaves it out', () => {
      const signature = `ts=${ts},v1=${sign(`id:${id};ts:${ts};`)}`;
      expect(verify(configured, notification({ id, signature }))?.signatureValid).toBe(true);
    });

    it('rejects a changed digit, a dropped x-request-id, another id and a stale ts', () => {
      const flipped = (valid[0] === 'a' ? 'b' : 'a') + valid.slice(1);
      for (const item of [
        notification({ id, requestId, signature: `ts=${ts},v1=${flipped}` }),
        notification({ id, signature: `ts=${ts},v1=${valid}` }),
        notification({ id: '987654321', requestId, signature: `ts=${ts},v1=${valid}` }),
        notification({ id, requestId, signature: `ts=1767225601,v1=${valid}` }),
      ]) {
        expect(verify(configured, item)?.signatureValid).toBe(false);
      }
    });

    it('rejects missing headers and non-numeric ids before computing anything', () => {
      const id2 = 'abc123';
      const forId2 = sign(`id:${id2};request-id:${requestId};ts:${ts};`);
      for (const item of [
        notification({ id, requestId }),
        notification({ id, requestId, signature: `v1=${valid}` }),
        notification({ id, requestId, signature: `ts=${ts}` }),
        notification({ requestId, signature: `ts=${ts},v1=${valid}` }),
        notification({ id: id2, requestId, signature: `ts=${ts},v1=${forId2}` }),
      ]) {
        expect(verify(configured, item)?.signatureValid).toBe(false);
      }
    });

    it('returns false instead of throwing on a v1 with multi-byte characters', () => {
      // Same string length as a real digest, different byte length.
      const v1 = 'é'.repeat(64);
      expect(() => verify(configured, notification({ id, requestId, signature: `ts=${ts},v1=${v1}` }))).not.toThrow();
      expect(verify(configured, notification({ id, requestId, signature: `ts=${ts},v1=${v1}` }))?.signatureValid).toBe(false);
    });

    it('rejects everything while the secret is the placeholder', () => {
      const placeholder = 'YOUR_MERCADOPAGO_WEBHOOK_SECRET';
      const forged = createHmac('sha256', placeholder).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
      expect(verify(code, notification({ id, requestId, signature: `ts=${ts},v1=${forged}` }))?.signatureValid).toBe(false);
    });
  });

  it.each(payments)('$file has no side effect reachable without a valid signature', ({ workflow }) => {
    const webhook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    expect(webhook).toBeDefined();
    const open = reachable(workflow, webhook?.name ?? '', (from, output) => from === 'Signature valid?' && output === 0);
    for (const name of open) {
      const type = nodeByName(workflow, name)?.type ?? '';
      expect(SIDE_EFFECT_TYPES.has(type), `${name} runs without a valid signature`).toBe(false);
    }
  });

  it.each(payments)('$file drops repeated notifications before writing anything', ({ workflow }) => {
    const dedupe = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.removeDuplicates');
    expect(dedupe?.parameters.operation).toBe('removeItemsSeenInPreviousExecutions');
    const before = reachable(workflow, 'Fetch payment from MercadoPago', (from) => from === dedupe?.name);
    for (const name of before) {
      const type = nodeByName(workflow, name)?.type ?? '';
      if (name === 'Fetch payment from MercadoPago') continue;
      expect(SIDE_EFFECT_TYPES.has(type), `${name} runs before deduplication`).toBe(false);
    }
  });

  it('issues an AFIP invoice only for approved payments, once, without automatic retry', () => {
    const afip = payments.find(({ file }) => file.includes('afip'));
    expect(afip).toBeDefined();
    const workflow = afip?.workflow as Workflow;
    const approved = nodeByName(workflow, 'Payment approved?');
    expect(strings(approved?.parameters)).toContainEqual(expect.objectContaining({ value: 'approved' }));
    const withoutApproval = reachable(workflow, 'Fetch payment from MercadoPago', (from, output) => from === 'Payment approved?' && output === 0);
    expect(withoutApproval).not.toContain('Issue invoice (AFIP)');
    const invoice = nodeByName(workflow, 'Issue invoice (AFIP)');
    expect(invoice).toBeDefined();
    expect(invoice).not.toHaveProperty('retryOnFail');
  });
});

describe('webhook templates that message customers', () => {
  // Each one validates the body and deduplicates before the first write or send.
  const cases = [
    {
      file: 'tiendanube-order-to-sheets-and-whatsapp.json',
      check: 'Your store and a new order?',
      dedupe: 'Confirm each order once',
      key: '={{ $json.id }}',
    },
    {
      file: 'calendly-booking-to-sheets-and-whatsapp.json',
      check: 'New booking with email and time?',
      dedupe: 'Confirm each booking once',
      key: '={{ $json.body.payload.uri }}',
    },
  ];

  it.each(cases)('$file writes and sends nothing before the check and the deduplication', ({ file, check, dedupe, key }) => {
    const workflow = templates.find((t) => t.file === file)?.workflow as Workflow;
    expect(nodeByName(workflow, dedupe)?.parameters).toMatchObject({
      operation: 'removeItemsSeenInPreviousExecutions',
      dedupeValue: key,
    });
    const webhook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    const open = reachable(workflow, webhook?.name ?? '', (from, output) => (from === check && output === 0) || from === dedupe);
    for (const name of open) {
      const type = nodeByName(workflow, name)?.type ?? '';
      expect(SIDE_EFFECT_TYPES.has(type), `${name} runs before "${check}" and "${dedupe}"`).toBe(false);
    }
  });

  it('pins the Tiendanube store id to a placeholder you replace', () => {
    const workflow = templates.find((t) => t.file.startsWith('tiendanube-'))?.workflow as Workflow;
    const conditions = strings(nodeByName(workflow, 'Your store and a new order?')?.parameters).map((s) => s.value);
    expect(conditions).toContain('YOUR_STORE_ID');
    expect(conditions).toContain('order/created');
  });
});

describe('WhatsApp message extraction, executed', () => {
  const workflow = templates.find((t) => t.file.startsWith('whatsapp-'))?.workflow as Workflow;
  const extract = (body: unknown) => runCode(codeOf(workflow, 'Extract message'), [{ json: { body } }]).map((i) => i.json);
  const change = (value: unknown) => ({ field: 'messages', value });

  it('keeps inbound text messages and drops status updates and other message types', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            change({ statuses: [{ id: 'wamid.status-1', status: 'delivered' }] }),
            change({
              contacts: [{ wa_id: '10000000001', profile: { name: 'Test Customer' } }],
              messages: [
                { id: 'wamid.text-1', from: '10000000001', type: 'text', text: { body: 'Hi, do you ship?' } },
                { id: 'wamid.image-1', from: '10000000001', type: 'image', image: { id: 'media-1' } },
                { id: 'wamid.text-2', from: '10000000002', type: 'text', text: { body: 'Price list please' } },
              ],
            }),
          ],
        },
      ],
    };
    expect(extract(body)).toEqual([
      { message_id: 'wamid.text-1', phone: '10000000001', name: 'Test Customer', text: 'Hi, do you ship?' },
      { message_id: 'wamid.text-2', phone: '10000000002', name: '', text: 'Price list please' },
    ]);
  });

  it('returns no items, and so stops the run, for a status-only event or an empty body', () => {
    expect(extract({ entry: [{ changes: [change({ statuses: [{ id: 'wamid.s', status: 'read' }] })] }] })).toEqual([]);
    expect(extract(undefined)).toEqual([]);
  });

  it('cuts long text and names before they reach Claude', () => {
    const body = {
      entry: [
        {
          changes: [
            change({
              contacts: [{ wa_id: '1', profile: { name: 'n'.repeat(500) } }],
              messages: [{ id: 'wamid.long', from: '1', type: 'text', text: { body: 'x'.repeat(10_000) } }],
            }),
          ],
        },
      ],
    };
    const [item] = extract(body);
    expect(String(item?.name)).toHaveLength(100);
    expect(String(item?.text)).toHaveLength(4000);
  });

  it('lets each message id through once before Claude is called', () => {
    expect(nodeByName(workflow, 'Skip redelivered messages')?.parameters).toMatchObject({
      operation: 'removeItemsSeenInPreviousExecutions',
      dedupeValue: '={{ $json.message_id }}',
    });
    expect(workflow.connections['Extract message']?.main?.[0]?.map((t) => t.node)).toEqual(['Skip redelivered messages']);
  });
});

describe('email triage', () => {
  const workflow = templates.find((t) => t.file.startsWith('email-triage-'))?.workflow as Workflow;

  it('uses every field it asks Claude for', () => {
    const schema = JSON.parse(String(nodeByName(workflow, 'Output schema')?.parameters.inputSchema)) as {
      properties: Record<string, unknown>;
    };
    const used = strings(workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.gmail').map((n) => n.parameters))
      .map((s) => s.value)
      .join('\n');
    for (const field of Object.keys(schema.properties)) expect(used, field).toContain(`$json.output.${field}`);
  });

  it('labels with placeholder label ids', () => {
    const labels = String(nodeByName(workflow, 'Label by category and urgency')?.parameters.labelIds);
    expect(labels.match(/'[^']+_LABEL_ID'/g)).toHaveLength(5);
  });
});

describe('referencedNodes', () => {
  it('finds the three reference forms', () => {
    const text = `={{ $('Normalize fields').item.json.name }} {{ $node["Result"].json.x }} {{ $items("Fetch data (HTTP)") }}`;
    expect(referencedNodes(text)).toEqual(['Normalize fields', 'Result', 'Fetch data (HTTP)']);
  });

  it('ignores $json and $input', () => {
    expect(referencedNodes('={{ $json.body.email }} {{ $input.first().json }}')).toEqual([]);
  });
});

describe('secret patterns', () => {
  // Samples are built at run time so this file does not itself look like a leak.
  const pattern = (label: string): RegExp => {
    const found = SECRET_PATTERNS.find(([l]) => l === label);
    if (!found) throw new Error(`no pattern ${label}`);
    return found[1];
  };

  it.each([
    ['API key (sk-...)', 'sk-ant-api03-' + 'a1'.repeat(15)],
    ['Slack token', 'xoxb-' + '1234-'.repeat(4)],
    ['Slack webhook with ids', 'https://hooks.slack.com/services/T' + '0'.repeat(8) + '/B000/xyz'],
    ['Telegram bot token', '123456789:' + 'A'.repeat(35)],
    ['long hex token', 'deadbeef'.repeat(5)],
    ['long base64 token', 'Zm9v'.repeat(12)],
    ['phone number', '+54 9 11 0000 0000'],
  ])('%s catches a sample', (label, sample) => {
    expect(pattern(label).test(sample)).toBe(true);
  });

  it('does not flag model ids, placeholders or ISO dates', () => {
    for (const value of ['claude-haiku-4-5-20251001', 'YOUR_MERCADOPAGO_WEBHOOK_SECRET', '2026-01-31T10:00:00Z']) {
      for (const [label, re] of SECRET_PATTERNS) expect(re.test(value), `${label}: ${value}`).toBe(false);
    }
  });

  it('finds every address, so the per-template check can reject non-example ones', () => {
    expect([...'you@example.com, sales@shop.test'.matchAll(EMAIL)].map((m) => m[0])).toEqual([
      'you@example.com',
      'sales@shop.test',
    ]);
  });
});
