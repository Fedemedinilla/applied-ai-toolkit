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
 *    declares a license must ship the LICENSE file, so the root must have one.
 * 3. Installs the tarball in a fresh project outside the repository. slop-lint has no
 *    dependencies, so `npm install --offline` installs it and links its bin. The gateway's two
 *    dependencies would need the registry, so its tarball is extracted into node_modules and its
 *    dependencies are linked to the repository's copies, the versions the lockfile pins.
 * 4. In a child process started in that project, imports each entry by package name and compares
 *    its runtime exports with the source module's. Compares the declared exports (values and
 *    types) of each `.d.ts` entry with the source module's, through the TypeScript compiler API.
 * 5. Typechecks a small consumer against the installed package with the repository's strict
 *    options and `skipLibCheck: false`. A `@ts-expect-error` line in it fails if the types
 *    collapse to `any`.
 * 6. For slop-lint, runs the installed bin and `node slop-lint/cli.ts` on the same inputs and
 *    compares stdout, stderr and the exit code.
 *
 * Set PACK_CHECK_KEEP=1 to keep the temporary folder and print its path.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** Dependencies linked from the repository's node_modules when the tarball is extracted. */
  readonly linkDependencies?: readonly string[];
  /** A consumer typechecked against the installed package. */
  readonly consumer: string;
  /** Arguments run through the installed bin and through the source CLI, for a package with a bin. */
  readonly binRuns?: ReadonlyArray<readonly string[]>;
}

const SLOP_FIXTURES = join(ROOT, 'slop-lint', 'fixtures', 'cover-letters');

const PACKAGES: readonly PackageSpec[] = [
  {
    folder: 'slop-lint',
    name: '@fedemedinilla/slop-lint',
    entries: [
      { subpath: '.', source: 'src/lint.ts' },
      { subpath: './types', source: 'src/types.ts' },
    ],
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

  // 3. Install it in a fresh project outside the repository.
  const consumer = join(work, 'consumer', spec.folder);
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'pack-check-consumer', private: true, type: 'module' }, null, 2)}\n`);
  const installed = join(consumer, 'node_modules', ...spec.name.split('/'));
  if (spec.linkDependencies === undefined) {
    mustRun('npm', ['install', '--no-save', '--no-package-lock', tarball], { cwd: consumer, env: npmEnv(work) });
  } else {
    mkdirSync(installed, { recursive: true });
    mustRun('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed], { cwd: work });
    for (const dependency of spec.linkDependencies) {
      const link = join(consumer, 'node_modules', ...dependency.split('/'));
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(NODE_MODULES, ...dependency.split('/')), link, 'junction');
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

    const exportsField = (manifest['exports'] as Record<string, { types: string }>)[entry.subpath] ?? fail(`exports has no ${entry.subpath}`);
    const declarationFile = join(installed, exportsField.types);
    const declared = declaredExports(declarationFile, { ...SOURCE_OPTIONS, allowImportingTsExtensions: false });
    const sourceDeclared = declaredExports(join(packageDir, entry.source), SOURCE_OPTIONS);
    sameList(`the declared exports of ${specifier} and ${spec.folder}/${entry.source}`, declared, sourceDeclared);
    say(`entry ${entry.subpath}: ${runtime.length} runtime exports and ${declared.length} declared exports match the source`);
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
  if (spec.binRuns !== undefined) {
    const bin = join(consumer, 'node_modules', '.bin', 'slop-lint');
    const first = readFileSync(join(installed, 'dist', 'cli.js'), 'utf8').split('\n')[0];
    if (first !== '#!/usr/bin/env node') fail(`dist/cli.js starts with ${String(first)}, not the shebang`);
    for (const args of spec.binRuns) {
      const viaBin = run(bin, args, { cwd: ROOT, input: '' });
      const viaSource = run(process.execPath, [join(ROOT, 'slop-lint', 'cli.ts'), ...args], { cwd: ROOT, input: '' });
      if (viaBin.status !== viaSource.status) fail(`slop-lint ${args.join(' ')} exited ${String(viaBin.status)} installed and ${String(viaSource.status)} from source`);
      if (viaBin.stdout !== viaSource.stdout) fail(`slop-lint ${args.join(' ')} printed different stdout installed and from source`);
      if (viaBin.stderr !== viaSource.stderr) fail(`slop-lint ${args.join(' ')} printed different stderr installed and from source`);
      say(`bin and source CLI agree on ${args.map((a) => (isAbsolute(a) ? relative(ROOT, a) : a)).join(' ')} (exit ${String(viaBin.status)})`);
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
