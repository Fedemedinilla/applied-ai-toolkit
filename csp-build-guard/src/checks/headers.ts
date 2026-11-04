/** Other security headers from the same deploy configuration, with exact values. */
import { headerValues } from '../routes.ts';
import { type CheckResult, type Context, groupBy, pagesLabel, plural } from '../types.ts';

export function checkHeaders(ctx: Context): CheckResult {
  const expected = ctx.config.headers;
  if (expected === undefined) return { id: 'headers', status: 'skip', summary: 'no headers in the config', failures: [] };
  if (ctx.headerRules === null) {
    return {
      id: 'headers',
      status: 'fail',
      summary: 'headers can only be checked against a vercel-json, vercel-output or netlify-headers csp source',
      failures: [{ message: `the csp source is ${ctx.config.csp?.from ?? 'not set'}, which carries no response headers` }],
    };
  }
  const problems: Array<{ page: string; message: string }> = [];
  for (const page of ctx.pages) {
    for (const [name, value] of Object.entries(expected)) {
      const found = headerValues(ctx.headerRules, page.urlPaths, name.toLowerCase());
      if (found.length === 0) problems.push({ page: page.display, message: `missing ${name}: ${value}` });
      else if (found.length > 1) problems.push({ page: page.display, message: `${found.length} rules set ${name} (${found.map((f) => f.origin).join('; ')})` });
      else if (found[0]?.value !== value) problems.push({ page: page.display, message: `${name} is "${found[0]?.value}", expected "${value}"` });
    }
  }
  const failingPages = new Set(problems.map((p) => p.page)).size;
  const failures = [...groupBy(problems, (p) => p.message)].map(([message, list]) => ({ message: `${pagesLabel(list.map((p) => p.page))}: ${message}` }));
  return {
    id: 'headers',
    status: failures.length ? 'fail' : 'pass',
    summary: failures.length
      ? `${failingPages} of ${plural(ctx.pages.length, 'page')} ${failingPages === 1 ? 'misses' : 'miss'} an expected header value`
      : `${plural(ctx.pages.length, 'page')} send ${Object.keys(expected).join(', ')} with the expected values`,
    failures,
  };
}
