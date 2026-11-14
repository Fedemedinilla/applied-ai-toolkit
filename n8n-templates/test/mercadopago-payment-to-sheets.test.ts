// mercadopago-payment-to-sheets.json: signature check, payment lookup,
// one row per id:status pair.

import { describe, expect, it } from 'vitest';
import { evaluate } from '../harness/expressions.ts';
import { DedupeHistory, NodeFailure, applySet, dedupeKey } from '../harness/nodes.ts';
import { loadTemplate, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { PAYMENT_ID, SIGNATURE_VALID, describeSignatureCheck, payment } from './helpers/mercadopago.ts';

const { workflow } = loadTemplate('mercadopago-payment-to-sheets.json');
const WEBHOOK = 'Receive MercadoPago notification (Webhook)';
const DEDUPE = 'Skip repeated notifications';

describeSignatureCheck(workflow);

describe('Fetch payment from MercadoPago', () => {
  it('asks the API for the verified payment id, and for nothing taken from the body', () => {
    const node = nodeNamed(workflow, 'Fetch payment from MercadoPago');
    const url = evaluate(node.parameters.url, { json: { paymentId: PAYMENT_ID, signatureValid: true } });
    expect(url).toBe(`https://api.mercadopago.com/v1/payments/${PAYMENT_ID}`);
    expect(node.parameters.method ?? 'GET').toBe('GET');
  });
});

describe('Skip repeated notifications', () => {
  const node = nodeNamed(workflow, DEDUPE);
  const key = (json: Record<string, unknown>) => dedupeKey(node, { json });

  it('gives the same notification delivered twice one key, so one row', () => {
    const history = new DedupeHistory();
    const first = key(payment());
    const second = key(payment());
    expect(first).toBe(`${PAYMENT_ID}:approved`);
    expect(second).toBe(first);
    expect(history.execute([first])).toEqual([true]);
    expect(history.execute([second])).toEqual([false]);
  });

  it('lets a status change of the same payment through, and another payment too', () => {
    const history = new DedupeHistory();
    const keys = [
      key(payment({ status: 'pending' })),
      key(payment({ status: 'approved' })),
      key(payment({ status: 'refunded' })),
      key(payment({ id: 987654321 })),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(keys.map((k) => history.execute([k])[0])).toEqual([true, true, true, true]);
    expect(history.execute([key(payment({ status: 'pending' }))])).toEqual([false]);
  });

  it('does not confuse the string and number forms of the same id', () => {
    expect(key(payment({ id: PAYMENT_ID }))).toBe(key(payment({ id: Number(PAYMENT_ID) })));
  });
});

describe('Normalize payment', () => {
  const node = nodeNamed(workflow, 'Normalize payment');

  it('writes the six columns from the API response', () => {
    expect(applySet(node, { json: payment() })).toEqual({
      payment_id: PAYMENT_ID,
      status: 'approved',
      amount: 15000.5,
      email: 'buyer@example.com',
      description: 'Box of 12 alfajores',
      approved_at: '2026-01-31T10:00:00.000-03:00',
    });
  });

  it('writes empty cells, not an error, for a payment without payer, description or approval date', () => {
    const json = payment({ status: 'pending', payer: null, description: null, date_approved: null });
    expect(applySet(node, { json })).toEqual({
      payment_id: PAYMENT_ID,
      status: 'pending',
      amount: 15000.5,
      email: null,
      description: null,
      approved_at: null,
    });
  });

  it('fails on an amount that is not a number instead of storing it', () => {
    expect(() => applySet(node, { json: payment({ transaction_amount: '=1+1' }) })).toThrow(NodeFailure);
    expect(applySet(node, { json: payment({ transaction_amount: '100.50' }) }).amount).toBe(100.5);
  });
});

describe('graph', () => {
  it('reaches no side effect without a valid signature', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === SIGNATURE_VALID && output === 0)).toEqual([]);
  });

  it('writes the row only after the lookup and the deduplication', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from) => from === DEDUPE)).toEqual(['Fetch payment from MercadoPago']);
    expect(reachableSideEffects(workflow, WEBHOOK)).toEqual(['Fetch payment from MercadoPago', 'Save to Sheets']);
  });
});
