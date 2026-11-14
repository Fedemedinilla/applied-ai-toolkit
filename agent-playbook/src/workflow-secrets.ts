/**
 * "CI holds no secrets", as a check over GitHub Actions workflow files.
 *
 * Coding agents push branches. A workflow that reads a repository secret runs on every branch that
 * triggers it, so a branch pushed by an agent session could change the workflow and print the
 * secret, or use it against production. The safe arrangement is a CI that verifies and holds
 * nothing: deploys come from the host's own Git integration, and database changes are applied by
 * a person's request outside CI. This module turns that arrangement into findings a test can
 * assert empty, so adding a secret to CI fails the suite and forces the decision to be revisited.
 *
 * The parser is line-based on purpose: the checks look for keys and expressions that are
 * recognizable on one line, and it needs no YAML dependency. It reads block-style YAML as GitHub's
 * own examples write it; a workflow written in flow style ({ a: b }) is out of scope.
 */

export interface WorkflowPolicy {
  /** Every value under an env: block whose name looks like a credential must match this. */
  readonly placeholder: RegExp;
  /**
   * Permissions this workflow may set to write, by name. Empty by default. A static-site deploy
   * through GitHub Pages needs `pages` and `id-token`, which publish an artifact and nothing else;
   * `contents`, `packages` and `write-all` stay findings whatever this lists.
   */
  readonly allowWrite?: readonly string[];
  /** Deployment environments this workflow may name, such as `github-pages`. Empty by default. */
  readonly allowEnvironments?: readonly string[];
  /**
   * Permissions from the never-write set below that this workflow may still set to write. Empty by
   * default, and only RELEASE_POLICY lists any. Each one is allowed in a job's own permissions
   * block only: at the top level it would reach every job. And never in a job that also holds
   * `id-token: write`, so the job that can publish cannot push to the repository.
   */
  readonly allowRepositoryWrite?: readonly string[];
  /** When true, every write permission at the top level is a finding, whatever the lists allow. */
  readonly writeInJobsOnly?: boolean;
}

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = { placeholder: /^ci-placeholder-[\w-]+$/ };

/** The policy for a workflow that only deploys a static site to GitHub Pages. */
export const PAGES_DEPLOY_POLICY: WorkflowPolicy = {
  ...DEFAULT_WORKFLOW_POLICY,
  allowWrite: ['pages', 'id-token'],
  allowEnvironments: ['github-pages'],
};

/**
 * The policy for .github/workflows/release.yml, which versions and publishes the npm packages with
 * Changesets. Its version job pushes a branch and opens the "Version Packages" pull request
 * (`contents` and `pull-requests`); its publish job holds `id-token`, for npm trusted publishing
 * and provenance. No secret and no environment: the actions take the job token as their default
 * input, so the workflow never writes a secrets or github.token expression.
 */
export const RELEASE_POLICY: WorkflowPolicy = {
  ...DEFAULT_WORKFLOW_POLICY,
  allowWrite: ['id-token'],
  allowRepositoryWrite: ['contents', 'pull-requests'],
  writeInJobsOnly: true,
};

/**
 * Never allowed to write, even when a policy lists them in allowWrite: each one can change the
 * repository. A policy can allow some of them only through allowRepositoryWrite.
 */
const NEVER_WRITE = new Set(['contents', 'packages', 'actions', 'pull-requests', 'deployments', 'security-events', 'statuses', 'checks', 'issues']);

export interface Finding {
  readonly line: number;
  readonly rule:
    | 'secret-expression'
    | 'environment'
    | 'privileged-trigger'
    | 'write-permission'
    | 'no-top-level-permissions'
    | 'persisted-credentials'
    | 'unpinned-action'
    | 'credential-value';
  readonly text: string;
}

const CREDENTIAL_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
const PINNED = /@[0-9a-f]{40}(\s|$)/;

interface Line {
  readonly number: number;
  readonly indent: number;
  /** Without the comment and the trailing spaces. */
  readonly code: string;
}

function lines(text: string): Line[] {
  return text.split(/\r?\n/).map((raw, i) => {
    // A # starts a comment at the line start or after a space, outside quotes. Workflow values
    // rarely quote a #, and a false cut only hides text from the checks after it.
    const code = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    return { number: i + 1, indent: raw.length - raw.trimStart().length, code };
  });
}

/** The lines nested under the key on line `at`, by indentation. */
function blockUnder(all: readonly Line[], at: number): Line[] {
  const head = all[at];
  if (head === undefined) return [];
  const out: Line[] = [];
  for (const line of all.slice(at + 1)) {
    if (line.code.trim() === '') continue;
    if (line.indent <= head.indent) break;
    out.push(line);
  }
  return out;
}

/** Every line of the step that holds line `at`, from its dash to the next item at its level. */
function stepOf(all: readonly Line[], at: number): Line[] {
  let start = at;
  while (start >= 0 && !/^\s*-\s/.test(all[start]?.code ?? '')) start -= 1;
  const dash = all[start];
  if (dash === undefined) return [];
  return [dash, ...blockUnder(all, start)];
}

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

export function workflowFindings(text: string, policy: WorkflowPolicy = DEFAULT_WORKFLOW_POLICY): Finding[] {
  const all = lines(text);
  const findings: Finding[] = [];
  const add = (line: Line, rule: Finding['rule']): void => {
    findings.push({ line: line.number, rule, text: line.code.trim() });
  };

  let topPermissions = false;
  all.forEach((line, i) => {
    const code = line.code;
    if (/\$\{\{[^}]*\b(secrets|github\.token)\b/.test(code) || /^\s*secrets\s*:/.test(code)) add(line, 'secret-expression');
    const environment = /^\s*environment\s*:(.*)$/.exec(code)?.[1];
    if (environment !== undefined) {
      // `environment: name` or a block with `name: name` under it.
      const name =
        environment.trim() === ''
          ? blockUnder(all, i)
              .map((l) => /^\s*name\s*:(.*)$/.exec(l.code)?.[1])
              .find((v) => v !== undefined)
          : environment;
      if (name === undefined || !(policy.allowEnvironments ?? []).includes(unquote(name))) add(line, 'environment');
    }
    if (/\bpull_request_target\b|\bworkflow_run\b/.test(code)) add(line, 'privileged-trigger');
    if (line.indent === 0 && /^permissions\s*:/.test(code)) topPermissions = true;
    const permissions = /^\s*permissions\s*:(.*)$/.exec(code)?.[1];
    if (permissions !== undefined && unquote(permissions) === 'write-all') add(line, 'write-permission');
    if (permissions !== undefined && permissions.trim() === '') {
      const writes: Array<{ name: string; entry: Line }> = [];
      for (const entry of blockUnder(all, i)) {
        const pair = /^\s*([\w-]+)\s*:(.*)$/.exec(entry.code);
        const [name, value] = [pair?.[1], pair?.[2]];
        if (name === undefined || value === undefined || unquote(value) !== 'write') continue;
        writes.push({ name, entry });
      }
      const holdsIdToken = writes.some((w) => w.name === 'id-token');
      for (const { name, entry } of writes) {
        const allowed = NEVER_WRITE.has(name)
          ? (policy.allowRepositoryWrite ?? []).includes(name) && line.indent > 0 && !holdsIdToken
          : (policy.allowWrite ?? []).includes(name);
        if (!allowed || (policy.writeInJobsOnly === true && line.indent === 0)) add(entry, 'write-permission');
      }
    }

    const usesRaw = /^\s*(?:-\s*)?uses\s*:\s*(.+)$/.exec(code)?.[1];
    const uses = usesRaw === undefined ? undefined : unquote(usesRaw);
    if (uses !== undefined && !uses.startsWith('./') && !uses.startsWith('docker://') && !PINNED.test(`${uses} `)) {
      add(line, 'unpinned-action');
    }
    // actions/checkout keeps the job's token in .git/config unless the step says otherwise.
    // One finding per step, on its uses line, whether the option is missing or set to true.
    if (uses?.startsWith('actions/checkout@') === true) {
      const step = stepOf(all, i);
      const persist = step.map((l) => /^\s*persist-credentials\s*:(.*)$/.exec(l.code)?.[1]).find((v) => v !== undefined);
      if (persist === undefined || unquote(persist) !== 'false') add(line, 'persisted-credentials');
    }

    if (/^\s*env\s*:\s*$/.test(code)) {
      for (const entry of blockUnder(all, i)) {
        const pair = /^\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(entry.code);
        if (pair?.[1] === undefined || pair[2] === undefined) continue;
        if (CREDENTIAL_NAME.test(pair[1]) && !policy.placeholder.test(unquote(pair[2]))) add(entry, 'credential-value');
      }
    }
  });
  if (!topPermissions) findings.push({ line: 1, rule: 'no-top-level-permissions', text: 'permissions: is missing at the top level' });
  return findings;
}
