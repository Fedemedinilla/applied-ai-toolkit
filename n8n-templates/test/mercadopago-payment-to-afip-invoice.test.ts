// mercadopago-payment-to-afip-invoice.json: signature check, payment lookup,
// approved payments only, one invoice per payment id, receipt email.

import { describe, expect, it } from 'vitest';
import { evaluate } from '../harness/expressions.ts';
import { DedupeHistory, NodeFailure, applySet, dedupeKey, ifPasses, jsonBody } from '../harness/nodes.ts';
import { loadTemplate, mainTargets, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { PAYMENT_ID, SIGNATURE_VALID, describeSignatureCheck, payment } from './helpers/mercadopago.ts';

const { workflow } = loadTemplate('mercadopago-payment-to-afip-invoice.json');
const WEBHOOK = 'Receive MercadoPago payment (Webhook)';
const APPROVED = 'Payment approved?';
const DEDUPE = 'One invoice per payment';
const INVOICE = 'Issue invoice (AFIP)';

describeSignatureCheck(workflow);

describe('Payment approved?', () => {
  const node = nodeNamed(workflow, APPROVED);

  it('continues only for the exact status "approved"', () => {
    expect(ifPasses(node, { json: payment() })).toBe(true);
    for (const status of ['pending', 'in_process', 'rejected', 'refunded', 'cancelled', 'charged_back', 'Approved', 'approved ', '']) {
      expect(ifPasses(node, { json: payment({ status }) }), status).toBe(false);
    }
  });

  it('does not continue for a response without a status, such as an API error body', () => {
    expect(ifPasses(node, { json: { message: 'Payment not found' } })).toBe(false);
    expect(ifPasses(node, { json: {} })).toBe(false);
    expect(mainTargets(workflow, APPROVED, 1)).toEqual(['Not approved (no invoice)']);
  });

  it('fails instead of invoicing when status is not a string', () => {
    expect(() => ifPasses(node, { json: payment({ status: 404 }) })).toThrow(NodeFailure);
  });
});

describe('One invoice per payment', () => {
  const node = nodeNamed(workflow, DEDUPE);
  const key = (json: Record<string, unknown>) => dedupeKey(node, { json });

  it('gives a payment delivered twice one key, so one invoice', () => {
    const history = new DedupeHistory();
    expect(key(payment())).toBe(PAYMENT_ID);
    expect(history.execute([key(payment())])).toEqual([true]);
    expect(history.execute([key(payment())])).toEqual([false]);
  });

  it('keeps one key for payment.created and payment.updated of the same approved payment', () => {
    const created = key(payment({ status_detail: 'accredited' }));
    const updated = key(payment({ status_detail: 'partially_refunded', id: PAYMENT_ID }));
    expect(updated).toBe(created);
  });

  it('gives another payment its own key', () => {
    expect(key(payment({ id: 987654321 }))).not.toBe(key(payment()));
  });
});

describe('Invoice fields and Issue invoice (AFIP)', () => {
  const fields = nodeNamed(workflow, 'Invoice fields');
  const invoice = nodeNamed(workflow, INVOICE);

  it('builds the invoice request from the API response', () => {
    const json = applySet(fields, { json: payment() });
    expect(json).toEqual({
      payment_id: PAYMENT_ID,
      amount: 15000.5,
      currency: 'ARS',
      email: 'buyer@example.com',
      name: 'Ana Test',
      id_type: 'DNI',
      id_number: '00000000',
      description: 'Box of 12 alfajores',
    });
    expect(jsonBody(invoice, { json })).toEqual({
      invoice_type: 'factura_b',
      external_reference: PAYMENT_ID,
      customer: { name: 'Ana Test', email: 'buyer@example.com', id_type: 'DNI', id_number: '00000000' },
      total: 15000.5,
      currency: 'ARS',
      concept: 'Box of 12 alfajores',
    });
  });

  it('keeps quotes and line breaks in a description inside the JSON body', () => {
    const description = 'Cake "Nº 3"\nwith {{ braces }} and a \\ backslash';
    const json = applySet(fields, { json: payment({ description }) });
    expect(jsonBody(invoice, { json })).toMatchObject({ concept: description });
  });

  it('sends empty customer fields, not a failed node, for a payment without payer data', () => {
    // n8n swallows the error of reading a field of a missing object, so the
    // request goes out and the invoicing provider decides. See Limits in the README.
    for (const payer of [null, {}, { email: null, identification: null }]) {
      const json = applySet(fields, { json: payment({ payer }) });
      expect(json).toMatchObject({ email: null, id_type: null, id_number: null });
      expect(jsonBody(invoice, { json })).toMatchObject({
        external_reference: PAYMENT_ID,
        total: 15000.5,
        customer: { email: null, id_type: null, id_number: null },
      });
    }
  });

  it('fails before the invoice call on an amount that is not a number', () => {
    expect(() => applySet(fields, { json: payment({ transaction_amount: 'abc' }) })).toThrow(NodeFailure);
  });

  it('never retries or hides a failure of the invoice call', () => {
    for (const key of ['retryOnFail', 'continueOnFail', 'onError', 'alwaysOutputData']) {
      expect(invoice, key).not.toHaveProperty(key);
    }
  });
});

describe('Send receipt', () => {
  const node = nodeNamed(workflow, 'Send receipt');
  const fields = (overrides: Record<string, unknown> = {}) =>
    applySet(nodeNamed(workflow, 'Invoice fields'), { json: payment(overrides) });
  const scope = (overrides: Record<string, unknown> = {}) => ({
    json: { cae: '00000000000000', cae_due_date: '2026-02-10' },
    nodes: { 'Invoice fields': fields(overrides) },
  });

  it('goes to the payer from the API, with the CAE, the total and the currency', () => {
    expect(evaluate(node.parameters.sendTo, scope())).toBe('buyer@example.com');
    expect(evaluate(node.parameters.subject, scope())).toBe('Your receipt: Box of 12 alfajores');
    const message = evaluate(node.parameters.message, scope());
    expect(message).toContain('Hi Ana Test,');
    expect(message).toContain('- CAE: 00000000000000');
    expect(message).toContain('- CAE due date: 2026-02-10');
    expect(message).toContain('- Total: 15000.5 ARS');
  });

  it('falls back to the payment id in the subject when the description is empty', () => {
    expect(evaluate(node.parameters.subject, scope({ description: null }))).toBe(`Your receipt: payment ${PAYMENT_ID}`);
    expect(evaluate(node.parameters.subject, scope({ description: '' }))).toBe(`Your receipt: payment ${PAYMENT_ID}`);
  });

  it('is not retried: a second receipt would look like a second charge', () => {
    expect(node).not.toHaveProperty('retryOnFail');
  });
});

describe('graph', () => {
  it('reaches no side effect without a valid signature', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === SIGNATURE_VALID && output === 0)).toEqual([]);
  });

  it('reaches the invoice and the receipt only through "approved" and the deduplication', () => {
    const lookupOnly = ['Fetch payment from MercadoPago'];
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === APPROVED && output === 0)).toEqual(lookupOnly);
    expect(reachableSideEffects(workflow, WEBHOOK, (from) => from === DEDUPE)).toEqual(lookupOnly);
    expect(reachableSideEffects(workflow, WEBHOOK)).toEqual([...lookupOnly, INVOICE, 'Send receipt']);
  });

  it('records the payment id before the invoice call, and sends the receipt after it', () => {
    expect(mainTargets(workflow, DEDUPE)).toEqual(['Invoice fields']);
    expect(mainTargets(workflow, 'Invoice fields')).toEqual([INVOICE]);
    expect(mainTargets(workflow, INVOICE)).toEqual(['Send receipt']);
  });
});
