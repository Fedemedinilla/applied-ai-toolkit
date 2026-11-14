// lead-capture-to-google-sheets.json: email check, normalized fields, one row.
// The workflow has no Code node; its logic is in the If and Set expressions.

import { describe, expect, it } from 'vitest';
import { applySet, ifPasses } from '../harness/nodes.ts';
import { loadTemplate, mainTargets, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { BAD_EMAILS, webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('lead-capture-to-google-sheets.json');
const CHECK = 'Has a valid email?';
const check = nodeNamed(workflow, CHECK);
const normalize = nodeNamed(workflow, 'Normalize fields');

describe('Has a valid email?', () => {
  it('accepts a well-formed address, with spaces around it', () => {
    for (const email of ['ana@example.com', '  Ana.Test+tag@Mail.Example.com  ', 'a@b.co']) {
      expect(ifPasses(check, { json: webhookItem({ email }) }), email).toBe(true);
    }
  });

  it('sends a missing or malformed address to the discard node', () => {
    for (const email of BAD_EMAILS) {
      expect(ifPasses(check, { json: webhookItem({ name: 'Ana', email }) }), JSON.stringify(email)).toBe(false);
    }
    expect(mainTargets(workflow, CHECK, 1)).toEqual(['Discard (no valid email)']);
  });

  it('discards a request without a JSON object body', () => {
    for (const body of [undefined, null, '', 'email=ana@example.com', [], [{ email: 'ana@example.com' }]]) {
      expect(ifPasses(check, { json: webhookItem(body) }), JSON.stringify(body)).toBe(false);
    }
    expect(ifPasses(check, { json: {} })).toBe(false);
  });
});

describe('Normalize fields', () => {
  it('trims, lowercases the email and stamps the time', () => {
    const json = webhookItem({ name: '  Ana Test ', email: ' Ana@Example.com ', message: ' Hello\nthere ', extra: 'dropped' });
    expect(applySet(normalize, { json })).toEqual({
      name: 'Ana Test',
      email: 'ana@example.com',
      message: 'Hello\nthere',
      received_at: '2026-01-31 10:00',
    });
  });

  it('cuts the name at 100 characters and the message at 2,000', () => {
    const json = webhookItem({ name: 'n'.repeat(500), email: 'ana@example.com', message: 'm'.repeat(9000) });
    const out = applySet(normalize, { json });
    expect(String(out.name)).toHaveLength(100);
    expect(String(out.message)).toHaveLength(2000);
  });

  it('stores empty strings for a missing name or message, and text for values of other types', () => {
    expect(applySet(normalize, { json: webhookItem({ email: 'ana@example.com' }) })).toMatchObject({ name: '', message: '' });
    const odd = applySet(normalize, { json: webhookItem({ email: 'ana@example.com', name: 123, message: { a: 1 } }) });
    expect(odd).toMatchObject({ name: '123', message: '[object Object]' });
  });

  it('keeps a formula-looking value as text for the RAW append', () => {
    const out = applySet(normalize, { json: webhookItem({ email: 'ana@example.com', name: '=IMPORTXML("http://x.example","//a")' }) });
    expect(out.name).toBe('=IMPORTXML("http://x.example","//a")');
    expect(nodeNamed(workflow, 'Save to Google Sheets').parameters.options).toMatchObject({ cellFormat: 'RAW' });
  });
});

describe('graph', () => {
  it('writes nothing for a lead that fails the check', () => {
    expect(reachableSideEffects(workflow, 'Receive lead (Webhook)', (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, 'Receive lead (Webhook)')).toEqual(['Save to Google Sheets']);
  });
});
