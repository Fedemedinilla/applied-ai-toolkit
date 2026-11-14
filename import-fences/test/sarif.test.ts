import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CheckResult, RuleId, Violation } from '../src/check.ts';
import { artifactUri, FINGERPRINT_KEY, INFORMATION_URI, messageOf, RULES, SARIF_SCHEMA, toSarif } from '../src/sarif.ts';
import { CLEAN, SAMPLE, SAMPLE_CONFIG, SAMPLE_FILES, writeTree } from './sample-tree.ts';

const FOLDER = join(import.meta.dirname, '..');
const CLI = join(FOLDER, 'cli.ts');
const README = readFileSync(join(FOLDER, 'README.md'), 'utf8');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tree(files: Readonly<Record<string, string>>): string {
  const root = writeTree(files);
  roots.push(root);
  return root;
}
function cli(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * What GitHub code scanning requires of an upload, from its SARIF support page: version 2.1.0, a
 * driver name, rules with an id, and results with a ruleId, a message text and a physical location
 * whose uri is relative to the repository (or a file: URI). The schema is strict where the CLI's
 * output is fixed, so a renamed or missing field fails here before it fails an upload.
 */
const relativeUri = z.string().regex(/^(?!\/)(?!\.\.?\/)(?![a-z][a-z0-9+.-]*:)[^\\]+$/i, 'a relative URI with forward slashes');
const region = z.strictObject({ startLine: z.number().int().min(1), startColumn: z.number().int().min(1) });
const result = z.strictObject({
  ruleId: z.string().min(1),
  ruleIndex: z.number().int().min(0),
  level: z.enum(['error', 'warning', 'note', 'none']),
  message: z.strictObject({ text: z.string().min(1) }),
  locations: z
    .array(z.strictObject({ physicalLocation: z.strictObject({ artifactLocation: z.strictObject({ uri: z.union([relativeUri, z.string().startsWith('file:///')]) }), region: region.optional() }) }))
    .length(1),
  partialFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{32}:\d+$/)),
});
const sarifSchema = z
  .strictObject({
    $schema: z.literal(SARIF_SCHEMA),
    version: z.literal('2.1.0'),
    runs: z
      .array(
        z.strictObject({
          tool: z.strictObject({
            driver: z.strictObject({
              name: z.literal('import-fences'),
              informationUri: z.literal(INFORMATION_URI),
              rules: z.array(
                z.strictObject({
                  id: z.string().min(1),
                  name: z.string().regex(/^[A-Z][A-Za-z]+$/),
                  shortDescription: z.strictObject({ text: z.string().min(1) }),
                  fullDescription: z.strictObject({ text: z.string().min(1) }),
                  helpUri: z.url({ protocol: /^https$/ }),
                  defaultConfiguration: z.strictObject({ level: z.literal('error') }),
                }),
              ),
            }),
          }),
          columnKind: z.literal('utf16CodeUnits'),
          results: z.array(result),
        }),
      )
      .length(1),
  })
  .superRefine((log, ctx) => {
    const run = log.runs[0];
    if (run === undefined) return;
    const ids = run.tool.driver.rules.map((r) => r.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate rule id' });
    run.results.forEach((r, i) => {
      if (ids[r.ruleIndex] !== r.ruleId) ctx.addIssue({ code: 'custom', message: `result ${i}: ruleIndex does not point at ${r.ruleId}` });
    });
    const prints = run.results.map((r) => r.partialFingerprints[FINGERPRINT_KEY]);
    if (prints.includes(undefined) || new Set(prints).size !== prints.length) ctx.addIssue({ code: 'custom', message: 'a fingerprint is missing or repeated' });
  });
type Sarif = z.infer<typeof sarifSchema>;
type Result = Sarif['runs'][number]['results'][number];

function sarif(cwd: string, args: string[] = []): { code: number | null; log: Sarif; results: Result[]; stdout: string } {
  const out = cli(cwd, [...args, '--sarif']);
  expect(out.stderr).toBe('');
  const log = sarifSchema.parse(JSON.parse(out.stdout));
  return { code: out.code, log, results: log.runs[0]?.results ?? [], stdout: out.stdout };
}
const uriOf = (r: Result) => r.locations[0]?.physicalLocation.artifactLocation.uri;
const regionOf = (r: Result) => r.locations[0]?.physicalLocation.region;
const fingerprintOf = (r: Result) => r.partialFingerprints[FINGERPRINT_KEY];
const place = (r: Result) => `${uriOf(r)}:${regionOf(r)?.startLine ?? 0}:${regionOf(r)?.startColumn ?? 0} ${r.ruleId}`;

const ALL_RULES: RuleId[] = ['forbidden-import', 'unresolved-import', 'single-importer', 'no-reexport', 'single-reader', 'single-string', 'relative-extension', 'dynamic-import', 'stale-allow', 'empty-group'];

describe('--sarif', () => {
  it('a clean tree is a valid log with every rule, no result, and exit 0', () => {
    const { code, log, results, stdout } = sarif(tree(CLEAN));
    expect(code).toBe(0);
    expect(results).toEqual([]);
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual(ALL_RULES);
    expect(stdout.endsWith('}\n')).toBe(true);
  });

  it('every violation of the text report is one error result at the same file, line and column, and the exit code is 1', () => {
    const root = tree(SAMPLE);
    const expected = (JSON.parse(cli(root, ['--json']).stdout) as CheckResult).violations;
    const { code, results } = sarif(root);
    expect(code).toBe(1);
    expect(results).toHaveLength(expected.length);
    for (const r of results) expect(r.level).toBe('error');
    // The text report sorts with the locale; the log sorts by code unit. The sets are the same.
    expect(results.map(place).sort()).toEqual(expected.map((v) => `${v.file}:${v.line}:${v.column} ${v.rule}`).sort());
    expect(results.map((r) => r.message.text).sort()).toEqual(expected.map(messageOf).sort());
  });

  it('puts the reason and the why of the rule in the message', () => {
    const { results } = sarif(tree(SAMPLE));
    const builtin = results.find((r) => r.ruleId === 'forbidden-import' && regionOf(r)?.startLine === 2);
    expect(builtin?.message.text).toBe('imports node:fs, forbidden in group "client". Why: client code ships to the browser');
    expect(uriOf(builtin as Result)).toBe('src/client/app.ts');
    expect(regionOf(builtin as Result)).toEqual({ startLine: 2, startColumn: 1 });
    // A crossing reached through another file is reported where the import is, with the chain.
    const chained = results.find((r) => uriOf(r) === 'src/shared/label.ts');
    expect(chained?.message.text).toContain('reached from src/client/widget.ts');
    // A rule without a why has only its reason.
    expect(results.find((r) => r.ruleId === 'single-reader')?.message.text).toBe("reads VENDOR_API_KEY (process.env['VENDOR_API_KEY']); only src/server/llm.ts may");
  });

  it('reports stale-allow and empty-group at the config file, with no region', () => {
    const { results } = sarif(tree(SAMPLE));
    const config = results.filter((r) => uriOf(r) === 'import-fences.config.ts');
    expect(config.map((r) => r.ruleId)).toEqual(['empty-group', 'stale-allow']);
    for (const r of config) expect(regionOf(r)).toBeUndefined();
    expect(config[1]?.message.text).toBe('allow entry src/server/gone.ts matches no file of group "all". Why: every call goes through the spending cap');
  });

  it('orders results by file, line, column and rule, and prints the same bytes on every run', () => {
    const root = tree(SAMPLE);
    const first = sarif(root);
    expect(first.results.map(place)).toEqual([
      'import-fences.config.ts:0:0 empty-group',
      'import-fences.config.ts:0:0 stale-allow',
      'src/client/app.ts:1:1 relative-extension',
      'src/client/app.ts:2:1 forbidden-import',
      'src/client/app.ts:3:1 forbidden-import',
      'src/client/app.ts:4:39 dynamic-import',
      'src/client/app.ts:4:39 unresolved-import',
      'src/server/report.ts:1:1 single-importer',
      'src/server/report.ts:3:25 single-reader',
      'src/shared/label.ts:1:1 forbidden-import',
    ]);
    expect(sarif(root).stdout).toBe(first.stdout);
    // The same tree in another folder: no absolute path, time or host name goes in.
    expect(sarif(tree(SAMPLE)).stdout).toBe(first.stdout);
  });

  it('makes paths relative to --sarif-base, and to the current folder by default', () => {
    const root = tree(Object.fromEntries(Object.entries(SAMPLE).map(([path, content]) => [`packages/web/${path}`, content])));
    const config = 'packages/web/import-fences.config.ts';
    const fromRoot = sarif(root, ['--config', config]);
    expect(fromRoot.code).toBe(1);
    expect(new Set(fromRoot.results.map(uriOf))).toEqual(new Set([config, 'packages/web/src/client/app.ts', 'packages/web/src/server/report.ts', 'packages/web/src/shared/label.ts']));
    // Run inside the package, as a monorepo script would, with the repository root as the base.
    const fromPackage = sarif(join(root, 'packages', 'web'), ['--sarif-base', root]);
    expect(fromPackage.stdout).toBe(fromRoot.stdout);
    // A base that does not hold the files gives absolute file: URIs, never ../ paths.
    const outside = sarif(root, ['--config', config, '--sarif-base', join(root, 'packages', 'web', 'src', 'server')]);
    expect(uriOf(outside.results[0] as Result)).toBe(pathToFileURL(join(root, config)).href);
    expect(outside.results.map(uriOf).filter((u) => !u?.startsWith('file:///'))).toEqual(['report.ts', 'report.ts']);
  });

  it('follows the root of the config, so a config kept in a subfolder still gives repository paths', () => {
    const root = tree({ ...SAMPLE_FILES, 'tools/fences.config.ts': SAMPLE_CONFIG.replace('groups:', "root: '..',\n  groups:") });
    const { results } = sarif(root, ['--config', 'tools/fences.config.ts']);
    expect(results.map(place).slice(0, 3)).toEqual(['src/client/app.ts:1:1 relative-extension', 'src/client/app.ts:2:1 forbidden-import', 'src/client/app.ts:3:1 forbidden-import']);
    expect(results.filter((r) => r.ruleId === 'empty-group').map(uriOf)).toEqual(['tools/fences.config.ts']);
  });

  it('percent-encodes a path segment that is not a plain URI', () => {
    const root = tree({
      'import-fences.config.ts': "export default { groups: { all: { include: ['**/*'] } }, rules: [{ rule: 'relative-extension', group: 'all' }] };",
      'src/my page #1/a.ts': "import './b';",
      'src/my page #1/b.ts': '',
    });
    expect(sarif(root).results.map(uriOf)).toEqual(['src/my%20page%20%231/a.ts']);
  });

  it('keeps a fingerprint when lines are added above the import or the why is reworded, and changes it with the file or the reason', () => {
    const before = sarif(tree(SAMPLE)).results;
    const moved = sarif(
      tree({
        ...SAMPLE,
        'import-fences.config.ts': SAMPLE_CONFIG.replace('client code ships to the browser', 'the browser has no file system'),
        'src/client/app.ts': `// a comment\n\n${SAMPLE_FILES['src/client/app.ts'] ?? ''}`,
      }),
    ).results;
    expect(moved.map(regionOf)).not.toEqual(before.map(regionOf));
    expect(moved.map((r) => r.message.text)).not.toEqual(before.map((r) => r.message.text));
    expect(moved.map(fingerprintOf)).toEqual(before.map(fingerprintOf));

    const renamed = sarif(tree({ ...Object.fromEntries(Object.entries(SAMPLE).filter(([path]) => path !== 'src/server/report.ts')), 'src/server/summary.ts': SAMPLE_FILES['src/server/report.ts'] ?? '' })).results;
    const old = before.filter((r) => uriOf(r) === 'src/server/report.ts').map(fingerprintOf);
    const next = renamed.filter((r) => uriOf(r) === 'src/server/summary.ts').map(fingerprintOf);
    expect(next).toHaveLength(old.length);
    for (const print of next) expect(old).not.toContain(print);
  });

  it('tells apart the same import written twice in one file by its order', () => {
    const root = tree({
      'import-fences.config.ts': "export default { groups: { all: { include: ['src/**'] } }, rules: [{ rule: 'forbidden-import', group: 'all', specifiers: ['node:*'] }] };",
      'src/a.ts': "import 'node:fs';\nimport 'node:fs';\n",
    });
    const prints = sarif(root).results.map(fingerprintOf);
    expect(prints).toHaveLength(2);
    expect(prints[0]?.endsWith(':1')).toBe(true);
    expect(prints[1]).toBe(`${prints[0]?.slice(0, -2)}:2`);
  });

  it('is a usage error with --json, and --sarif-base needs --sarif; exit 2 prints nothing on stdout', () => {
    const root = tree(SAMPLE);
    expect(cli(root, ['--json', '--sarif'])).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^--json and --sarif are mutually exclusive\nusage: /) as unknown });
    expect(cli(root, ['--sarif-base', '.'])).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^--sarif-base needs --sarif\nusage: /) as unknown });
    expect(cli(root, ['--json', '--sarif-base', '.'])).toMatchObject({ code: 2, stdout: '' });
    expect(cli(root, ['--sarif', '--config', 'missing.config.ts'])).toMatchObject({ code: 2, stdout: '' });
    const invalid = tree({ 'import-fences.config.ts': "export default { groups: {}, rules: [{ rule: 'nope', group: 'x' }] };" });
    expect(cli(invalid, ['--sarif'])).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^invalid config:/) as unknown });
  });
});

describe('toSarif', () => {
  const violation = (v: Partial<Violation> & { rule: RuleId }): Violation => ({ file: 'src/a.ts', line: 1, column: 1, reason: 'a reason', ...v });
  const log = (violations: Violation[]) => toSarif({ violations, files: 1, rules: 1 }, { root: '/repo/web', configPath: '/repo/web/fences.config.ts', base: '/repo' });

  it('has a rule text for every id the checker can report, and each result indexes its own', () => {
    expect(Object.keys(RULES)).toEqual(ALL_RULES);
    const built = sarifSchema.parse(log(ALL_RULES.map((rule, i) => violation({ rule, line: i + 1 }))));
    expect(built.runs[0]?.results.map((r) => r.ruleId)).toEqual(ALL_RULES);
    expect(built.runs[0]?.results.map((r) => r.ruleIndex)).toEqual(ALL_RULES.map((_, i) => i));
  });

  it('resolves code paths against the root and config violations against the config file', () => {
    const results = log([violation({ rule: 'no-reexport', line: 3, column: 8 }), violation({ rule: 'stale-allow', file: 'fences.config.ts', line: 0, column: 0 })]).runs[0]?.results ?? [];
    expect(results.map((r) => r.locations[0]?.physicalLocation)).toEqual([
      { artifactLocation: { uri: 'web/fences.config.ts' } },
      { artifactLocation: { uri: 'web/src/a.ts' }, region: { startLine: 3, startColumn: 8 } },
    ]);
  });

  it('sorts by code unit, whatever the order and the locale of the input', () => {
    const files = ['src/b.ts', 'src/B.ts', 'src/a.ts', 'src/_.ts'];
    const results = log(files.map((file) => violation({ rule: 'dynamic-import', file }))).runs[0]?.results ?? [];
    expect(results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri)).toEqual(['web/src/B.ts', 'web/src/_.ts', 'web/src/a.ts', 'web/src/b.ts']);
  });

  it('artifactUri is relative inside the base and a file: URI outside it', () => {
    expect(artifactUri('/repo/src/a b.ts', '/repo')).toBe('src/a%20b.ts');
    expect(artifactUri('/other/a.ts', '/repo')).toBe('file:///other/a.ts');
    expect(artifactUri('/repo', '/repo')).toBe('file:///repo');
  });
});

describe('the README', () => {
  it('documents --sarif with the fingerprint key and links every rule to the rule reference', () => {
    expect(README).toContain('## SARIF for code scanning');
    expect(README).toContain(FINGERPRINT_KEY);
    expect(README).toMatch(/^## Rule reference$/m);
    for (const id of ALL_RULES) expect(README, id).toContain(`\`${id}\``);
  });
});

// Kept last: writes a tree by hand to cover a file the config root does not hold.
describe('a config whose root is elsewhere', () => {
  it('points config violations at the config file even when it is outside the root', () => {
    const root = tree({ 'app/src/a.ts': '' });
    const config = join(root, 'config', 'fences.config.ts');
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "export default { root: '../app', groups: { gone: { include: ['lib/**'] } }, rules: [{ rule: 'dynamic-import', group: 'gone' }] };");
    const { results } = sarif(root, ['--config', 'config/fences.config.ts']);
    expect(results.map(place)).toEqual(['config/fences.config.ts:0:0 empty-group']);
  });
});
