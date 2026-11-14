// scheduled-report-with-claude.json: daily fetch, one combined item, one
// bounded prompt, one email. The workflow has no Code node and no webhook.

import { describe, expect, it } from 'vitest';
import { evaluate, evaluateString } from '../harness/expressions.ts';
import { loadTemplate, mainTargets, nodeNamed } from '../harness/workflow.ts';

const { workflow } = loadTemplate('scheduled-report-with-claude.json');
const chain = nodeNamed(workflow, 'Summarize with Claude');
const send = nodeNamed(workflow, 'Send report');

describe('trigger and data', () => {
  it('runs once a day at 8', () => {
    expect(nodeNamed(workflow, 'Every day at 8 (Schedule)').parameters.rule).toEqual({ interval: [{ triggerAtHour: 8 }] });
  });

  it('combines every fetched item into one `data` list, so there is one Claude call per run', () => {
    expect(nodeNamed(workflow, 'Combine items').parameters).toMatchObject({
      aggregate: 'aggregateAllItemData',
      destinationFieldName: 'data',
    });
    expect(mainTargets(workflow, 'Fetch data (HTTP)')).toEqual(['Combine items']);
    expect(mainTargets(workflow, 'Combine items')).toEqual(['Summarize with Claude']);
  });

  it('fetches from a placeholder host', () => {
    expect(new URL(String(nodeNamed(workflow, 'Fetch data (HTTP)').parameters.url)).hostname).toMatch(/\.example$/);
  });
});

describe('Summarize with Claude, prompt', () => {
  const prompt = (data: unknown) => evaluateString(chain.parameters.text, { json: { data } });

  it('puts the data, as JSON, inside the data tags', () => {
    expect(prompt([{ day: '2026-01-30', sales: 12 }])).toContain('<data>\n[{"day":"2026-01-30","sales":12}]\n</data>');
  });

  it('cuts the data at 50,000 characters', () => {
    const base = prompt([]).length - '[]'.length;
    expect(prompt([{ blob: 'x'.repeat(500_000) }]).length).toBe(base + 50_000);
  });

  it('leaves the tags empty when there is no data, and tells the model what to do then', () => {
    const text = evaluateString(chain.parameters.text, { json: {} });
    expect(text).toContain('<data>\n\n</data>');
    expect(text).toContain('If the data is empty or looks like an error message, say that in one line');
  });
});

describe('Send report', () => {
  it('emails the model text to the placeholder address, with the date in the subject', () => {
    expect(send.parameters.sendTo).toBe('you@example.com');
    expect(evaluate(send.parameters.subject, { json: {}, now: '2026-03-09T08:00' })).toBe('Daily report: 2026-03-09');
    expect(evaluate(send.parameters.message, { json: { text: 'Sales rose.' } })).toBe('Sales rose.');
  });
});
