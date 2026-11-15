/**
 * Check 5. The JavaScript a page makes the browser download on load, compressed, against a budget:
 * external scripts, modulepreload links, Astro island URLs, inline scripts, and every module those
 * import statically. Dynamic import() calls do not count, since they load later, on demand, and
 * neither do classic nomodule scripts, which a browser with module support never loads. Sizes
 * are gzip level 9 and brotli quality 11 of each file; 1 kB is 1000 bytes.
 */
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { matchesAny } from '../glob.ts';
import { pageUrl, resolveUrl } from '../site.ts';
import { type CheckResult, type Context, type Failure, pagesLabel, plural } from '../types.ts';

// Static import and re-export statements, minified or not: `import"./a.js"`, `import{a}from"./b.js"`,
// `export*from"./c.js"`, matched outside comments and literals (see maskNonCode). Any quoted specifier is taken, so one without .js or with a query
// (`./x.js?v=1`) still reaches resolveUrl and fails as not in the build or bare instead of being
// dropped. Dynamic `import("./d.js")` does not match: a "(" is not allowed after `import`.
const STATIC_IMPORT = /(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\n]+)["']/g;

// After one of these a "/" starts a regex literal; after a name, a number, ")" or "]" it divides.
const REGEX_AFTER_PUNCTUATOR = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * The code with the contents of comments, string literals, template text and regex literals
 * replaced by spaces, so every index still points at the same place in the original. Quotes stay,
 * so an import specifier is still found and read back from the original text. A small lexer, not a
 * parser: a "/" after "}" is read as a regex, after ")" as a division, and a string or regex that
 * reaches the end of its line ends there, which keeps a misread from masking more than one line.
 */
export function maskNonCode(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // One entry per open template substitution: the brace depth inside it.
  const templates: number[] = [];
  let last = ''; // the last significant character, or a word
  let i = 0;
  const n = code.length;
  const readTemplate = (start: number): number => {
    // From just after a "`" or a "}" that closes a substitution, to the "`" or "${" that ends the text.
    let j = start;
    while (j < n && code[j] !== '`' && !(code[j] === '$' && code[j + 1] === '{')) j += code[j] === '\\' ? 2 : 1;
    blank(start, Math.min(j, n));
    if (j >= n) return n;
    if (code[j] === '`') {
      last = 'a';
      return j + 1;
    }
    templates.push(0);
    last = '{';
    return j + 2;
  };
  while (i < n) {
    const c = code[i] ?? '';
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      last = 'a';
    } else if (c === '`') {
      i = readTemplate(i + 1);
    } else if (c === '/' && (last === '' || REGEX_AFTER_PUNCTUATOR.has(last) || last === '}' || REGEX_AFTER_KEYWORD.has(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== '\n' && (inClass || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      last = 'a';
    } else if (c === '}' && templates.length && templates[templates.length - 1] === 0) {
      templates.pop();
      i = readTemplate(i + 1);
    } else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j] ?? '')) j++;
      last = code.slice(i, j);
      i = j;
    } else {
      if (templates.length && (c === '{' || c === '}')) templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + (c === '{' ? 1 : -1);
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join('');
}

export function staticImports(code: string): string[] {
  // Matched on the masked code, so text in comments and literals is not taken; the specifier is
  // read back from the original at the same place.
  return [...maskNonCode(code).matchAll(STATIC_IMPORT)].map((m) => {
    const end = (m.index ?? 0) + m[0].length - 1;
    return code.slice(end - (m[1] ?? '').length, end);
  });
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
      ...page.parts.inlineJsOnLoad.flatMap((code) => staticImports(code).map((url) => ({ from, url, specifier: true }))),
    ];
    const seen = new Map<string, Sizes>();
    const unmeasured: Array<{ url: string; reason: string }> = [];
    while (queue.length) {
      const next = queue.shift();
      if (next === undefined) break;
      const resolved = resolveUrl(ctx.site, next.from, next.url, next.specifier);
      if (resolved.kind !== 'file') {
        if (!unmeasured.some((u) => u.url === resolved.url)) {
          const reason = { external: 'another origin', bare: 'bare specifier (import map)', missing: 'not in the build', invalid: 'not a valid URL' }[resolved.kind];
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
    const inlineSizes = page.parts.inlineJsOnLoad.map((code) => compressedSizes(Buffer.from(code))).reduce(add, ZERO);
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
  // A budget whose glob matches no page measured nothing (a typo such as "index.htm"), so it fails.
  for (const b of budgets) {
    if (!ctx.pages.some((page) => matchesAny(page.path, [b.pages]))) failures.push({ message: `the budget for "${b.pages}" matches no page, so it measures nothing` });
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
