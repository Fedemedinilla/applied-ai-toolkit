/** Builds the context once (pages, policies, header rules) and runs every check over it. */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { checkHeaders } from './checks/headers.ts';
import { checkInlineHashes } from './checks/inline-hashes.ts';
import { checkJsBudget } from './checks/js-budget.ts';
import { checkLookbehind } from './checks/lookbehind.ts';
import { checkPolicy } from './checks/policy.ts';
import { checkSecrets } from './checks/secrets.ts';
import { ConfigError, type GuardConfig } from './config.ts';
import { parseCsp, parseSerializedCsp } from './csp.ts';
import { parsePage } from './html.ts';
import { buildOutputRules, type HeaderRule, headerValues, netlifyHeadersRules, vercelJsonRules } from './routes.ts';
import { openSite, type Site, urlPathsForPage } from './site.ts';
import type { Context, GuardReport, Page } from './types.ts';

function readRules(config: GuardConfig, site: Site): HeaderRule[] | null {
  const csp = config.csp;
  if (csp === undefined || csp.from === 'meta' || csp.from === 'literal') return null;
  let file: string;
  if (csp.from === 'vercel-json') file = resolve(config.configDir, csp.file);
  else if (csp.from === 'vercel-output') file = csp.file === undefined ? join(site.dir, 'config.json') : resolve(config.configDir, csp.file);
  else file = csp.file === undefined ? join(site.staticRoot, '_headers') : resolve(config.configDir, csp.file);
  if (!existsSync(file)) throw new ConfigError(`csp source ${csp.from}: ${file} does not exist`);
  const label = relative(process.cwd(), file) || file;
  const text = readFileSync(file, 'utf8');
  try {
    if (csp.from === 'netlify-headers') return netlifyHeadersRules(text, label);
    const json: unknown = JSON.parse(text);
    return csp.from === 'vercel-json' ? vercelJsonRules(json, label) : buildOutputRules(json, label);
  } catch (error) {
    throw new ConfigError(`csp source ${csp.from}: ${(error as Error).message}`);
  }
}

export interface RunOptions {
  readonly dir: string;
  readonly config: GuardConfig;
  /** The environment to read secret values from; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function runGuard({ dir, config, env = process.env }: RunOptions): GuardReport {
  const site = openSite(dir, config.basePath, config.exclude);
  const headerRules = readRules(config, site);
  const prefix = site.buildOutput ? 'static/' : '';
  const pages: Page[] = site.pages.map((path) => {
    const parts = parsePage(readFileSync(join(site.staticRoot, path), 'utf8'));
    const urlPaths = urlPathsForPage(site, path);
    const csp = config.csp;
    let delivered: Page['csp'] = [];
    if (csp?.from === 'literal') delivered = [{ origin: 'literal', value: csp.value }];
    else if (csp?.from === 'meta') delivered = parts.metaPolicies.map((value, i) => ({ origin: `<meta> ${i + 1}`, value }));
    else if (headerRules !== null) delivered = headerValues(headerRules, urlPaths, 'content-security-policy');
    const policies =
      csp?.from === 'meta'
        ? delivered.flatMap((d) => parseSerializedCsp(d.value) ?? [])
        : parseCsp(delivered.map((d) => d.value).join(', '));
    return { path, display: `${prefix}${path}`, urlPaths, parts, csp: delivered, policies };
  });
  const ctx: Context = { site, config, pages, headerRules, env };
  const checks = [checkInlineHashes, checkPolicy, checkHeaders, checkSecrets, checkLookbehind, checkJsBudget].map((check) => check(ctx));
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    dir: site.dir,
    staticRoot: site.staticRoot,
    pages: pages.length,
    checks,
  };
}
