import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = new URL('../../.github/dependabot.yml', import.meta.url);
const tracked = (): string[] => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

interface Entry {
  readonly ecosystem: string;
  /** `directory`, or each item of a `directories` list. */
  readonly directories: readonly string[];
  readonly text: string;
  readonly field: (key: string) => string | undefined;
}

/**
 * Splits .github/dependabot.yml into its update entries. The file keeps one layout on purpose
 * (`  - package-ecosystem:` opens an entry, one key per line), so a line reader is enough and the
 * test needs no YAML dependency.
 */
function entries(text: string): Entry[] {
  const blocks = text.split(/^ {2}- (?=package-ecosystem:)/m).slice(1);
  return blocks.map((block) => {
    const field = (key: string) => new RegExp(`^\\s*${key}:\\s*"?([^"\\n#]*?)"?\\s*(?:#.*)?$`, 'm').exec(block)?.[1];
    const list = /^\s*directories:\s*\[([^\]]*)\]/m.exec(block)?.[1];
    const directories = list === undefined ? [field('directory') ?? '?'] : list.split(',').map((d) => d.trim().replace(/^"|"$/g, ''));
    return { ecosystem: field('package-ecosystem') ?? '', directories, text: block, field };
  });
}

/** What Dependabot has to watch, read from the files the repository tracks. */
function expectedTargets(files: readonly string[]): string[] {
  const dirOf = (file: string) => {
    const dir = file.split('/').slice(0, -1).join('/');
    return dir === '' ? '/' : `/${dir}`;
  };
  const targets = new Set<string>();
  for (const file of files) {
    if (file.includes('node_modules/')) continue;
    if (/(^|\/)package-lock\.json$/.test(file)) targets.add(`npm ${dirOf(file)}`);
    if (/(^|\/)composer\.lock$/.test(file)) targets.add(`composer ${dirOf(file)}`);
    if (/(^|\/)requirements[^/]*\.txt$/.test(file)) targets.add(`pip ${dirOf(file)}`);
    if (/(^|\/)pyproject\.toml$/.test(file)) {
      // A pyproject with no dependencies has nothing for Dependabot to bump.
      const deps = /^dependencies\s*=\s*\[([^\]]*)\]/m.exec(readFileSync(`${ROOT}/${file}`, 'utf8'))?.[1] ?? '';
      if (deps.trim() !== '') targets.add(`pip ${dirOf(file)}`);
    }
    // Dependabot reads .github/workflows/ from "/", and a composite action from its own folder.
    if (file.startsWith('.github/workflows/')) targets.add('github-actions /');
    if (/(^|\/)action\.ya?ml$/.test(file)) targets.add(`github-actions ${dirOf(file)}`);
  }
  return [...targets].sort();
}

describe('.github/dependabot.yml', () => {
  it('exists', () => {
    expect(existsSync(CONFIG)).toBe(true);
  });

  const text = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
  const all = entries(text);

  it('has one entry per lockfile and covers the workflows and every composite action, and none for a stdlib-only pyproject', () => {
    expect(text).toMatch(/^version: 2$/m);
    const targets = all.flatMap((e) => e.directories.map((d) => `${e.ecosystem} ${d}`)).sort();
    expect(targets).toEqual(expectedTargets(tracked()));
    expect(targets).not.toContain('pip /site-check');
  });

  it.each(['npm /', 'npm /docs-site', 'composer /wp-hardening', 'github-actions /'])('covers %s', (target) => {
    expect(all.flatMap((e) => e.directories.map((d) => `${e.ecosystem} ${d}`))).toContain(target);
  });

  it('runs every entry weekly with a commit-message prefix and a small open-PR limit', () => {
    for (const e of all) {
      expect(e.field('interval'), e.ecosystem).toBe('weekly');
      expect(e.field('prefix'), e.ecosystem).toMatch(/^\S+$/);
      const limit = Number(e.field('open-pull-requests-limit'));
      expect(limit, e.ecosystem).toBeGreaterThanOrEqual(1);
      expect(limit, e.ecosystem).toBeLessThanOrEqual(10);
    }
  });

  it('groups minor and patch updates into one PR per entry and leaves majors out of every group', () => {
    for (const e of all) {
      expect(e.text, e.ecosystem).toMatch(/^\s+groups:$/m);
      const types = [...e.text.matchAll(/^\s+update-types:\s*\[([^\]]*)\]/gm)].map((m) => (m[1] ?? '').replace(/["'\s]/g, ''));
      expect(types, e.ecosystem).toEqual(['minor,patch']);
    }
  });

  it('keeps exact pins exact: npm and Composer entries raise the pin instead of widening a range', () => {
    for (const e of all.filter((x) => x.ecosystem === 'npm' || x.ecosystem === 'composer')) {
      expect(e.field('versioning-strategy'), e.ecosystem).toBe('increase');
    }
  });

  it('sets no label, since the repository defines none for dependencies', () => {
    expect(text).not.toMatch(/^\s+labels:/m);
  });
});
