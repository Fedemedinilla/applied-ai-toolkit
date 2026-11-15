// sale-closed-to-google-review-request.json: customer fields, email check,
// once per address, one review request, one log row. The workflow has no Code node.

import { describe, expect, it } from 'vitest';
import { evaluate, evaluateString } from '../harness/expressions.ts';
import { DedupeHistory, applySet, dedupeKey, ifPasses } from '../harness/nodes.ts';
import { loadTemplate, mainTargets, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { BAD_EMAILS, webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('sale-closed-to-google-review-request.json');
const WEBHOOK = 'Sale closed (Webhook)';
const CHECK = 'Has a valid email?';
const DEDUPE = 'Ask each customer once';
const fields = nodeNamed(workflow, 'Customer fields');
const check = nodeNamed(workflow, CHECK);
const dedupe = nodeNamed(workflow, DEDUPE);
const ask = nodeNamed(workflow, 'Ask for review (email)');

const customer = (body: unknown) => applySet(fields, { json: webhookItem(body) });

describe('Customer fields and Has a valid email?', () => {
  it('trims the name, lowercases the email and stamps the time', () => {
    expect(customer({ name: '  Ana Test ', email: ' Ana@Example.com ', total: 100 })).toEqual({
      name: 'Ana Test',
      email: 'ana@example.com',
      asked_at: '2026-01-31 10:00',
    });
    expect(String(customer({ name: 'n'.repeat(400), email: 'ana@example.com' }).name)).toHaveLength(100);
  });

  it('accepts a well-formed address and discards the rest', () => {
    expect(ifPasses(check, { json: customer({ email: ' ana@example.com ' }) })).toBe(true);
    for (const email of BAD_EMAILS) {
      expect(ifPasses(check, { json: customer({ email }) }), JSON.stringify(email)).toBe(false);
    }
    for (const body of [undefined, null, {}, []]) {
      expect(ifPasses(check, { json: customer(body) }), JSON.stringify(body)).toBe(false);
    }
    expect(mainTargets(workflow, CHECK, 1)).toEqual(['Discard (no valid email)']);
  });
});

describe('Ask each customer once', () => {
  const key = (body: Record<string, unknown>) => dedupeKey(dedupe, { json: customer(body) });

  it('gives the same sale delivered twice one key, so one request', () => {
    const history = new DedupeHistory();
    const keys = [key({ name: 'Ana', email: 'ana@example.com' }), key({ name: 'Ana', email: 'ana@example.com' })];
    expect(keys).toEqual(['ana@example.com', 'ana@example.com']);
    expect(keys.map((k) => history.execute([k])[0])).toEqual([true, false]);
  });

  it('treats a second sale to the same address, in other letter case or with spaces, as the same customer', () => {
    expect(key({ name: 'Ana T.', email: '  ANA@Example.COM ' })).toBe('ana@example.com');
  });

  it('gives another customer their own key', () => {
    expect(key({ email: 'bea@example.com' })).toBe('bea@example.com');
  });
});

describe('Ask for review (email)', () => {
  const scope = (body: Record<string, unknown>) => ({ json: customer(body) });
  const message = (body: Record<string, unknown>) => evaluateString(ask.parameters.message, scope(body));

  it('goes to the customer, greets by name and carries the review link placeholder', () => {
    const body = { name: 'Ana Test', email: 'ana@example.com' };
    expect(evaluate(ask.parameters.sendTo, scope(body))).toBe('ana@example.com');
    const text = message(body);
    expect(text.split('\n')[0]).toBe('Hi Ana Test,');
    expect(text).toContain('\nYOUR_GOOGLE_REVIEW_LINK\n');
  });

  // The webhook is unauthenticated and sends email to the address in the
  // body. Before the fix the subject and the greeting carried 100 characters
  // chosen by the caller.
  it('has a subject without submitted text', () => {
    expect(evaluate(ask.parameters.subject, scope({ name: 'http://evil.example', email: 'victim@example.com' }))).toBe(
      'Could you leave us a review?',
    );
  });

  it('keeps links, digits and markup of a submitted name out of the email', () => {
    for (const name of ['Win a prize at http://evil.example/claim?id=1', 'www.evil.example/free', '<b>call</b> +00 000 0000', 'A'.repeat(100)]) {
      const text = message({ name, email: 'victim@example.com' });
      expect(text.split('\n')[0], name).toMatch(/^Hi [A-Za-zÀ-ɏ' -]{1,40},$/);
      expect(text.split('\n')[0]).not.toMatch(/[.\/:@<>0-9]/);
    }
  });

  it('keeps accented Latin names and falls back to a neutral greeting', () => {
    const name = "José Núñez-O'Brien";
    expect(message({ name, email: 'ana@example.com' }).split('\n')[0]).toBe(`Hi ${name},`);
    for (const empty of [undefined, '', '12345']) {
      expect(message({ name: empty, email: 'ana@example.com' }).split('\n')[0]).toBe('Hi there,');
    }
  });

  it('is not retried: asking twice annoys more than not asking', () => {
    expect(ask).not.toHaveProperty('retryOnFail');
  });
});

describe('graph', () => {
  it('sends nothing before the email check and the deduplication, and logs after the send', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, WEBHOOK, (from) => from === DEDUPE)).toEqual([]);
    expect(reachableSideEffects(workflow, WEBHOOK)).toEqual(['Ask for review (email)', 'Log request']);
  });
});
