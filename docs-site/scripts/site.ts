/**
 * Where the docs site is served and which folders it documents. astro.config.mjs and the sync
 * script both read this file, so the base path and the sidebar cannot disagree with the pages.
 */

/** The GitHub Pages origin. The demos are served from the same site, one level up from the docs. */
export const ORIGIN = 'https://fedemedinilla.github.io';
/** The path of the docs inside the Pages site, without a trailing slash. */
export const BASE = '/applied-ai-toolkit/docs';
export const REPO_URL = 'https://github.com/Fedemedinilla/applied-ai-toolkit';
export const BRANCH = 'main';

export interface Group {
  readonly label: string;
  /** Folders with a README.md, as paths from the repository root, in sidebar order. */
  readonly folders: readonly string[];
}

/** The groups of the root README, in its order. A folder with a README that is in none fails the sync. */
export const GROUPS: readonly Group[] = [
  { label: 'LLM in production', folders: ['gateway', 'evals', 'content-forge', 'grounded-assistant'] },
  {
    label: 'Security',
    folders: ['csp-build-guard', 'import-fences', 'supabase-auth-hardening', 'safe-markdown', 'safe-contact-form', 'wp-hardening', 'site-check'],
  },
  { label: 'Data and correctness', folders: ['amount-parser', 'idempotent-orders', 'deterministic-sim', 'pdf-receipt'] },
  { label: 'Testing, writing, automation and process', folders: ['fake-supabase-auth', 'slop-lint', 'n8n-templates', 'agent-playbook'] },
  {
    label: 'Apps',
    folders: [
      'apps/caja',
      'apps/receipt',
      'apps/replay-lab',
      'apps/checklist',
      'apps/rewriter',
      'apps/writer',
      'apps/chat-widget',
      'apps/salon-assistant',
      'apps/push-lab',
    ],
  },
];

/** Hand-written pages, as files under docs-site/pages/, with the slug each one is served at. */
export const HAND_WRITTEN: ReadonlyArray<{ readonly file: string; readonly slug: string; readonly label: string }> = [
  { file: 'index.md', slug: '', label: 'Overview' },
  { file: 'start-here.md', slug: 'start-here', label: 'Start here' },
];

/** Root documents under Project, with their slugs. The license is linked on GitHub, not copied. */
export const PROJECT_DOCS: ReadonlyArray<{ readonly file: string; readonly slug: string; readonly label: string }> = [
  { file: 'CONTRIBUTING.md', slug: 'contributing', label: 'Contributing' },
  { file: 'SECURITY.md', slug: 'security', label: 'Security' },
];

/**
 * Top-level folders with a README that is not a page: this site's own folder, and the folders of
 * the prose rewriter while they are being built (phases F0 to F6). They get a sidebar group in F7.
 */
export const NOT_DOCUMENTED: readonly string[] = ['docs-site', 'prose-rewriter', 'style-refs'];
