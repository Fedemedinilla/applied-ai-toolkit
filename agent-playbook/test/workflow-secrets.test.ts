import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGES_DEPLOY_POLICY, RELEASE_POLICY, workflowFindings, type WorkflowPolicy } from '../src/workflow-secrets.ts';

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
/** The one workflow that deploys: the static demos to GitHub Pages. Every other file gets the default policy. */
const POLICIES: Readonly<Record<string, WorkflowPolicy>> = { 'pages.yml': PAGES_DEPLOY_POLICY };

// The rule pointed at this repository's own CI. Adding a secret, an environment or a write
// permission to a workflow fails the suite, so the decision is made in review, not by accident.
describe("this repository's workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

  it('exist, so the check below is not vacuous', () => {
    expect(files).toContain('ci.yml');
  });

  it.each(files)('%s holds no secret and cannot write beyond its policy', (file) => {
    const text = readFileSync(new URL(file, WORKFLOWS), 'utf8');
    expect(workflowFindings(text, POLICIES[file])).toEqual([]);
  });

  it('gives pages.yml its write permissions only in the deploy job, and ci.yml none', () => {
    const pages = readFileSync(new URL('pages.yml', WORKFLOWS), 'utf8');
    expect(pages).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflowFindings(pages).map((f) => f.rule).sort()).toEqual(['environment', 'write-permission', 'write-permission']);
  });

  it('ci.yml really passes credential-shaped variables, so the placeholder check is exercised', () => {
    const text = readFileSync(new URL('ci.yml', WORKFLOWS), 'utf8');
    expect(text).toMatch(/^\s+[A-Z_]*(KEY|SECRET|PASSWORD)[A-Z_]*: ci-placeholder-/m);
  });
});

/** A minimal clean workflow; each test below breaks it in one way. */
const CLEAN = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      APP_API_KEY: ci-placeholder-app-0001
      NODE_ENV: test
    steps:
      - name: Check out
        uses: actions/checkout@${SHA} # v7.0.1
        with:
          persist-credentials: false
      - run: npm test
`;

const rules = (text: string): string[] => workflowFindings(text).map((f) => `${f.line}:${f.rule}`);

describe('workflowFindings', () => {
  it('accepts the clean workflow', () => {
    expect(workflowFindings(CLEAN)).toEqual([]);
  });

  it('reports a secret read through an expression, and one handed to a reusable workflow', () => {
    expect(rules(CLEAN.replace('ci-placeholder-app-0001', '${{ secrets.APP_API_KEY }}'))).toEqual(['10:credential-value', '10:secret-expression']);
    expect(rules(CLEAN.replace('      - run: npm test\n', '      - run: npm test\n  deploy:\n    uses: ./.github/workflows/deploy.yml\n    secrets: inherit\n'))).toEqual([
      '20:secret-expression',
    ]);
  });

  it('reports the job token used inline', () => {
    expect(rules(CLEAN.replace('      - run: npm test\n', '      - uses: ./.github/actions/release\n        with:\n          token: ${{ github.token }}\n'))).toEqual(['19:secret-expression']);
  });

  it('reports a real-looking value in a credential-shaped variable, and leaves other variables alone', () => {
    const found = workflowFindings(CLEAN.replace('ci-placeholder-app-0001', 'sk-live-0000'));
    expect(found).toEqual([{ line: 10, rule: 'credential-value', text: 'APP_API_KEY: sk-live-0000' }]);
    expect(rules(CLEAN.replace('NODE_ENV: test', 'NODE_ENV: production'))).toEqual([]);
  });

  it('accepts a quoted placeholder', () => {
    expect(rules(CLEAN.replace('ci-placeholder-app-0001', "'ci-placeholder-app-0001'"))).toEqual([]);
  });

  it('reports a deployment environment, which is where secrets for production live', () => {
    expect(rules(CLEAN.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    environment: production\n'))).toEqual(['9:environment']);
  });

  it('reports triggers that run with the base repository secrets on code from elsewhere', () => {
    expect(rules(CLEAN.replace('  push:', '  pull_request_target:'))).toEqual(['3:privileged-trigger']);
    expect(rules(CLEAN.replace('  push:', '  workflow_run:'))).toEqual(['3:privileged-trigger']);
  });

  it('reports write permissions and a missing top-level permissions block', () => {
    expect(rules(CLEAN.replace('contents: read', 'contents: write'))).toEqual(['5:write-permission']);
    expect(rules(CLEAN.replace('permissions:\n  contents: read', 'permissions: write-all'))).toEqual(['4:write-permission']);
    expect(rules(CLEAN.replace('permissions:\n  contents: read\n', ''))).toEqual(['1:no-top-level-permissions']);
  });

  it('allows only the write permissions and environments a policy names', () => {
    const deploy = CLEAN.replace(
      '    runs-on: ubuntu-latest\n',
      '    runs-on: ubuntu-latest\n    permissions:\n      pages: write\n      id-token: write\n    environment:\n      name: github-pages\n',
    );
    expect(rules(deploy)).toEqual(['10:write-permission', '11:write-permission', '12:environment']);
    expect(rules(deploy.replace('id-token: write', 'packages: write'))).toEqual(['10:write-permission', '11:write-permission', '12:environment']);
    expect(workflowFindings(deploy, PAGES_DEPLOY_POLICY)).toEqual([]);
    expect(rules(deploy.replace('id-token: write', 'contents: write')).length).toBe(3);
    const strict = (text: string) => workflowFindings(text, PAGES_DEPLOY_POLICY).map((f) => `${f.line}:${f.rule}`);
    expect(strict(deploy.replace('id-token: write', 'contents: write'))).toEqual(['11:write-permission']);
    expect(strict(deploy.replace('name: github-pages', 'name: production'))).toEqual(['12:environment']);
    expect(strict(deploy.replace('    environment:\n      name: github-pages\n', '    environment: github-pages\n'))).toEqual([]);
    expect(strict(deploy.replace('    environment:\n      name: github-pages\n', '    environment: production\n'))).toEqual(['12:environment']);
    // contents can push to the repository: a policy that lists it still gets the finding.
    const listed = workflowFindings(deploy.replace('id-token: write', 'contents: write'), { ...PAGES_DEPLOY_POLICY, allowWrite: ['pages', 'contents'] });
    expect(listed.map((f) => `${f.line}:${f.rule}`)).toEqual(['11:write-permission']);
  });

  it('reads quoted permission values', () => {
    expect(rules(CLEAN.replace('contents: read', "contents: 'write'"))).toEqual(['5:write-permission']);
    expect(rules(CLEAN.replace('contents: read', 'contents: "write"'))).toEqual(['5:write-permission']);
    expect(rules(CLEAN.replace('permissions:\n  contents: read', "permissions: 'write-all'"))).toEqual(['4:write-permission']);
  });

  it('reports a checkout that keeps the token in .git/config', () => {
    expect(rules(CLEAN.replace('persist-credentials: false', 'persist-credentials: true'))).toEqual(['14:persisted-credentials']);
    expect(rules(CLEAN.replace('        with:\n          persist-credentials: false\n', ''))).toEqual(['14:persisted-credentials']);
    expect(rules(CLEAN.replace('persist-credentials: false', "persist-credentials: 'false'"))).toEqual([]);
  });

  it('reads a quoted uses value, so a quoted checkout is still checked', () => {
    expect(rules(CLEAN.replace(`uses: actions/checkout@${SHA}`, `uses: "actions/checkout@${SHA}"`))).toEqual([]);
    const quotedNoOption = CLEAN.replace(`uses: actions/checkout@${SHA}`, `uses: 'actions/checkout@${SHA}'`).replace(
      '        with:\n          persist-credentials: false\n',
      '',
    );
    expect(rules(quotedNoOption)).toEqual(['14:persisted-credentials']);
    expect(rules(CLEAN.replace(`uses: actions/checkout@${SHA}`, "uses: 'actions/checkout@v7'"))).toEqual(['14:unpinned-action']);
  });

  it('reports an action pinned to a tag or a branch, and accepts local actions', () => {
    expect(rules(CLEAN.replace(`@${SHA}`, '@v7'))).toEqual(['14:unpinned-action']);
    expect(rules(CLEAN.replace('      - run: npm test', '      - uses: ./.github/actions/setup'))).toEqual([]);
  });

  it('ignores what a comment says, at the end of a line or on a line of its own', () => {
    // Without the comment stripping, each of these lines would produce a finding.
    expect(rules(CLEAN.replace('      - run: npm test', '      - run: npm test # ${{ secrets.APP_API_KEY }}'))).toEqual([]);
    expect(rules(CLEAN.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    # environment: production\n'))).toEqual([]);
    expect(rules(CLEAN.replace('  contents: read', '  contents: read\n  # packages: write'))).toEqual([]);
  });
});

/** The shape of release.yml: a version job that can push and open a pull request, a publish job with OIDC. */
const RELEASE = `name: Release
on:
  push:
    branches:
      - main
permissions:
  contents: read
jobs:
  version:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - run: npx changeset version
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: npx changeset publish
`;

describe('RELEASE_POLICY', () => {
  const strict = (text: string) => workflowFindings(text, RELEASE_POLICY).map((f) => `${f.line}:${f.rule}`);

  it('accepts the version and publish jobs, which the default and Pages policies reject', () => {
    expect(strict(RELEASE)).toEqual([]);
    expect(rules(RELEASE)).toEqual(['12:write-permission', '13:write-permission', '19:write-permission']);
    expect(workflowFindings(RELEASE, PAGES_DEPLOY_POLICY).map((f) => f.line)).toEqual([12, 13]);
  });

  it('rejects every other write permission, in a job or at the top level', () => {
    for (const name of ['packages', 'actions', 'issues', 'deployments', 'statuses', 'checks', 'security-events', 'pages', 'attestations']) {
      expect(strict(RELEASE.replace('      pull-requests: write\n', `      pull-requests: write\n      ${name}: write\n`))).toEqual(['14:write-permission']);
    }
    expect(strict(RELEASE.replace('    permissions:\n      id-token: write\n', '    permissions: write-all\n'))).toEqual(['18:write-permission']);
  });

  it('rejects the repository writes at the top level, where they would reach every job', () => {
    expect(strict(RELEASE.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'))).toEqual(['7:write-permission']);
    expect(strict(RELEASE.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  pull-requests: write'))).toEqual(['8:write-permission']);
    // id-token is allowed in a job; at the top level every job could publish.
    expect(strict(RELEASE.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write'))).toEqual(['8:write-permission']);
  });

  it('rejects a job that holds id-token next to a repository write', () => {
    expect(strict(RELEASE.replace('      id-token: write\n', '      id-token: write\n      contents: write\n'))).toEqual(['20:write-permission']);
    expect(strict(RELEASE.replace('      pull-requests: write\n', '      pull-requests: write\n      id-token: write\n'))).toEqual([
      '12:write-permission',
      '13:write-permission',
    ]);
  });

  it('still rejects secrets, the token written out, environments and untrusted triggers', () => {
    const step = '      - run: npx changeset publish\n';
    expect(strict(RELEASE.replace(step, `${step}        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`))).toEqual(['23:credential-value', '23:secret-expression']);
    expect(strict(RELEASE.replace(step, `${step}        env:\n          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`))).toEqual(['23:credential-value', '23:secret-expression']);
    expect(strict(RELEASE.replace(step, '      - uses: ./.github/actions/release\n        with:\n          github-token: ${{ github.token }}\n'))).toEqual(['23:secret-expression']);
    expect(strict(RELEASE.replace('    runs-on: ubuntu-latest\n    permissions:\n      id-token', '    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      id-token'))).toEqual([
      '18:environment',
    ]);
    expect(strict(RELEASE.replace('  push:', '  pull_request_target:'))).toEqual(['3:privileged-trigger']);
  });
});
