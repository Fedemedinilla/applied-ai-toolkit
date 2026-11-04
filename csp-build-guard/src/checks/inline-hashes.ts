/**
 * Check 1. Every inline script and style must be allowed by a hash the policy lists, every listed
 * hash must belong to inline content the build ships, and no directive that governs inline content
 * may hold 'unsafe-inline'.
 */
import { effectiveDirective, normalizeHash, type Policy } from '../csp.ts';
import type { InlineItem, InlineKind } from '../html.ts';
import { type CheckResult, type Context, type Failure, groupBy, type Page, pagesLabel, plural } from '../types.ts';

const allHashes = (item: InlineItem): string[] => [item.hashes.sha256, item.hashes.sha384, item.hashes.sha512];
const ALL_KINDS: readonly InlineKind[] = ['script-elem', 'script-attr', 'style-elem', 'style-attr'];
/** Every directive a kind can fall back to, most specific first (CSP3). */
const fallbacks = (kind: InlineKind): string[] => {
  const [type, where] = kind.split('-') as [string, string];
  return [`${type}-src-${where}`, `${type}-src`, 'default-src'];
};

/** Whether a policy lets this inline item run or apply. */
function allowedBy(policy: Policy, item: InlineItem): boolean | 'unrestricted' {
  const directive = effectiveDirective(policy, item.kind);
  if (directive === undefined) return 'unrestricted';
  const listedHashes = new Set(directive.sources.map(normalizeHash));
  const listed = allHashes(item).some((h) => listedHashes.has(h));
  // Hashes only cover attributes (event handlers, style="") when the directive also has 'unsafe-hashes'.
  if (item.kind === 'script-attr' || item.kind === 'style-attr') return listed && directive.sources.includes("'unsafe-hashes'");
  return listed;
}

export function checkInlineHashes(ctx: Context): CheckResult {
  if (ctx.config.csp === undefined) return { id: 'inline-hashes', status: 'skip', summary: 'no csp source in the config', failures: [] };
  const checkStyles = ctx.config.inline.styles === 'hash';
  const kinds: InlineKind[] = checkStyles ? ['script-elem', 'script-attr', 'style-elem', 'style-attr'] : ['script-elem', 'script-attr'];
  const failures: Failure[] = [];
  const once = new Set<string>();
  const fail = (message: string, file?: string) => {
    if (once.has(message)) return;
    once.add(message);
    failures.push(file === undefined ? { message } : { message, file });
  };

  const byHeader = groupBy(ctx.pages.filter((p) => p.csp.length), headerOf);
  const withoutPolicy = ctx.pages.filter((p) => p.csp.length === 0).map((p) => p.display);
  if (withoutPolicy.length) fail(`${pagesLabel(withoutPolicy)}: no Content-Security-Policy, so inline content is not restricted and there is nothing to check hashes against`);

  // Missing hashes: grouped by hash, so one changed script on forty pages is one line.
  const blocked = new Map<string, { item: InlineItem; directive: string; pages: string[] }>();
  let inlineCount = 0;
  const distinct = new Set<string>();
  for (const page of ctx.pages) {
    if (page.csp.length === 0) continue;
    const policies = page.policies;
    const items = page.parts.inline.filter((i) => kinds.includes(i.kind));
    inlineCount += items.length;
    for (const item of items) distinct.add(item.hashes.sha256);
    for (const policy of policies) {
      for (const kind of kinds) {
        const directive = effectiveDirective(policy, kind);
        const what = kind.startsWith('script') ? 'scripts' : 'styles';
        const where = kind.endsWith('attr') ? `inline ${kind.startsWith('script') ? 'event handlers' : 'style attributes'}` : `inline ${what}`;
        if (directive === undefined) {
          if (items.some((i) => i.kind === kind)) fail(`${page.display}: the policy has no ${kind.replace('-', '-src-')}, ${kind.split('-')[0]}-src or default-src, so ${where} are not restricted`, page.display);
          continue;
        }
        if (directive.sources.includes("'unsafe-inline'")) {
          fail(`${pagesLabel((byHeader.get(headerOf(page)) ?? [page]).map((p) => p.display))}: ${directive.name} has 'unsafe-inline', which lets any injected inline ${what.slice(0, -1)} run. Allow inline content by hash instead.`);
        }
      }
      for (const item of items) {
        if (allowedBy(policy, item) !== false) continue;
        const directive = effectiveDirective(policy, item.kind)?.name ?? '';
        const key = `${directive} ${item.kind} ${item.hashes.sha256}`;
        const entry = blocked.get(key);
        if (entry) {
          if (!entry.pages.includes(page.display)) entry.pages.push(page.display);
        } else blocked.set(key, { item, directive, pages: [page.display] });
      }
    }
  }
  for (const { item, directive, pages } of blocked.values()) {
    if (item.kind === 'script-attr' || item.kind === 'style-attr') {
      fail(
        `${item.label} on ${pagesLabel(pages)} is blocked by ${directive}: an attribute needs 'unsafe-hashes' and its hash ${item.hashes.sha256} in the policy, or should move into a file.`,
        pages[0],
      );
    } else {
      fail(
        `${directive} does not list ${item.hashes.sha256}, the hash of an inline ${item.label} on ${pagesLabel(pages)}. The browser blocks it. If the content changed on purpose, replace the old hash with this one.`,
        pages[0],
      );
    }
  }

  // Stale hashes: per group of pages served with the same policy, a hash listed in any directive an
  // inline kind can fall back to must match some inline item on those pages that the directive
  // governs. A directive that more specific ones shadow (script-src next to script-src-elem and
  // script-src-attr) governs nothing, so every hash in it is stale.
  const families = new Set(kinds.flatMap(fallbacks));
  for (const group of byHeader.values()) {
    const first = group[0];
    if (first === undefined) continue;
    for (const policy of first.policies) {
      for (const [name, sources] of policy.directives) {
        if (!families.has(name)) continue;
        const governs = ALL_KINDS.some((k) => effectiveDirective(policy, k)?.name === name);
        const inUse = new Set(
          group.flatMap((p) =>
            p.parts.inline.filter((i) => effectiveDirective(policy, i.kind)?.name === name).flatMap(allHashes),
          ),
        );
        for (const source of sources) {
          const hash = normalizeHash(source);
          if (hash === undefined || inUse.has(hash)) continue;
          const pages = pagesLabel(group.map((p) => p.display));
          fail(
            governs
              ? `${name} lists ${source}, which matches no inline content on ${pages}. A stale hash keeps allowing inline content nobody ships; remove it.`
              : `${name} lists ${source}, but more specific directives take precedence over ${name} for every inline kind on ${pages}, so the hash has no effect; remove it.`,
          );
        }
      }
    }
  }

  const scope = checkStyles ? 'inline scripts and styles' : 'inline scripts';
  return {
    id: 'inline-hashes',
    status: failures.length ? 'fail' : 'pass',
    summary: failures.length
      ? `${plural(failures.length, 'problem')} with ${scope}`
      : `${inlineCount} ${scope} on ${plural(ctx.pages.length, 'page')}, ${distinct.size} distinct, all allowed by hash; no stale hash`,
    failures,
  };
}

// Groups pages by what they are served with. JSON keeps one <meta> holding "a, b" apart from two
// <meta> elements "a" and "b".
const headerOf = (page: Page): string => JSON.stringify(page.csp.map((c) => c.value));
