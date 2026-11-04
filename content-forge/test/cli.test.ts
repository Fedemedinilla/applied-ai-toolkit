// The command line end to end: validate, generate against a fake Anthropic API, stats, promote and
// validate again, with exit codes. One test runs cli.ts itself in a child process.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/commands.ts';
import { copyCatalog, response, writeJson } from './helpers/catalog-dir.ts';
import { apiError, fakeAnthropic, messageText, type Reply } from './helpers/fake-anthropic.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

/** The README's sample output: the one ```text block. */
async function readmeSample(): Promise<string[]> {
  const text = await readFile(README, 'utf8');
  const start = text.indexOf('```text\n');
  const end = text.indexOf('\n```', start + 1);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start + '```text\n'.length, end).split('\n');
}

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await copyCatalog());
});
afterEach(async () => {
  await cleanup();
});

function io(replies: readonly Reply[] = [], apiKey: string | null = 'sk-ant-test-not-a-key') {
  const out: string[] = [];
  const err: string[] = [];
  const api = fakeAnthropic(replies);
  const value: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), apiKey, fetch: api.fetch, now: () => new Date('2026-11-04T15:00:00.000Z'), log: () => {} };
  return { io: value, out, err, api };
}

describe('the command line', () => {
  it('runs the whole loop: validate, generate, stats, promote, validate', async () => {
    const a = io();
    expect(await runCli(['validate', '--dir', dir], a.io)).toBe(0);
    expect(a.out).toEqual(['catalogue valid: 5 keyword, 3 faction, 2 set, 13 card, 2 deck']);

    const b = io([messageText(await response('card-batch'))]);
    expect(await runCli(['generate', '--entity', 'card', '--count', '8', '--dir', dir], b.io)).toBe(0);
    // Word for word the sample in the README, so the two cannot drift apart.
    expect(b.out).toEqual(await readmeSample());

    const c = io();
    expect(await runCli(['stats', '--dir', dir], c.io)).toBe(0);
    expect(c.out).toEqual([
      'card card@1: 2/8 = 25% (95% CI 7% to 59%) over 1 run(s), 0 unusable; rejected at schema 1, rules 1, references 3; rules broken: cost-curve 1, no-legendary 1',
    ]);

    const d = io();
    expect(await runCli(['promote', '--entity', 'card', '--all', '--dir', dir], d.io)).toBe(0);
    expect(d.out).toEqual(['promoted card brine-scout', 'promoted card moss-lantern']);

    const e = io();
    expect(await runCli(['validate', '--dir', dir], e.io)).toBe(0);
    expect(e.out).toEqual(['catalogue valid: 5 keyword, 3 faction, 2 set, 15 card, 2 deck']);
  });

  it('exits 3 without a key, before any call', async () => {
    const r = io([], null);
    expect(await runCli(['generate', '--entity', 'card', '--count', '2', '--dir', dir], r.io)).toBe(3);
    expect(r.api.requests).toHaveLength(0);
    expect(r.err[0]).toContain('ANTHROPIC_API_KEY');
  });

  it('exits 3 on a gateway failure and prints its code, never the API message', async () => {
    const r = io([apiError(529, 'overloaded_error')]);
    expect(await runCli(['generate', '--entity', 'card', '--count', '2', '--dir', dir], r.io)).toBe(3);
    expect(r.err).toEqual(['the model call failed: overloaded']);
  });

  it('exits 1 when validate finds problems, with one line per problem', async () => {
    await writeJson(join(dir, 'factions', 'tide.json'), { id: 'tide', name: 'Tidebound', motto: 'What the sea takes, it returns.', rival: 'grove', handwritten: true });
    const r = io();
    expect(await runCli(['validate', '--dir', dir], r.io)).toBe(1);
    expect(r.err).toEqual([
      'faction/ember: rival: rival "tide" names "grove" instead of "ember"',
      'faction/tide: rival: rival "grove" names no rival instead of "tide"',
      '2 problem(s)',
    ]);
  });

  it('exits 1 when promote refuses, and moves nothing', async () => {
    await writeJson(join(dir, '_candidates', 'cards', 'flare.json'), { id: 'flare' });
    const r = io();
    expect(await runCli(['promote', '--entity', 'card', 'flare', '--dir', dir], r.io)).toBe(1);
    expect(r.err[0]).toContain('cards/flare.json: is hand-written, and promote never overwrites it');
    expect(await readdir(join(dir, '_candidates', 'cards'))).toEqual(['flare.json']);
  });

  it('prints one line for an unexpected error, with its code and no path or stack trace', async () => {
    const r = io();
    expect(await runCli(['validate', '--dir', README], r.io)).toBe(1);
    expect(r.err).toEqual(['validate failed: ENOTDIR']);
  });

  it.each([
    [[]],
    [['frobnicate']],
    [['generate', '--entity', 'spell', '--count', '2']],
    [['generate', '--entity', 'card', '--count', '20']],
    [['generate', '--entity', 'card', '--count', 'two']],
    [['promote', '--entity', 'card']],
    [['promote', '--entity', 'card', '--all', 'flare']],
    [['validate', '--colour']],
  ])('exits 2 on bad usage: %j', async (argv) => {
    const r = io();
    expect(await runCli([...argv, '--dir', dir], r.io)).toBe(2);
    expect(r.err.at(-1)).toContain('usage:');
    expect(r.api.requests).toHaveLength(0);
  });

  it('runs as a script: cli.ts validate on the example catalogue', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'validate'], { env: { PATH: process.env['PATH'] ?? '' } });
    expect(stdout).toBe('catalogue valid: 5 keyword, 3 faction, 2 set, 13 card, 2 deck\n');
  });

  it('runs as a script: generate without a key exits 3', async () => {
    const run = promisify(execFile)(process.execPath, [CLI, 'generate', '--entity', 'card', '--count', '1', '--dir', dir], { env: { PATH: process.env['PATH'] ?? '' } });
    await expect(run).rejects.toMatchObject({ code: 3 });
  });
});
