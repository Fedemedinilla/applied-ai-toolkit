// The rewriter's model-facing building blocks: the four task configs with the caps measured in F6,
// the evals ModelClient over the gateway, and the scripted gateway the stage tests will use. Every
// call here goes through a real gateway over in-memory stores and a fake fetch: no key, no network.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapError, GlobalCaps, TaskConfig } from '../../gateway/src/index.ts';
import { gatewayModelClient } from '../src/model-client.ts';
import { callSettings, REWRITE_CAPS, REWRITE_TASKS, TASK_CONFIGS, taskConfig } from '../src/tasks.ts';
import { ScriptMismatchError, scriptedGateway, UnscriptedCallError, USER } from './scripted-gateway.ts';

const PROMPT_VERSION = 'rewrite-judge@test';
const JOB_A = '00000000-0000-4000-8000-00000000a001';
const JOB_B = '00000000-0000-4000-8000-00000000b001';
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

  it('runs every task at effort medium, the level measured in the fourth F6b run (D2)', () => {
    // medium is what Agency-Seeker's Fable 5.2 writer runs at (WRITER_EFFORT) and what evals' judge uses.
    expect(REWRITE_TASKS.map((task) => [task, taskConfig(task).effort])).toEqual([
      ['rewrite.plan', 'medium'],
      ['rewrite.edit', 'medium'],
      ['rewrite.style', 'medium'],
      ['rewrite.judge', 'medium'],
    ]);
  });

  it('has the caps measured in F6, which the gateway accepts', () => {
    expect(GlobalCaps.parse(REWRITE_CAPS)).toEqual(REWRITE_CAPS);
    expect(REWRITE_CAPS).toEqual({ perJobUsd: 0.25, dailyPerUserUsd: 2, monthlyUsd: 10 });
    // Above the highest p90 per rewrite measured in run 4 (US$0.1412, staged follow-up).
    expect(REWRITE_CAPS.perJobUsd).toBeGreaterThan(0.1412);
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

  it('reports the cache reads and both kinds of cache writes the gateway measured', async () => {
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'ok', usage: { input: 10, output: 2, cacheRead: 30, cacheWrite5m: 7, cacheWrite1h: 5 } }] });
    const client = gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, promptVersion: PROMPT_VERSION });
    const reply = await client.create({ ...callSettings('rewrite.judge', 2000), ...conversation });
    expect(reply.usage).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 12 });
  });

  it('passes the job id, so the per-job cap holds the calls of one rewrite', async () => {
    // Fixture usage: 60,000 output tokens of claude-sonnet-5-5 cost US$0.60, over the US$0.25 per job.
    const scripted = scriptedGateway({ 'rewrite.judge': [{ text: 'first', usage: { input: 10, output: 60_000 } }, { text: 'other job' }, { text: 'never sent' }] });
    const job = (jobId: string) => gatewayModelClient(scripted.gateway, { task: 'rewrite.judge', userId: USER, jobId, promptVersion: PROMPT_VERSION });
    const settings = callSettings('rewrite.judge', 70_000);
    expect((await job(JOB_A).create({ ...settings, ...conversation })).text).toBe('first');
    expect(scripted.stores.usage.calls.map((row) => row.jobId)).toEqual([JOB_A]);
    await expect(job(JOB_A).create({ ...settings, ...conversation })).rejects.toMatchObject({ code: 'cap_per_job' });
    expect((await job(JOB_B).create({ ...settings, ...conversation })).text).toBe('other job');
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

  it('keeps the reply of a call the gateway refused before the API, for the next call of its task', async () => {
    const scripted = scriptedGateway({ 'rewrite.plan': [{ data: { items: ['for call 1'] } }, { data: { items: ['for call 2'] } }] });
    const g = scripted.gateway;
    await expect(g.structured(PlanReply, { ...request('rewrite.plan'), userId: 'not-a-uuid' })).rejects.toThrow(/userId/);
    const streamed = g.structuredStream(PlanReply, { ...request('rewrite.plan'), userId: 'not-a-uuid' });
    await expect(streamed.final).rejects.toThrow(/userId/);
    expect((await g.structured(PlanReply, request('rewrite.plan'))).data.items).toEqual(['for call 1']);
    expect(scripted.calls.map((c) => c.sent !== null)).toEqual([false, false, true]);
    expect(() => scripted.assertDone()).toThrow(/rewrite\.plan: 1/);
    expect((await g.structured(PlanReply, request('rewrite.plan'))).data.items).toEqual(['for call 2']);
    scripted.assertDone();
  });

  it('answers a structured call only with a data reply, and a text call only with a text reply', async () => {
    const scripted = scriptedGateway({ 'rewrite.edit': [{ data: { items: ['x'] } }], 'rewrite.plan': [{ text: '{"items":["y"]}' }] });
    const g = scripted.gateway;
    await expect(g.text(request('rewrite.edit'))).rejects.toThrow(ScriptMismatchError);
    await expect(g.structured(PlanReply, request('rewrite.plan'))).rejects.toThrow(/text reply.*structured/);
    await expect(g.structuredStream(PlanReply, request('rewrite.plan')).final).rejects.toThrow(ScriptMismatchError);
    // A mismatch uses no reply: the script still holds both.
    expect(scripted.calls).toEqual([]);
    expect((await g.structured(PlanReply, request('rewrite.edit'))).data.items).toEqual(['x']);
    expect((await g.text(request('rewrite.plan'))).text).toBe('{"items":["y"]}');
    scripted.assertDone();
  });

  it('fails loudly on an unscripted call, and on a script left unused', async () => {
    const scripted = scriptedGateway({ 'rewrite.plan': [{ data: { items: [] } }] });
    await expect(scripted.gateway.structured(PlanReply, request('rewrite.edit'))).rejects.toThrow(UnscriptedCallError);
    await expect(scripted.gateway.text(request('rewrite.judge'))).rejects.toThrow(/rewrite\.judge/);
    expect(() => scripted.assertDone()).toThrow(/rewrite\.plan: 1/);
  });
});
