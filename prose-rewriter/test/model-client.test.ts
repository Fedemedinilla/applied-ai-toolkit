// The rewriter's model-facing building blocks: the four task configs with their provisional caps,
// the evals ModelClient over the gateway, and the scripted gateway the stage tests will use. Every
// call here goes through a real gateway over in-memory stores and a fake fetch: no key, no network.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapError, GlobalCaps, TaskConfig } from '../../gateway/src/index.ts';
import { gatewayModelClient } from '../src/model-client.ts';
import { callSettings, PROVISIONAL_CAPS, REWRITE_TASKS, TASK_CONFIGS, taskConfig } from '../src/tasks.ts';
import { scriptedGateway, UnscriptedCallError, USER } from './scripted-gateway.ts';

const PROMPT_VERSION = 'rewrite-judge@test';
const conversation = { system: [{ type: 'text' as const, text: 'Judge each line.' }], messages: [{ role: 'user' as const, content: '1. Hola.' }] };

describe('the rewrite tasks', () => {
  it('names the four tasks of the design, each with a config the gateway accepts', () => {
    expect(REWRITE_TASKS).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge']);
    for (const task of REWRITE_TASKS) {
      const config = TaskConfig.parse(TASK_CONFIGS[task]);
      expect(config.task).toBe(task);
      // Fixed effort per task: no hard-case variant, so a call never changes the cached prefix's effort.
      expect(config.hardCaseEffort).toBeNull();
    }
  });

  it('edits with claude-fable-5-2 and judges with claude-sonnet-5-5 (D2)', () => {
    expect(taskConfig('rewrite.plan').model).toBe('claude-fable-5-2');
    expect(taskConfig('rewrite.edit').model).toBe('claude-fable-5-2');
    expect(taskConfig('rewrite.style').model).toBe('claude-fable-5-2');
    expect(taskConfig('rewrite.judge').model).toBe('claude-sonnet-5-5');
    expect(taskConfig('rewrite.judge').model).not.toBe(taskConfig('rewrite.edit').model);
  });

  it('has provisional caps the gateway accepts', () => {
    expect(GlobalCaps.parse(PROVISIONAL_CAPS)).toEqual(PROVISIONAL_CAPS);
  });

  it('builds the evals call settings from the task config, with no output format', () => {
    expect(callSettings('rewrite.judge', 3000)).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 3000, output_config: { effort: taskConfig('rewrite.judge').effort } });
  });
});

describe('gatewayModelClient', () => {
  it('routes the call through the gateway: the task config picks the model and the ledger gets a row', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: '{"lines":[]}', usage: { input: 120, output: 30 } }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    const reply = await client.create({ ...callSettings('rewrite.judge', 2000), ...conversation });
    expect(reply).toEqual({
      text: '{"lines":[]}',
      stopReason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const [call] = scripted.calls;
    expect(call?.request).toMatchObject({ task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION, maxTokens: 2000, system: ['Judge each line.'] });
    expect(call?.sent).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: taskConfig('rewrite.judge').effort } });
    expect(scripted.stores.usage.calls.map((row) => row.task)).toEqual(['rewrite.judge']);
    scripted.assertDone();
  });

  it('refuses settings that differ from the task config before calling', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'never sent' }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    await expect(client.create({ ...callSettings('rewrite.edit', 2000), ...conversation })).rejects.toThrow(/differ from the gateway task/);
    await expect(client.create({ model: 'claude-sonnet-5-5', max_tokens: 2000, ...conversation })).rejects.toThrow(/differ from the gateway task/);
    expect(scripted.calls).toEqual([]);
  });

  it('refuses an output format, which the gateway text call cannot send', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'never sent' }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    const settings = callSettings('rewrite.judge', 2000);
    const withFormat = { ...settings, output_config: { ...settings.output_config, format: { type: 'json_schema' as const, schema: { type: 'object' } } } };
    await expect(client.create({ ...withFormat, ...conversation })).rejects.toThrow(/output format/);
    expect(scripted.calls).toEqual([]);
  });

  it('refuses a conversation that does not end on a user turn', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'never sent' }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    const messages = [...conversation.messages, { role: 'assistant' as const, content: '{' }];
    await expect(client.create({ ...callSettings('rewrite.judge', 2000), system: conversation.system, messages })).rejects.toThrow(/user turn/);
    expect(scripted.calls).toEqual([]);
  });

  it('is held by the caps: once the day is spent, the next call is refused without reaching the API', async () => {
    // Fixture cap and usage: 100,000 output tokens of claude-sonnet-5-5 cost US$1 at the registry price.
    const scripted = scriptedGateway(
      { 'rewrite.judge': [{ text: 'first', usage: { input: 10, output: 100_000 } }, { text: 'second' }] },
      { caps: { perJobUsd: 0.5, dailyPerUserUsd: 0.5, monthlyUsd: 5 } },
    );
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    const settings = callSettings('rewrite.judge', 120_000);
    expect((await client.create({ ...settings, ...conversation })).text).toBe('first');
    const refused = client.create({ ...settings, ...conversation });
    await expect(refused).rejects.toBeInstanceOf(CapError);
    await expect(refused).rejects.toMatchObject({ code: 'cap_daily_user' });
    expect(scripted.calls.map((call) => call.sent === null)).toEqual([false, true]);
    expect(scripted.stores.usage.calls).toHaveLength(1);
  });
});

describe('scriptedGateway', () => {
  const PlanReply = z.strictObject({ items: z.array(z.string()) });
  const request = (task: string) => ({ task, userId: USER, promptVersion: 'test@1', maxTokens: 1000, system: ['rules'], messages: [{ role: 'user' as const, content: 'texto' }] as const });

  it('answers each task from its own script, in order, and records every request', async () => {
    const scripted = scriptedGateway({
      'rewrite.plan': [{ data: { items: ['plan'] } }],
      'rewrite.edit': [{ data: { items: ['edit 1'] } }, { data: { items: ['edit 2'] } }],
    });
    const g = scripted.gateway;
    expect((await g.structured(PlanReply, request('rewrite.edit'))).data.items).toEqual(['edit 1']);
    expect((await g.structured(PlanReply, request('rewrite.plan'))).data.items).toEqual(['plan']);
    expect((await g.structuredStream(PlanReply, request('rewrite.edit')).final).data.items).toEqual(['edit 2']);
    expect(scripted.calls.map((c) => [c.operation, c.task])).toEqual([
      ['structured', 'rewrite.edit'],
      ['structured', 'rewrite.plan'],
      ['structuredStream', 'rewrite.edit'],
    ]);
    scripted.assertDone();
  });

  it('sends the judge to a different model than the editor', async () => {
    const scripted = scriptedGateway({ 'rewrite.edit': [{ data: { items: [] } }], 'rewrite.judge': [{ data: { items: [] } }] });
    await scripted.gateway.structured(PlanReply, request('rewrite.edit'));
    await scripted.gateway.structured(PlanReply, request('rewrite.judge'));
    const [edit, judge] = scripted.calls.map((c) => c.sent?.model);
    expect(edit).toBe('claude-fable-5-2');
    expect(judge).toBe('claude-sonnet-5-5');
  });

  it('fails loudly on an unscripted call, and on a script left unused', async () => {
    const scripted = scriptedGateway({ 'rewrite.plan': [{ data: { items: [] } }] });
    await expect(scripted.gateway.structured(PlanReply, request('rewrite.edit'))).rejects.toThrow(UnscriptedCallError);
    await expect(scripted.gateway.text(request('rewrite.judge'))).rejects.toThrow(/rewrite\.judge/);
    expect(() => scripted.assertDone()).toThrow(/rewrite\.plan: 1/);
  });
});
