/**
 * Check 2. Every page is served with exactly one policy, and that policy matches the expected one
 * directive by directive, source by source (see diffPolicy).
 */
import { diffParsedPolicy, diffPolicy, IGNORED_IN_META, parseSerializedCsp } from '../csp.ts';
import { type CheckResult, type Context, groupBy, pagesLabel, plural } from '../types.ts';

export function checkPolicy(ctx: Context): CheckResult {
  const { csp, policy } = ctx.config;
  if (csp === undefined || policy === undefined) {
    return { id: 'policy', status: 'skip', summary: `no ${csp === undefined ? 'csp source' : 'expected policy'} in the config`, failures: [] };
  }
  const problems: Array<{ page: string; message: string }> = [];
  for (const page of ctx.pages) {
    const add = (message: string) => problems.push({ page: page.display, message });
    if (page.csp.length === 0) {
      add('no Content-Security-Policy');
      continue;
    }
    if (csp.from === 'meta') {
      if (page.parts.metaAfterContent) add('the <meta> policy comes after a script or style, which runs before the policy applies');
      for (const p of page.policies) {
        for (const name of IGNORED_IN_META) if (p.directives.has(name)) add(`${name} has no effect in a <meta> policy; send it as a header`);
      }
      if (page.csp.length > 1) {
        add(`${page.csp.length} <meta> policies; the browser enforces each of them, and one is expected`);
        continue;
      }
      for (const diff of diffParsedPolicy(parseSerializedCsp(page.csp[0]?.value ?? ''), policy)) add(diff);
      continue;
    }
    if (page.csp.length > 1) {
      add(`${page.csp.length} rules set Content-Security-Policy (${page.csp.map((c) => c.origin).join('; ')}); what the host sends then depends on how it merges them`);
      continue;
    }
    for (const diff of diffPolicy(page.csp[0]?.value ?? '', policy)) add(diff);
  }
  const failures = [...groupBy(problems, (p) => p.message)].map(([message, list]) => ({
    message: `${pagesLabel(list.map((p) => p.page))}: ${message}`,
  }));
  const failing = new Set(problems.map((p) => p.page)).size;
  return {
    id: 'policy',
    status: failures.length ? 'fail' : 'pass',
    summary: failures.length
      ? `${failing} of ${plural(ctx.pages.length, 'page')} ${failing === 1 ? 'differs' : 'differ'} from the expected policy`
      : `${plural(ctx.pages.length, 'page')} ${ctx.pages.length === 1 ? 'sends' : 'send'} exactly the expected policy (${plural(Object.keys(policy).length, 'directive')})`,
    failures,
  };
}
