// The audit units of this repository, as data: the 32 units and 4 cross-cutting areas of the full
// audit, plus one area of our own for the repository tooling the full audit leaves out. Each area
// owns the files its globs match (globs as in import-fences: `**` spans folders, `*` one segment).
// A file may belong to more than one area: apps/caja/vite.config.ts is in apps-caja and in
// apps-shell-and-pages, package.json in packaging-release and in dependencies.
//
// `paths` and `context` are copied from the full audit's UNITS and CROSS arrays, so a diff-scoped
// finder gets the same brief as a full-audit finder. units.test.ts checks that every file git
// tracks belongs to an area.

import { globMatcher } from '../../import-fences/src/index.ts';

export type AreaKind =
  /** One of the 32 units of the full audit: a folder or an app. */
  | 'unit'
  /** One of the 4 cross-cutting areas of the full audit. */
  | 'cross'
  /** Not in the full audit: repository tooling and root config. */
  | 'extra';

export interface Area {
  readonly id: string;
  readonly kind: AreaKind;
  /** What the full audit says the area covers, for the finder's prompt. */
  readonly paths: string;
  readonly globs: readonly string[];
  readonly context: string;
}

const folder = (id: string, context: string, dir = id): Area => ({ id, kind: 'unit', paths: `${dir}/`, globs: [`${dir}/**`], context });

export const UNITS: readonly Area[] = [
  folder('gateway', 'Spend caps, worst-case reservation, model registry, Postgres adapter with advisory lock (only tested with single-connection PGlite: check whether two real connections are handled correctly; if psql/initdb/pg_ctl are available you may start a throwaway local Postgres in /tmp/claude-0 to test, otherwise reason from the SQL), tracing hook. Null totals must never read as zero.'),
  folder('evals', 'Variant runner, blinding, rubrics (groundedness/classification/extraction), Wilson + Newcombe gate with exit codes 0/1/2/3, HTML report escaping, red-team runner. CASE-STUDY numbers must stay reproducible.'),
  folder('slop-lint', 'Rules, config discovery/validation, custom regex rules, inline suppression, SARIF (column units, fingerprints), --list-rules, action.yml, golden outputs.'),
  folder('site-check', 'Passive scope guard in the network layer, every number traced to a measurement, run.json v2 with v1 migration, --compare, --lang, --json, --sarif, pyproject packaging.'),
  folder('import-fences', 'Import parsing via the TypeScript compiler API (type-only imports, dynamic imports, re-exports), globbing, JSON config + schema, SARIF, action.yml.'),
  folder('csp-build-guard', 'CSP set comparison, inline hashes, secrets scan, lookbehind detection, JS budget, a check that cannot run must fail, SARIF, action.yml, new src/index.ts public entry.'),
  folder('amount-parser', 'Known lead to confirm or refute by running it: "un millón doscientos cincuenta" may give 1200050; readWordNumber skipping leading non-number tokens. 424 surviving mutants documented by area: look for real bugs among them. ambiguous:true instead of guessing.'),
  folder('grounded-assistant', 'decide() five checks against salon tables, money guard over every $ figure (184 surviving mutants: real untested alternatives), signed conversation history.'),
  folder('idempotent-orders', 'Postgres functions + TS client: one order per key with fingerprint, stock taken once under races, four-way result including unknown.'),
  folder('supabase-auth-hardening', 'SQL controls for sign-ups, pre-registered passwords, email changes, code guesses; read-only audit of RLS/grants/search_path; PGlite tests against default grants.'),
  folder('safe-markdown', 'Escape-first renderer used with innerHTML: try to break it (XSS in links, nested emphasis, entities, javascript: and data: URLs, unicode tricks).'),
  folder('safe-contact-form', 'Honeypot, clock skew, origin check behind proxies, destination never from the request, acknowledgment without visitor links.'),
  folder('pdf-receipt', 'pdf-lib receipts, WinAnsi sanitizer, pagination, amount box fitting.'),
  folder('deterministic-sim', 'Seeded streams, one rounding per formula, canonical SHA-256 run hash, purity test on the syntax tree, guard hooks.'),
  folder('content-forge', 'LLM candidates validated by zod schemas, range rules, cross-references; per-candidate verdicts; promote never overwrites hand-written files.'),
  folder('prose-rewriter', 'Rewrites a user text with slop-lint findings and the CV as the only fact source: zod contract, edits over exact quotes, fact diff per edit (nothing added that is not in the text or CV, nothing lost), fixtures fictional with a witness test.'),
  folder('style-refs', 'Data and validator only, no I/O: sources with legal status per jurisdiction, principles, excerpts, fictional examples. Nothing protected in the US may enter; unverified counts as not free.'),
  folder('fake-supabase-auth', 'Fetch fake of Supabase Auth and PostgREST with real ES256/HS256 JWTs and JWKS.'),
  folder('agent-playbook', 'Session hook, test env isolation, workflow-secrets policy parser (quoted keys, flow mappings, fail closed), edit hooks, reviewer agent, CLAUDE.md template.'),
  folder('n8n-templates', 'Thirteen workflows + offline harness (node:vm) + structural tests. The harness is a port of n8n semantics never checked against a real n8n: look for places where it diverges from n8n 2.15 source (you may npm pack n8n-workflow / n8n-nodes-base into /tmp/claude-0 to read their source, not as dependencies). Six fixes were made; verify each fix is correct and complete. Known open: Remove Duplicates 10,000-key history, MercadoPago type check, signature ts age.'),
  folder('wp-hardening', 'WordPress plugin hardening controls with guards, Site Health tests, wp harden CLI, read-only audit, generated server rules. Run npm run test:php.'),
  folder('apps-caja', 'Offline cash book PWA on amount-parser, optional model mode through gateway (amount must still come from the parser).', 'apps/caja'),
  folder('apps-chat-widget', 'Multi-tenant chat backend + embeddable widget, owner panel, abuse controls, tenant isolation.', 'apps/chat-widget'),
  folder('apps-checklist', 'Offline audit checklist, run rules (Fixed refused before pre-change list), site-check import of run.json v2 and datos.json v1, storage, service worker.', 'apps/checklist'),
  folder('apps-rewriter', 'Local server over prose-rewriter rewrite() through gateway caps; page recomposes text from accepted changes (reverted ones give back the original words); demo mode with recorded results; CV never stored or logged.', 'apps/rewriter'),
  folder('apps-writer', 'School message writer through gateway and evals, [COMPLETAR] markers for missing facts.', 'apps/writer'),
  folder('apps-salon-assistant', 'Booking assistant: price, time and stylist from tables, never from the model; safe-markdown rendering.', 'apps/salon-assistant'),
  folder('apps-push-lab', 'Web push incl. iPhone, VAPID, its own server, badge.', 'apps/push-lab'),
  folder('apps-receipt', 'In-tab PDF receipt builder on pdf-receipt.', 'apps/receipt'),
  folder('apps-replay-lab', 'Deterministic replay, export/import with hash checks, worker with 1,000 runs.', 'apps/replay-lab'),
  {
    id: 'apps-shell-and-pages',
    kind: 'unit',
    paths: 'apps/shared/ apps/pages.ts apps/index.html and every apps/*/csp-guard.config.json and vite config',
    // apps/* is every file directly under apps/: pages.ts, its test, index.html, index.css.
    globs: ['apps/*', 'apps/shared/**', 'apps/*/csp-guard.config.json', 'apps/*/vite.config.ts'],
    context: 'Pages assembly, landing page, shared app code, CSP configs per app.',
  },
  folder('docs-site', 'Astro Starlight site generated from READMEs: link rewriting, broken-link failure, base path /applied-ai-toolkit/docs/, check-links, pages.yml integration. Run npm run build:docs.'),
];

export const CROSS: readonly Area[] = [
  {
    id: 'ci-workflows-actions',
    kind: 'cross',
    paths: '.github/workflows/*.yml, */action.yml',
    // The rest of .github/ (the pull request template) has no other home.
    globs: ['.github/**', '*/action.yml', '.node-version'],
    context: 'Script injection, permissions, SHA pins (verify each with git ls-remote against its tag), triggers (forks, pull_request_target), release gating by vars.NPM_RELEASE, OIDC provenance, quality.yml weekly jobs, pages.yml docs step, the Composite actions job. Simulate run: steps locally where possible.',
  },
  {
    id: 'packaging-release',
    kind: 'cross',
    paths: 'test/packaging/, */package.json, */tsconfig.build.json, .changeset/, root package.json workspaces, site-check/pyproject.toml',
    globs: ['test/packaging/**', 'package.json', '*/package.json', '*/tsconfig.build.json', '.changeset/**', 'site-check/pyproject.toml'],
    context: 'Build and pack all four packages and install them in an empty temp project as a user would; check exports, bins, d.ts, sourcemaps, files lists, engines, dependency vs peer choices, LICENSE in tarballs, changesets that exist and what version each would release; site-check sdist.',
  },
  {
    id: 'root-docs-truth',
    kind: 'cross',
    paths: 'README.md, CONTRIBUTING.md, SECURITY.md, docs-site/pages/*.md, every claim with a number',
    globs: ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'MAINTENANCE.md', 'LICENSE', 'docs-site/pages/*.md', '.github/*.md'],
    context: 'Every command in Run everything runs as written; every number matches a run you do or a dated folder README; every link resolves; claims about what a folder does match its code.',
  },
  {
    id: 'dependencies',
    kind: 'cross',
    paths: 'package.json, package-lock.json, docs-site/package.json, wp-hardening/composer.json, .github/dependabot.yml and its test',
    globs: [
      'package.json',
      'package-lock.json',
      '.npmrc',
      'docs-site/package.json',
      'docs-site/package-lock.json',
      'wp-hardening/composer.json',
      'wp-hardening/composer.lock',
      '.github/dependabot.yml',
      'test/maintenance/dependabot.test.ts',
    ],
    context: 'npm audit (root and docs-site, with and without --omit=dev), packages declared but unused, used but undeclared (runtime imports resolved only through hoisting), version consistency across workspaces, very fresh pins.',
  },
];

/** Not in the full audit, which names no unit for test/bench, root config or the audit tooling itself. */
export const EXTRA: readonly Area[] = [
  {
    id: 'repo-tooling',
    kind: 'extra',
    paths: 'test/bench/, test/audit-scope/, .claude/workflows/, tsconfig.json, vitest configs, .gitignore',
    globs: ['test/bench/**', 'test/audit-scope/**', '.claude/workflows/**', 'tsconfig.json', 'vitest.config.ts', 'vitest.bench.config.ts', '.gitignore'],
    context: 'Benchmark compare and calibration, this diff-scoped audit (scope tool and workflow), the root TypeScript and Vitest configs. Commands in their READMEs run as written.',
  },
];

export const AREAS: readonly Area[] = [...UNITS, ...CROSS, ...EXTRA];

const matchers = new WeakMap<Area, (path: string) => boolean>();

/** The ids of every area that owns the path, in the order of AREAS. */
export function unitsOf(path: string, areas: readonly Area[] = AREAS): string[] {
  return areas
    .filter((area) => {
      let match = matchers.get(area);
      if (match === undefined) matchers.set(area, (match = globMatcher(area.globs)));
      return match(path);
    })
    .map((area) => area.id);
}
