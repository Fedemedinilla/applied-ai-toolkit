/**
 * Packs each published package the way `npm publish` would and checks what a user would install.
 * Run it with `npm run pack:check`; CI runs it after the tests. It needs no network and no key.
 *
 * Node runs the repository's `.ts` files directly, but it does not strip types inside
 * node_modules, so a package ships compiled JavaScript and `.d.ts` files. For each package this
 * script:
 *
 * 1. Copies the package folder, the root tsconfig.json and LICENSE (when the root has one) into a
 *    temporary copy of the repository whose node_modules links to the real one, and runs
 *    `npm pack` there. The package's own prepack script copies LICENSE and builds dist/, so the
 *    working tree is never written to.
 * 2. Reads the tarball's file list: only package.json, README.md, LICENSE and dist/, no test,
 *    fixture or `.ts` source, and every file that exports, types and bin point at. A package that
 *    declares a license must ship the LICENSE file, so the root must have one. Every source map
 *    holds the text of each source the tarball leaves out, and every sourceMappingURL names a map
 *    the tarball holds, so no tool goes looking for a `.ts` file that is not there.
 * 3. Installs the tarball in a fresh project outside the repository. slop-lint has no
 *    dependencies, so `npm install --offline` installs it and links its bin. The dependencies of
 *    the other packages would need the registry, so each tarball is extracted into node_modules
 *    and its dependencies are linked to the repository's copies, the versions the lockfile pins.
 *    The linked set is what package.json declares in dependencies and peerDependencies. It must
 *    equal the spec's linkDependencies, cover every bare import of a shipped .js file, and each
 *    repository copy must satisfy the declared range.
 *    The bin of such a package is linked into node_modules/.bin and made executable by hand, the
 *    two things npm does on install.
 * 4. In a child process started in that project, imports each entry by package name and compares
 *    its runtime exports with the source module's, then does the same with require() from
 *    CommonJS: the types resolve for a CommonJS consumer too, so the runtime must as well.
 *    Compares the declared exports (values and types) of each `.d.ts` entry with the source
 *    module's, through the TypeScript compiler API. A JSON entry is imported with
 *    `{ type: 'json' }` and must be byte for byte its source file.
 * 5. Typechecks a small consumer against the installed package with the repository's strict
 *    options and `skipLibCheck: false`. A `@ts-expect-error` line in it fails if the types
 *    collapse to `any`.
 * 6. For a package with a bin, runs the installed bin and the source CLI (`node <folder>/cli.ts`)
 *    on the same inputs and compares stdout, stderr and the exit code. A run may state the exit
 *    code it expects, so two identical failures do not pass as agreement. Runs marked `consumer`
 *    start in the fresh project, over files written there: for import-fences that is a config
 *    written in TypeScript that imports the installed package, which Node loads by stripping its
 *    types because the file is the user's own, outside node_modules.
 *
 * Set PACK_CHECK_KEEP=1 to keep the temporary folder and print its path.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { builtinModules } from 'node:module';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NODE_MODULES = join(ROOT, 'node_modules');
const TSC = join(NODE_MODULES, 'typescript', 'bin', 'tsc');

interface Entry {
  /** The subpath in package.json exports, "." for the main entry. */
  readonly subpath: string;
  /** The source module the entry is built from, relative to the package folder. */
  readonly source: string;
}

interface PackageSpec {
  readonly folder: string;
  readonly name: string;
  readonly entries: readonly Entry[];
  /** JSON files exported by subpath, each imported by package name and compared with its source file. */
  readonly jsonEntries?: readonly Entry[];
  /**
   * The dependencies and peer dependencies package.json must declare. They are linked from the
   * repository's node_modules when the tarball is extracted; without any, npm installs the tarball.
   */
  readonly linkDependencies?: readonly string[];
  /** A consumer typechecked against the installed package. */
  readonly consumer: string;
  /** The bin's name in package.json, for a package with one. Its source is <folder>/cli.ts. */
  readonly bin?: string;
  /** Arguments run through the installed bin and through the source CLI, from the repository root. */
  readonly binRuns?: ReadonlyArray<readonly string[] | BinRun>;
  /** Files written into the fresh project before the bin runs, for the runs marked `consumer`. */
  readonly consumerFiles?: Readonly<Record<string, string>>;
  /** Environment variables added to every bin run. */
  readonly binEnv?: Readonly<Record<string, string>>;
}

interface BinRun {
  readonly args: readonly string[];
  /** The exit code both runs must give. */
  readonly exit: number;
  /** Run in the fresh project where the package is installed, not in the repository root. */
  readonly consumer?: boolean;
}

const GUARD_FIXTURES = 'csp-build-guard/fixtures';
const guardFixture = (name: string): string[] => ['--dir', `${GUARD_FIXTURES}/${name}/site`, '--config', `${GUARD_FIXTURES}/${name}/csp-guard.config.json`];

/** A user's config in TypeScript, with a type annotation and an import of the installed package. */
const FENCES_TS_CONFIG = `import { defineConfig, type FencesConfigInput } from '@fedemedinilla/import-fences';

const groups: FencesConfigInput['groups'] = {
  client: { include: ['src/client/**'] },
  all: { include: ['src/**'] },
};

export default defineConfig({
  groups,
  rules: [
    { rule: 'forbidden-import', group: 'client', specifiers: ['node:*'], paths: ['src/server/**'], why: 'client code ships to the browser' },
    { rule: 'relative-extension', group: 'all' },
  ],
});
`;
const FENCES_JSON_CONFIG = `${JSON.stringify({ groups: { all: { include: ['src/**'] } }, rules: [{ rule: 'dynamic-import', group: 'all' }] }, null, 2)}\n`;

const SLOP_FIXTURES = join(ROOT, 'slop-lint', 'fixtures', 'cover-letters');

const PACKAGES: readonly PackageSpec[] = [
  {
    folder: 'slop-lint',
    name: '@fedemedinilla/slop-lint',
    entries: [
      { subpath: '.', source: 'src/lint.ts' },
      { subpath: './types', source: 'src/types.ts' },
      { subpath: './config', source: 'src/config.ts' },
    ],
    jsonEntries: [{ subpath: './config.schema.json', source: 'schema/config.schema.json' }],
    bin: 'slop-lint',
    consumer: `import { lint, RULES } from '@fedemedinilla/slop-lint';
import type { LintOptions, LintResult } from '@fedemedinilla/slop-lint/types';

const options: LintOptions = { lang: 'en', format: 'markdown', anchors: ['dbt'] };
const result: LintResult = lint('I used dbt in 2024.', options);
export const passes: boolean = result.passesTier1;
export const ruleCount: number = RULES.length;
// @ts-expect-error lang is 'en' or 'es'; this line fails if the types collapse to any.
lint('text', { lang: 'fr' });
`,
    binRuns: [
      [join(SLOP_FIXTURES, 'en-before.txt'), '--lang', 'en'],
      [join(SLOP_FIXTURES, 'es-rioplatense-after.txt'), '--lang', 'es', '--json'],
      [join(ROOT, 'slop-lint', 'README.md'), '--lang', 'en'],
      ['--lang', 'en'],
    ],
  },
  {
    folder: 'gateway',
    name: '@fedemedinilla/claude-gateway',
    entries: [{ subpath: '.', source: 'src/index.ts' }],
    linkDependencies: ['@anthropic-ai/sdk', 'zod'],
    consumer: `import { createGateway, structuredFormat, type Gateway, type GatewayDeps, type GatewayRequest } from '@fedemedinilla/claude-gateway';
import { z } from 'zod';

const Summary = z.object({ title: z.string(), points: z.array(z.string()) });
export const format = structuredFormat(Summary);
declare const deps: GatewayDeps;
declare const request: GatewayRequest;
const gateway: Gateway = createGateway(deps);
export async function title(): Promise<string> {
  const result = await gateway.structured(Summary, request);
  return result.data.title;
}
export async function wrong(): Promise<string> {
  const result = await gateway.structured(Summary, request);
  // @ts-expect-error points is string[]; this line fails if the types collapse to any.
  return result.data.points;
}
`,
  },
  {
    folder: 'import-fences',
    name: '@fedemedinilla/import-fences',
    entries: [{ subpath: '.', source: 'src/index.ts' }],
    linkDependencies: ['typescript', 'zod'],
    consumer: `import { check, defineConfig, memorySource, parseConfig, toSarif, type CheckResult, type FencesConfigInput, type SarifLog } from '@fedemedinilla/import-fences';

const input: FencesConfigInput = defineConfig({ groups: { all: { include: ['src/**'] } }, rules: [{ rule: 'dynamic-import', group: 'all' }] });
const result: CheckResult = check(parseConfig(input), memorySource({ 'src/a.ts': '' }));
export const count: number = result.violations.length;
export const log: SarifLog = toSarif(result, { root: '.', configPath: 'fences.config.json' });
// @ts-expect-error nope is not a rule; this line fails if the types collapse to any.
defineConfig({ groups: {}, rules: [{ rule: 'nope', group: 'all' }] });
`,
    bin: 'import-fences',
    consumerFiles: {
      'fences.config.ts': FENCES_TS_CONFIG,
      'fences.config.json': FENCES_JSON_CONFIG,
      'src/client/app.ts': "import { rows } from '../server/db';\nimport { readFileSync } from 'node:fs';\nexport const app = [rows, readFileSync];\n",
      'src/server/db.ts': 'export const rows = [];\n',
    },
    binRuns: [
      { args: ['--config', 'import-fences/repo.config.ts'], exit: 0 },
      { args: ['--config', 'import-fences/repo.config.ts', '--sarif'], exit: 0 },
      { args: ['--config', 'fences.config.ts'], exit: 1, consumer: true },
      { args: ['--config', 'fences.config.ts', '--json'], exit: 1, consumer: true },
      { args: ['--config', 'fences.config.ts', '--sarif'], exit: 1, consumer: true },
      { args: ['--config', 'fences.config.json'], exit: 0, consumer: true },
      { args: ['--json', '--sarif'], exit: 2, consumer: true },
    ],
  },
  {
    folder: 'csp-build-guard',
    name: '@fedemedinilla/csp-build-guard',
    entries: [{ subpath: '.', source: 'src/index.ts' }],
    linkDependencies: ['zod'],
    consumer: `import { ConfigError, InputError, formatReport, loadConfig, runGuard, toSarif, type GuardConfig, type GuardReport, type RunOptions, type SarifLog } from '@fedemedinilla/csp-build-guard';

export async function audit(dir: string): Promise<string> {
  const config: GuardConfig = await loadConfig('csp-guard.config.json');
  const options: RunOptions = { dir, config };
  const report: GuardReport = runGuard(options);
  const log: SarifLog = toSarif(report, { configPath: 'csp-guard.config.json' });
  return log.runs.length > 0 ? formatReport(report, dir) : '';
}
export const known = (error: unknown): boolean => error instanceof ConfigError || error instanceof InputError;
declare const report: GuardReport;
// @ts-expect-error ok is a boolean; this line fails if the types collapse to any.
export const wrong: string = report.ok;
`,
    bin: 'csp-build-guard',
    binEnv: { FIXTURE_SECRET: 'fixture-secret-value-0001' },
    binRuns: [
      { args: guardFixture('pass'), exit: 0 },
      { args: [...guardFixture('pass'), '--json'], exit: 0 },
      { args: guardFixture('lookbehind'), exit: 1 },
      { args: [...guardFixture('lookbehind'), '--sarif'], exit: 1 },
      { args: ['--dir', `${GUARD_FIXTURES}/nope`, '--config', `${GUARD_FIXTURES}/pass/csp-guard.config.json`], exit: 2 },
    ],
  },
];

function run(command: string, args: readonly string[], options: SpawnSyncOptions & { cwd: string }): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return { stdout: String(result.stdout), stderr: String(result.stderr), status: result.status };
}

function mustRun(command: string, args: readonly string[], options: SpawnSyncOptions & { cwd: string }): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)} in ${options.cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** npm with its cache and user config kept inside the temporary folder, and no registry access. */
function npmEnv(work: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_userconfig: join(work, 'npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function sameList(what: string, actual: readonly string[], expected: readonly string[]): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.join('\n') !== e.join('\n')) {
    const missing = e.filter((x) => !a.includes(x));
    const extra = a.filter((x) => !e.includes(x));
    fail(`${what} differ. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`);
  }
}

/** Every exported name of a module, values and types, as the compiler sees it. */
function declaredExports(file: string, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram([file], options);
  const source = program.getSourceFile(file) ?? fail(`the compiler did not load ${file}`);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source);
  return symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((s) => s.name);
}

const SOURCE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2024,
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: true,
  types: ['node'],
  typeRoots: [join(NODE_MODULES, '@types')],
};

/** The tarball's paths without the leading package/, and the mode of each file. */
function tarballFiles(tarball: string, cwd: string): Map<string, string> {
  const listing = mustRun('tar', ['-tvzf', tarball], { cwd });
  const files = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const match = /^(\S+)\s.*\spackage\/(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) files.set(match[2], match[1]);
  }
  return files;
}

/** Every file path a package.json points at through exports, types and bin. */
function pointedAt(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value.replace(/^\.\//, ''));
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest['exports']);
  walk(manifest['types']);
  walk(manifest['bin']);
  return out;
}

/**
 * Every map in an unpacked tarball either holds the text of each source the tarball leaves out
 * (sourcesContent) or points only at files it ships, and every sourceMappingURL comment names a map
 * that is there. Returns the number of maps.
 */
function checkSourceMaps(unpacked: string, paths: readonly string[]): number {
  const shipped = new Set(paths);
  let count = 0;
  for (const path of paths) {
    if (path.endsWith('.map')) {
      count += 1;
      const map = JSON.parse(readFileSync(join(unpacked, path), 'utf8')) as { sources?: unknown; sourcesContent?: unknown };
      const sources = Array.isArray(map.sources) ? (map.sources as unknown[]) : [];
      const contents = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
      sources.forEach((source, i) => {
        const target = relative(unpacked, join(unpacked, dirname(path), String(source))).split(/[\\/]/).join('/');
        if (!shipped.has(target) && typeof contents[i] !== 'string') fail(`${path} points at ${String(source)}, which the tarball does not hold, and carries no sourcesContent for it`);
      });
    } else if (/\.(js|d\.ts)$/.test(path)) {
      const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(join(unpacked, path), 'utf8'))?.[1];
      if (url === undefined || url.startsWith('data:')) continue;
      const target = relative(unpacked, join(unpacked, dirname(path), url)).split(/[\\/]/).join('/');
      if (!shipped.has(target)) fail(`${path} names the source map ${url}, which the tarball does not hold`);
    }
  }
  return count;
}

/** The package name of a bare import specifier: @scope/name or name, without a subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/**
 * Every bare specifier a shipped .js file imports, requires or loads with import(), read by the
 * TypeScript preprocessor so comments and strings do not count.
 */
function bareImports(unpacked: string, paths: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths.filter((p) => /\.(js|mjs|cjs)$/.test(p))) {
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(join(unpacked, path), 'utf8'), true, true).importedFiles) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || builtinModules.includes(packageOf(specifier))) continue;
      if (!found.has(packageOf(specifier))) found.set(packageOf(specifier), path);
    }
  }
  return found;
}

/** An exact version or a caret range, the two forms the manifests use; anything else fails. */
function satisfies(version: string, range: string): boolean {
  const parse = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? fail(`${v} is not a plain x.y.z version`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  if (!range.startsWith('^')) return version === range;
  const [major = 0, minor = 0, patch = 0] = parse(range.slice(1));
  const [vMajor = 0, vMinor = 0, vPatch = 0] = parse(version);
  if (major === 0) return vMajor === 0 && vMinor === minor && vPatch >= patch;
  return vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch));
}

async function checkPackage(spec: PackageSpec, work: string): Promise<void> {
  const say = (message: string): void => console.log(`${spec.name}: ${message}`);
  const packageDir = join(ROOT, spec.folder);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (manifest['name'] !== spec.name) fail(`${spec.folder}/package.json is named ${String(manifest['name'])}, not ${spec.name}`);
  const hasLicense = existsSync(join(ROOT, 'LICENSE'));
  if (typeof manifest['license'] === 'string' && manifest['license'] !== 'UNLICENSED' && !hasLicense) {
    fail(`${spec.folder}/package.json declares the ${manifest['license']} license and the repository has no LICENSE to ship with it`);
  }

  // 1. Pack from a copy, so prepack runs as it would on publish without writing to the tree.
  const stage = join(work, 'repo');
  mkdirSync(stage, { recursive: true });
  cpSync(join(ROOT, 'tsconfig.json'), join(stage, 'tsconfig.json'));
  if (hasLicense) cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  if (!existsSync(join(stage, 'node_modules'))) symlinkSync(NODE_MODULES, join(stage, 'node_modules'), 'junction');
  const stagedPackage = join(stage, spec.folder);
  cpSync(packageDir, stagedPackage, {
    recursive: true,
    filter: (path) => {
      const rel = relative(packageDir, path).split(/[\\/]/)[0];
      return rel !== 'node_modules' && rel !== 'dist' && rel !== 'LICENSE';
    },
  });
  const out = join(work, 'tarballs', spec.folder);
  mkdirSync(out, { recursive: true });
  mustRun('npm', ['pack', '--pack-destination', out], { cwd: stagedPackage, env: npmEnv(work) });
  const tarballs = readdirSync(out).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1 || tarballs[0] === undefined) fail(`expected one tarball in ${out}, found ${tarballs.join(', ')}`);
  const tarball = join(out, tarballs[0]);
  say(`packed ${tarballs[0]}`);

  // 2. The file list.
  const files = tarballFiles(tarball, work);
  const paths = [...files.keys()];
  const outside = paths.filter((p) => !['package.json', 'README.md', 'LICENSE'].includes(p) && !p.startsWith('dist/'));
  if (outside.length > 0) fail(`the tarball holds files outside dist/: ${outside.join(', ')}`);
  const sources = paths.filter((p) => /\.(ts|mts|cts|tsx)$/.test(p) && !/\.d\.(ts|mts|cts)$/.test(p));
  if (sources.length > 0) fail(`the tarball holds TypeScript sources: ${sources.join(', ')}`);
  const tests = paths.filter((p) => /(^|\/)(test|tests|fixtures|examples)\//.test(p) || /\.test\.(js|d\.ts)$/.test(p));
  if (tests.length > 0) fail(`the tarball holds tests or fixtures: ${tests.join(', ')}`);
  for (const required of ['package.json', 'README.md', ...pointedAt(manifest)]) {
    if (!files.has(required)) fail(`the tarball has no ${required}`);
  }
  if (hasLicense !== files.has('LICENSE')) {
    fail(hasLicense ? 'the repository has a LICENSE and the tarball does not' : 'the tarball has a LICENSE the repository does not');
  }
  say(`${paths.length} files, all under dist/ or package.json, README.md${hasLicense ? ', LICENSE' : ' (no root LICENSE yet, so none packed)'}`);
  const unpacked = join(work, 'unpacked', spec.folder);
  mkdirSync(unpacked, { recursive: true });
  mustRun('tar', ['-xzf', tarball, '--strip-components=1', '-C', unpacked], { cwd: work });
  const maps = checkSourceMaps(unpacked, paths);
  say(`${maps} source maps, each with the text of every source the tarball leaves out`);

  // The dependencies to link come from package.json, and must match the spec and what dist imports.
  const declaredRanges: Record<string, string> = {
    ...((manifest['dependencies'] ?? {}) as Record<string, string>),
    ...((manifest['peerDependencies'] ?? {}) as Record<string, string>),
  };
  sameList(`the dependencies and peer dependencies of ${spec.folder}/package.json and the spec's linkDependencies`, Object.keys(declaredRanges), spec.linkDependencies ?? []);
  for (const [name, path] of bareImports(unpacked, paths)) {
    if (name !== spec.name && !(name in declaredRanges)) fail(`${path} imports ${name}, which ${spec.folder}/package.json declares in neither dependencies nor peerDependencies`);
  }
  for (const [name, range] of Object.entries(declaredRanges)) {
    const version = (JSON.parse(readFileSync(join(NODE_MODULES, ...name.split('/'), 'package.json'), 'utf8')) as { version: string }).version;
    if (!satisfies(version, range)) fail(`the repository's ${name} is ${version}, outside the range ${range} that ${spec.folder}/package.json declares`);
  }

  // 3. Install it in a fresh project outside the repository.
  const consumer = join(work, 'consumer', spec.folder);
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'pack-check-consumer', private: true, type: 'module' }, null, 2)}\n`);
  const installed = join(consumer, 'node_modules', ...spec.name.split('/'));
  if (Object.keys(declaredRanges).length === 0) {
    mustRun('npm', ['install', '--no-save', '--no-package-lock', tarball], { cwd: consumer, env: npmEnv(work) });
  } else {
    mkdirSync(installed, { recursive: true });
    mustRun('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed], { cwd: work });
    for (const dependency of Object.keys(declaredRanges)) {
      const link = join(consumer, 'node_modules', ...dependency.split('/'));
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(NODE_MODULES, ...dependency.split('/')), link, 'junction');
    }
    // What npm install does for a bin: a link in node_modules/.bin and the executable bit.
    for (const [name, target] of Object.entries((manifest['bin'] ?? {}) as Record<string, string>)) {
      mkdirSync(join(consumer, 'node_modules', '.bin'), { recursive: true });
      chmodSync(join(installed, target), 0o755);
      symlinkSync(relative(join(consumer, 'node_modules', '.bin'), join(installed, target)), join(consumer, 'node_modules', '.bin', name));
    }
  }
  // The consumer's typecheck needs Node's types; linked after npm install, which would prune them.
  mkdirSync(join(consumer, 'node_modules', '@types'), { recursive: true });
  symlinkSync(join(NODE_MODULES, '@types', 'node'), join(consumer, 'node_modules', '@types', 'node'), 'junction');
  say(`installed in ${relative(work, consumer)}`);

  // 4. Runtime and declared exports, entry by entry.
  for (const entry of spec.entries) {
    const specifier = entry.subpath === '.' ? spec.name : `${spec.name}/${entry.subpath.replace(/^\.\//, '')}`;
    const script = `const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m)));`;
    const runtime = JSON.parse(mustRun(process.execPath, ['--input-type=module', '-e', script], { cwd: consumer })) as string[];
    const source = Object.keys((await import(pathToFileURL(join(packageDir, entry.source)).href)) as Record<string, unknown>);
    sameList(`the runtime exports of ${specifier} and ${spec.folder}/${entry.source}`, runtime, source);
    const cjs = `console.log(JSON.stringify(Object.keys(require(${JSON.stringify(specifier)}))));`;
    const required = run(process.execPath, ['--input-type=commonjs', '-e', cjs], { cwd: consumer });
    if (required.status !== 0) fail(`require(${JSON.stringify(specifier)}) from CommonJS failed:\n${required.stderr}`);
    sameList(`the exports require() returns for ${specifier} and ${spec.folder}/${entry.source}`, JSON.parse(required.stdout) as string[], source);

    const exportsField = (manifest['exports'] as Record<string, { types: string }>)[entry.subpath] ?? fail(`exports has no ${entry.subpath}`);
    const declarationFile = join(installed, exportsField.types);
    const declared = declaredExports(declarationFile, { ...SOURCE_OPTIONS, allowImportingTsExtensions: false });
    const sourceDeclared = declaredExports(join(packageDir, entry.source), SOURCE_OPTIONS);
    sameList(`the declared exports of ${specifier} and ${spec.folder}/${entry.source}`, declared, sourceDeclared);
    say(`entry ${entry.subpath}: ${runtime.length} runtime exports, through import and require(), and ${declared.length} declared exports match the source`);
  }

  // A JSON entry, through import with { type: 'json' }: the same bytes as the source file.
  for (const entry of spec.jsonEntries ?? []) {
    const specifier = `${spec.name}/${entry.subpath.replace(/^\.\//, '')}`;
    const script = `import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const m = await import(${JSON.stringify(specifier)}, { with: { type: 'json' } });
const file = fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}));
console.log(JSON.stringify({ parsed: m.default, text: readFileSync(file, 'utf8') }));`;
    const got = JSON.parse(mustRun(process.execPath, ['--input-type=module', '-e', script], { cwd: consumer })) as { parsed: unknown; text: string };
    const sourceText = readFileSync(join(packageDir, entry.source), 'utf8');
    if (got.text !== sourceText) fail(`${specifier} is not byte for byte ${spec.folder}/${entry.source}`);
    if (JSON.stringify(got.parsed) !== JSON.stringify(JSON.parse(sourceText))) fail(`${specifier} imports as JSON different from ${spec.folder}/${entry.source}`);
    say(`entry ${entry.subpath}: imports as JSON by package name, byte for byte ${entry.source}`);
  }

  // 5. A strict consumer typechecks against the installed declarations.
  writeFileSync(join(consumer, 'consumer.ts'), spec.consumer);
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          lib: ['ES2024'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  mustRun(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: consumer });
  say('a strict consumer typechecks against the installed declarations');

  // 6. The installed bin against the source CLI.
  if (spec.bin !== undefined && spec.binRuns !== undefined) {
    const declared = (manifest['bin'] as Record<string, string> | undefined)?.[spec.bin] ?? fail(`package.json has no bin named ${spec.bin}`);
    const bin = join(consumer, 'node_modules', '.bin', spec.bin);
    const first = readFileSync(join(installed, declared), 'utf8').split('\n')[0];
    if (first !== '#!/usr/bin/env node') fail(`${declared} starts with ${String(first)}, not the shebang`);
    for (const [path, content] of Object.entries(spec.consumerFiles ?? {})) {
      mkdirSync(dirname(join(consumer, path)), { recursive: true });
      writeFileSync(join(consumer, path), content);
    }
    const sourceCli = join(ROOT, spec.folder, 'cli.ts');
    const env = { ...process.env, ...spec.binEnv };
    for (const binRun of spec.binRuns) {
      const { args, exit, consumer: inConsumer }: { args: readonly string[]; exit?: number; consumer?: boolean } = 'args' in binRun ? binRun : { args: binRun };
      const cwd = inConsumer === true ? consumer : ROOT;
      const viaBin = run(bin, args, { cwd, input: '', env });
      const viaSource = run(process.execPath, [sourceCli, ...args], { cwd, input: '', env });
      const shown = args.map((a) => (isAbsolute(a) ? relative(ROOT, a) : a)).join(' ');
      if (viaBin.status !== viaSource.status) fail(`${spec.bin} ${shown} exited ${String(viaBin.status)} installed and ${String(viaSource.status)} from source\n${viaBin.stderr}`);
      if (exit !== undefined && viaBin.status !== exit) fail(`${spec.bin} ${shown} exited ${String(viaBin.status)}, expected ${exit}\n${viaBin.stderr}`);
      if (viaBin.stdout !== viaSource.stdout) fail(`${spec.bin} ${shown} printed different stdout installed and from source`);
      if (viaBin.stderr !== viaSource.stderr) fail(`${spec.bin} ${shown} printed different stderr installed and from source`);
      say(`bin and source CLI agree on ${shown}${inConsumer === true ? ' (in the fresh project)' : ''} (exit ${String(viaBin.status)})`);
    }
  }
}

const work = mkdtempSync(join(tmpdir(), 'pack-check-'));
try {
  for (const spec of PACKAGES) await checkPackage(spec, work);
  console.log(`pack-check: ${PACKAGES.length} packages ok`);
} finally {
  if (process.env['PACK_CHECK_KEEP'] === '1') console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
