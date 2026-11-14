// calendly-booking-to-sheets-and-whatsapp.json: booking check, once per
// invitee URI, one row, a WhatsApp template only to a plausible phone number.
// The workflow has no Code node; its logic is in the If, Set and HTTP expressions.

import { describe, expect, it } from 'vitest';
import { DedupeHistory, applySet, dedupeKey, ifPasses, jsonBody } from '../harness/nodes.ts';
import { loadTemplate, mainTargets, nodeNamed, reachableSideEffects } from '../harness/workflow.ts';
import { BAD_EMAILS, webhookItem } from './helpers/webhook.ts';

const { workflow } = loadTemplate('calendly-booking-to-sheets-and-whatsapp.json');
const WEBHOOK = 'Receive booking (Webhook)';
const CHECK = 'New booking with email and time?';
const DEDUPE = 'Confirm each booking once';
const PHONE = 'Has a valid phone number?';
const check = nodeNamed(workflow, CHECK);
const fields = nodeNamed(workflow, 'Booking fields');

const URI = 'https://api.calendly.example/scheduled_events/EV0001/invitees/IN0001';
const booking = (payload: Record<string, unknown> = {}, event: unknown = 'invitee.created') =>
  webhookItem({
    event,
    payload: {
      name: 'Ana Test',
      email: 'ana@example.com',
      text_reminder_number: '+54 9 11 0000-0000',
      uri: URI,
      scheduled_event: { name: 'Intro call', start_time: '2026-02-03T15:00:00.000000Z' },
      ...payload,
    },
  });

describe('New booking with email and time?', () => {
  it('accepts a new booking with an email, a start time and an invitee URI', () => {
    expect(ifPasses(check, { json: booking() })).toBe(true);
  });

  it('discards other events, such as a cancellation', () => {
    for (const event of ['invitee.canceled', 'invitee_no_show.created', 'INVITEE.CREATED', '', null]) {
      expect(ifPasses(check, { json: booking({}, event) }), String(event)).toBe(false);
    }
  });

  it('discards a booking with a missing or malformed email', () => {
    for (const email of BAD_EMAILS) {
      expect(ifPasses(check, { json: booking({ email }) }), JSON.stringify(email)).toBe(false);
    }
  });

  it('discards a booking without a start time or an invitee URI', () => {
    expect(ifPasses(check, { json: booking({ scheduled_event: {} }) })).toBe(false);
    expect(ifPasses(check, { json: booking({ scheduled_event: null }) })).toBe(false);
    expect(ifPasses(check, { json: booking({ uri: '' }) })).toBe(false);
    expect(ifPasses(check, { json: booking({ uri: undefined }) })).toBe(false);
  });

  it('discards a body without a payload, or no body at all', () => {
    expect(ifPasses(check, { json: webhookItem({ event: 'invitee.created' }) })).toBe(false);
    expect(ifPasses(check, { json: webhookItem({ event: 'invitee.created', payload: null }) })).toBe(false);
    expect(ifPasses(check, { json: webhookItem(undefined) })).toBe(false);
    expect(mainTargets(workflow, CHECK, 1)).toEqual(['Discard (not a new booking)']);
  });
});

describe('Confirm each booking once', () => {
  const node = nodeNamed(workflow, DEDUPE);

  it('gives a booking delivered twice one key, so one row and one message', () => {
    const history = new DedupeHistory();
    const first = dedupeKey(node, { json: booking() });
    const again = dedupeKey(node, { json: booking({ name: 'Ana T.' }) });
    expect(first).toBe(URI);
    expect(again).toBe(first);
    expect(history.execute([first])).toEqual([true]);
    expect(history.execute([again])).toEqual([false]);
  });

  it('gives another invitee its own key', () => {
    expect(dedupeKey(node, { json: booking({ uri: `${URI}2` }) })).not.toBe(URI);
  });
});

describe('Booking fields', () => {
  it('trims the text fields and reduces the phone to digits', () => {
    expect(applySet(fields, { json: booking({ name: '  Ana Test ' }) })).toEqual({
      name: 'Ana Test',
      email: 'ana@example.com',
      phone: '5491100000000',
      start_time: '2026-02-03T15:00:00.000000Z',
      event: 'Intro call',
      invitee_uri: URI,
    });
  });

  it('cuts long values and stores an empty phone when there is none', () => {
    const out = applySet(fields, {
      json: booking({
        name: 'n'.repeat(400),
        text_reminder_number: null,
        scheduled_event: { name: 'e'.repeat(400), start_time: 't'.repeat(400) },
        uri: 'u'.repeat(900),
      }),
    });
    expect(String(out.name)).toHaveLength(100);
    expect(String(out.event)).toHaveLength(100);
    expect(String(out.start_time)).toHaveLength(40);
    expect(String(out.invitee_uri)).toHaveLength(300);
    expect(out.phone).toBe('');
  });
});

describe('Has a valid phone number? and Confirm on WhatsApp', () => {
  const phoneCheck = nodeNamed(workflow, PHONE);
  const whatsapp = nodeNamed(workflow, 'Confirm on WhatsApp');
  const scopeFor = (payload: Record<string, unknown> = {}) => {
    const row = applySet(fields, { json: booking(payload) });
    return { json: row, nodes: { 'Booking fields': row } };
  };

  it('sends only to a phone of 8 to 15 digits', () => {
    for (const phone of ['+54 9 11 0000-0000', '00000000', '000000000000000']) {
      expect(ifPasses(phoneCheck, scopeFor({ text_reminder_number: phone })), phone).toBe(true);
    }
    for (const phone of [null, '', 'call me', '0000000', '0000000000000000', '+1 (000) 000']) {
      expect(ifPasses(phoneCheck, scopeFor({ text_reminder_number: phone })), String(phone)).toBe(false);
    }
    expect(mainTargets(workflow, PHONE, 0)).toEqual(['Confirm on WhatsApp']);
    expect(mainTargets(workflow, PHONE, 1)).toEqual(['No valid phone (skip WhatsApp)']);
  });

  it('sends a template message with the name, the event and the time', () => {
    expect(jsonBody(whatsapp, scopeFor())).toEqual({
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
              { type: 'text', text: 'Ana Test' },
              { type: 'text', text: 'Intro call' },
              { type: 'text', text: '2026-02-03T15:00:00.000000Z' },
            ],
          },
        ],
      },
    });
  });

  it('keeps quotes, braces and line breaks of a name inside the JSON body', () => {
    const name = 'Ana "the }} boss"\nO\'Brien';
    const body = jsonBody(whatsapp, scopeFor({ name })) as { template: { components: { parameters: { text: string }[] }[] } };
    expect(body.template.components[0]?.parameters[0]?.text).toBe(name);
  });

  it('is not retried, because Meta bills each template message', () => {
    expect(whatsapp).not.toHaveProperty('retryOnFail');
  });
});

describe('graph', () => {
  it('writes and sends nothing before the check and the deduplication', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === CHECK && output === 0)).toEqual([]);
    expect(reachableSideEffects(workflow, WEBHOOK, (from) => from === DEDUPE)).toEqual([]);
  });

  it('reaches WhatsApp only through the phone check', () => {
    expect(reachableSideEffects(workflow, WEBHOOK, (from, output) => from === PHONE && output === 0)).toEqual(['Save to Sheets']);
    expect(reachableSideEffects(workflow, WEBHOOK)).toEqual(['Save to Sheets', 'Confirm on WhatsApp']);
  });
});
