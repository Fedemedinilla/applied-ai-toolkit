// Fixtures and the shared signature suite for the two MercadoPago templates.
// Both carry their own copy of the "Verify signature (x-signature)" Code node,
// so each test file runs the whole suite against its own copy.

import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type Item, runCodeNode } from '../../harness/code-node.ts';
import { NodeFailure, ifPasses } from '../../harness/nodes.ts';
import { type Workflow, mainTargets, nodeNamed, stringParam } from '../../harness/workflow.ts';

export const VERIFY = 'Verify signature (x-signature)';
export const SIGNATURE_VALID = 'Signature valid?';
export const PLACEHOLDER_SECRET = 'YOUR_MERCADOPAGO_WEBHOOK_SECRET';
/** Not a real secret: a fixture value that only this test signs with. */
export const TEST_SECRET = 'fixture-secret-not-a-real-one';

export const TS = '1767225600';
export const REQUEST_ID = 'req-0001';
export const PAYMENT_ID = '123456789';

export const sign = (manifest: string, secret = TEST_SECRET): string =>
  crypto.createHmac('sha256', secret).update(manifest).digest('hex');

export const manifest = (id: string, ts = TS, requestId: string | null = REQUEST_ID): string =>
  `id:${id};` + (requestId === null ? '' : `request-id:${requestId};`) + `ts:${ts};`;

export interface NotificationOptions {
  id?: unknown;
  requestId?: string;
  signature?: string;
  /** Put data.id in the query string instead of the body. */
  inQuery?: boolean;
}

/** The item an n8n Webhook node emits for a MercadoPago notification. */
export function notification(options: NotificationOptions): Item {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.signature !== undefined) headers['x-signature'] = options.signature;
  if (options.requestId !== undefined) headers['x-request-id'] = options.requestId;
  return {
    json: {
      headers,
      params: {},
      query: options.inQuery ? { 'data.id': options.id, type: 'payment' } : {},
      body: options.inQuery
        ? { type: 'payment', action: 'payment.updated' }
        : { type: 'payment', action: 'payment.updated', data: { id: options.id } },
    },
  };
}

/** A correctly signed notification for PAYMENT_ID. */
export const validNotification = (): Item =>
  notification({ id: PAYMENT_ID, requestId: REQUEST_ID, signature: `ts=${TS},v1=${sign(manifest(PAYMENT_ID))}` });

/** The Code node's JavaScript with the placeholder secret replaced by TEST_SECRET. */
export function configuredCode(workflow: Workflow): string {
  const code = stringParam(nodeNamed(workflow, VERIFY), 'jsCode');
  const configured = code.replace(`const SECRET = '${PLACEHOLDER_SECRET}'`, `const SECRET = '${TEST_SECRET}'`);
  if (configured === code) throw new Error('the SECRET line of the signature node changed: update this helper');
  return configured;
}

/** What GET /v1/payments/<id> returns, reduced to the fields the templates read. */
export function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(PAYMENT_ID),
    status: 'approved',
    status_detail: 'accredited',
    transaction_amount: 15000.5,
    currency_id: 'ARS',
    description: 'Box of 12 alfajores',
    date_approved: '2026-01-31T10:00:00.000-03:00',
    payer: {
      email: 'buyer@example.com',
      first_name: 'Ana',
      last_name: 'Test',
      identification: { type: 'DNI', number: '00000000' },
    },
    ...overrides,
  };
}

/** Registers the signature tests for one template's copy of the Code node. */
export function describeSignatureCheck(workflow: Workflow): void {
  const original = stringParam(nodeNamed(workflow, VERIFY), 'jsCode');
  const code = configuredCode(workflow);
  const verify = async (item: Item, source = code) => (await runCodeNode(source, { items: [item] }))[0]?.json;
  const valid = sign(manifest(PAYMENT_ID));
  const signed = (v1: string, ts = TS): Item =>
    notification({ id: PAYMENT_ID, requestId: REQUEST_ID, signature: `ts=${ts},v1=${v1}` });

  describe('Verify signature (x-signature), executed', () => {
    it('accepts a correctly signed notification, with data.id in the body or in the query', async () => {
      for (const inQuery of [false, true]) {
        const item = notification({ id: PAYMENT_ID, requestId: REQUEST_ID, signature: `ts=${TS},v1=${valid}`, inQuery });
        expect(await verify(item)).toEqual({ paymentId: PAYMENT_ID, signatureValid: true });
      }
    });

    it('accepts a data.id sent as a JSON number, and spaces around the header parts', async () => {
      const item = notification({ id: Number(PAYMENT_ID), requestId: REQUEST_ID, signature: ` ts=${TS} , v1=${valid} ` });
      expect(await verify(item)).toEqual({ paymentId: PAYMENT_ID, signatureValid: true });
    });

    it('accepts a notification without x-request-id only when the signed manifest left it out too', async () => {
      const withoutRequestId = sign(manifest(PAYMENT_ID, TS, null));
      const accepted = await verify(notification({ id: PAYMENT_ID, signature: `ts=${TS},v1=${withoutRequestId}` }));
      const rejected = await verify(notification({ id: PAYMENT_ID, signature: `ts=${TS},v1=${valid}` }));
      expect(accepted?.signatureValid).toBe(true);
      expect(rejected?.signatureValid).toBe(false);
    });

    it('rejects a wrong signature: a changed digit, another secret, another id, ts or request id', async () => {
      const flipped = (valid.startsWith('a') ? 'b' : 'a') + valid.slice(1);
      const cases: Item[] = [
        signed(flipped),
        signed(sign(manifest(PAYMENT_ID), 'another-fixture-secret')),
        signed(valid, String(Number(TS) + 1)),
        signed(valid.toUpperCase()),
        signed(valid.slice(0, 32)),
        signed(`${valid}00`),
        notification({ id: '987654321', requestId: REQUEST_ID, signature: `ts=${TS},v1=${valid}` }),
        notification({ id: PAYMENT_ID, requestId: 'req-0002', signature: `ts=${TS},v1=${valid}` }),
      ];
      for (const item of cases) {
        expect((await verify(item))?.signatureValid, JSON.stringify(item.json.headers)).toBe(false);
      }
    });

    it('rejects a missing x-signature header, and a header without ts or without v1', async () => {
      const headers = [undefined, '', `v1=${valid}`, `ts=${TS}`, `ts=,v1=${valid}`, `ts=${TS},v1=`, 'garbage', ',,,=,='];
      for (const signature of headers) {
        const item = notification({ id: PAYMENT_ID, requestId: REQUEST_ID, ...(signature === undefined ? {} : { signature }) });
        expect((await verify(item))?.signatureValid, String(signature)).toBe(false);
      }
    });

    it('rejects an id that is not all digits, even when it is signed correctly', async () => {
      for (const id of ['abc123', '123/../../users/me', '12 34', '-1', '1.5', '']) {
        const signature = `ts=${TS},v1=${sign(manifest(id))}`;
        expect((await verify(notification({ id, requestId: REQUEST_ID, signature })))?.signatureValid, id).toBe(false);
      }
    });

    it('rejects a data.id sent twice in the query string, which arrives as a list', async () => {
      const item = notification({
        id: [PAYMENT_ID, '987654321'],
        requestId: REQUEST_ID,
        signature: `ts=${TS},v1=${valid}`,
        inQuery: true,
      });
      expect(await verify(item)).toEqual({ paymentId: `${PAYMENT_ID},987654321`, signatureValid: false });
    });

    it('returns false, without throwing, on a missing or malformed request', async () => {
      const shapes: Record<string, unknown>[] = [
        {},
        { headers: null, body: null, query: null },
        { headers: {}, body: 'not json', query: {} },
        { headers: { 'x-signature': ['a', 'b'] }, body: { data: null }, query: {} },
        { headers: { 'x-signature': 12345 }, body: { data: { id: {} } }, query: {} },
        { headers: { 'x-signature': `ts=${TS},v1=${valid}` }, body: [], query: [] },
      ];
      for (const json of shapes) {
        expect((await verify({ json }))?.signatureValid, JSON.stringify(json)).toBe(false);
      }
    });

    it('returns false instead of throwing on a v1 whose byte length differs from its string length', async () => {
      expect((await verify(signed('é'.repeat(64))))?.signatureValid).toBe(false);
    });

    it('rejects everything while the secret is the placeholder, even a request signed with the placeholder', async () => {
      const forged = sign(manifest(PAYMENT_ID), PLACEHOLDER_SECRET);
      expect(await verify(signed(forged), original)).toEqual({ paymentId: PAYMENT_ID, signatureValid: false });
    });

    it('decides with crypto.timingSafeEqual on buffers of equal length, and with nothing else', async () => {
      const calls: [Buffer, Buffer][] = [];
      const timingSafeEqual = vi.fn((a: Buffer, b: Buffer) => {
        calls.push([a, b]);
        return crypto.timingSafeEqual(a, b);
      });
      const modules = { crypto: { createHmac: crypto.createHmac, timingSafeEqual } };
      const run = async (v1: string) => (await runCodeNode(code, { items: [signed(v1)], modules }))[0]?.json.signatureValid;

      // Same length, wrong value: the decision comes from timingSafeEqual.
      const wrong = sign(manifest(PAYMENT_ID), 'another-fixture-secret');
      expect(await run(wrong)).toBe(false);
      expect(await run(valid)).toBe(true);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
      for (const [a, b] of calls) {
        expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
        expect(a.length).toBe(b.length);
        expect(a.toString()).toBe(valid);
      }
      // Different length: rejected before the comparison, which would throw.
      expect(await run(valid.slice(0, 10))).toBe(false);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
      // The node returns what timingSafeEqual says: no other comparison overrides it.
      timingSafeEqual.mockReturnValueOnce(true);
      expect(await run(wrong)).toBe(true);
      // No early-exit comparison of the digests in the source.
      expect(original).not.toMatch(/\b(v1|received|expected)\s*[!=]==?\s*(v1|received|expected)\b/);
    });

    it('does not check the age of ts: a correctly signed old notification still verifies', async () => {
      // Listed under Limits in the README. If the node starts checking age,
      // replace this test with accepted-when-fresh and rejected-when-old cases.
      const oldTs = '1000000000';
      expect((await verify(signed(sign(manifest(PAYMENT_ID, oldTs)), oldTs)))?.signatureValid).toBe(true);
      expect(original).not.toMatch(/Date\.now|new Date/);
    });

    it('fails the node, so nothing continues, when the instance does not allow require("crypto")', async () => {
      await expect(runCodeNode(code, { items: [validNotification()], modules: {} })).rejects.toThrow(
        /Cannot find module 'crypto'/,
      );
    });

    it('reads the first item only and returns exactly one', async () => {
      const out = await runCodeNode(code, { items: [validNotification(), validNotification()] });
      expect(out).toEqual([{ json: { paymentId: PAYMENT_ID, signatureValid: true } }]);
    });
  });

  describe('Signature valid?', () => {
    const node = nodeNamed(workflow, SIGNATURE_VALID);

    it('sends a verified item to the fetch and anything else to the discard node', async () => {
      const good = await verify(validNotification());
      const bad = await verify(notification({ id: PAYMENT_ID, requestId: REQUEST_ID }));
      expect(ifPasses(node, { json: good })).toBe(true);
      expect(ifPasses(node, { json: bad })).toBe(false);
      expect(ifPasses(node, { json: {} })).toBe(false);
      expect(mainTargets(workflow, SIGNATURE_VALID, 0)).toEqual(['Fetch payment from MercadoPago']);
      expect(mainTargets(workflow, SIGNATURE_VALID, 1)).toEqual(['Invalid signature (discard)']);
      expect(nodeNamed(workflow, 'Invalid signature (discard)').type).toBe('n8n-nodes-base.noOp');
    });

    it('fails instead of passing when signatureValid is not a boolean', () => {
      for (const signatureValid of ['true', 1, 'yes']) {
        expect(() => ifPasses(node, { json: { signatureValid } })).toThrow(NodeFailure);
      }
    });
  });
}
