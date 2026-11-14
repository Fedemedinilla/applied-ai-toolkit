# Changesets

Two folders of this repository are published to npm: `gateway/` as `@fedemedinilla/claude-gateway` and `slop-lint/` as `@fedemedinilla/slop-lint`. Their versions and changelogs are managed with [Changesets](https://changesets.dev). The rest of the repository is not published, and the root package is private.

## Record a change

A change to a published package comes with a changeset, a small Markdown file in this folder that names the package, the bump and one line for the changelog:

```sh
npm run changeset          # asks which package changed and how
git add .changeset/*.md    # commit it with the change
```

A change that needs no release (a test, a README typo) needs no changeset.

## What happens on main

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on every push to `main`, never on a pull request, one run at a time:

1. **Select mode** reads this folder. With changesets, the mode is `version`. Without changesets, and with a package version that npm does not have yet, the mode is `publish`. Otherwise nothing runs.
2. **Version** runs `npm run version-packages` (`changeset version`, then a lockfile refresh) and opens or updates a pull request titled "Version Packages" with the new versions, the changelogs and the deleted changesets. Merging that pull request is the release decision.
3. **Pack** runs `npm run pack:check`, then packs each package to publish into a tarball, built by the package's prepack script.
4. **Publish** publishes those tarballs with npm trusted publishing. No npm token exists anywhere. npm trusts a short-lived OIDC token that GitHub issues to this workflow, and attaches a provenance statement that links each version to the commit and the run that built it.

Each job holds only the permissions its step needs. Select mode and pack can only read the repository. Version can push its branch and open the pull request. Publish holds `id-token: write` and nothing else, so the one job that can publish to npm cannot push to the repository, and it installs with `--ignore-scripts` and runs no build. That is also why git tags and GitHub releases are off: creating them would need `contents: write` in the publishing job. The provenance on npm already names the commit of each version. `agent-playbook/test/workflow-secrets.test.ts` checks the file with `RELEASE_POLICY`, which allows exactly these permissions.

## One-time setup

The workflow does nothing until the repository variable `NPM_RELEASE` is set to `enabled`, so merging it publishes nothing by accident. Before setting it:

1. **On npmjs.com,** sign in to the account that owns the `@fedemedinilla` scope. A user named `fedemedinilla` owns it already; any other account first creates a free organization of that name, which creates the scope.
2. **For each package,** open its Settings page, find "Trusted Publisher", choose GitHub Actions and fill in owner `Fedemedinilla`, repository `applied-ai-toolkit`, workflow filename `release.yml` and no environment. Allow `npm publish`. npm does not check these fields when they are saved; a mismatch shows up as a failed publish. The configuration has to see its first publish within two days or it expires.
3. **In the repository,** under Settings > Actions > General, enable "Allow GitHub Actions to create and approve pull requests", which the version step needs. Then add the variable under Settings > Secrets and variables > Actions > Variables: `NPM_RELEASE` with the value `enabled`.

npm's documentation describes the trusted publisher form on the Settings page of a package that already exists, and it does not say whether a name that was never published can have one. If it cannot, the first version (0.1.0 of each package) has to be published once by hand with an npm login, and trusted publishing is configured after it. From a clean checkout, run `npm ci` and then `npm run release`, which runs the pack check and `changeset publish`; that publishes each version npm does not have yet, through each package's prepack script. Provenance can only be generated inside CI, so if npm refuses that publish over the `provenance` setting in `publishConfig`, remove the setting for that one publish and leave it uncommitted.

## Known limits

- A pull request opened with the workflow's own token does not start other workflows, so CI does not run on "Version Packages" by itself. It changes only versions, changelogs and the lockfile. Closing and reopening it from the GitHub page starts CI.
- `npm run version-packages` also runs `npm install --package-lock-only`. The lockfile records each workspace's version, and `changeset version` does not touch it. Without the refresh, the next `npm install` on any machine would rewrite those lines in an unrelated change.
- Changesets 3 needs Node 22.11 or newer; the workflow uses the version in `.node-version`. Trusted publishing needs npm 11.5.1 or newer, and Node 24.22.1 ships npm 11.19.1.
