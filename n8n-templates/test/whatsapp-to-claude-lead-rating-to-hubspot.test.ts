// whatsapp-to-claude-lead-rating-to-hubspot.json: Meta verification (GET),
// extraction of inbound text messages (Code node), once per message id,
// bounded prompt, one HubSpot contact.

import { describe, expect, it } from 'vitest';
import { type Item, runCodeNode } from '../harness/code-node.ts';
import { evaluate, evaluateString } from '../harness/expressions.ts';
import { DedupeHistory, dedupeKey, ifPasses, jsonBody } from '../harness/nodes.ts';
import { loadTemplate, mainTargets, nodeNamed, reachableSideEffects, stringParam } from '../harness/workflow.ts';
import { webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('whatsapp-to-claude-lead-rating-to-hubspot.json');
const EXTRACT = 'Extract message';
const DEDUPE = 'Skip redelivered messages';
const code = stringParam(nodeNamed(workflow, EXTRACT), 'jsCode');
const dedupe = nodeNamed(workflow, DEDUPE);

const text = (id: unknown, from: string, body: unknown) => ({ id, from, type: 'text', text: { body } });
const event = (...values: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '0', changes: values.map((value) => ({ field: 'messages', value })) }],
});
const extract = async (...bodies: unknown[]): Promise<Record<string, unknown>[]> => {
  const items: Item[] = bodies.map((body) => ({ json: webhookItem(body) }));
  return (await runCodeNode(code, { items })).map((item) => item.json);
};

describe('Extract message, executed', () => {
  it('returns one item per inbound text message, with the contact name', async () => {
    const body = event({
      contacts: [{ wa_id: '10000000001', profile: { name: 'Test Customer' } }],
      messages: [text('wamid.text-1', '10000000001', 'Hi, do you ship?'), text('wamid.text-2', '10000000002', 'Price list please')],
    });
    expect(await extract(body)).toEqual([
      { message_id: 'wamid.text-1', phone: '10000000001', name: 'Test Customer', text: 'Hi, do you ship?' },
      { message_id: 'wamid.text-2', phone: '10000000002', name: '', text: 'Price list please' },
    ]);
  });

  it('drops status updates and messages that are not text, so they never reach Claude', async () => {
    const body = event(
      { statuses: [{ id: 'wamid.status-1', status: 'delivered' }] },
      {
        messages: [
          { id: 'wamid.image-1', from: '10000000001', type: 'image', image: { id: 'media-1' } },
          { id: 'wamid.empty-1', from: '10000000001', type: 'text', text: { body: '' } },
          { id: 'wamid.notext-1', from: '10000000001', type: 'text' },
        ],
      },
    );
    expect(await extract(body)).toEqual([]);
  });

  it('reads every entry, change and webhook item', async () => {
    const one = event({ messages: [text('wamid.a', '10000000001', 'a')] }, { messages: [text('wamid.b', '10000000001', 'b')] });
    const two = event({ messages: [text('wamid.c', '10000000002', 'c')] });
    expect((await extract(one, two)).map((m) => m.message_id)).toEqual(['wamid.a', 'wamid.b', 'wamid.c']);
  });

  it('cuts the name at 100 characters and the text at 4,000', async () => {
    const body = event({
      contacts: [{ wa_id: '1', profile: { name: 'n'.repeat(500) } }],
      messages: [text('wamid.long', '1', 'x'.repeat(10_000))],
    });
    const [item] = await extract(body);
    expect(String(item?.name)).toHaveLength(100);
    expect(String(item?.text)).toHaveLength(4000);
  });

  it('returns a message id once when one request carries it twice', async () => {
    // Remove Duplicates only compares with earlier executions: items that
    // share a new key inside one execution all pass (see DedupeHistory). Without
    // this, a repeated id in one request costs two Claude calls and two contacts.
    const body = event(
      { messages: [text('wamid.same', '10000000001', 'Hi'), text('wamid.same', '10000000001', 'Hi')] },
      { messages: [text('wamid.same', '10000000001', 'Hi'), text('wamid.other', '10000000001', 'Hi')] },
    );
    const items = await extract(body, body);
    expect(items.map((m) => m.message_id)).toEqual(['wamid.same', 'wamid.other']);
    const history = new DedupeHistory();
    const passed = history.execute(items.map((json) => dedupeKey(dedupe, { json })));
    expect(passed).toEqual([true, true]);
  });

  it('drops a message without a usable id, which would otherwise share the empty dedupe key', async () => {
    const body = event({
      messages: [text(undefined, '10000000001', 'no id'), text('', '10000000001', 'empty id'), text({ a: 1 }, '10000000001', 'object id'), text(42, '10000000001', 'number id')],
    });
    expect(await extract(body)).toEqual([]);
  });

  it('returns no items, without failing, for a body that is not a WhatsApp event', async () => {
    const shapes: unknown[] = [
      undefined,
      null,
      '',
      'text',
      [],
      {},
      { entry: null },
      { entry: {} },
      { entry: 5 },
      { entry: 'abc' },
      { entry: [null, 5, 'x', {}] },
      { entry: [{ changes: {} }] },
      { entry: [{ changes: [null, 5, {}, { value: null }, { value: 'x' }] }] },
      { entry: [{ changes: [{ value: { messages: {}, contacts: {} } }] }] },
      { entry: [{ changes: [{ value: { messages: [null, 5, 'x', {}], contacts: [null, 5] } }] }] },
    ];
    for (const body of shapes) {
      expect(await extract(body), JSON.stringify(body)).toEqual([]);
    }
    expect(await runCodeNode(code, { items: [] })).toEqual([]);
    expect(await runCodeNode(code, { items: [{ json: {} }] })).toEqual([]);
  });

  it('stores the phone and the text as strings whatever their type', async () => {
    const body = event({
      contacts: [{ wa_id: '__proto__', profile: { name: 'x' } }],
      messages: [{ id: 'wamid.odd', from: 10000000001, type: 'text', text: { body: 12345 } }],
    });
    expect(await extract(body)).toEqual([{ message_id: 'wamid.odd', phone: '10000000001', name: '', text: '12345' }]);
  });
});

describe('Skip redelivered messages', () => {
  it('gives a message delivered twice one key, so one Claude call and one contact', async () => {
    const body = event({ messages: [text('wamid.text-1', '10000000001', 'Hi')] });
    const history = new DedupeHistory();
    const keys = [];
    for (const delivery of [body, body]) {
      const [json] = await extract(delivery);
      keys.push(dedupeKey(dedupe, { json }));
    }
    expect(keys).toEqual(['wamid.text-1', 'wamid.text-1']);
    expect(keys.map((k) => history.execute([k])[0])).toEqual([true, false]);
  });

  it('sits between the extraction and the model call', () => {
    expect(mainTargets(workflow, EXTRACT)).toEqual([DEDUPE]);
    expect(mainTargets(workflow, DEDUPE)).toEqual(['Rate with Claude']);
    expect(reachableSideEffects(workflow, 'Receive WhatsApp (Webhook)', (from) => from === DEDUPE)).toEqual([]);
  });
});

describe('Verify webhook (GET)', () => {
  const check = nodeNamed(workflow, 'Verify token matches?');
  const request = (query: Record<string, unknown>) => ({ json: webhookItem(undefined, { query }) });

  it('answers the challenge only for mode "subscribe" with the configured token', () => {
    const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'YOUR_VERIFY_TOKEN', 'hub.challenge': '1158201444' };
    expect(ifPasses(check, request(query))).toBe(true);
    expect(evaluate(nodeNamed(workflow, 'Return challenge').parameters.responseBody, request(query))).toBe('1158201444');
    expect(mainTargets(workflow, 'Verify token matches?', 0)).toEqual(['Return challenge']);
  });

  it('answers 403 for a wrong or missing token or mode', () => {
    for (const query of [
      {},
      { 'hub.mode': 'subscribe' },
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong' },
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'your_verify_token' },
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'YOUR_VERIFY_TOKEN' },
      { 'hub.verify_token': 'YOUR_VERIFY_TOKEN' },
    ]) {
      expect(ifPasses(check, request(query)), JSON.stringify(query)).toBe(false);
    }
    expect(mainTargets(workflow, 'Verify token matches?', 1)).toEqual(['Reject (403)']);
    expect(nodeNamed(workflow, 'Reject (403)').parameters.options).toEqual({ responseCode: 403 });
  });

  it('reaches nothing but the two responses', () => {
    expect([...new Set(reachableSideEffects(workflow, 'Verify webhook (GET)'))]).toEqual([]);
  });
});

describe('Rate with Claude and Create contact in HubSpot', () => {
  const chain = nodeNamed(workflow, 'Rate with Claude');
  const hubspot = nodeNamed(workflow, 'Create contact in HubSpot');
  const message = { message_id: 'wamid.text-1', phone: '10000000001', name: 'Test "Customer"', text: 'Hi, do you ship?' };

  it('puts the sender and the message inside their tags, cut again in the prompt', () => {
    const prompt = evaluateString(chain.parameters.text, { json: message });
    expect(prompt).toContain('<sender>Test "Customer" (10000000001)</sender>');
    expect(prompt).toContain('<message>\nHi, do you ship?\n</message>');
    const base = evaluateString(chain.parameters.text, { json: { name: '', phone: '', text: '' } }).length;
    const long = evaluateString(chain.parameters.text, { json: { name: 'n'.repeat(999), phone: '9'.repeat(999), text: 'x'.repeat(9999) } });
    expect(long.length).toBe(base + 100 + 20 + 4000);
  });

  it('creates the contact with the extracted name and phone and the model rating and summary', () => {
    const scope = { json: { output: { intent: 'buy', rating: 'hot', summary: 'Asks about "shipping"', suggested_reply: 'Yes!' } }, nodes: { [EXTRACT]: message } };
    expect(jsonBody(hubspot, scope)).toEqual({
      properties: { firstname: 'Test "Customer"', phone: '10000000001', ai_lead_rating: 'hot', ai_lead_summary: 'Asks about "shipping"' },
    });
  });

  it('never sends the model reply to the customer: the flow ends at a placeholder', () => {
    expect(JSON.stringify(hubspot.parameters)).not.toContain('suggested_reply');
    expect(mainTargets(workflow, 'Create contact in HubSpot')).toEqual(['Notify team or reply']);
    expect(nodeNamed(workflow, 'Notify team or reply').type).toBe('n8n-nodes-base.noOp');
    expect(hubspot).not.toHaveProperty('retryOnFail');
  });
});
