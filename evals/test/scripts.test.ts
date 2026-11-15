import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { BlindKey, BlindPiece } from '../src/blind.ts';
import type { JudgedPiece } from '../src/judge.ts';
import type { EvalRow } from '../src/runner.ts';

const dir = mkdtempSync(join(tmpdir(), 'evals-scripts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url));
const node = (...args: string[]) => {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r) + '\n').join('');

const row = (variant: string, sample: number): EvalRow => ({
  variant,
  lang: 'en',
  case: 'c',
  sample,
  now: '2026-03-04T12:00:00.000Z',
  brief: 'b',
  text: 'Fixed.',
  words: 1,
  stop: 'end_turn',
  ms: 1,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

describe('blind.ts', () => {
  it('writes neither file when one of them already exists', () => {
    const rows = file('rows.jsonl', jsonl([row('V0', 1), row('V4', 1)]));
    const pieces = join(dir, 'p.jsonl');
    const key = file('k.json', '{}');
    const r = node(script('blind'), rows, pieces, key, '--seed', '1');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('k.json already exists');
    expect(existsSync(pieces)).toBe(false);
  });
});

describe('runs.ts', () => {
  const pieces: BlindPiece[] = ['a', 'b'].map((id) => ({ id, case: 'c', lang: 'en', now: '2026-03-04T12:00:00.000Z', brief: 'b', text: 'Fixed.' }));
  const key: BlindKey = {
    a: { variant: 'V0', lang: 'en', case: 'c', sample: 1, stop: 'end_turn' },
    b: { variant: 'V4', lang: 'en', case: 'c', sample: 1, stop: 'end_turn' },
  };
  const verdict = (id: string): JudgedPiece => ({ id, judge: 1, lines: [{ line: 1, support: 'no-claim', note: '' }], voice: 'on', robotic: false, quality: 4, note: '' });

  it('writes no run when a later output file already exists', () => {
    const p = file('rp.jsonl', jsonl(pieces));
    const k = file('rk.json', JSON.stringify({ seed: 1, key }));
    const v = file('rv.jsonl', jsonl([verdict('a'), verdict('b')]));
    const prefix = join(dir, 'out');
    file('out-V4.json', '{}');
    const r = node(script('runs'), p, k, v, prefix);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('out-V4.json already exists');
    expect(existsSync(`${prefix}-V0.json`)).toBe(false);
    rmSync(`${prefix}-V4.json`);
    const ok = node(script('runs'), p, k, v, prefix);
    expect(ok).toMatchObject({ status: 0, stderr: '' });
    expect(ok.stdout).toContain('V0: 1/1 pass');
  });
});
