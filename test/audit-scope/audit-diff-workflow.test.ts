// Structural and dry-run checks of the audit-diff workflow (.claude/workflows/audit-diff.js). The
// workflow runs inside Claude Code's Workflow tool, which wraps the body in an async function with
// agent(), parallel(), pipeline(), phase(), log() and args. These tests compile it the same way and
// run it with fake agents, so its guards and its agent count are checked offline.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../../.claude/workflows/audit-diff.js', import.meta.url), 'utf8');
const META_END = SOURCE.indexOf('\n}\n');

/** The text of the meta object literal, from its opening brace to its closing one. */
const metaLiteral = (): string => SOURCE.slice('export const meta = '.length, META_END + 2);

/** True when the text is only object and array literals of strings, numbers and booleans, with plain keys. */
function isPureLiteral(text: string): boolean {
  const rest = text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
  if (/`/.test(rest)) return false;
  const tokens = rest.replace(/""|\b\d+\b|\btrue\b|\bfalse\b|\bnull\b|\b[A-Za-z_]\w*\s*:/g, ' ');
  return /^[\s{}[\]:,]*$/.test(tokens);
}

type Hook = (...args: never[]) => unknown;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...hooks: unknown[]) => Promise<unknown>;
const compile = () => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', SOURCE.replace(/^export const meta/, 'const meta'));

interface Call {
  readonly label: string;
  readonly prompt: string;
  readonly opts: Record<string, unknown>;
}

/** Runs the workflow with fake hooks. `answer` gives each agent's result from its label. */
async function dryRun(args: unknown, answer: (label: string, prompt: string) => unknown) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const agent = async (prompt: string, opts: Record<string, unknown> = {}) => {
    const label = String(opts.label ?? '');
    calls.push({ label, prompt, opts });
    return answer(label, prompt);
  };
  const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = (items: unknown[], ...stages: ((prev: unknown, item: unknown, i: number) => unknown)[]) =>
    Promise.all(
      items.map(async (item, i) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, i);
          } catch {
            return null;
          }
        }
        return value;
      }),
    );
  const result = await compile()(agent, parallel, pipeline, (t: string) => phases.push(t), () => undefined, args, { total: null }, (() => undefined) as Hook);
  return { result: result as Record<string, unknown>, calls, phases };
}

const scope = (over: Record<string, unknown> = {}) => ({
  version: 1,
  root: '/repo',
  base: 'origin/main',
  mergeBase: 'b'.repeat(40),
  head: 'h'.repeat(40),
  branch: 'claude/work',
  dirty: false,
  files: ['gateway/src/caps.ts'],
  units: [
    { id: 'gateway', kind: 'unit', reason: 'changed', files: ['gateway/src/caps.ts'], paths: 'gateway/', context: 'Spend caps.' },
    { id: 'apps-caja', kind: 'unit', reason: 'dependent', files: ['apps/caja/src/main.ts'], paths: 'apps/caja/', context: 'Cash book.' },
  ],
  dependents: [{ unit: 'apps-caja', because: [{ on: 'gateway', importer: 'apps/caja/src/main.ts', line: 3, specifier: '../../../gateway/src/index.ts', target: 'gateway/src/index.ts' }] }],
  unmapped: [],
  ...over,
});

const finding = (severity: string) => ({
  kind: 'bug',
  severity,
  file: 'gateway/src/caps.ts',
  line: 10,
  title: `a ${severity} bug`,
  detail: 'd',
  evidence: 'e',
  failure_scenario: 's',
  proposed_fix: 'f',
});

/** One high finding from gateway's lens A, none elsewhere; every verifier upholds. */
const happy = (label: string): unknown => {
  if (label === 'find:gateway:A') return { findings: [finding('high')], covered: 'ran it' };
  if (label.startsWith('find:')) return { findings: [], covered: 'read it' };
  if (label.startsWith('verify:')) return { refuted: false, reason: 'reproduced', evidence: 'out' };
  return `report of ${label}`;
};

describe('the audit-diff workflow file', () => {
  it('starts with a meta object that is a pure literal', () => {
    expect(SOURCE.startsWith('export const meta = {')).toBe(true);
    expect(isPureLiteral(metaLiteral())).toBe(true);
    expect(isPureLiteral("{ name: `x${y}` }")).toBe(false);
    expect(isPureLiteral('{ name: NAME }')).toBe(false);
    expect(isPureLiteral('{ ...base }')).toBe(false);
    expect(isPureLiteral("{ name: f('x') }")).toBe(false);
  });

  it('names itself audit-diff and lists every phase it starts, and only those', () => {
    const meta = new Function(`return (${metaLiteral()})`)() as { name: string; description: string; whenToUse: string; phases: { title: string }[] };
    expect(meta.name).toBe('audit-diff');
    expect(meta.description.length).toBeGreaterThan(20);
    expect(meta.whenToUse).toMatch(/audit:scope/);
    // A phase starts with phase('X') or groups agents with the option phase: 'X' (Verify runs inside the Find pipeline).
    const used = [...SOURCE.matchAll(/\bphase(?:\(|: )'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(meta.phases.map((p) => p.title).sort());
    expect(meta.phases.map((p) => p.title)).toEqual(['Find', 'Verify', 'Fix', 'Integrate', 'Report']);
  });

  it('parses as the body of an async function', () => {
    expect(compile).not.toThrow();
  });

  it('uses no clock, randomness, filesystem or worktree isolation option', () => {
    for (const banned of [/Date\.now/, /Math\.random/, /new Date\(/, /\brequire\(/, /^\s*import\s/m, /\bprocess\./, /isolation\s*:/]) expect(SOURCE).not.toMatch(banned);
    expect(SOURCE).toContain('worktree add');
    expect(SOURCE).toContain('.claude/worktrees/');
  });

  it('puts the fixer worktrees where the root .gitignore ignores them, so the integrator sees a clean status', () => {
    // Read .gitignore itself: .git/info/exclude is a setting of one checkout, not of the repository.
    const rules = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    expect(rules).toContain('/.claude/worktrees/');
  });
});

describe('a dry run with fake agents', () => {
  it('runs two lenses per changed unit and one per dependent, three verifiers for a high finding, then fixes and reports', async () => {
    const { result, calls, phases } = await dryRun(scope(), happy);
    const labels = calls.map((c) => c.label);
    expect(labels.filter((l) => l.startsWith('find:')).sort()).toEqual(['find:apps-caja:D', 'find:gateway:A', 'find:gateway:B']);
    expect(labels.filter((l) => l.startsWith('verify:'))).toHaveLength(3);
    expect(new Set(calls.filter((c) => c.label.startsWith('verify:')).map((c) => c.prompt)).size).toBe(3);
    expect(labels.filter((l) => l.startsWith('fix:'))).toEqual(['fix:gateway']);
    expect(labels.slice(-2)).toEqual(['integrate', 'report']);
    expect(phases).toEqual(['Find', 'Fix', 'Integrate', 'Report']);
    expect(result.counts).toEqual({ units: 2, finders: 3, raw: 1, confirmed: 1 });
    const fix = calls.find((c) => c.label === 'fix:gateway');
    expect(fix?.prompt).toContain('git -C /repo worktree add');
    expect(fix?.prompt).toContain('/repo/.claude/worktrees/audit-diff-gateway');
    expect(fix?.prompt).toContain('h'.repeat(40));
    expect(fix?.opts.isolation).toBeUndefined();
    expect(calls.find((c) => c.label === 'report')?.prompt).toMatch(/castellano rioplatense/);
  });

  it('scales the agent count with the diff', async () => {
    const one = scope({ units: [scope().units[0]], dependents: [] });
    const { calls } = await dryRun(one, (label) => (label.startsWith('find:') ? { findings: [], covered: 'x' } : 'r'));
    expect(calls.map((c) => c.label)).toEqual(expect.arrayContaining(['find:gateway:A', 'find:gateway:B']));
    // Nothing confirmed: no fixer and no integration, only the report.
    expect(calls.map((c) => c.label).filter((l) => !l.startsWith('find:'))).toEqual(['report']);
  });

  it('gives a medium finding one verifier that builds its own reproduction, and low findings one batch verifier', async () => {
    const { calls } = await dryRun(scope(), (label) => {
      if (label === 'find:gateway:B') return { findings: [finding('medium'), finding('low'), { ...finding('low'), line: 40 }], covered: 'x' };
      if (label.startsWith('find:')) return { findings: [], covered: 'x' };
      if (label.endsWith(':low')) return { verdicts: [{ index: 0, refuted: true, reason: 'no' }, { index: 1, refuted: false, reason: 'yes' }] };
      if (label.startsWith('verify:')) return { refuted: false, reason: 'yes', evidence: 'e' };
      return 'r';
    });
    const verifiers = calls.filter((c) => c.label.startsWith('verify:'));
    expect(verifiers).toHaveLength(2);
    expect(verifiers.find((c) => !c.label.endsWith(':low'))?.prompt).toMatch(/own minimal reproduction/);
  });

  it('refutes a high finding when two of three verifiers refute it', async () => {
    let n = 0;
    const { result, calls } = await dryRun(scope(), (label) => {
      if (label.startsWith('verify:')) return { refuted: n++ > 0, reason: 'r', evidence: 'e' };
      return happy(label);
    });
    expect((result.counts as Record<string, number>).confirmed).toBe(0);
    expect(calls.some((c) => c.label.startsWith('fix:'))).toBe(false);
  });

  it('stops before Fix when a finder is missing', async () => {
    const { result, calls } = await dryRun(scope(), (label) => (label === 'find:apps-caja:D' ? null : happy(label)));
    expect(result.incomplete).toBe(true);
    expect(result.missingFinders).toBe(1);
    expect(calls.some((c) => c.label.startsWith('fix:') || c.label === 'integrate')).toBe(false);
  });

  it('stops before Fix when a verdict is missing', async () => {
    let n = 0;
    const { result, calls } = await dryRun(scope(), (label) => (label.startsWith('verify:') && n++ === 1 ? null : happy(label)));
    expect(result.incomplete).toBe(true);
    expect(result.shortVerdicts).toBe(1);
    expect(calls.some((c) => c.label.startsWith('fix:'))).toBe(false);
  });

  it('stops before Fix when the scope had uncommitted changes', async () => {
    const { result, calls } = await dryRun(scope({ dirty: true }), happy);
    expect(result.stoppedBeforeFix).toMatch(/uncommitted/);
    expect(calls.some((c) => c.label.startsWith('fix:'))).toBe(false);
  });

  it('stops before Integrate when a fixer is missing', async () => {
    const { result, calls } = await dryRun(scope(), (label) => (label.startsWith('fix:') ? null : happy(label)));
    expect(result).toMatchObject({ incomplete: true, stage: 'Fix', missing: ['gateway'] });
    expect(calls.some((c) => c.label === 'integrate')).toBe(false);
  });

  it('refuses args that are not a scope, and accepts the scope as a JSON string', async () => {
    for (const bad of [undefined, {}, { version: 2, units: [] }, '{not json']) {
      const { result, calls } = await dryRun(bad, happy);
      expect(result.error).toMatch(/audit:scope/);
      expect(calls).toEqual([]);
    }
    const { calls } = await dryRun(JSON.stringify(scope()), happy);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns without agents when the diff touches no unit', async () => {
    const { result, calls } = await dryRun(scope({ units: [], dependents: [], files: [] }), happy);
    expect(result.nothingToAudit).toBe(true);
    expect(calls).toEqual([]);
  });
});
