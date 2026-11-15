import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AREAS, CROSS, EXTRA, UNITS, unitsOf } from './units.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tracked = (): string[] => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

describe('the audit areas', () => {
  it('are the 31 units and 4 cross-cutting areas of the full audit, plus the extra area', () => {
    expect(UNITS).toHaveLength(31);
    expect(CROSS.map((a) => a.id)).toEqual(['ci-workflows-actions', 'packaging-release', 'root-docs-truth', 'dependencies']);
    expect(EXTRA.map((a) => a.id)).toEqual(['repo-tooling']);
    expect(new Set(AREAS.map((a) => a.id)).size).toBe(AREAS.length);
  });

  it('give every top-level folder of the repository a unit', () => {
    const folders = [...new Set(tracked().filter((f) => f.includes('/')).map((f) => f.split('/')[0] ?? ''))].sort();
    expect(folders.length).toBeGreaterThan(20);
    const unmapped = folders.filter((dir) => !tracked().some((f) => f.startsWith(`${dir}/`) && unitsOf(f).length > 0));
    expect(unmapped).toEqual([]);
  });

  it('give every file git tracks at least one unit', () => {
    expect(tracked().filter((f) => unitsOf(f).length === 0)).toEqual([]);
  });

  it('map files by their globs, a file to every area that names it', () => {
    expect(unitsOf('gateway/src/index.ts')).toEqual(['gateway']);
    expect(unitsOf('apps/caja/src/main.ts')).toEqual(['apps-caja']);
    expect(unitsOf('apps/caja/vite.config.ts')).toEqual(['apps-caja', 'apps-shell-and-pages']);
    expect(unitsOf('apps/pages.ts')).toEqual(['apps-shell-and-pages']);
    expect(unitsOf('slop-lint/action.yml')).toEqual(['slop-lint', 'ci-workflows-actions']);
    expect(unitsOf('package.json')).toEqual(['packaging-release', 'dependencies']);
    expect(unitsOf('test/packaging/pack-check.ts')).toEqual(['packaging-release']);
    expect(unitsOf('.github/dependabot.yml')).toEqual(['ci-workflows-actions', 'dependencies']);
    expect(unitsOf('test/maintenance/dependabot.test.ts')).toEqual(['dependencies']);
    expect(unitsOf('README.md')).toEqual(['root-docs-truth']);
    expect(unitsOf('.claude/workflows/audit-diff.js')).toEqual(['repo-tooling']);
    expect(unitsOf('nowhere.txt')).toEqual([]);
  });
});
