import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTestEnv, crossingNames, DEFAULT_POLICY, envLeaks, type IsolationPolicy } from '../src/test-env.ts';

/** The default policy plus a database prefix, with the two names a local stack needs kept. */
const POLICY: IsolationPolicy = {
  ...DEFAULT_POLICY,
  prefixes: [...DEFAULT_POLICY.prefixes, 'SUPABASE_'],
  keep: new Set(['SUPABASE_EXPERIMENTAL_STACK', 'SUPABASE_NATIVE_POSTGRES_USER']),
};

/** A session environment with credentials loaded. Every value is fake. */
const session = (): NodeJS.ProcessEnv => ({
  APP_ANTHROPIC_KEY: 'session-value',
  ANTHROPIC_API_KEY: 'session-value',
  ANTHROPIC_BASE_URL: 'https://proxy.example.test',
  ANTHROPIC_CUSTOM_HEADERS: 'x-session: 1',
  ANTHROPIC_LOG: 'debug',
  CLAUDE_CODE_OAUTH_TOKEN: 'session-value',
  SUPABASE_ACCESS_TOKEN: 'session-value',
  SUPABASE_SECRET_KEY: 'session-value',
  SUPABASE_EXPERIMENTAL_STACK: '1',
  SUPABASE_NATIVE_POSTGRES_USER: 'postgres',
  PUBLIC_APP_URL: 'https://app.example.test',
  PATH: '/usr/bin',
});

describe('applyTestEnv', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-playbook-env-'));
    writeFileSync(join(root, '.env.test'), 'APP_ANTHROPIC_KEY=placeholder-test\nSUPABASE_SECRET_KEY=placeholder-test\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports each leak by name, then leaves test values, kept names and unrelated variables', () => {
    const env = session();
    expect(envLeaks(root, POLICY, env)).toEqual([
      'ANTHROPIC_API_KEY: comes from the session environment',
      'ANTHROPIC_BASE_URL: comes from the session environment',
      'ANTHROPIC_CUSTOM_HEADERS: comes from the session environment',
      'ANTHROPIC_LOG: comes from the session environment',
      "APP_ANTHROPIC_KEY: does not hold the test file's value",
      'CLAUDE_CODE_OAUTH_TOKEN: comes from the session environment',
      'SUPABASE_ACCESS_TOKEN: comes from the session environment',
      "SUPABASE_SECRET_KEY: does not hold the test file's value",
    ]);

    applyTestEnv(root, POLICY, env);

    expect(env).toEqual({
      APP_ANTHROPIC_KEY: 'placeholder-test',
      SUPABASE_SECRET_KEY: 'placeholder-test',
      SUPABASE_EXPERIMENTAL_STACK: '1',
      SUPABASE_NATIVE_POSTGRES_USER: 'postgres',
      PUBLIC_APP_URL: 'https://app.example.test',
      PATH: '/usr/bin',
    });
    expect(envLeaks(root, POLICY, env)).toEqual([]);
  });

  it('never prints a value', () => {
    const report = envLeaks(root, POLICY, session()).join('\n');
    expect(report).not.toContain('session-value');
    expect(report).not.toContain('proxy.example.test');
  });

  it('keeps what the local file overrides on purpose, even under an isolated prefix', () => {
    writeFileSync(join(root, '.env.test.local'), 'ANTHROPIC_BASE_URL=http://127.0.0.1:9999\nSUPABASE_SECRET_KEY=local-stack\n');
    const env = session();

    applyTestEnv(root, POLICY, env);

    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9999');
    expect(env['SUPABASE_SECRET_KEY']).toBe('local-stack');
    expect(env['ANTHROPIC_LOG']).toBeUndefined();
    expect(envLeaks(root, POLICY, env)).toEqual([]);
  });

  it('throws without the test file, because the suite would run on the session values', () => {
    rmSync(join(root, '.env.test'));
    expect(() => applyTestEnv(root, POLICY, session())).toThrow(/Missing .*\.env\.test/);
  });

  it('touches only the env object it is given', () => {
    const before = { ...process.env };
    applyTestEnv(root, POLICY, session());
    expect(process.env).toEqual(before);
  });
});

// Why the isolation exists: the SDK reads these variables even when it is given a key.
describe('the Anthropic SDK and the session environment', () => {
  const NAMES = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_LOG'] as const;
  let saved: Partial<Record<(typeof NAMES)[number], string>>;

  beforeEach(() => {
    saved = {};
    for (const name of NAMES) {
      const value = process.env[name];
      if (value !== undefined) saved[name] = value;
    }
  });

  afterEach(() => {
    for (const name of NAMES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('takes the base URL and the log level from the environment despite an explicit apiKey', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'https://proxy.example.test';
    process.env['ANTHROPIC_LOG'] = 'debug';
    const client = new Anthropic({ apiKey: 'placeholder-test' });
    expect(client.baseURL).toBe('https://proxy.example.test');
    expect(client.logLevel).toBe('debug');
  });

  it('goes back to its defaults once the isolation has removed them', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-playbook-sdk-'));
    try {
      writeFileSync(join(root, '.env.test'), 'APP_ANTHROPIC_KEY=placeholder-test\n');
      const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://proxy.example.test', ANTHROPIC_LOG: 'debug' };
      applyTestEnv(root, DEFAULT_POLICY, env);
      for (const name of NAMES) {
        if (env[name] === undefined) delete process.env[name];
      }
      const client = new Anthropic({ apiKey: 'placeholder-test' });
      expect(client.baseURL).toBe('https://api.anthropic.com');
      expect(client.logLevel).not.toBe('debug');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('crossingNames', () => {
  it('flags an app variable that shares a prefix with the agent session', () => {
    expect(crossingNames(['APP_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY', 'PUBLIC_APP_URL'])).toEqual(['ANTHROPIC_API_KEY']);
    expect(crossingNames(['APP_ANTHROPIC_KEY', 'APP_DATABASE_URL'])).toEqual([]);
  });
});
