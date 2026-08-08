# @imartisann/repo-int

Private Bun CLI for applying the repository defaults used by ImArtisann.

## Use

GitHub Packages requires a classic personal access token with `read:packages`.
Configure it once in your user-level `~/.npmrc`:

```ini
@imartisann:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Then run the initializer from the repository root:

```bash
bunx --registry=https://npm.pkg.github.com @imartisann/repo-int --yes
```

The command:

- initializes Git with `main` when the directory is not already in a worktree;
- installs `oxfmt`, `oxlint`, `husky`, and `lint-staged` as Bun development
  dependencies;
- merges the formatter, linter, and Husky scripts into `package.json`;
- copies the `oxfmt.config.ts` and `oxlint.config.ts` defaults from
  `projects/my-agents`;
- creates the lint-staged, Husky, and `.github/dependabot.yml` configurations;
- enables classic protection for an existing, unprotected remote `main` branch;
  and
- leaves existing branch protections and active rulesets unchanged.

Differing managed configurations are preserved by default and prompt before
replacement. In non-interactive environments they are also preserved. Pass
`--yes` to replace every differing managed configuration:

```bash
bun x @imartisann/repo-int --yes
```

Branch protection is skipped when `gh` is unavailable or unauthenticated, the
directory has no accessible GitHub remote, `main` has not been pushed, existing
protection cannot be inspected, or the current account lacks repository
administration permission.

## Develop and publish

```bash
bun install
bun run check
```

Publishing a GitHub release runs `.github/workflows/publish.yml`, verifies the
package, and publishes its current `package.json` version to GitHub Packages
with restricted access.
