# docs-site

The documentation site of the repository, built with [Astro Starlight](https://starlight.astro.build/) and published at <https://fedemedinilla.github.io/applied-ai-toolkit/docs/>, next to the live demos. Its pages are generated from the READMEs on every build, so the site cannot drift from them.

## Run it

From the repository root:

```sh
npm run build:docs            # npm ci inside docs-site, then sync, astro build and the link check
npx vitest run docs-site      # the sync and link-check tests; they need no install here
```

Inside `docs-site/`, `npm run dev` syncs and starts the Astro dev server, and `npm run preview` serves the last build under its base path.

This folder has its own `package.json` and `package-lock.json` and is not an npm workspace of the root. The root `npm ci` therefore installs nothing for it, and Astro stays out of the toolkit's lockfile.

## Where the pages come from

[`scripts/sync.ts`](scripts/sync.ts) writes `src/content/docs/`, which is gitignored:

| Source | Page |
|---|---|
| `<folder>/README.md` and `apps/<app>/README.md` | `/<folder>/` and `/apps/<app>/` |
| `<folder>/CASE-STUDY.md` | `/<folder>/case-study/` |
| `CONTRIBUTING.md`, `SECURITY.md` | `/contributing/`, `/security/` |
| [`pages/index.md`](pages/index.md), [`pages/start-here.md`](pages/start-here.md), written by hand | `/`, `/start-here/` |

The title is the H1 and the description is the first paragraph. Each page's "Edit page" link opens its source file on GitHub. The sidebar groups are listed in [`scripts/site.ts`](scripts/site.ts), in the order of the root README. A folder with a README that is in no group fails the sync, so a new folder cannot be left out by accident.

## Links

A README is written to be read on GitHub, so the sync rewrites its relative links:

- A link to a file or folder that has a page becomes a link to that page, with its anchor.
- A link to any other file or folder becomes a GitHub URL on `main`.
- A relative link to a file that does not exist fails the sync and lists every broken link. Nothing is written.

Links inside code spans and fenced blocks are left as written. The hand-written pages go through the same step, so they link to READMEs by relative path as well.

After the build, [`scripts/check-links.ts`](scripts/check-links.ts) reads `dist/`. The built pages must be the planned pages plus Starlight's 404 page. Every internal `href` and `src` must point at a file in the build under `/applied-ai-toolkit/docs/`, and every fragment must be an id on its target page. External URLs are not fetched.

## Design decisions

**Starlight defaults.** System fonts, Pagefind search and the light and dark themes come from Starlight. The site loads no analytics, no external font and no external script.

**The base path is in one file.** `scripts/site.ts` holds the origin, the base and the repository URL. `astro.config.mjs`, the sync and the link check all read it.

**Tests run without an install.** [`scripts/sync.test.ts`](scripts/sync.test.ts) imports only Node built-ins and Vitest, so it runs in the root `npm test`. It also syncs the real repository into a temporary folder, so a broken relative link in any README fails CI before the Pages build.

## Limits

- The link rewriter reads inline links, images and reference definitions. It does not read `href` or `src` in raw HTML, which no README uses today.
- The sync checks that a link's file exists, not its anchor. Anchors on docs pages are checked by `check-links.ts` after `astro build`, which runs in `build:docs` in the CI docs job on every push to `main` and every pull request. Anchors on links that become GitHub URLs are not checked at all.
- The root README has no page. Links to it go to GitHub.
- GitHub Pages cannot send response headers, so the site is served without a Content-Security-Policy, like the demos.
