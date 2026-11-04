import { describe, expect, it } from 'vitest';
import { globMatcher, globToRegExp } from '../src/glob.ts';

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('lets ** span directories and keeps * inside one segment', () => {
    expect(matches('apps/**/src/**', 'apps/web/src/a.ts')).toBe(true);
    expect(matches('apps/**/src/**', 'apps/web/deep/src/x/a.ts')).toBe(true);
    expect(matches('apps/*/src/**', 'apps/web/deep/src/a.ts')).toBe(false);
    expect(matches('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(matches('**/*.test.ts', 'a/b/c.test.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
  });

  it('matches the folder itself with a trailing /**', () => {
    expect(matches('gateway/**', 'gateway')).toBe(true);
    expect(matches('gateway/**', 'gateway/src/a.ts')).toBe(true);
    expect(matches('gateway/**', 'gateway-two/a.ts')).toBe(false);
  });

  it('supports ? and {a,b} and escapes the rest', () => {
    expect(matches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.{ts,js}', 'src/a.js')).toBe(true);
    expect(matches('src/*.{ts,js}', 'src/a.mjs')).toBe(false);
    expect(matches('src/a+b.ts', 'src/a+b.ts')).toBe(true);
    expect(matches('src/a.ts', 'src/abts')).toBe(false);
    expect(() => globToRegExp('src/{a,b')).toThrow(/unbalanced/);
  });

  it('globMatcher of an empty list matches nothing', () => {
    expect(globMatcher([])('a.ts')).toBe(false);
  });
});
