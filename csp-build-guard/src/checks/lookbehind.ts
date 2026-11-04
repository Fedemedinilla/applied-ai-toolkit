/**
 * Check 4. Regex lookbehind, (?<= or (?<!, in code the browser loads. A browser without lookbehind
 * support fails to parse the whole script or module that contains one, so everything in it stops,
 * with no visible error. Named groups, (?<name>, are not flagged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, compareVersions, LOOKBEHIND_SUPPORT } from '../config.ts';
import { matchesAny } from '../glob.ts';
import { listFiles } from '../site.ts';
import { type CheckResult, type Context, type Failure, plural } from '../types.ts';

const LOOKBEHIND = /\(\?<[=!]/g;

const BROWSER_NAMES: Record<Browser, string> = {
  chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', ios: 'Safari on iOS', opera: 'Opera', samsung: 'Samsung Internet',
};

/** Count and position (1-based line and column) of the first lookbehind in a text. */
export function findLookbehind(text: string): { count: number; line: number; column: number } | null {
  const matches = [...text.matchAll(LOOKBEHIND)];
  const first = matches[0];
  if (first === undefined) return null;
  const before = text.slice(0, first.index);
  const line = before.split('\n').length;
  return { count: matches.length, line, column: first.index - before.lastIndexOf('\n') };
}

export function checkLookbehind(ctx: Context): CheckResult {
  const config = ctx.config.lookbehind;
  if (config === false) return { id: 'lookbehind', status: 'skip', summary: 'disabled in the config', failures: [] };
  let unsupported: string;
  if (config.targets === undefined) unsupported = 'browsers without lookbehind support (Safari before 16.4)';
  else {
    const targets = Object.entries(config.targets) as Array<[Browser, { text: string; version: readonly [number, number] }]>;
    const old = targets.filter(([browser, v]) => compareVersions(v.version, LOOKBEHIND_SUPPORT[browser]) < 0);
    if (old.length === 0) return { id: 'lookbehind', status: 'skip', summary: 'every configured target supports lookbehind', failures: [] };
    unsupported = old.map(([browser, v]) => `${BROWSER_NAMES[browser]} ${v.text}`).join(', ');
  }
  const failures: Failure[] = [];
  const prefix = ctx.site.buildOutput ? 'static/' : '';
  const files = listFiles(ctx.site.staticRoot).filter((f) => matchesAny(f, config.files));
  // The match may sit in a string or a comment, which only fails if it reaches new RegExp.
  const describe = (count: number) =>
    `${plural(count, 'regex lookbehind')}, which ${unsupported} cannot parse; in a regex literal the whole script fails to load`;
  for (const file of files) {
    const found = findLookbehind(readFileSync(join(ctx.site.staticRoot, file), 'utf8'));
    if (found) failures.push({ message: `${prefix}${file}:${found.line}:${found.column}: ${describe(found.count)}`, file: `${prefix}${file}` });
  }
  let inlineScripts = 0;
  for (const page of ctx.pages) {
    page.parts.inlineJs.forEach((text, index) => {
      inlineScripts++;
      const found = findLookbehind(text);
      if (found) failures.push({ message: `${page.display}, inline script ${index + 1}: ${describe(found.count)}`, file: page.display });
    });
  }
  return {
    id: 'lookbehind',
    status: failures.length ? 'fail' : 'pass',
    summary: failures.length
      ? `${plural(failures.length, 'script')} with a regex lookbehind`
      : `${plural(files.length, 'browser file')} and ${plural(inlineScripts, 'inline script')}, no regex lookbehind`,
    failures,
  };
}
