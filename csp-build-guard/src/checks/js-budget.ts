/**
 * Check 5. The JavaScript a page makes the browser download on load, compressed, against a budget:
 * external scripts, modulepreload links, Astro island URLs, inline scripts, and every module those
 * import statically. Dynamic import() calls do not count, since they load later, on demand. Sizes
 * are gzip level 9 and brotli quality 11 of each file; 1 kB is 1000 bytes.
 */
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { matchesAny } from '../glob.ts';
import { pageUrl, resolveUrl } from '../site.ts';
import { type CheckResult, type Context, type Failure, pagesLabel, plural } from '../types.ts';

// Static import and re-export statements, minified or not: `import"./a.js"`, `import{a}from"./b.js"`,
// `export*from"./c.js"`. Any quoted specifier is taken, so one without .js or with a query
// (`./x.js?v=1`) still reaches resolveUrl and fails as not in the build or bare instead of being
// dropped. Dynamic `import("./d.js")` does not match: a "(" is not allowed after `import`.
const STATIC_IMPORT = /(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\n]+)["']/g;

export function staticImports(code: string): string[] {
  return [...code.matchAll(STATIC_IMPORT)].map((m) => m[1] ?? '');
}

export interface Sizes {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

export function compressedSizes(bytes: Buffer): Sizes {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

export interface PageWeight {
  readonly page: string;
  readonly budget: string;
  readonly gzipKb?: number;
  readonly brotliKb?: number;
  readonly total: Sizes;
  readonly files: ReadonlyArray<{ readonly url: string } & Sizes>;
  readonly inline: Sizes;
  /** URLs that could not be measured: another origin, a bare specifier, or not in the build. */
  readonly unmeasured: ReadonlyArray<{ readonly url: string; readonly reason: string }>;
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1);

export function checkJsBudget(ctx: Context): CheckResult {
  const budgets = ctx.config.budgets;
  if (budgets.length === 0) return { id: 'js-budget', status: 'skip', summary: 'no budgets in the config', failures: [] };
  const cache = new Map<string, { sizes: Sizes; imports: string[] }>();
  const measureFile = (file: string) => {
    let entry = cache.get(file);
    if (!entry) {
      const bytes = readFileSync(file);
      entry = { sizes: compressedSizes(bytes), imports: staticImports(bytes.toString('utf8')) };
      cache.set(file, entry);
    }
    return entry;
  };

  const weights: PageWeight[] = [];
  const failures: Failure[] = [];
  const unmeasurable = new Map<string, string[]>();
  let unbudgeted = 0;
  for (const page of ctx.pages) {
    const budget = budgets.find((b) => matchesAny(page.path, [b.pages]));
    if (!budget) {
      unbudgeted++;
      continue;
    }
    const from = pageUrl(ctx.site, page.path);
    const queue: Array<{ from: string; url: string; specifier: boolean }> = [
      ...[...page.parts.scriptSrcs, ...page.parts.modulePreloads, ...page.parts.islandUrls].map((url) => ({ from, url, specifier: false })),
      ...page.parts.inlineJs.flatMap((code) => staticImports(code).map((url) => ({ from, url, specifier: true }))),
    ];
    const seen = new Map<string, Sizes>();
    const unmeasured: Array<{ url: string; reason: string }> = [];
    while (queue.length) {
      const next = queue.shift();
      if (next === undefined) break;
      const resolved = resolveUrl(ctx.site, next.from, next.url, next.specifier);
      if (resolved.kind !== 'file') {
        if (!unmeasured.some((u) => u.url === resolved.url)) {
          const reason = { external: 'another origin', bare: 'bare specifier (import map)', missing: 'not in the build' }[resolved.kind];
          unmeasured.push({ url: resolved.url, reason });
        }
        continue;
      }
      if (seen.has(resolved.url)) continue;
      const { sizes, imports } = measureFile(resolved.file);
      seen.set(resolved.url, sizes);
      for (const url of imports) queue.push({ from: resolved.url, url, specifier: true });
    }
    // Inline scripts travel inside the compressed HTML; each is measured on its own, which can only overcount.
    const inlineSizes = page.parts.inlineJs.map((code) => compressedSizes(Buffer.from(code))).reduce(add, ZERO);
    const total = [...seen.values()].reduce(add, inlineSizes);
    const files = [...seen].map(([url, sizes]) => ({ url, ...sizes })).sort((a, b) => b.gzip - a.gzip);
    weights.push({
      page: page.display,
      budget: budget.pages,
      ...(budget.gzipKb === undefined ? {} : { gzipKb: budget.gzipKb }),
      ...(budget.brotliKb === undefined ? {} : { brotliKb: budget.brotliKb }),
      total,
      files,
      inline: inlineSizes,
      unmeasured,
    });
    const over: string[] = [];
    if (budget.gzipKb !== undefined && total.gzip > budget.gzipKb * 1000) over.push(`${kb(total.gzip)} kB gzip, budget ${budget.gzipKb} kB`);
    if (budget.brotliKb !== undefined && total.brotli > budget.brotliKb * 1000) over.push(`${kb(total.brotli)} kB brotli, budget ${budget.brotliKb} kB`);
    if (over.length) {
      const top = files.slice(0, 3).map((f) => `${f.url} ${kb(f.gzip)} kB`).join(', ');
      failures.push({ message: `${page.display}: ${over.join('; ')} (largest: ${top || 'inline scripts only'})`, file: page.display });
    }
    for (const u of unmeasured) {
      const key = `${u.url} (${u.reason})`;
      const list = unmeasurable.get(key);
      if (list) list.push(page.display);
      else unmeasurable.set(key, [page.display]);
    }
  }
  // One line per URL that could not be measured, with the pages that load it.
  for (const [what, pages] of unmeasurable) failures.push({ message: `cannot measure ${what}, loaded by ${pagesLabel(pages)}`, ...(pages[0] === undefined ? {} : { file: pages[0] }) });
  const note = unbudgeted ? `; ${plural(unbudgeted, 'page')} match${unbudgeted === 1 ? 'es' : ''} no budget` : '';
  const heaviest = weights.reduce<PageWeight | undefined>((a, w) => (a === undefined || w.total.gzip > a.total.gzip ? w : a), undefined);
  return {
    id: 'js-budget',
    status: failures.length ? 'fail' : 'pass',
    summary: failures.length
      ? `${plural(failures.length, 'problem')} over ${plural(weights.length, 'page')}${note}`
      : `${plural(weights.length, 'page')} within budget${heaviest ? `, heaviest ${heaviest.page} at ${kb(heaviest.total.gzip)} kB gzip, ${kb(heaviest.total.brotli)} kB brotli` : ''}${note}`,
    failures,
    details: weights,
  };
}

const ZERO: Sizes = { raw: 0, gzip: 0, brotli: 0 };
const add = (a: Sizes, b: Sizes): Sizes => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli });
