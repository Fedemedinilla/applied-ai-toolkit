// Structural rules over every workflow file. ../templates.test.ts already
// checks names, expression references, secret patterns, hosts and placeholders;
// this file adds the rules about failure handling and about what stands
// between a webhook and a side effect.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE,
  SIDE_EFFECT_TYPES,
  STICKY,
  TEMPLATES_DIR,
  WEBHOOK,
  type Workflow,
  loadTemplates,
  mainTargets,
  nodeNamed,
  reachableSideEffects,
  strings,
  templateFiles,
  workingNodes,
} from '../harness/workflow.ts';

const templates = loadTemplates();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Node types that may retry: reads, Sheets appends, alerts to the owner, drafts and the owner's report. */
const MAY_RETRY: Readonly<Record<string, string[]>> = {
  'n8n-nodes-base.googleSheets': ['*'],
  'n8n-nodes-base.telegram': ['Alert on Telegram'],
  'n8n-nodes-base.gmail': ['Create draft reply', 'Send report'],
  'n8n-nodes-base.httpRequest': ['Fetch payment from MercadoPago', 'Fetch order (Tiendanube)', 'Fetch data (HTTP)', 'Post to Slack'],
};

/** Webhooks that receive payment notifications: every one must be behind a signature check. */
const isPaymentWebhook = (workflow: Workflow, path: string): boolean =>
  /mercadopago|payment|stripe|paypal/i.test(`${workflow.name} ${path}`) && !/sale-closed/.test(path);

describe('template set', () => {
  it('has 13 workflow files', () => {
    expect(templateFiles()).toHaveLength(13);
  });
});

describe.each(templates)('$file', ({ file, raw, workflow }) => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const working = workingNodes(workflow);

  it('is valid JSON in the format n8n exports, so a diff shows only real changes', () => {
    const text = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
    expect(Object.keys(raw as object).sort()).toEqual(['active', 'connections', 'name', 'nodes', 'pinData', 'settings', 'tags']);
  });

  it('gives every node a unique UUID and a unique name', () => {
    for (const node of workflow.nodes) expect(node.id, node.name).toMatch(UUID);
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(workflow.nodes.length);
    expect(names.size).toBe(workflow.nodes.length);
  });

  it('connects only existing working nodes, on input 0, with a known connection type', () => {
    for (const [from, byType] of Object.entries(workflow.connections)) {
      expect(names, `connection from "${from}"`).toContain(from);
      expect(nodeNamed(workflow, from).type).not.toBe(STICKY);
      for (const [type, outputs] of Object.entries(byType)) {
        expect(['main', 'ai_languageModel', 'ai_outputParser']).toContain(type);
        for (const target of outputs.flat()) {
          expect(names, `"${from}" connects to "${target.node}"`).toContain(target.node);
          expect(nodeNamed(workflow, target.node).type).not.toBe(STICKY);
          expect(target).toMatchObject({ type, index: 0 });
        }
      }
    }
  });

  it('has no output wired to nothing on a node with two or more outputs', () => {
    for (const node of working.filter((n) => n.type === 'n8n-nodes-base.if')) {
      expect(mainTargets(workflow, node.name, 0).length, `${node.name} true`).toBeGreaterThan(0);
      expect(mainTargets(workflow, node.name, 1).length, `${node.name} false`).toBeGreaterThan(0);
    }
  });

  it('embeds no credential, account id, instance URL, real email or phone number', () => {
    for (const node of workflow.nodes) {
      for (const key of ['credentials', 'webhookId', 'disabled', 'notes']) expect(node, `${node.name}.${key}`).not.toHaveProperty(key);
    }
    for (const { path, value } of strings(raw)) {
      const where = `${path.join('.')}: ${value.slice(0, 60)}`;
      expect(value, where).not.toMatch(/\/webhook(-test)?\/[A-Za-z0-9-]/);
      expect(value, where).not.toMatch(/\b(Bearer|Basic|bearer)\s+(?!YOUR_|\.\.\.)[A-Za-z0-9._~+/-]{12,}/);
      expect(value, where).not.toMatch(/\.app\.n8n\.cloud|localhost|127\.0\.0\.1/);
      for (const [address] of value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g)) {
        expect(address, where).toMatch(/@example\.com$/);
      }
      if (path.at(-1) !== 'id') expect(value.replace(/claude-[a-z0-9-]+/g, ''), where).not.toMatch(/(?<![\w.])\+?\d[\d ()-]{8,}\d(?![\w.])/);
    }
  });

  it('writes every placeholder as YOUR_UPPER_SNAKE or an .example host', () => {
    for (const { value } of strings(workflow.nodes.filter((n) => n.type !== STICKY).map((n) => n.parameters))) {
      for (const [placeholder] of value.matchAll(/\bYOUR[_-][A-Za-z_-]+/g)) {
        expect(placeholder).toMatch(/^YOUR_[A-Z]+(_[A-Z]+)*$|^YOUR-[A-Z]+(-[A-Z]+)*$/);
      }
    }
  });

  it('has no node that hides a failure or runs once for many items', () => {
    for (const node of workflow.nodes) {
      for (const key of ['continueOnFail', 'onError', 'alwaysOutputData', 'executeOnce']) {
        expect(node, `${node.name}.${key}`).not.toHaveProperty(key);
      }
    }
    expect(workflow.settings).toEqual({ executionOrder: 'v1' });
  });

  it('retries only reads, Sheets appends, alerts to the owner and drafts', () => {
    for (const node of working) {
      if (!('retryOnFail' in node)) continue;
      const allowed = MAY_RETRY[node.type] ?? [];
      expect(allowed.includes('*') || allowed.includes(node.name), `${node.name} retries`).toBe(true);
      expect(node).toMatchObject({ retryOnFail: true, maxTries: 3 });
    }
  });

  it('wires no webhook straight to a side effect: a check, a Code node or a Set node comes first', () => {
    for (const webhook of working.filter((n) => n.type === WEBHOOK)) {
      const next = mainTargets(workflow, webhook.name);
      expect(next.length, webhook.name).toBe(1);
      for (const name of next) {
        expect(SIDE_EFFECT_TYPES.has(nodeNamed(workflow, name).type), `${webhook.name} -> ${name}`).toBe(false);
      }
    }
  });

  it('uses only strict filters of version 2, the ones the harness evaluates', () => {
    for (const { path, value } of strings(working.map((n) => n.parameters))) {
      if (path.at(-1) === 'typeValidation') expect(value).toBe('strict');
    }
  });

  it('puts a signature check between every payment webhook and any side effect', () => {
    for (const webhook of working.filter((n) => n.type === WEBHOOK)) {
      if (!isPaymentWebhook(workflow, String(webhook.parameters.path))) continue;
      expect(reachableSideEffects(workflow, webhook.name).length).toBeGreaterThan(0);

      // The first node after the webhook is the Code node that verifies in constant time.
      const [verifier] = mainTargets(workflow, webhook.name);
      const code = nodeNamed(workflow, verifier ?? '');
      expect(code.type).toBe(CODE);
      expect(String(code.parameters.jsCode)).toMatch(/createHmac\('sha256'/);
      expect(String(code.parameters.jsCode)).toMatch(/timingSafeEqual\(/);

      // Its only output is an If on the boolean it computed.
      const [gate] = mainTargets(workflow, code.name);
      const check = nodeNamed(workflow, gate ?? '');
      expect(check.type).toBe('n8n-nodes-base.if');
      expect(strings(check.parameters).map((s) => s.value)).toContain('={{ $json.signatureValid }}');
      expect(JSON.stringify(check.parameters)).toContain('"operation":"true"');

      // Without the true branch of that If, or without the Code node, no side effect is reachable.
      expect(reachableSideEffects(workflow, webhook.name, (from, output) => from === check.name && output === 0)).toEqual([]);
      expect(reachableSideEffects(workflow, webhook.name, (from) => from === code.name)).toEqual([]);
      // The false branch ends in a node that does nothing.
      for (const name of mainTargets(workflow, check.name, 1)) {
        expect(nodeNamed(workflow, name).type).toBe('n8n-nodes-base.noOp');
        expect(mainTargets(workflow, name)).toEqual([]);
      }
    }
  });
});

describe('payment webhooks', () => {
  it('finds the two MercadoPago webhooks, so the rule above is not vacuous', () => {
    const found = templates.flatMap(({ file, workflow }) =>
      workingNodes(workflow)
        .filter((n) => n.type === WEBHOOK && isPaymentWebhook(workflow, String(n.parameters.path)))
        .map(() => file),
    );
    expect(found).toEqual(['mercadopago-payment-to-afip-invoice.json', 'mercadopago-payment-to-sheets.json']);
  });
});

describe('deduplication', () => {
  it('places every Remove Duplicates node before the sends and writes it protects', () => {
    const found: string[] = [];
    for (const { file, workflow } of templates) {
      for (const node of workingNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.removeDuplicates')) {
        found.push(file);
        expect(node.parameters).toMatchObject({
          operation: 'removeItemsSeenInPreviousExecutions',
          logic: 'removeItemsWithAlreadySeenKeyValues',
          options: {},
        });
        expect(reachableSideEffects(workflow, node.name).length, `${file}: nothing after ${node.name}`).toBeGreaterThan(0);
        // Nothing that sends to a customer or creates a record is reachable around it.
        const trigger = workingNodes(workflow).find((n) => n.type === WEBHOOK && n.parameters.httpMethod === 'POST');
        const around = reachableSideEffects(workflow, trigger?.name ?? '', (from) => from === node.name);
        for (const name of around) expect(name, file).toMatch(/^Fetch /);
      }
    }
    expect(found).toHaveLength(6);
  });
});
