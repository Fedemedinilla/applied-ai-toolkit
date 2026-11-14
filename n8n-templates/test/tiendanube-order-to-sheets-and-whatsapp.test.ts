// tiendanube-order-to-sheets-and-whatsapp.json: store and id check, order
// lookup, once per order, one row, one WhatsApp template. The workflow has no
// Code node; its logic is in the If, Set and HTTP expressions.

import { describe, expect, it } from 'vitest';
import { evaluate } from '../harness/expressions.ts';
import { DedupeHistory, applySet, dedupeKey, ifPasses, jsonBody } from '../harness/nodes.ts';
import { type WorkflowNode, loadTemplate, mainTargets, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('tiendanube-order-to-sheets-and-whatsapp.json');
const WEBHOOK = 'Receive order (Webhook)';
const CHECK = 'Your store and a new order?';
const DEDUPE = 'Confirm each order once';
const STORE_ID = '1000001';

const placeholderCheck = nodeNamed(workflow, CHECK);
/** The check as it is after the owner replaces YOUR_STORE_ID with a store id. */
const check = JSON.parse(JSON.stringify(placeholderCheck).replace('YOUR_STORE_ID', STORE_ID)) as WorkflowNode;
const notice = (body: Record<string, unknown> = {}) => webhookItem({ store_id: Number(STORE_ID), event: 'order/created', id: 871254203, ...body });

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 871254203,
  number: 1042,
  contact_name: 'Ana Test',
  contact_phone: '+54 9 11 0000-0000',
  total: '15000.50',
  status: 'open',
  ...overrides,
});

describe('Your store and a new order?', () => {
  it('accepts order/created from the configured store with a numeric order id', () => {
    expect(ifPasses(check, { json: notice() })).toBe(true);
    expect(ifPasses(check, { json: notice({ store_id: STORE_ID, id: '871254203' }) })).toBe(true);
  });

  it('discards another store, another event and an order id that is not all digits', () => {
    for (const body of [
      { store_id: 1000002 },
      { store_id: `${STORE_ID}0` },
      { store_id: null },
      { event: 'order/paid' },
      { event: 'product/created' },
      { event: undefined },
      { id: '12/../../customers' },
      { id: '12?fields=x' },
      { id: 'abc' },
      { id: '' },
      { id: null },
      { id: 1.5 },
    ]) {
      expect(ifPasses(check, { json: notice(body) }), JSON.stringify(body)).toBe(false);
    }
    expect(ifPasses(check, { json: webhookItem(undefined) })).toBe(false);
    expect(ifPasses(check, { json: webhookItem({}) })).toBe(false);
    expect(mainTargets(workflow, CHECK, 1)).toEqual(['Discard (bad payload)']);
  });

  it('discards every request while the store id is still the placeholder, as its setup note says', () => {
    // Before the fix a request that sent the literal placeholder as its store id passed.
    for (const store_id of ['YOUR_STORE_ID', STORE_ID, Number(STORE_ID), '', undefined]) {
      expect(ifPasses(placeholderCheck, { json: notice({ store_id }) }), String(store_id)).toBe(false);
    }
  });
});

describe('Fetch order (Tiendanube)', () => {
  it('asks the API for the checked store and order ids', () => {
    const url = evaluate(nodeNamed(workflow, 'Fetch order (Tiendanube)').parameters.url, { json: notice() });
    expect(url).toBe(`https://api.tiendanube.com/v1/${STORE_ID}/orders/871254203`);
  });
});

describe('Confirm each order once', () => {
  const node = nodeNamed(workflow, DEDUPE);

  it('gives an order delivered twice one key, so one row and one message', () => {
    const history = new DedupeHistory();
    const keys = [dedupeKey(node, { json: order() }), dedupeKey(node, { json: order({ status: 'closed' }) })];
    expect(keys).toEqual(['871254203', '871254203']);
    expect(keys.map((k) => history.execute([k])[0])).toEqual([true, false]);
  });

  it('gives another order its own key', () => {
    expect(dedupeKey(node, { json: order({ id: 871254204 }) })).toBe('871254204');
  });
});

describe('Order fields and WhatsApp to customer', () => {
  const fields = nodeNamed(workflow, 'Order fields');
  const whatsapp = nodeNamed(workflow, 'WhatsApp to customer');

  it('keeps the order number, customer, digits of the phone, total and status', () => {
    expect(applySet(fields, { json: order() })).toEqual({
      order: '1042',
      customer: 'Ana Test',
      phone: '5491100000000',
      total: '15000.50',
      status: 'open',
      received_at: '2026-01-31 10:00',
    });
  });

  it('cuts a long customer name and stores empty values for missing fields', () => {
    const out = applySet(fields, { json: order({ contact_name: ` ${'n'.repeat(400)} `, contact_phone: null, total: undefined }) });
    expect(String(out.customer)).toHaveLength(100);
    expect(out.phone).toBe('');
    expect(out.total).toBeNull();
  });

  it('sends a template message with the customer, the order number and the total', () => {
    const row = applySet(fields, { json: order({ contact_name: 'Ana "A"\nTest' }) });
    expect(jsonBody(whatsapp, { json: {}, nodes: { 'Order fields': row } })).toEqual({
      messaging_product: 'whatsapp',
      to: '5491100000000',
      type: 'template',
      template: {
        name: 'YOUR_TEMPLATE_NAME',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana "A"\nTest' },
              { type: 'text', text: '1042' },
              { type: 'text', text: '15000.50' },
            ],
          },
        ],
      },
    });
  });

  it('is not retried, because Meta bills each template message', () => {
    expect(whatsapp).not.toHaveProperty('retryOnFail');
  });
});

describe('graph', () => {
  it('calls nothing before the check, and only the order lookup before the deduplication', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, WEBHOOK, (from) => from === DEDUPE)).toEqual(['Fetch order (Tiendanube)']);
    expect(reachableSideEffects(workflow, WEBHOOK)).toEqual(['Fetch order (Tiendanube)', 'Save to Sheets', 'WhatsApp to customer']);
  });
});
