// The docs site: Starlight with its defaults (system fonts, Pagefind search, light and dark).
// No analytics, no external fonts or scripts. The content is written by scripts/sync.ts.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { BASE, ORIGIN, REPO_URL } from './scripts/site.ts';
import { plan, REPO_ROOT, sidebar } from './scripts/sync.ts';

export default defineConfig({
  site: ORIGIN,
  base: BASE,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Applied AI Toolkit',
      description: 'Documentation of the Applied AI Toolkit repository, generated from its READMEs.',
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      // Each page carries its own editUrl in the frontmatter, pointing at the file it was made from.
      sidebar: sidebar(plan(REPO_ROOT)),
    }),
  ],
});
