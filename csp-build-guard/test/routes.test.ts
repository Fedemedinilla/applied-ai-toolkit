import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from '../src/glob.ts';
import { buildOutputRules, headerValues, netlifyHeadersRules, vercelJsonRules, vercelSourceToRegExp } from '../src/routes.ts';

describe('vercelSourceToRegExp', () => {
  it.each([
    ['/(.*)', ['/', '/a', '/a/b/'], []],
    ['/blog/:slug', ['/blog/x', '/blog/x/'], ['/blog', '/blog/x/y']],
    ['/blog/:slug?', ['/blog', '/blog/x'], ['/blog/x/y']],
    ['/docs/:path*', ['/docs', '/docs/', '/docs/a/b'], ['/docsx']],
    ['/docs/:path+', ['/docs/a', '/docs/a/b'], ['/docs', '/docs/']],
    ['/post/:id(\\d+)', ['/post/12'], ['/post/ab']],
    ['/((?!api/).*)', ['/', '/about'], ['/api/x']],
    ['/index.html', ['/index.html', '/INDEX.HTML'], ['/indexxhtml']],
  ])('%s', (source, yes, no) => {
    const re = vercelSourceToRegExp(source);
    for (const path of yes) expect(re.test(path), path).toBe(true);
    for (const path of no) expect(re.test(path), path).toBe(false);
  });

  it('rejects syntax it does not read instead of never matching', () => {
    expect(() => vercelSourceToRegExp('/a/*')).toThrow(/unsupported/);
    expect(() => vercelSourceToRegExp('a')).toThrow(/start with/);
    expect(() => vercelSourceToRegExp('/(a')).toThrow(/unbalanced/);
  });
});

describe('header rules', () => {
  it('collects every vercel.json rule that sets a header for a page', () => {
    const rules = vercelJsonRules(
      { headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'a' }] }, { source: '/about', headers: [{ key: 'content-security-policy', value: 'b' }] }] },
      'vercel.json',
    );
    expect(headerValues(rules, ['/'], 'content-security-policy').map((v) => v.value)).toEqual(['a']);
    expect(headerValues(rules, ['/about/', '/about'], 'content-security-policy').map((v) => v.value)).toEqual(['a', 'b']);
  });

  it('refuses vercel.json rules with conditions it cannot evaluate', () => {
    expect(() => vercelJsonRules({ headers: [{ source: '/(.*)', has: [{ type: 'host', value: 'x' }], headers: [] }] }, 'vercel.json')).toThrow(/has/);
  });

  it('reads Build Output routes with headers, anchoring src and skipping handle phases', () => {
    const rules = buildOutputRules({ routes: [{ src: '/a', headers: { 'X-A': '1' } }, { handle: 'filesystem' }, { src: '^/(.*)$', headers: { 'X-B': '2' } }, { src: '/.*', dest: '/_render' }] }, 'config.json');
    expect(rules).toHaveLength(2);
    expect(headerValues(rules, ['/a'], 'x-a')).toHaveLength(1);
    expect(headerValues(rules, ['/ab'], 'x-a')).toHaveLength(0);
    expect(headerValues(rules, ['/ab'], 'x-b')).toHaveLength(1);
  });

  it('reads a Netlify _headers file with splats, placeholders and comments', () => {
    const rules = netlifyHeadersRules('# comment\n/*\n  X-A: 1\n/blog/:slug\n  X-B: two words\n', '_headers');
    expect(headerValues(rules, ['/anything/here'], 'x-a').map((v) => v.value)).toEqual(['1']);
    expect(headerValues(rules, ['/blog/post'], 'x-b').map((v) => v.value)).toEqual(['two words']);
    expect(headerValues(rules, ['/blog/post/extra'], 'x-b')).toEqual([]);
    expect(() => netlifyHeadersRules('  X-A: 1\n', '_headers')).toThrow(/_headers:1/);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['index.html', 'index.html', true],
    ['index.html', 'a/index.html', false],
    ['**/*.html', 'index.html', true],
    ['**/*.html', 'a/b/c.html', true],
    ['blog/**', 'blog/a/b.html', true],
    ['*.html', 'a/b.html', false],
    ['_astro/*.{js,mjs}', '_astro/x.mjs', true],
    ['page?.html', 'page1.html', true],
    ['a.b', 'axb', false],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('matches against any of several globs and rejects unbalanced braces', () => {
    expect(matchesAny('x.js', ['*.css', '*.js'])).toBe(true);
    expect(() => globToRegExp('{a,b')).toThrow(/unbalanced/);
  });
});
