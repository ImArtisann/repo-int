# @artisann-studios/repo-int

Public Bun CLI for scaffolding a Bun-workspaces monorepo managed by Vite+, with
Effect tooling and Alchemy deployment stacks.

## Use

Run in a new repository directory; `bun init` is not required:

```bash
mkdir my-repository
cd my-repository
bun x @artisann-studios/repo-int config convex ui assets tanstack astro --owner ImArtisann --yes
```

Requires Bun 1.4 or newer, Node.js for the toolchain executables, and network
access. Registry credentials are not required. Pass `--owner <login>` for the
GitHub stack, or authenticate `gh` so repo-int can resolve your login.

| Template   | Result                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`   | Root Vite+ lint/format/test/task configuration, Effect TypeScript tooling, shared `@repo/typescript-config`, lefthook, CI, Dependabot, CodeRabbit, merged `.gitignore`, and `stacks/github.ts`. |
| `convex`   | `@repo/backend` in `packages/backend`, with Convex, Confect, example notes queries/mutations, Confect-generated code, and Convex AI guidelines/skills.                                          |
| `ui`       | `@repo/ui` in `packages/ui`, with shadcn configuration, a Button, mobile hook, class utility, shared Tailwind v4 theme, and package exports. Integrates with TanStack apps.                     |
| `assets`   | `@repo/assets` in `packages/assets`, with an Alchemy R2 bucket/custom-domain stack, image manifest generator, upload script, and Unpic components for TanStack and Astro apps.                  |
| `tanstack` | `@repo/web` in `apps/web`, with TanStack Start, React, Tailwind, and an Alchemy Cloudflare stack. Runs a build to generate the route tree.                                                      |
| `astro`    | An Astro/Tailwind app with an Alchemy Cloudflare stack. Reuses an existing Astro app in `apps/web` or `apps/static`; otherwise takes `apps/web` when free, or `apps/static`.                    |

Templates always apply in `config → convex → ui → assets → tanstack → astro`
order, regardless of argument order. TanStack reserves `apps/web` when both
frontend templates are selected. Occupied directories containing a different app
are not overwritten.

Apply `config` first, or include it in the same command as the other templates:

```bash
bun x @artisann-studios/repo-int config --owner ImArtisann --yes
bun x @artisann-studios/repo-int convex tanstack --yes
```

All scaffold writes precede one `bun install`. Root `prepare` installs lefthook
and patches TypeScript/Oxlint. Hooks invoke the locally installed Vite+ through
Bun; no global `vp` installation is needed. Formatting runs before linting and
fixed files are re-staged.

## Existing repositories

Managed configuration files prompt before replacement; non-interactive input
keeps differences unless `--yes` is supplied. Scaffold app/package files are
create-only and are never overwritten, including with `--yes`.

Package integrations work in either order: add `ui` and `assets` to existing
apps, or create the packages before adding frontend templates. repo-int checks
the dependencies of each `apps/*` workspace to select its integration. Unrelated
apps are left unchanged. Occupied `packages/ui` and `packages/assets`
directories must already have the corresponding `@repo/*` package name.

Integrations add missing app dependencies, shadcn import aliases, and
create-only component/configuration files. The UI integration replaces the app's
bare Tailwind import in `src/styles.css` with the shared stylesheet import,
retaining local CSS. Repeated runs do not duplicate the import.

Existing catalog entries and package-manager settings are kept. Missing catalog
entries, workspace globs, dependencies, and scripts are added. Conflicting
scripts or dependencies prompt before replacement. Stable package versions use
caret ranges; prereleases stay exact. The compatible Vite+/Effect TypeScript
compiler and linter versions are pinned together.

Existing `.gitignore` rules are preserved. CodeRabbit path filters are extended
to exclude generated output, including the whole Confect-managed `convex/`
directory, generated Confect code, AI files, and frontend build artifacts.
Rerunning `config` preserves filters added by the other templates.

Version 1 replaces the old flag-only initializer. `--effect` is removed: Effect
tooling is part of `config`. Generated repositories use lefthook instead of
Husky/lint-staged. repo-int no longer creates GitHub remotes or changes branch
protection directly; it only initializes local Git with `main` when needed.
Existing legacy files are not automatically removed.

## After generation

```bash
bun run check
bun run test
bun run build
```

Confect code generation runs without deployment credentials. Convex 1.45
requires a linked deployment for its own code generation, so that step is
explicitly skipped during scaffolding. Link the backend, then generate Convex's
API/server definitions:

```bash
bun run --cwd packages/backend dev:convex
bun run --cwd packages/backend codegen
```

Convex AI skill installation uses `npx`; Convex reports a warning if that
optional skill installation is unavailable. Guidelines are still installed. A
failed TanStack post-install build warns without aborting scaffolding; its route
tree is regenerated by the next dev/build command.

Authenticate Alchemy separately before deploying the private, squash-only GitHub
repository and its scoped Cloudflare deployment secrets:

```bash
bun x alchemy login --profile admin
bun run deploy:github
```

Start an app with `bun run --cwd apps/web dev` or
`bun run --cwd apps/static dev`. Cloudflare/GitHub stack deployments require
your credentials and are never run by repo-int.

### Shared shadcn UI

```bash
bun x @artisann-studios/repo-int ui --yes
bun x --bun shadcn@latest add input --cwd apps/web
```

Both `packages/ui/components.json` and the TanStack app's `components.json` use
the Radix Nova preset, neutral colors, Lucide icons, and Tailwind v4.
Components, hooks, utilities, and the theme live under `packages/ui/src`. Adding
a shared component from the app routes it to the UI package:

```tsx
import { Button } from "@repo/ui/components/button";
import { useIsMobile } from "@repo/ui/hooks/use-mobile";
```

With no app yet, run shadcn with `--cwd packages/ui`. Astro apps are not
converted to React; using shadcn there requires a separate Astro React
integration.

### R2 images and Unpic

```bash
bun x @artisann-studios/repo-int assets --yes
cp packages/assets/.env.example packages/assets/.env
```

Set `ASSETS_HOST` to a custom hostname, such as `assets.example.com`, and
`ASSETS_ZONE_ID` to its Cloudflare zone ID. `ASSETS_BUCKET_NAME` defaults to a
normalized repository name plus `-assets`, using lowercase letters, numbers, and
hyphens within R2's 63-character limit. The stack creates the bucket and
attaches the custom domain. It does not change zone-wide image transformation
settings.

Add source images under `packages/assets/images/`; nested directories become key
prefixes. PNG, JPEG, WebP, AVIF, GIF, and SVG are supported. The generator reads
intrinsic dimensions and writes `src/manifest.gen.ts`, keyed by source path.
Object keys include a content hash and use immutable cache headers. Commit the
source images and generated manifest.

```bash
bun run --cwd packages/assets generate
bun run --cwd packages/assets verify
bun run --cwd packages/assets upload:plan

# Authenticate and provision the bucket; this does not upload images.
bun x alchemy login
bun run --cwd packages/assets deploy

# Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY
# in packages/assets/.env, then upload.
bun run --cwd packages/assets upload
```

Scope the R2 S3 credentials to object read/write access for the bucket and use
the same account as the Alchemy deployment. `upload` regenerates the manifest
and skips objects already present. `verify` fails on a stale manifest without
rewriting it. An empty image directory is valid and requires no credentials to
generate or preview.

Each supported app receives `src/components/AssetImage` and
`.env.assets.example`. Copy the example's public settings into that app's
`.env`:

- TanStack: `VITE_ASSETS_HOST`, `VITE_ASSETS_TRANSFORM`.
- Astro: `PUBLIC_ASSETS_HOST`, `PUBLIC_ASSETS_TRANSFORM`.

Use the same hostname as `ASSETS_HOST`. Never copy R2 credentials into app
environment variables. Original R2 images work with transformation mode set to
`false`. To enable responsive Cloudflare transformations, first enable Image
Transformations for the zone, then set the app's transform flag to `true` and
rebuild. Cloudflare usage charges may apply.

For example, after adding `images/brand/hero.png`, a TanStack component can use:

```tsx
import { resolveAssetPath } from "@repo/assets/urls";
import { AssetImage } from "./components/AssetImage";

export function Hero() {
    const asset = resolveAssetPath("brand/hero.png");
    return asset ? (
        <AssetImage asset={asset} alt="Project preview" width={800} />
    ) : null;
}
```

The lookup also typechecks while the manifest is empty. Astro uses the same
`asset`, `alt`, and `width` props through its native `AssetImage.astro`
component. For metadata URLs, use
`assetUrl(asset, "https://assets.example.com")` from `@repo/assets/urls`.

## Develop and publish

repo-int itself retains its existing Bun/Oxlint/Oxfmt/Husky toolchain:

```bash
bun install
bun run check
```

Repository tests are scoped to `src`; Confect's template `notes.spec.ts` defines
an API contract, not a Bun test. Publishing a GitHub release runs
`.github/workflows/publish.yml`, verifies the package, and publishes to npm
through trusted publishing.
