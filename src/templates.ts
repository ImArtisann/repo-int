import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedTemplate, PackageJsonSpec } from "./configure.ts";
import { TOOLCHAIN } from "./versions.ts";

export type TemplateName = "config" | "convex" | "ui" | "assets" | "tanstack" | "astro";

/** Canonical application order, independent of the order templates were named in. */
export const TEMPLATE_ORDER: readonly TemplateName[] = [
    "config",
    "convex",
    "ui",
    "assets",
    "tanstack",
    "astro",
];

export interface TemplateContext {
    cwd: string;
    repoName: string;
    stackName: string;
    /** GitHub owner; only the config template consumes it. */
    owner: string;
    /** "web" for tanstack, "web" | "static" for astro, "" otherwise. */
    appDir: string;
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
    command: readonly string[];
    description: string;
}

export interface ResolvedTemplate {
    name: TemplateName;
    files: LoadedTemplate[];
    packageJson: PackageJsonSpec;
    codeRabbitPathFilters: readonly string[];
    postInstall: readonly PostInstallCommand[];
}

const TEMPLATES_ROOT = join(import.meta.dir, "../templates");

const ALCHEMY: CatalogSpec = { package: "alchemy", spec: "alchemy@latest" };
const EFFECT: CatalogSpec = { package: "effect", spec: "effect" };
const TAILWIND: readonly CatalogSpec[] = [
    { package: "@tailwindcss/vite", spec: "@tailwindcss/vite@latest" },
    { package: "tailwindcss", spec: "tailwindcss@latest" },
];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isObject(error) && error.code === "ENOENT") return false;
        throw error;
    }
}

function templateTokens(context: TemplateContext): ReadonlyMap<string, string> {
    return new Map<string, string>([
        ["__REPO_NAME__", context.repoName],
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
}

function substituteTokens(value: string, tokens: ReadonlyMap<string, string>): string {
    let substituted = value;
    for (const [token, replacement] of tokens) {
        substituted = substituted.replaceAll(token, replacement);
    }
    return substituted;
}

/**
 * Maps a template source path onto its destination: tokens are substituted
 * first, then a single leading underscore turns a segment into a dotfile
 * (`_gitignore` -> `.gitignore`). Segments starting with two underscores are
 * framework names or tokens (`src/routes/__root.tsx`) and stay untouched.
 */
function mapDestinationPath(source: string, tokens: ReadonlyMap<string, string>): string {
    return substituteTokens(source, tokens)
        .split("/")
        .map((segment) => (/^_[^_]/.test(segment) ? `.${segment.slice(1)}` : segment))
        .join("/");
}

async function loadTemplateDirectory(
    root: string,
    directory: string,
    tool: string,
    mapDestination: (source: string) => string,
    tokens: ReadonlyMap<string, string>,
): Promise<LoadedTemplate[]> {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const loaded = await Promise.all(
        entries
            .toSorted((left, right) => left.name.localeCompare(right.name))
            .map(async (entry): Promise<LoadedTemplate[]> => {
                const source = directory === "" ? entry.name : `${directory}/${entry.name}`;
                if (entry.isDirectory()) {
                    return loadTemplateDirectory(root, source, tool, mapDestination, tokens);
                }
                if (!entry.isFile()) return [];
                return [
                    {
                        tool,
                        destination: mapDestination(source),
                        source,
                        content: substituteTokens(
                            await readFile(join(root, source), "utf8"),
                            tokens,
                        ),
                    },
                ];
            }),
    );
    return loaded.flat();
}

async function loadTemplateTree(
    root: string,
    tool: string,
    mapDestination: (source: string) => string,
    tokens: ReadonlyMap<string, string>,
): Promise<LoadedTemplate[]> {
    if (!(await pathExists(root))) return [];
    return loadTemplateDirectory(root, "", tool, mapDestination, tokens);
}

/**
 * Catalog values arrive from the CLI already range-formatted; keys the map
 * lacks (neither existing nor resolved) are skipped so they are never written.
 */
function catalogEntries(
    name: TemplateName,
    versions: Record<string, string>,
): Record<string, string> {
    const catalog: Record<string, string> = {};
    for (const entry of catalogSpecs(name)) {
        const version = versions[entry.package];
        if (version !== undefined) catalog[entry.package] = version;
    }
    return catalog;
}

/**
 * Catalog specs per template; the CLI resolves the union across the selected
 * templates, skipping keys already present in the existing catalog.
 */
export function catalogSpecs(name: TemplateName): readonly CatalogSpec[] {
    switch (name) {
        case "config":
            return [
                ALCHEMY,
                EFFECT,
                { package: "@types/bun", spec: "@types/bun@latest" },
                { package: "lefthook", spec: "lefthook@latest" },
            ];
        case "convex":
            return [
                { package: "convex", spec: "convex@latest" },
                { package: "@confect/core", spec: "@confect/core@next" },
                { package: "@confect/server", spec: "@confect/server@next" },
                { package: "@confect/cli", spec: "@confect/cli@next" },
                { package: "@confect/react", spec: "@confect/react@next" },
            ];
        case "ui":
            return [
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
                { package: "radix-ui", spec: "radix-ui@latest" },
                { package: "shadcn", spec: "shadcn@latest" },
                { package: "tw-animate-css", spec: "tw-animate-css@latest" },
                ...TAILWIND,
            ];
        case "assets":
            return [
                ALCHEMY,
                EFFECT,
                { package: "@types/bun", spec: "@types/bun@latest" },
                { package: "aws4fetch", spec: "aws4fetch@latest" },
                { package: "image-size", spec: "image-size@latest" },
                { package: "@unpic/react", spec: "@unpic/react@latest" },
                { package: "@unpic/astro", spec: "@unpic/astro@latest" },
            ];
        case "tanstack":
            return [
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
            ];
        case "astro":
            return [
                ALCHEMY,
                EFFECT,
                { package: "astro", spec: "astro@latest" },
                ...TAILWIND,
                { package: "@alchemy.run/frontend-frameworks", spec: "alchemy-peer" },
            ];
    }
}

function packageJsonSpec(name: TemplateName, versions: Record<string, string>): PackageJsonSpec {
    const catalog = catalogEntries(name, versions);
    switch (name) {
        case "config":
            return {
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
            };
        case "convex":
        case "ui":
        case "assets":
        case "tanstack":
        case "astro":
            return { catalog };
    }
}

function codeRabbitPathFilters(name: TemplateName, context: TemplateContext): readonly string[] {
    switch (name) {
        case "config":
            return [
                "!bun.lock",
                "!**/dist/**",
                "!**/.output/**",
                "!**/.alchemy/**",
                "!**/.wrangler/**",
                "!tools/oxlint/**",
            ];
        case "convex":
            return [
                "!packages/backend/convex/**",
                "!packages/backend/confect/_generated/**",
                "!packages/backend/AGENTS.md",
                "!packages/backend/CLAUDE.md",
                "!packages/backend/.claude/**",
                "!packages/backend/.agents/**",
                "!packages/backend/skills-lock.json",
            ];
        case "ui":
            return [];
        case "assets":
            return ["!packages/assets/src/manifest.gen.ts", "!packages/assets/.alchemy/**"];
        case "tanstack":
            return [
                "!apps/web/src/routeTree.gen.ts",
                "!apps/web/.tanstack/**",
                "!apps/web/.output/**",
                "!apps/web/.alchemy/**",
            ];
        case "astro": {
            const appDir = context.appDir;
            return [
                `!apps/${appDir}/.astro/**`,
                `!apps/${appDir}/dist/**`,
                `!apps/${appDir}/.alchemy/**`,
            ];
        }
    }
}

function postInstallCommands(name: TemplateName): readonly PostInstallCommand[] {
    switch (name) {
        case "config":
        case "astro":
        case "ui":
        case "assets":
            return [];
        case "convex":
            return [
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
            ];
        case "tanstack":
            return [
                {
                    cwd: "apps/web",
                    command: [process.execPath, "run", "build"],
                    description: "vite build",
                },
            ];
    }
}

export async function resolveTemplate(
    name: TemplateName,
    context: TemplateContext,
    versions: Record<string, string>,
): Promise<ResolvedTemplate> {
    const tokens = templateTokens(context);
    const mapDestination = (source: string): string => mapDestinationPath(source, tokens);
    const root = join(TEMPLATES_ROOT, name);
    const managed = await loadTemplateTree(join(root, "managed"), name, mapDestination, tokens);
    const scaffold = await loadTemplateTree(join(root, "scaffold"), name, mapDestination, tokens);
    const scaffoldFiles = scaffold.map((file) => ({ ...file, createOnly: true }));
    const files = [...managed, ...scaffoldFiles].map((file) => {
        if (file.destination === ".gitignore") return { ...file, mergeIgnorePatterns: true };
        if (file.destination === ".coderabbit.yaml") return { ...file, mergePathFilters: true };
        return file;
    });
    return {
        name,
        files,
        packageJson: packageJsonSpec(name, versions),
        codeRabbitPathFilters: codeRabbitPathFilters(name, context),
        postInstall: postInstallCommands(name),
    };
}

export async function resolvePackageIntegration(
    name: "ui" | "assets",
    framework: "tanstack" | "astro",
    context: TemplateContext,
): Promise<LoadedTemplate[]> {
    const tokens = templateTokens(context);
    const files = await loadTemplateTree(
        join(TEMPLATES_ROOT, name, "integrations", framework),
        name,
        (source) => mapDestinationPath(source, tokens),
        tokens,
    );
    return files.map((file) => ({ ...file, createOnly: true }));
}
