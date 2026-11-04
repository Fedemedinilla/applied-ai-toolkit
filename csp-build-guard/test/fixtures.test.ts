import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageWeight } from '../src/checks/js-budget.ts';
import { loadConfig } from '../src/config.ts';
import { runGuard } from '../src/run.ts';
import type { CheckId, GuardReport } from '../src/types.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const SECRET = 'fixture-secret-value-0001';
const env = { FIXTURE_SECRET: SECRET };

async function run(name: string, dir = 'site', environment: Record<string, string | undefined> = env): Promise<GuardReport> {
  const config = await loadConfig(join(FIXTURES, name, 'csp-guard.config.json'));
  return runGuard({ dir: join(FIXTURES, name, dir), config, env: environment });
}

const statuses = (report: GuardReport) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
const messages = (report: GuardReport, id: CheckId) => report.checks.find((c) => c.id === id)?.failures.map((f) => f.message) ?? [];
const ALL_PASS = { 'inline-hashes': 'pass', policy: 'pass', headers: 'pass', secrets: 'pass', lookbehind: 'pass', 'js-budget': 'pass' };

describe('fixtures that pass', () => {
  it.each([
    ['pass', 'site'],
    ['netlify', 'site'],
  ])('%s passes every check', async (name, dir) => {
    const report = await run(name, dir);
    expect(statuses(report)).toEqual(ALL_PASS);
    expect(report.ok).toBe(true);
  });

  it('meta passes with the policy read from each page', async () => {
    const report = await run('meta');
    expect(statuses(report)).toEqual({ ...ALL_PASS, headers: 'skip' });
  });

  it('measures each page with its static imports, and not the dynamic one', async () => {
    const report = await run('pass');
    const weights = report.checks.find((c) => c.id === 'js-budget')?.details as PageWeight[];
    const urls = Object.fromEntries(weights.map((w) => [w.page, w.files.map((f) => f.url).sort()]));
    expect(urls).toEqual({
      'index.html': ['/_astro/app.js', '/_astro/chunk.js'],
      'about/index.html': ['/_astro/chunk.js', '/_astro/client.js', '/_astro/island.js'],
    });
    for (const w of weights) {
      expect(w.total.gzip).toBeGreaterThan(0);
      expect(w.total.brotli).toBeGreaterThan(0);
      expect(w.unmeasured).toEqual([]);
    }
  });
});

describe('fixtures that fail one check each', () => {
  it('stale-hash: the edited script is blocked and the old hash is stale', async () => {
    const report = await run('stale-hash');
    expect(statuses(report)).toEqual({ ...ALL_PASS, 'inline-hashes': 'fail' });
    const [blocked, stale] = messages(report, 'inline-hashes');
    expect(blocked).toMatch(/^script-src does not list 'sha256-[^']+', the hash of an inline <script> on about\/index.html and 1 more page\. The browser blocks it/);
    expect(stale).toMatch(/^script-src lists 'sha256-[^']+', which matches no inline content/);
  });

  it("unsafe-inline: fails the inline check and the exact policy", async () => {
    const report = await run('unsafe-inline');
    expect(statuses(report)).toEqual({ ...ALL_PASS, 'inline-hashes': 'fail', policy: 'fail' });
    expect(messages(report, 'inline-hashes')).toEqual([expect.stringContaining("script-src has 'unsafe-inline'")]);
    expect(messages(report, 'policy')).toEqual(["about/index.html and 1 more page: script-src: unexpected 'unsafe-inline'"]);
  });

  it('inline-handler: an onclick attribute is blocked by a hash-only script-src', async () => {
    const report = await run('inline-handler');
    expect(statuses(report)).toEqual({ ...ALL_PASS, 'inline-hashes': 'fail' });
    expect(messages(report, 'inline-hashes')).toEqual([expect.stringMatching(/^<button onclick> on index\.html is blocked by script-src: an attribute needs 'unsafe-hashes'/)]);
  });

  it('policy-drift: extra source, repeated and dropped directives, an unlisted one, two rules for one page', async () => {
    const report = await run('policy-drift');
    expect(report.checks.find((c) => c.id === 'policy')?.status).toBe('fail');
    const policy = messages(report, 'policy');
    expect(policy).toContain('index.html: connect-src: unexpected https:');
    expect(policy).toContain('index.html: script-src is repeated: the browser uses the first and ignores the rest');
    expect(policy).toContain("index.html: object-src 'none' has non-ASCII characters: the browser drops it");
    expect(policy).toContain('index.html: unexpected directive upgrade-insecure-requests');
    expect(policy.find((m) => m.startsWith('about/index.html: 2 rules set Content-Security-Policy'))).toBeDefined();
  });

  it('secret-leak: finds the plain value in a bundle and a base64 copy inside a .gz file, and never prints the value', async () => {
    const report = await run('secret-leak');
    expect(statuses(report)).toEqual({ ...ALL_PASS, secrets: 'fail' });
    expect(messages(report, 'secrets')).toEqual([
      'the value of FIXTURE_SECRET is in _astro/app.js',
      'the value of FIXTURE_SECRET is in _astro/data.json.gz (base64)',
    ]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('secrets: an unset or short variable fails by default, since the check could not run', async () => {
    const report = await run('pass', 'site', { FIXTURE_SECRET: 'short' });
    expect(messages(report, 'secrets')).toEqual(['FIXTURE_SECRET is shorter than 8 characters: run the guard with the environment the build used']);
    expect(messages(await run('pass', 'site', {}), 'secrets')).toEqual([expect.stringContaining('FIXTURE_SECRET is not set')]);
  });

  it('lookbehind: reports file, line and column, and not the named group', async () => {
    const report = await run('lookbehind');
    expect(statuses(report)).toEqual({ ...ALL_PASS, lookbehind: 'fail' });
    expect(messages(report, 'lookbehind')).toEqual([
      '_astro/app.js:2:34: 1 regex lookbehind, which Safari 15.6 cannot parse; in a regex literal the whole script fails to load',
    ]);
  });

  it('over-budget: the page over its gzip budget fails, the other passes its brotli budget', async () => {
    const report = await run('over-budget');
    expect(statuses(report)).toEqual({ ...ALL_PASS, 'js-budget': 'fail' });
    expect(messages(report, 'js-budget')).toEqual([expect.stringMatching(/^index\.html: 0\.\d kB gzip, budget 0\.1 kB \(largest: \/_astro\/app\.js/)]);
  });

  it('meta-misplaced: a meta after the inline script, and frame-ancestors in a meta policy', async () => {
    const report = await run('meta-misplaced');
    expect(messages(report, 'policy')).toEqual([
      'index.html: the <meta> policy comes after a script or style, which runs before the policy applies',
      'index.html: frame-ancestors has no effect in a <meta> policy; send it as a header',
    ]);
  });

  it('vercel-output: reads static/ and config.json, and finds the secret in the server function', async () => {
    const report = await run('vercel-output', 'output');
    expect(statuses(report)).toEqual({ ...ALL_PASS, secrets: 'fail' });
    expect(report.staticRoot.endsWith(join('output', 'static'))).toBe(true);
    expect(messages(report, 'secrets')).toEqual(['the value of FIXTURE_SECRET is in functions/_render.func/index.mjs']);
  });
});
