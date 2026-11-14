import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { formatReport } from '../src/report.ts';
import { runGuard } from '../src/run.ts';
import { fingerprintKey, FINGERPRINT_KEY, INFORMATION_URI, RULES, SARIF_SCHEMA, withoutContentHashes } from '../src/sarif.ts';
import type { CheckId, GuardReport } from '../src/types.ts';

const FOLDER = join(import.meta.dirname, '..');
const ROOT = join(FOLDER, '..');
const CLI = join(FOLDER, 'cli.ts');
const SECRET = 'fixture-secret-value-0001';
const ENV = { FIXTURE_SECRET: SECRET };

function cli(args: string[], { env = ENV, cwd = ROOT }: { env?: Record<string, string>; cwd?: string } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** --dir and --config of a fixture, relative to the repository root, the CLI's working folder here. */
const fixture = (name: string, dir = 'site') => [
  '--dir', `csp-build-guard/fixtures/${name}/${dir}`, '--config', `csp-build-guard/fixtures/${name}/csp-guard.config.json`,
];

/**
 * What GitHub code scanning requires of an upload, from its SARIF support page: version 2.1.0, a
 * driver name, rules with an id, and results with a ruleId, a message text and a physical location
 * whose uri is relative to the repository (or a file: URI). The schema is strict where the guard's
 * output is fixed, so a renamed or missing field fails here before it fails an upload.
 */
const relativeUri = z.string().regex(/^(?!\/)(?![a-z][a-z0-9+.-]*:)[^\\]+$/i, 'a relative URI with forward slashes');
const region = z.strictObject({ startLine: z.number().int().min(1), startColumn: z.number().int().min(1).optional() });
const result = z.strictObject({
  ruleId: z.string().min(1),
  ruleIndex: z.number().int().min(0),
  level: z.enum(['error', 'warning', 'note', 'none']),
  message: z.strictObject({ text: z.string().min(1) }),
  locations: z
    .array(z.strictObject({ physicalLocation: z.strictObject({ artifactLocation: z.strictObject({ uri: z.union([relativeUri, z.string().startsWith('file:///')]) }), region: region.optional() }) }))
    .length(1),
  partialFingerprints: z.record(z.string(), z.string().min(1)),
});
const sarifSchema = z.strictObject({
  $schema: z.literal(SARIF_SCHEMA),
  version: z.literal('2.1.0'),
  runs: z
    .array(
      z.strictObject({
        tool: z.strictObject({
          driver: z.strictObject({
            name: z.literal('csp-build-guard'),
            informationUri: z.literal(INFORMATION_URI),
            rules: z.array(
              z.strictObject({
                id: z.string().min(1),
                name: z.string().min(1),
                shortDescription: z.strictObject({ text: z.string().min(1) }),
                fullDescription: z.strictObject({ text: z.string().min(1) }),
                helpUri: z.url(),
                defaultConfiguration: z.strictObject({ level: z.literal('error') }),
              }),
            ),
          }),
        }),
        invocations: z.array(
          z.strictObject({
            executionSuccessful: z.boolean(),
            toolExecutionNotifications: z.array(
              z.strictObject({ level: z.literal('note'), message: z.strictObject({ text: z.string() }), descriptor: z.strictObject({ id: z.string() }) }),
            ),
          }),
        ),
        columnKind: z.literal('utf16CodeUnits'),
        results: z.array(result),
      }),
    )
    .length(1),
}).superRefine((log, ctx) => {
  const run = log.runs[0];
  if (run === undefined) return;
  run.results.forEach((r, i) => {
    if (run.tool.driver.rules[r.ruleIndex]?.id !== r.ruleId) ctx.addIssue({ code: 'custom', message: `result ${i}: ruleIndex does not point at ${r.ruleId}` });
  });
});
type Sarif = z.infer<typeof sarifSchema>;
type Result = Sarif['runs'][number]['results'][number];

function sarif(args: string[], options?: Parameters<typeof cli>[1]): { code: number | null; log: Sarif; results: Result[]; stdout: string } {
  const out = cli([...args, '--sarif'], options);
  const log = sarifSchema.parse(JSON.parse(out.stdout));
  return { code: out.code, log, results: log.runs[0]?.results ?? [], stdout: out.stdout };
}
/** The item at an index, or a failed test when there is none. */
function at<T>(list: readonly T[], index = 0): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${index} in a list of ${list.length}`);
  return item;
}
const uriOf = (r: Result) => r.locations[0]?.physicalLocation.artifactLocation.uri;
const regionOf = (r: Result) => r.locations[0]?.physicalLocation.region;
const fingerprintOf = (r: Result) => r.partialFingerprints[FINGERPRINT_KEY];

async function report(name: string, dir = 'site', env: Record<string, string> = ENV): Promise<GuardReport> {
  const config = await loadConfig(join(FOLDER, 'fixtures', name, 'csp-guard.config.json'));
  return runGuard({ dir: join(FOLDER, 'fixtures', name, dir), config, env });
}

describe('--sarif', () => {
  it('a passing build is a valid log with every rule, no result, and exit 0', () => {
    const { code, log, results } = sarif(fixture('pass'));
    expect(code).toBe(0);
    expect(results).toEqual([]);
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual(['inline-hashes', 'policy', 'headers', 'secrets', 'lookbehind', 'js-budget']);
  });

  const FAILING: Array<[string, string]> = [
    ['stale-hash', 'site'], ['unsafe-inline', 'site'], ['inline-handler', 'site'], ['policy-drift', 'site'], ['secret-leak', 'site'],
    ['lookbehind', 'site'], ['over-budget', 'site'], ['meta-misplaced', 'site'], ['vercel-output', 'output'],
  ];

  it.each(FAILING)('%s: every failure of every failing check is one error result, and the exit code is 1', async (name, dir) => {
    const expected = await report(name, dir);
    const { code, results } = sarif(fixture(name, dir));
    expect(code).toBe(1);
    const failures = expected.checks.flatMap((c) => (c.status === 'fail' ? c.failures.map((f) => ({ ruleId: c.id, text: f.message, file: f.file })) : []));
    expect(failures.length).toBeGreaterThan(0);
    expect(results.map((r) => ({ ruleId: r.ruleId, text: r.message.text })).sort((a, b) => (a.text < b.text ? -1 : 1))).toEqual(
      failures.map(({ ruleId, text }) => ({ ruleId, text })).sort((a, b) => (a.text < b.text ? -1 : 1)),
    );
    for (const r of results) expect(r.level).toBe('error');
    // A failure about a file points at it in the build; one about no file points at the config.
    for (const f of failures) {
      const r = at(results.filter((x) => x.message.text === f.text));
      expect(uriOf(r)).toBe(f.file === undefined ? `csp-build-guard/fixtures/${name}/csp-guard.config.json` : `csp-build-guard/fixtures/${name}/${dir}/${f.file}`);
    }
  });

  it('covers every check: the six rules each map at least one failure', async () => {
    const seen = new Set<string>();
    for (const [name, dir] of FAILING) for (const r of sarif(fixture(name, dir)).results) seen.add(r.ruleId);
    // headers fails in no committed fixture; a literal policy with a headers map makes it fail.
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-sarif-'));
    const config = join(tmp, 'csp-guard.config.json');
    writeFileSync(config, JSON.stringify({ csp: { from: 'literal', value: "default-src 'self'" }, headers: { 'X-Content-Type-Options': 'nosniff' }, lookbehind: false }));
    for (const r of sarif(['--dir', 'csp-build-guard/fixtures/pass/site', '--config', config]).results) seen.add(r.ruleId);
    expect([...seen].sort()).toEqual((Object.keys(RULES) as CheckId[]).sort());
  });

  it('a check that could not run is an error result at the config file, never dropped', () => {
    const { code, results } = sarif(fixture('pass'), { env: {} });
    expect(code).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ruleId: 'secrets',
      level: 'error',
      message: { text: expect.stringContaining('FIXTURE_SECRET is not set') },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'csp-build-guard/fixtures/pass/csp-guard.config.json' } } }],
    });
    expect(regionOf(at(results))).toBeUndefined();

    // headers with a csp source that carries no headers: the check cannot run, and fails.
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-sarif-'));
    const config = join(tmp, 'csp-guard.config.json');
    writeFileSync(config, JSON.stringify({ csp: { from: 'meta' }, headers: { 'X-Content-Type-Options': 'nosniff' }, lookbehind: false }));
    const headers = sarif(['--dir', 'csp-build-guard/fixtures/meta/site', '--config', config]);
    expect(headers.results.find((r) => r.ruleId === 'headers')).toMatchObject({
      level: 'error',
      message: { text: 'the csp source is meta, which carries no response headers' },
      locations: [{ physicalLocation: { artifactLocation: { uri: pathToFileURL(config).href } } }],
    });
  });

  it('lists skipped checks as notes of the run, not as results', () => {
    const { code, log, results } = sarif(fixture('meta'));
    expect(code).toBe(0);
    expect(results).toEqual([]);
    expect(log.runs[0]?.invocations[0]?.toolExecutionNotifications).toEqual([
      { level: 'note', message: { text: 'headers skipped: no headers in the config' }, descriptor: { id: 'headers' } },
    ]);
  });

  it('gives the line and column the lookbehind check found, and no region where no line is known', () => {
    const { results } = sarif(fixture('lookbehind'));
    expect(results).toHaveLength(1);
    expect(uriOf(at(results))).toBe('csp-build-guard/fixtures/lookbehind/site/_astro/app.js');
    expect(regionOf(at(results))).toEqual({ startLine: 2, startColumn: 34 });
    for (const [name, dir] of FAILING) {
      for (const r of sarif(fixture(name, dir)).results) if (r.ruleId !== 'lookbehind') expect(regionOf(r)).toBeUndefined();
    }
  });

  it('makes paths relative to the current folder, or to --sarif-base, with forward slashes', () => {
    const fromRoot = sarif(fixture('secret-leak')).results.map(uriOf);
    expect(fromRoot).toEqual(['csp-build-guard/fixtures/secret-leak/site/_astro/app.js', 'csp-build-guard/fixtures/secret-leak/site/_astro/data.json.gz']);

    const fromFolder = sarif([...fixture('secret-leak'), '--sarif-base', 'csp-build-guard']).results.map(uriOf);
    expect(fromFolder).toEqual(['fixtures/secret-leak/site/_astro/app.js', 'fixtures/secret-leak/site/_astro/data.json.gz']);

    // Run from inside the build folder with absolute arguments and the repository root as base.
    const site = join(FOLDER, 'fixtures', 'secret-leak', 'site');
    const absolute = ['--dir', site, '--config', join(FOLDER, 'fixtures', 'secret-leak', 'csp-guard.config.json')];
    expect(sarif([...absolute, '--sarif-base', ROOT], { cwd: site }).results.map(uriOf)).toEqual(fromRoot);
    expect(sarif(absolute, { cwd: site }).results.map(uriOf)).toEqual(['_astro/app.js', '_astro/data.json.gz']);

    // A config outside the base cannot be a relative path in the repository: it is a file: URI.
    const inside = sarif(['--dir', site, '--config', join(FOLDER, 'fixtures', 'pass', 'csp-guard.config.json'), '--sarif-base', site], { env: {} }).results;
    expect(inside.map(uriOf)).toEqual([pathToFileURL(join(FOLDER, 'fixtures', 'pass', 'csp-guard.config.json')).href]);
  });

  it('prints the same bytes on every run, with results sorted by rule, path, line and message', () => {
    for (const [name, dir] of FAILING) {
      const first = sarif(fixture(name, dir));
      expect(sarif(fixture(name, dir)).stdout).toBe(first.stdout);
      const keys = first.results.map((r) => [r.ruleIndex, uriOf(r) ?? '', regionOf(r)?.startLine ?? 0, r.message.text] as const);
      const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
      expect(keys).toEqual(sorted);
      const fingerprints = first.results.map(fingerprintOf);
      expect(new Set(fingerprints).size).toBe(fingerprints.length);
    }
  });

  it("links each rule to a heading of the README, as GitHub builds the heading's anchor", () => {
    const anchors = readFileSync(join(FOLDER, 'README.md'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#+\s*/, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-'));
    for (const rule of Object.values(RULES)) expect(anchors).toContain(rule.anchor);
  });

  it('never prints a secret value', () => {
    const out = cli([...fixture('secret-leak'), '--sarif']);
    const vercel = cli([...fixture('vercel-output', 'output'), '--sarif']);
    expect(out.stdout + out.stderr + vercel.stdout + vercel.stderr).not.toContain(SECRET);
  });
});

describe('fingerprints', () => {
  /** A copy of a fixture whose app.js is renamed to app-<hash>.js, as a bundler names chunks. */
  function hashedBuild(name: string, hash: string, edit: (text: string) => string = (t) => t): string {
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-build-'));
    cpSync(join(FOLDER, 'fixtures', name), tmp, { recursive: true });
    const astro = join(tmp, 'site', '_astro');
    writeFileSync(join(astro, 'app.js'), edit(readFileSync(join(astro, 'app.js'), 'utf8')));
    renameSync(join(astro, 'app.js'), join(astro, `app-${hash}.js`));
    for (const page of ['index.html', join('about', 'index.html')]) {
      const path = join(tmp, 'site', page);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('/_astro/app.js', `/_astro/app-${hash}.js`));
    }
    return tmp;
  }
  const run = (tmp: string) =>
    sarif(['--dir', join(tmp, 'site'), '--config', join(tmp, 'csp-guard.config.json'), '--sarif-base', tmp], { cwd: tmp }).results;

  it('stay the same across two builds whose asset names carry different hashes', () => {
    for (const name of ['secret-leak', 'lookbehind']) {
      // The second build also moves the lookbehind two lines down: the region moves, the fingerprint does not.
      const a = run(hashedBuild(name, 'AbC123de'));
      const b = run(hashedBuild(name, 'D-3kX_9a', (t) => `\n\n${t}`));
      expect(a.length).toBeGreaterThan(0);
      expect(a.map(uriOf)).not.toEqual(b.map(uriOf));
      expect(b.map(fingerprintOf)).toEqual(a.map(fingerprintOf));
      expect(new Set(a.map(fingerprintOf)).size).toBe(a.length);
      if (name === 'lookbehind') expect([regionOf(at(a))?.startLine, regionOf(at(b))?.startLine]).toEqual([2, 4]);
    }
  });

  it('stay the same when a count in the message crosses 1, so the noun turns plural', () => {
    // 1 regex lookbehind, then 2 regex lookbehinds: the same finding in the same file.
    const one = run(hashedBuild('lookbehind', 'AbC123de')).filter((r) => r.ruleId === 'lookbehind');
    const two = run(hashedBuild('lookbehind', 'D-3kX_9a', (t) => `${t}export const cents=s=>s.replace(/(?<!\\d)0/,"");\n`)).filter((r) => r.ruleId === 'lookbehind');
    expect([one.length, two.length]).toEqual([1, 1]);
    expect(at(one).message.text).toContain(': 1 regex lookbehind,');
    expect(at(two).message.text).toContain(': 2 regex lookbehinds,');
    expect(two.map(fingerprintOf)).toEqual(one.map(fingerprintOf));
    expect(fingerprintKey('a.js:1:1: 1 regex lookbehind, which x')).toBe(fingerprintKey('a.js:1:1: 3 regex lookbehinds, which x'));
    expect(fingerprintKey('1 page sends x')).toBe(fingerprintKey('2 pages send x'));
  });

  it('normalize content hashes in asset names and nothing else', () => {
    const cases: Array<[string, string]> = [
      ['_astro/index-AbC123.js', '_astro/index-*.js'],
      ['_astro/index-D-3kX_9a.js', '_astro/index-*.js'],
      ['assets/my-component-AbC123de.js', 'assets/my-component-*.js'],
      ['_astro/Layout.astro_astro_type_script_index_0_lang.BKz0kd1K.js', '_astro/Layout.astro_astro_type_script_index_0_lang.*.js'],
      ['static/js/main.3f9a2b1c4d5e6f70.js.gz', 'static/js/main.*.js.gz'],
      ['assets/style-Q1w2E3r4.css', 'assets/style-*.css'],
      ['_astro/chunk-vendors.js', '_astro/chunk-vendors.js'],
      ['_astro/about.client.js', '_astro/about.client.js'],
      ['_astro/island.js', '_astro/island.js'],
      ['blog/2024-recap/index.html', 'blog/2024-recap/index.html'],
    ];
    for (const [input, output] of cases) expect(withoutContentHashes(input)).toBe(output);
  });

  it('drop the numbers that move, and keep paths and inline content hashes', () => {
    expect(fingerprintKey('_astro/app-AbC123de.js:12:7: 2 regex lookbehinds')).toBe('_astro/app-*.js:#:#: # regex lookbehind');
    expect(fingerprintKey('index.html: 61.2 kB gzip, budget 60 kB (largest: /_astro/app-AbC123de.js 40.1 kB)')).toBe(
      'index.html: # kB gzip, budget # kB (largest: /_astro/app-*.js # kB)',
    );
    expect(fingerprintKey('about/index.html and 1 more page: x')).toBe(fingerprintKey('about/index.html and 3 more pages: x'));
    expect(fingerprintKey("blog/2024/index.html: script-src lists 'sha256-l2rlx9AdVltct3vNjFj7Ba2RsyBsJgijalc2DD9opMI='")).toBe(
      "blog/2024/index.html: script-src lists 'sha256-l2rlx9AdVltct3vNjFj7Ba2RsyBsJgijalc2DD9opMI='",
    );
    expect(fingerprintKey('the value of API_KEY_2 is in a.js')).not.toBe(fingerprintKey('the value of API_KEY_3 is in a.js'));
  });
});

describe('usage', () => {
  it('--json and --sarif are mutually exclusive, and --sarif-base needs --sarif: exit 2, nothing on stdout', () => {
    const both = cli([...fixture('pass'), '--json', '--sarif']);
    expect(both).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('--json and --sarif are mutually exclusive') });
    const base = cli([...fixture('pass'), '--sarif-base', '.']);
    expect(base).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('--sarif-base needs --sarif') });
    const empty = cli([...fixture('pass'), '--sarif', '--sarif-base']);
    expect(empty.code).toBe(2);
  });

  it('keeps exit code 2 for a missing folder or a bad config with --sarif, and prints no SARIF', () => {
    const missing = cli(['--dir', 'csp-build-guard/fixtures/nope', '--config', 'csp-build-guard/fixtures/pass/csp-guard.config.json', '--sarif']);
    expect(missing).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('is not a folder') });
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-sarif-'));
    const bad = join(tmp, 'csp-guard.config.json');
    writeFileSync(bad, JSON.stringify({ budgets: [{ pages: '**' }] }));
    expect(cli(['--dir', 'csp-build-guard/fixtures/pass/site', '--config', bad, '--sarif'])).toMatchObject({ code: 2, stdout: '' });
  });
});

describe('the text and --json outputs', () => {
  // --sarif is a third output; it must not change the two that existed before it.
  it.each([['pass', 'site'], ['meta', 'site'], ['stale-hash', 'site'], ['policy-drift', 'site'], ['vercel-output', 'output']])(
    '%s: byte for byte what the report functions print',
    async (name, dir) => {
      const expected = await report(name, dir);
      const display = relative(ROOT, join(FOLDER, 'fixtures', name, dir));
      const text = cli(fixture(name, dir));
      expect(text.stdout).toBe(formatReport(expected, display));
      expect(text.code).toBe(expected.ok ? 0 : 1);
      const json = cli([...fixture(name, dir), '--json']);
      expect(json.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
      expect(json.code).toBe(text.code);
    },
  );
});
