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

  it('stops on a misspelled optional rule key, which would otherwise fall back to its default', () => {
    const misspelled = [
      { rule: 'single-importer', group: 'src', package: 'x', allow: [], typeonly: 'forbid' },
      { rule: 'forbidden-import', group: 'src', paths: ['a/**'], transitve: false },
      { rule: 'forbidden-import', group: 'src', paths: ['a/**'], excpet: ['a/index.ts'] },
      { rule: 'single-reader', group: 'src', variable: 'KEY', allow: [], whyy: 'typo' },
    ];
    for (const rule of misspelled) {
      expect(() => parseConfig({ ...base, rules: [rule] }), JSON.stringify(rule)).toThrow(/^invalid config:\n {2}rules\.0: Unrecognized key: "\w+"$/);
    }
  });

  it('rejects a specifier pattern with a * anywhere but at the end, since it would match nothing', () => {
    for (const pattern of ['node:**', '@vendor/*-internal', '*x*']) {
      expect(() => parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', specifiers: [pattern] }] }), pattern).toThrow(/rules\.0\.specifiers\.0: only a trailing \*/);
      expect(() => parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', paths: ['a/**'], external: [pattern] }] }), pattern).toThrow(/rules\.0\.external\.0: only a trailing \*/);
    }
    expect(() => parseConfig({ ...base, rules: [{ rule: 'single-importer', group: 'src', package: '@vendor/*-sdk', allow: [] }] })).toThrow(/rules\.0\.package: only a trailing \*/);
    expect(parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', specifiers: [...NODE_BUILTINS, '@vendor/*', 'virtual:*'] }] }).rules).toHaveLength(1);
  });

  it('rejects a glob that cannot compile, naming its key', () => {
    const config = { groups: { src: { include: ['src/{a,b.ts'] } }, rules: [{ rule: 'dynamic-import', group: 'src' }] };
    expect(() => parseConfig(config)).toThrow(ConfigError);
    expect(() => parseConfig(config)).toThrow(/groups\.src\.include\.0: unbalanced braces/);
  });

  it('rejects a glob written as ./x, /x or with backslashes, since it would match no repository path', () => {
    for (const glob of ['./server/**', '/server/**', 'server\\**']) {
      const config = { ...base, rules: [{ rule: 'forbidden-import', group: 'src', paths: [glob] }] };
      expect(() => parseConfig(config), glob).toThrow(ConfigError);
      expect(() => parseConfig(config), glob).toThrow(/rules\.0\.paths\.0: /);
    }
    expect(() => parseConfig({ groups: { src: { include: ['./src/**'] } }, rules: [{ rule: 'dynamic-import', group: 'src' }] })).toThrow(/groups\.src\.include\.0/);
    expect(() => parseConfig({ ...base, ignore: ['./dist/**'], rules: [{ rule: 'dynamic-import', group: 'src' }] })).toThrow(/ignore\.0/);
    expect(parseConfig({ ...base, rules: [{ rule: 'forbidden-import', group: 'src', paths: ['server/**', '**/x.ts', '{a,b}/*.ts'] }] }).rules).toHaveLength(1);
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
