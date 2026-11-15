// lead-to-sheets-and-welcome-email.json: email check, normalized fields, one
// row, one welcome email to the submitted address. The workflow has no Code node.

import { describe, expect, it } from 'vitest';
import { evaluate, evaluateString } from '../harness/expressions.ts';
import { applySet, ifPasses } from '../harness/nodes.ts';
import { loadTemplate, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { BAD_EMAILS, webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('lead-to-sheets-and-welcome-email.json');
const CHECK = 'Has a valid email?';
const check = nodeNamed(workflow, CHECK);
const normalize = nodeNamed(workflow, 'Normalize fields');
const welcome = nodeNamed(workflow, 'Send welcome email');

const scopeFor = (body: Record<string, unknown>) => {
  const row = applySet(normalize, { json: webhookItem(body) });
  return { json: row, nodes: { 'Normalize fields': row } };
};
const message = (body: Record<string, unknown>) => evaluateString(welcome.parameters.message, scopeFor(body));

describe('Has a valid email? and Normalize fields', () => {
  it('accepts a well-formed address and discards the rest, so there is no row and no failed send', () => {
    expect(ifPasses(check, { json: webhookItem({ email: ' ana@example.com ' }) })).toBe(true);
    for (const email of BAD_EMAILS) {
      expect(ifPasses(check, { json: webhookItem({ email }) }), JSON.stringify(email)).toBe(false);
    }
    expect(ifPasses(check, { json: webhookItem(undefined) })).toBe(false);
  });

  it('trims and cuts the fields, lowercases the email and stamps the time', () => {
    const out = applySet(normalize, { json: webhookItem({ name: ' Ana ', email: ' Ana@Example.com ', message: 'm'.repeat(5000) }) });
    expect(out).toMatchObject({ name: 'Ana', email: 'ana@example.com', received_at: '2026-01-31 10:00' });
    expect(String(out.message)).toHaveLength(2000);
  });
});

describe('Send welcome email', () => {
  it('goes to the normalized address with a fixed subject', () => {
    const scope = scopeFor({ name: 'Ana', email: ' Ana@Example.com ' });
    expect(evaluate(welcome.parameters.sendTo, scope)).toBe('ana@example.com');
    expect(welcome.parameters.subject).toBe('Thanks for your message');
    expect(welcome.parameters.emailType).toBe('text');
  });

  it('greets by name', () => {
    expect(message({ name: 'Ana Test', email: 'ana@example.com' })).toBe(
      'Hi Ana Test,\n\nThanks for writing to us. We got your message and will reply soon.\n\nBest regards',
    );
  });

  it('keeps accented Latin letters, apostrophes and hyphens of a name', () => {
    const name = "José Núñez-O'Brien";
    expect(message({ name, email: 'ana@example.com' })).toContain(`Hi ${name},`);
  });

  it('does not quote the submitted message', () => {
    const text = message({ name: 'Ana', email: 'ana@example.com', message: 'UNIQUE-MESSAGE-TEXT' });
    expect(text).not.toContain('UNIQUE-MESSAGE-TEXT');
  });

  // Anyone who finds the webhook can make it send this email to any address,
  // and the setup note says the text they control stays out of it. The name is
  // text they control: before the fix 100 characters of it went into the body.
  it('keeps links, digits and markup of a submitted name out of the email', () => {
    const hostile = [
      'Win a prize at http://evil.example/claim?id=1',
      'www.evil.example/free now',
      'call +00 000 0000 <b>today</b>',
      'bit.ly/x_y@evil',
      'A'.repeat(100),
    ];
    for (const name of hostile) {
      const [greeting] = message({ name, email: 'victim@example.com' }).split('\n');
      expect(greeting, name).toMatch(/^Hi [A-Za-zÀ-ɏ' -]{1,40},$/);
    }
  });

  // What is left is still caller text: up to 40 letters and spaces, enough for a
  // short sentence. The setup note says so instead of promising it stays out.
  it('lets up to 40 letters of a submitted name into the greeting, as the setup note says', () => {
    const [greeting] = message({ name: 'Your account is locked reply with password', email: 'victim@example.com' }).split('\n');
    expect(greeting).toBe('Hi Your account is locked reply with passwo,');
    const note = String(nodeNamed(workflow, 'Validation note').parameters.content);
    expect(note).not.toContain('stays out of it');
    expect(note).toContain('40 letters');
  });

  it('falls back to a neutral greeting when nothing of the name is left', () => {
    for (const name of [undefined, '', '   ', '12345', '://1.2.3.4/', '李雷']) {
      expect(message({ name, email: 'ana@example.com' }).split('\n')[0], String(name)).toBe('Hi there,');
    }
  });

  it('has no attribution line and is not retried', () => {
    expect(welcome.parameters.options).toEqual({ appendAttribution: false });
    expect(welcome).not.toHaveProperty('retryOnFail');
  });
});

describe('graph', () => {
  it('writes and sends nothing for a lead that fails the check, and saves the row before the email', () => {
    const webhook = 'Receive lead (Webhook)';
    expect(reachableSideEffects(workflow, webhook, (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, webhook)).toEqual(['Save to Google Sheets', 'Send welcome email']);
  });
});
