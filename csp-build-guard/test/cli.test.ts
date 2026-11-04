import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FOLDER = join(import.meta.dirname, '..');
const CLI = join(FOLDER, 'cli.ts');
const SECRET = 'fixture-secret-value-0001';

function cli(args: string[], env: Record<string, string> = { FIXTURE_SECRET: SECRET }) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const fixture = (name: string, dir = 'site') => ['--dir', join(FOLDER, 'fixtures', name, dir), '--config', join(FOLDER, 'fixtures', name, 'csp-guard.config.json')];

describe('cli', () => {
  it('exits 0 and prints one line per check for a passing build', () => {
    const { code, stdout } = cli(fixture('pass'));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^PASS inline-hashes /m);
    expect(stdout).toMatch(/^OK: 6 checks passed, 0 skipped$/m);
  });

  it('exits 1 on a failure and never prints a secret value, in text or JSON', () => {
    const text = cli(fixture('secret-leak'));
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('FAIL secrets');
    const json = cli([...fixture('secret-leak'), '--json']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout) as { ok: boolean; checks: Array<{ id: string; status: string }> };
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'secrets')?.status).toBe('fail');
    expect(text.stdout + text.stderr + json.stdout + json.stderr).not.toContain(SECRET);
  });

  it('exits 2 on bad usage, a missing folder or an invalid config', () => {
    expect(cli([]).code).toBe(2);
    expect(cli(['--dir']).code).toBe(2);
    expect(cli(['--dir', join(FOLDER, 'fixtures', 'pass', 'site'), '--bogus']).code).toBe(2);
    const missing = cli(['--dir', join(FOLDER, 'fixtures', 'nope'), '--config', join(FOLDER, 'fixtures', 'pass', 'csp-guard.config.json')]);
    expect(missing).toMatchObject({ code: 2, stderr: expect.stringContaining('is not a folder') });

    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-'));
    const bad = join(tmp, 'csp-guard.config.json');
    writeFileSync(bad, JSON.stringify({ budgets: [{ pages: '**' }], policy: { 'Script-Src': ["'self'"] } }));
    const invalid = cli(['--dir', join(FOLDER, 'fixtures', 'pass', 'site'), '--config', bad]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('budgets.0: a budget needs gzipKb, brotliKb or both');
    expect(invalid.stderr).toContain('policy.Script-Src');

    writeFileSync(bad, JSON.stringify({ csp: { from: 'vercel-json', file: 'missing.json' } }));
    expect(cli(['--dir', join(FOLDER, 'fixtures', 'pass', 'site'), '--config', bad])).toMatchObject({ code: 2, stderr: expect.stringContaining('does not exist') });
  });

  it('loads a .ts config through its default export', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-'));
    const config = join(tmp, 'csp-guard.config.ts');
    writeFileSync(config, `const config = { csp: { from: 'literal', value: "script-src 'none'" }, policy: { 'script-src': ["'none'"] } };\nexport default config;\n`);
    const { code, stdout } = cli(['--dir', join(FOLDER, 'fixtures', 'pass', 'site'), '--config', config]);
    // The literal policy lists no hash, so the inline theme script is blocked; the exact policy matches.
    expect(code).toBe(1);
    expect(stdout).toMatch(/^FAIL inline-hashes /m);
    expect(stdout).toMatch(/^PASS policy /m);
  });
});
