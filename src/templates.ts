import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Match from "effect/Match";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type { LoadedTemplate, PackageJsonSpec } from "./configure.ts";
import { TOOLCHAIN } from "./versions.ts";

export const TEMPLATE_NAMES = ["config", "convex", "ui", "assets", "tanstack", "astro"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export type UiBase = "radix" | "base";

/** Canonical application order, independent of the order templates were named in. */
export const TEMPLATE_ORDER: ReadonlyArray<TemplateName> = TEMPLATE_NAMES;

/** Optional template features toggled by CLI flags, e.g. `--xstate`. */
export type TemplateFeature = "xstate";

export interface TemplateContext {
    cwd: string;
    repoName: string;
    stackName: string;
    /** GitHub owner; only the config template consumes it. */
    owner: string;
    /**
     * Application directory under `apps/` for the tanstack and astro templates
     * (`web` by default); "" for templates that do not generate an app.
     */
    appDir: string;
    uiBase?: UiBase;
    /** Enabled template features; `// repo-int:<feature>` marker lines survive only when set. */
    features: ReadonlySet<TemplateFeature>;
}

/**
 * npm spec markers: "effect" resolves through resolveEffectVersion and
 * "alchemy-peer" reuses the resolved alchemy version.
 */
export interface CatalogSpec {
    package: string;
    spec: string | "effect" | "alchemy-peer";
}

export interface PostInstallCommand {
    /** Repository-relative working directory. */
    cwd: string;
    command: ReadonlyArray<string>;
    description: string;
}

export interface ResolvedTemplate {
    name: TemplateName;
    files: Array<LoadedTemplate>;
    packageJson: PackageJsonSpec;
    codeRabbitPathFilters: ReadonlyArray<string>;
    postInstall: ReadonlyArray<PostInstallCommand>;
}

const TEMPLATES_ROOT = Bun.fileURLToPath(new URL("../templates", import.meta.url));

/** Scaffold offered alongside every template, not owned by a single one. */
const SHARED_SCAFFOLD_ROOT = `${TEMPLATES_ROOT}/shared/scaffold`;

const ALCHEMY: CatalogSpec = { package: "alchemy", spec: "alchemy@latest" };

const EFFECT: CatalogSpec = { package: "effect", spec: "effect" };

const TAILWIND: ReadonlyArray<CatalogSpec> = [
    { package: "@tailwindcss/vite", spec: "@tailwindcss/vite@latest" },
    { package: "tailwindcss", spec: "tailwindcss@latest" },
];

const templateTokens = (context: TemplateContext): ReadonlyMap<string, string> =>
    new Map<string, string>([
        ["__REPO_NAME__", context.repoName],
        ["__UI_BASE__", context.uiBase ?? "radix"],
        ["__UI_PRIMITIVES_PACKAGE__", context.uiBase === "base" ? "@base-ui/react" : "radix-ui"],
        [
            "__ASSETS_BUCKET_NAME__",
            `${
                context.repoName
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/^-+/, "")
                    .slice(0, 56) || "repo"
            }-assets`,
        ],
        ["__STACK_NAME__", context.stackName],
        ["__OWNER__", context.owner],
        ["__APP_DIR__", context.appDir],
        ["__APP_NAME__", `@repo/${context.appDir}`],
        ["__APP_STACK__", context.appDir.charAt(0).toUpperCase() + context.appDir.slice(1)],
    ]);

const substituteTokens = (value: string, tokens: ReadonlyMap<string, string>): string => {
    let substituted = value;

    for (const [token, replacement] of tokens) {
        substituted = substituted.replaceAll(token, replacement);
    }

    return substituted;
};

/**
 * Feature marker lines (`// repo-int:<feature>` trailing a statement) are kept
 * without the marker when the feature is enabled and dropped entirely when it
 * is not. Other lines pass through unchanged.
 */
export const applyFeatureMarkers = (
    content: string,
    features: ReadonlySet<TemplateFeature>,
): string =>
    content
        .split("\n")
        .flatMap((line) => {
            const marker = /^(?<code>.*?)[ \t]*\/\/ repo-int:(?<feature>[a-z-]+)$/.exec(line);

            if (marker === null) return [line];
            const code = marker.groups?.["code"] ?? "";
            const feature = marker.groups?.["feature"] ?? "";

            // SAFETY: marker names are validated against TemplateFeature by the regex
            // character class; unknown names simply never match the set.
            return features.has(feature as TemplateFeature) ? [code] : [];
        })
        .join("\n");

/**
 * Maps a template source path onto its destination: tokens are substituted
 * first, then a single leading underscore turns a segment into a dotfile
 * (`_gitignore` -> `.gitignore`). Segments starting with two underscores are
 * framework names or tokens (`src/routes/__root.tsx`) and stay untouched.
 */
const mapDestinationPath = (source: string, tokens: ReadonlyMap<string, string>): string =>
    substituteTokens(source, tokens)
        .split("/")
        .map((segment) => (/^_[^_]/.test(segment) ? `.${segment.slice(1)}` : segment))
        .join("/");

const loadTemplateDirectory = (
    root: string,
    directory: string,
    tool: string,
    mapDestination: (source: string) => string,
    tokens: ReadonlyMap<string, string>,
    features: ReadonlySet<TemplateFeature>,
): Effect.Effect<Array<LoadedTemplate>, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const entries = yield* fs.readDirectory(pathService.join(root, directory));
        const sorted = entries.toSorted((left, right) => left.localeCompare(right));

        const loaded = yield* Effect.all(
            sorted.map((entry) =>
                Effect.gen(function* (): Effect.fn.Return<
                    Array<LoadedTemplate>,
                    PlatformError,
                    FileSystem | Path
                > {
                    const source = directory === "" ? entry : `${directory}/${entry}`;
                    const info = yield* fs.stat(pathService.join(root, source));

                    if (info.type === "Directory") {
                        return yield* loadTemplateDirectory(
                            root,
                            source,
                            tool,
                            mapDestination,
                            tokens,
                            features,
                        );
                    }

                    if (info.type !== "File") return [];
                    const content = yield* fs.readFileString(pathService.join(root, source));

                    return [
                        {
                            tool,
                            destination: mapDestination(source),
                            source,
                            content: applyFeatureMarkers(
                                substituteTokens(content, tokens),
                                features,
                            ),
                        },
                    ];
                }),
            ),
            { concurrency: "unbounded" },
        );

        return loaded.flat();
    });

const loadTemplateTree = (
    root: string,
    tool: string,
    mapDestination: (source: string) => string,
    tokens: ReadonlyMap<string, string>,
    features: ReadonlySet<TemplateFeature>,
): Effect.Effect<Array<LoadedTemplate>, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;

        if (!(yield* fs.exists(root))) return [];

        return yield* loadTemplateDirectory(root, "", tool, mapDestination, tokens, features);
    });

/**
 * Catalog values arrive from the CLI already range-formatted; keys the map
 * lacks (neither existing nor resolved) are skipped so they are never written.
 */
const catalogEntries = (name: TemplateName, versions: Record<string, string>, uiBase: UiBase) =>
    Object.fromEntries(
        catalogSpecs(name, uiBase).flatMap((entry) => {
            const version = versions[entry.package];

            return version === undefined ? [] : [[entry.package, version] as const];
        }),
    );

/**
 * Catalog specs per template; the CLI resolves the union across the selected
 * templates, skipping keys already present in the existing catalog.
 */
export const catalogSpecs = (
    name: TemplateName,
    uiBase: UiBase = "radix",
): ReadonlyArray<CatalogSpec> =>
    Match.value(name).pipe(
        Match.when("config", () => [
            ALCHEMY,
            EFFECT,
            { package: "@types/bun", spec: "@types/bun@latest" },
            { package: "lefthook", spec: "lefthook@latest" },
        ]),
        Match.when("convex", () => [
            { package: "convex", spec: "convex@latest" },
            { package: "@confect/core", spec: "@confect/core@next" },
            { package: "@confect/server", spec: "@confect/server@next" },
            { package: "@confect/cli", spec: "@confect/cli@next" },
            { package: "@confect/react", spec: "@confect/react@next" },
        ]),
        Match.when("ui", () => [
            { package: "react", spec: "react@latest" },
            { package: "react-dom", spec: "react-dom@latest" },
            { package: "@types/react", spec: "@types/react@latest" },
            { package: "@types/react-dom", spec: "@types/react-dom@latest" },
            {
                package: "@fontsource-variable/geist",
                spec: "@fontsource-variable/geist@latest",
            },
            { package: "class-variance-authority", spec: "class-variance-authority@latest" },
            { package: "cn", spec: "cn@latest" },
            { package: "lucide-react", spec: "lucide-react@latest" },
            uiBase === "base"
                ? { package: "@base-ui/react", spec: "@base-ui/react@latest" }
                : { package: "radix-ui", spec: "radix-ui@latest" },
            { package: "shadcn", spec: "shadcn@latest" },
            { package: "tw-animate-css", spec: "tw-animate-css@latest" },
            ...TAILWIND,
        ]),
        Match.when("assets", () => [
            ALCHEMY,
            EFFECT,
            { package: "@types/bun", spec: "@types/bun@latest" },
            { package: "aws4fetch", spec: "aws4fetch@latest" },
            { package: "image-size", spec: "image-size@latest" },
            { package: "@unpic/react", spec: "@unpic/react@latest" },
            { package: "@unpic/astro", spec: "@unpic/astro@latest" },
        ]),
        Match.when("tanstack", () => [
            ALCHEMY,
            EFFECT,
            { package: "@tanstack/react-router", spec: "@tanstack/react-router@latest" },
            { package: "@tanstack/react-start", spec: "@tanstack/react-start@latest" },
            { package: "react", spec: "react@latest" },
            { package: "react-dom", spec: "react-dom@latest" },
            { package: "@types/react", spec: "@types/react@latest" },
            { package: "@types/react-dom", spec: "@types/react-dom@latest" },
            { package: "@vitejs/plugin-react", spec: "@vitejs/plugin-react@latest" },
            ...TAILWIND,
            { package: "vite", spec: "vite@latest" },
            { package: "@cloudflare/workers-types", spec: "@cloudflare/workers-types@latest" },
        ]),
        Match.when("astro", () => [
            ALCHEMY,
            EFFECT,
            { package: "astro", spec: "astro@latest" },
            ...TAILWIND,
            { package: "@alchemy.run/frontend-frameworks", spec: "alchemy-peer" },
        ]),
        Match.exhaustive,
    );

const packageJsonSpec = (
    name: TemplateName,
    versions: Record<string, string>,
    uiBase: UiBase,
): PackageJsonSpec => {
    const catalog = catalogEntries(name, versions, uiBase);

    return Match.value(name).pipe(
        Match.when("config", () => ({
            packageManager: `bun@${Bun.version}`,
            workspaces: ["apps/*", "packages/*"],
            catalog,
            devDependencies: {
                "@effect/tsgo": TOOLCHAIN["@effect/tsgo"],
                "@oxlint/plugins": TOOLCHAIN["@oxlint/plugins"],
                "@repo/typescript-config": "workspace:*",
                "@types/bun": "catalog:",
                alchemy: "catalog:",
                effect: "catalog:",
                lefthook: "catalog:",
                typescript: TOOLCHAIN.typescript,
                "vite-plus": TOOLCHAIN["vite-plus"],
            },
            scripts: {
                check: "vp check",
                test: "vp test",
                build: "vp run -r build",
                "deploy:github": "alchemy deploy stacks/github.ts --profile admin",
                prepare: "lefthook install && effect-tsgo patch --typescript --oxlint",
            },
        })),
        Match.whenOr("convex", "ui", "assets", "tanstack", "astro", () => ({ catalog })),
        Match.exhaustive,
    );
};

const codeRabbitPathFilters = (
    name: TemplateName,
    context: TemplateContext,
): ReadonlyArray<string> =>
    Match.value(name).pipe(
        Match.when("config", () => [
            "!bun.lock",
            "!**/dist/**",
            "!**/.output/**",
            "!**/.alchemy/**",
            "!**/.wrangler/**",
            "!tools/oxlint/**",
        ]),
        Match.when("convex", () => [
            "!packages/backend/convex/**",
            "!packages/backend/confect/_generated/**",
            "!packages/backend/AGENTS.md",
            "!packages/backend/CLAUDE.md",
            "!packages/backend/.claude/**",
            "!packages/backend/.agents/**",
            "!packages/backend/skills-lock.json",
        ]),
        Match.when("ui", () => []),
        Match.when("assets", () => [
            "!packages/assets/src/manifest.gen.ts",
            "!packages/assets/.alchemy/**",
        ]),
        Match.when("tanstack", () => [
            `!apps/${context.appDir}/src/routeTree.gen.ts`,
            `!apps/${context.appDir}/.tanstack/**`,
            `!apps/${context.appDir}/.output/**`,
            `!apps/${context.appDir}/.alchemy/**`,
        ]),
        Match.when("astro", () => [
            `!apps/${context.appDir}/.astro/**`,
            `!apps/${context.appDir}/dist/**`,
            `!apps/${context.appDir}/.alchemy/**`,
        ]),
        Match.exhaustive,
    );

const postInstallCommands = (
    name: TemplateName,
    context: TemplateContext,
): ReadonlyArray<PostInstallCommand> =>
    Match.value(name).pipe(
        Match.whenOr("config", "astro", "ui", "assets", () => []),
        Match.when("convex", () => [
            {
                cwd: "packages/backend",
                command: [process.execPath, "x", "--bun", "confect", "codegen"],
                description: "confect codegen",
            },
            {
                cwd: "packages/backend",
                command: [process.execPath, "x", "--bun", "convex", "ai-files", "install"],
                description: "convex ai-files install",
            },
        ]),
        Match.when("tanstack", () => [
            {
                cwd: `apps/${context.appDir}`,
                command: [process.execPath, "run", "build"],
                description: "vite build",
            },
        ]),
        Match.exhaustive,
    );

/**
 * The production deploy workflow belongs to no single template: it ships with
 * every one of them so adding tooling to an already-configured repository picks
 * it up, not just the initial `config` run. Files already on disk are dropped
 * here rather than merely marked `createOnly`, which keeps an existing workflow
 * byte-identical and keeps a multi-template run from reporting the same
 * untouched file once per template.
 */
const sharedScaffold = (
    tool: TemplateName,
    mapDestination: (source: string) => string,
    tokens: ReadonlyMap<string, string>,
    features: ReadonlySet<TemplateFeature>,
    cwd: string,
): Effect.Effect<Array<LoadedTemplate>, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;

        const files = yield* loadTemplateTree(
            SHARED_SCAFFOLD_ROOT,
            tool,
            mapDestination,
            tokens,
            features,
        );

        const present = yield* Effect.all(
            files.map((file) => fs.exists(pathService.join(cwd, file.destination))),
            { concurrency: "unbounded" },
        );

        return files.filter((_, index) => present[index] !== true);
    });

export const resolveTemplate = (
    name: TemplateName,
    context: TemplateContext,
    versions: Record<string, string>,
): Effect.Effect<ResolvedTemplate, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const tokens = templateTokens(context);
        const mapDestination = (source: string): string => mapDestinationPath(source, tokens);
        const pathService = yield* Path;
        const root = pathService.join(TEMPLATES_ROOT, name);

        const managed = yield* loadTemplateTree(
            pathService.join(root, "managed"),
            name,
            mapDestination,
            tokens,
            context.features,
        );

        if (name === "config" && context.features.has("xstate")) {
            managed.push(
                ...(yield* loadTemplateTree(
                    pathService.join(root, "variants", "xstate"),
                    name,
                    mapDestination,
                    tokens,
                    context.features,
                )),
            );
        }

        const scaffold = yield* loadTemplateTree(
            pathService.join(root, "scaffold"),
            name,
            mapDestination,
            tokens,
            context.features,
        );

        if (name === "ui") {
            scaffold.push(
                ...(yield* loadTemplateTree(
                    pathService.join(root, "variants", context.uiBase ?? "radix"),
                    name,
                    mapDestination,
                    tokens,
                    context.features,
                )),
            );
        }

        scaffold.push(
            ...(yield* sharedScaffold(name, mapDestination, tokens, context.features, context.cwd)),
        );
        const scaffoldFiles = scaffold.map((file) => ({ ...file, createOnly: true }));

        const files = [...managed, ...scaffoldFiles].map((file) => {
            if (file.destination === ".gitignore") return { ...file, mergeIgnorePatterns: true };

            if (file.destination === ".coderabbit.yaml") return { ...file, mergePathFilters: true };

            return file;
        });

        return {
            name,
            files,
            packageJson: packageJsonSpec(name, versions, context.uiBase ?? "radix"),
            codeRabbitPathFilters: codeRabbitPathFilters(name, context),
            postInstall: postInstallCommands(name, context),
        };
    });

export const resolvePackageIntegration = (
    name: "ui" | "assets",
    framework: "tanstack" | "astro",
    context: TemplateContext,
): Effect.Effect<Array<LoadedTemplate>, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const pathService = yield* Path;
        const tokens = templateTokens(context);

        const files = yield* loadTemplateTree(
            pathService.join(TEMPLATES_ROOT, name, "integrations", framework),
            name,
            (source) => mapDestinationPath(source, tokens),
            tokens,
            context.features,
        );

        return files.map((file) => ({ ...file, createOnly: true }));
    });
