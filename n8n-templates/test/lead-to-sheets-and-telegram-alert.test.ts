// lead-to-sheets-and-telegram-alert.json: email check, normalized fields, one
// row, one Telegram alert to the owner. The workflow has no Code node.

import { describe, expect, it } from 'vitest';
import { evaluateString } from '../harness/expressions.ts';
import { applySet, ifPasses } from '../harness/nodes.ts';
import { STICKY, loadTemplate, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { BAD_EMAILS, webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('lead-to-sheets-and-telegram-alert.json');
const CHECK = 'Has a valid email?';
const check = nodeNamed(workflow, CHECK);
const normalize = nodeNamed(workflow, 'Normalize fields');
const alert = nodeNamed(workflow, 'Alert on Telegram');

const alertText = (body: Record<string, unknown>) => {
  const row = applySet(normalize, { json: webhookItem(body) });
  return evaluateString(alert.parameters.text, { json: row, nodes: { 'Normalize fields': row } });
};

describe('Has a valid email? and Normalize fields', () => {
  it('accepts a well-formed address and discards the rest', () => {
    expect(ifPasses(check, { json: webhookItem({ email: ' ana@example.com ' }) })).toBe(true);
    for (const email of BAD_EMAILS) {
      expect(ifPasses(check, { json: webhookItem({ email }) }), JSON.stringify(email)).toBe(false);
    }
    expect(ifPasses(check, { json: webhookItem(undefined) })).toBe(false);
  });

  it('trims and cuts the fields, lowercases the email and stamps the time', () => {
    const json = webhookItem({ name: ` ${'n'.repeat(300)} `, email: ' Ana@Example.com ', message: 'm'.repeat(5000) });
    const out = applySet(normalize, { json });
    expect(String(out.name)).toHaveLength(100);
    expect(out.email).toBe('ana@example.com');
    expect(String(out.message)).toHaveLength(2000);
    expect(out.received_at).toBe('2026-01-31 10:00');
  });
});

describe('Alert on Telegram', () => {
  // The Telegram node sends parse_mode "Markdown" when the parameter is unset
  // (n8n-nodes-base 2.15.1, Telegram/GenericFunctions.js). In that mode one
  // unmatched "_" or "*" makes Telegram reject the message, and "[text](url)"
  // from a stranger becomes a link in the owner's chat.
  const parseMode = (alert.parameters.additionalFields as { parse_mode?: string }).parse_mode ?? 'Markdown';

  it('shows the three fields of the lead', () => {
    expect(alertText({ name: 'Ana Test', email: 'ana@example.com', message: 'Do you ship?' })).toBe(
      'New lead\n\nName: Ana Test\nEmail: ana@example.com\nMessage: Do you ship?',
    );
  });

  it('does not send submitted text as legacy Markdown', () => {
    expect(parseMode).toBe('HTML');
  });

  it('escapes submitted text for HTML mode, so no character of a lead is read as markup', () => {
    const name = 'a_b *bold* `code` [link](http://evil.example) <b>x</b> & <a href="http://evil.example">y</a>';
    const email = 'first_last@example.com';
    const text = alertText({ name: name.slice(0, 100), email, message: '1 < 2 && 3 > 2 &amp;' });
    expect(text).not.toMatch(/[<>]/);
    expect(text.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
    const shown = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(shown).toBe(`New lead\n\nName: ${name.slice(0, 100)}\nEmail: ${email}\nMessage: 1 < 2 && 3 > 2 &amp;`);
  });

  it('stays under the 4,096 characters Telegram accepts, counted after entities are parsed', () => {
    const text = alertText({ name: 'n'.repeat(500), email: 'ana@example.com', message: 'm'.repeat(9000) });
    expect(text.length).toBeLessThan(4096);
  });

  it('says in its setup note which parse mode it uses', () => {
    const notes = workflow.nodes.filter((n) => n.type === STICKY).map((n) => String(n.parameters.content)).join('\n');
    expect(notes).not.toContain('no parse mode');
    expect(notes).toContain('HTML');
  });

  it('goes to the owner chat placeholder, without the n8n attribution, and keeps its retries', () => {
    expect(alert.parameters.chatId).toBe('YOUR_TELEGRAM_CHAT_ID');
    expect(alert.parameters.additionalFields).toMatchObject({ appendAttribution: false });
    expect(alert).toMatchObject({ retryOnFail: true, maxTries: 3 });
  });
});

describe('graph', () => {
  it('writes and alerts nothing for a lead that fails the check, and saves the row before the alert', () => {
    const webhook = 'Receive lead (Webhook)';
    expect(reachableSideEffects(workflow, webhook, (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, webhook)).toEqual(['Save to Google Sheets', 'Alert on Telegram']);
  });
});
