import { describe, expect, it } from 'vitest';
import { ConfigError, NODE_BUILTINS, parseConfig } from '../src/config.ts';
import { matchesSpecifier } from '../src/check.ts';

describe('parseConfig', () => {
  const base = { groups: { src: { include: ['src/**'] } } };

  it('fills the defaults', () => {
    const config = parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', paths: ['server/**'] }] });
    expect(config.rules[0]).toEqual({ rule: 'forbidden-import', group: 'src', specifiers: [], paths: ['server/**'], except: [], typeOnly: 'forbid', transitive: true, external: [] });
    expect(config.ignore).toContain('**/node_modules/**');
  });

  it('stops on a typo instead of turning a fence off', () => {
    const invalid = [
      { ...base, rules: [{ rule: 'single-importer', group: 'src', pakage: 'x', allow: [] }] },
      { ...base, rules: [{ rule: 'relative-extensions', group: 'src' }] },
      { ...base, rules: [{ rule: 'dynamic-import', group: 'scr' }] },
      { ...base, rules: [{ rule: 'forbidden-import', group: 'src' }] },
      { ...base, rules: [{ rule: 'forbidden-import', group: 'src', specifiers: ['x'], except: ['lib/index.ts'] }] },
      { ...base, rules: [{ rule: 'single-reader', group: 'src', variable: 'process.env.KEY', allow: [] }] },
      { ...base, rules: [] },
      { groups: { src: { include: ['src/**'], exlude: [] } }, rules: [{ rule: 'dynamic-import', group: 'src' }] },
    ];
    for (const config of invalid) expect(() => parseConfig(config), JSON.stringify(config)).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, rules: [{ rule: 'dynamic-import', group: 'scr' }] })).toThrow(/rules\.0\.group: unknown group "scr"/);
    expect(() => parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', specifiers: ['x'], except: ['a.ts'] }] })).toThrow(/except narrows paths/);
  });
});

describe('specifier patterns', () => {
  it('matches a package with its subpaths, and a prefix ending in *', () => {
    expect(matchesSpecifier('@vendor/sdk/resources', '@vendor/sdk')).toBe(true);
    expect(matchesSpecifier('@vendor/sdk-extra', '@vendor/sdk')).toBe(false);
    expect(matchesSpecifier('node:fs/promises', 'node:*')).toBe(true);
  });

  it('NODE_BUILTINS covers both spellings', () => {
    const forbidden = (s: string) => NODE_BUILTINS.some((p) => matchesSpecifier(s, p));
    for (const s of ['node:fs', 'fs', 'fs/promises', 'path', 'node:test', 'child_process']) expect(forbidden(s), s).toBe(true);
    for (const s of ['zod', 'fsevents', 'pathe']) expect(forbidden(s), s).toBe(false);
  });
});
