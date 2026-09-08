import { createInterface } from "node:readline/promises";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
    defaultPackageName,
    synchronizeManagedFile,
    updatePackageJson,
    mergeCodeRabbitPathFilters,
    type Confirm,
    type Logger,
} from "./configure.ts";
import { initializeGitRepository, resolveGitHubOwner } from "./git.ts";
import { requireSuccess, runCommand, type CommandRunner } from "./process.ts";
import {
    TEMPLATE_ORDER,
    catalogSpecs,
    resolveTemplate,
    resolvePackageIntegration,
    type TemplateName,
    type ResolvedTemplate,
    type UiBase,
} from "./templates.ts";
import { catalogRange, resolveEffectVersion, resolveVersion } from "./versions.ts";

export interface CliOptions {
    args?: readonly string[];
    confirm?: Confirm;
    cwd?: string;
    logger?: Logger;
    prompt?: Prompt;
    runner?: CommandRunner;
}

/** Free-form question; the answer is trimmed by the caller. */
export type Prompt = (question: string) => Promise<string>;

const HELP = `repo-int

Usage:
  bun x @artisann-studios/repo-int <template...> [--ui-base radix|base] [--app-dir <name>] [--owner <login>] [--yes]

Templates: ${TEMPLATE_ORDER.join(", ")}

Options:
      --app-dir Directory under apps/ for the tanstack template (default: web)
      --owner   GitHub owner for the config template (defaults to authenticated gh user)
      --ui-base Shadcn primitives for the ui template: radix or base (default: existing choice, or radix)
  -y, --yes     Replace every differing managed configuration without prompting
  -h, --help    Show this help
`;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackage(cwd: string): Promise<Record<string, unknown>> {
    const file = Bun.file(join(cwd, "package.json"));
    if (!(await file.exists())) return {};
    const value: unknown = await file.json();
    if (!isObject(value)) throw new Error(`${file.name} must contain a JSON object.`);
    return value;
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

async function hasDependency(cwd: string, name: string): Promise<boolean> {
    const pkg = await readPackage(cwd);
    return isObject(pkg.dependencies) && name in pkg.dependencies;
}

/**
 * Walks up from the invocation directory so `repo-int convex` inside apps/web
 * configures the workspace instead of nesting a second one. The search never
 * leaves the enclosing Git repository, and an unconfigured tree keeps its own
 * directory as the root. A malformed package.json is not a root here; the
 * invocation directory is revalidated later with its original error.
 */
async function findWorkspaceRoot(cwd: string): Promise<string> {
    let directory = resolve(cwd);
    for (;;) {
        if (await Bun.file(join(directory, "vite.config.ts")).exists()) {
            try {
                if ("workspaces" in (await readPackage(directory))) return directory;
            } catch {
                /* not a usable workspace root */
            }
        }
        const parent = dirname(directory);
        if (parent === directory || (await pathExists(join(directory, ".git")))) return cwd;
        directory = parent;
    }
}

/** Rejects traversal, absolute paths, and anything that is not one plain segment. */
function appDirIssue(value: string): string | undefined {
    if (value === "") return "an application directory name is required.";
    if (value.length > 64) return `"${value}" is longer than 64 characters.`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
        return `"${value}" must be a single directory name under apps/ using letters, digits, ".", "_", or "-".`;
    return undefined;
}

/** True when apps/<name> is free or already holds a TanStack Start app. */
async function isTanStackAppDir(cwd: string, name: string): Promise<boolean> {
    const directory = join(cwd, "apps", name);
    if (!(await pathExists(directory))) return true;
    return await hasDependency(directory, "@tanstack/react-start");
}

/**
 * apps/web is the default; when something else already owns it the caller must
 * name another directory. Neither --yes nor a plain rerun ever overwrites the
 * occupant.
 */
async function resolveTanStackAppDir(
    cwd: string,
    flag: string | undefined,
    prompt: Prompt | undefined,
    logger: Logger,
): Promise<string> {
    if (flag !== undefined) {
        const issue = appDirIssue(flag);
        if (issue) throw new Error(`--app-dir ${issue}`);
        if (!(await isTanStackAppDir(cwd, flag)))
            throw new Error(
                `apps/${flag} exists and is not a TanStack Start app; pass --app-dir with a free directory name.`,
            );
        return flag;
    }
    if (await isTanStackAppDir(cwd, "web")) return "web";
    if (!prompt)
        throw new Error(
            "apps/web exists and is not a TanStack Start app; pass --app-dir <name> to scaffold the app in another directory under apps/.",
        );
    for (;;) {
        const answer = (
            await prompt(
                "apps/web is taken. Directory name for the TanStack app under apps/ (empty to cancel):",
            )
        ).trim();
        if (answer === "") break;
        const issue = appDirIssue(answer);
        if (issue) {
            logger.warn(`[rejected] ${issue}`);
            continue;
        }
        if (!(await isTanStackAppDir(cwd, answer))) {
            logger.warn(`[rejected] apps/${answer} exists and is not a TanStack Start app.`);
            continue;
        }
        return answer;
    }
    throw new Error(
        "No TanStack application directory was chosen; rerun with --app-dir <name> to scaffold the app under apps/.",
    );
}

async function readUiBase(directory: string): Promise<UiBase | undefined> {
    const file = Bun.file(join(directory, "components.json"));
    if (!(await file.exists())) return undefined;
    const config: unknown = await file.json();
    if (isObject(config) && typeof config.style === "string") {
        if (config.style.startsWith("base-")) return "base";
        if (
            config.style.startsWith("radix-") ||
            config.style === "new-york" ||
            config.style === "default"
        )
            return "radix";
    }
    throw new Error(`Cannot determine the shadcn base from ${file.name}.`);
}

async function checkUiAppCompatibility(cwd: string, uiBase: UiBase): Promise<void> {
    const appsRoot = join(cwd, "apps");
    if (!(await pathExists(appsRoot))) return;
    for (const app of await readdir(appsRoot, { withFileTypes: true })) {
        if (!app.isDirectory()) continue;
        const directory = join(appsRoot, app.name);
        if (!(await hasDependency(directory, "@tanstack/react-start"))) continue;
        const appBase = await readUiBase(directory);
        if (appBase !== undefined && appBase !== uiBase) {
            throw new Error(
                `apps/${app.name}/components.json uses ${appBase}, but the shared UI uses ${uiBase}. Migrate the app's shadcn configuration and components before continuing.`,
            );
        }
    }
}

async function integrateWorkspacePackages(
    cwd: string,
    confirm: Confirm,
    logger: Logger,
    uiBase: UiBase,
): Promise<void> {
    const ui = (await readPackage(join(cwd, "packages/ui"))).name === "@repo/ui";
    const assets = (await readPackage(join(cwd, "packages/assets"))).name === "@repo/assets";
    if ((!ui && !assets) || !(await pathExists(join(cwd, "apps")))) return;
    const apps = await readdir(join(cwd, "apps"), { withFileTypes: true });
    for (const app of apps.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (!app.isDirectory()) continue;
        const appRoot = join(cwd, "apps", app.name);
        const pkg = await readPackage(appRoot);
        if (!isObject(pkg.dependencies)) continue;
        const framework =
            "@tanstack/react-start" in pkg.dependencies
                ? "tanstack"
                : "astro" in pkg.dependencies
                  ? "astro"
                  : undefined;
        if (!framework) continue;
        const dependencies: Record<string, string> = {};
        const packages: ("ui" | "assets")[] = [];
        if (ui && framework === "tanstack") {
            packages.push("ui");
            dependencies["@repo/ui"] = "workspace:*";
        }
        if (assets) {
            packages.push("assets");
            dependencies["@repo/assets"] = "workspace:*";
            dependencies[framework === "tanstack" ? "@unpic/react" : "@unpic/astro"] = "catalog:";
        }
        if (packages.length === 0) continue;
        for (const name of packages) {
            const files = await resolvePackageIntegration(name, framework, {
                cwd,
                appDir: app.name,
                repoName: defaultPackageName(cwd),
                stackName: "",
                owner: "",
                uiBase,
            });
            for (const file of files) await synchronizeManagedFile(cwd, file, confirm, logger);
        }
        await updatePackageJson(
            appRoot,
            ui && framework === "tanstack"
                ? {
                      dependencies,
                      imports: {
                          "#components/*": "./src/components/*.tsx",
                          "#lib/*": "./src/lib/*.ts",
                      },
                  }
                : { dependencies },
            confirm,
            logger,
        );
        if (ui && framework === "tanstack") {
            const stylesheet = Bun.file(join(appRoot, "src/styles.css"));
            const content = (await stylesheet.exists()) ? await stylesheet.text() : "";
            const importRule = '@import "@repo/ui/styles/globals.css";';
            if (!/@import\s+["']@repo\/ui\/styles\/globals\.css["']/.test(content)) {
                const localStyles = content.replace(/^@import\s+["']tailwindcss["'];\r?\n?/gm, "");
                await Bun.write(stylesheet, `${importRule}\n${localStyles}`);
                logger.log(`[updated] apps/${app.name}/src/styles.css (shared UI import)`);
            }
        }
    }
}

function existingCatalog(pkg: Record<string, unknown>): Record<string, string> {
    const parent = isObject(pkg.workspaces) && "catalog" in pkg.workspaces ? pkg.workspaces : pkg;
    if (!("catalog" in parent)) return {};
    if (!isObject(parent.catalog))
        throw new Error('package.json has a non-object "catalog" field.');
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parent.catalog)) {
        if (typeof value !== "string")
            throw new Error(`package.json catalog entry "${key}" must be a string.`);
        result[key] = value;
    }
    return result;
}

export async function runCli(options: CliOptions = {}): Promise<number> {
    const args = options.args ?? [];
    const logger = options.logger ?? console;
    const selected = new Set<TemplateName>();
    let ownerFlag: string | undefined;
    let uiBaseFlag: UiBase | undefined;
    let appDirFlag: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === undefined) break;
        if (arg === "--owner") {
            ownerFlag = args[++index];
            if (!ownerFlag || ownerFlag.startsWith("-")) {
                logger.error("--owner requires a login.");
                return 1;
            }
        } else if (arg === "--app-dir") {
            appDirFlag = args[++index];
            if (!appDirFlag || appDirFlag.startsWith("-")) {
                logger.error("--app-dir requires a directory name.");
                return 1;
            }
        } else if (arg === "--ui-base") {
            const value = args[++index];
            if (value !== "radix" && value !== "base") {
                logger.error("--ui-base requires radix or base.");
                return 1;
            }
            uiBaseFlag = value;
        } else if (["--yes", "-y", "--help", "-h"].includes(arg)) {
            continue;
        } else if (
            arg === "config" ||
            arg === "convex" ||
            arg === "ui" ||
            arg === "assets" ||
            arg === "tanstack" ||
            arg === "astro"
        ) {
            selected.add(arg);
        } else {
            logger.error(
                arg.startsWith("-")
                    ? `Unknown option: ${arg}\n\n${HELP}`
                    : `Unknown template "${arg}". Expected: ${TEMPLATE_ORDER.join(", ")}.`,
            );
            return 1;
        }
    }
    if (args.includes("--help") || args.includes("-h")) {
        logger.log(HELP);
        return 0;
    }
    if (uiBaseFlag !== undefined && !selected.has("ui")) {
        logger.error("--ui-base requires the ui template.");
        return 1;
    }
    if (appDirFlag !== undefined && !selected.has("tanstack")) {
        logger.error("--app-dir requires the tanstack template.");
        return 1;
    }
    if (selected.size === 0) {
        logger.log(HELP);
        return 1;
    }

    const runner = options.runner ?? runCommand;
    const assumeYes = args.includes("--yes") || args.includes("-y");
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    const readline =
        interactive && (!options.confirm || !options.prompt)
            ? createInterface({ input: process.stdin, output: process.stdout })
            : undefined;
    // A directory name is never a destructive answer, so --yes still asks.
    const prompt: Prompt | undefined =
        options.prompt ??
        (readline ? async (question) => await readline.question(`${question} `) : undefined);
    const confirm: Confirm =
        options.confirm ??
        (assumeYes
            ? async () => true
            : interactive && readline
              ? async (question) => {
                    const answer = await readline.question(`${question} [y/N] `);
                    return /^(?:y|yes)$/i.test(answer.trim());
                }
              : async (question) => {
                    logger.warn(
                        `[kept] ${question} Non-interactive input; use --yes to replace it.`,
                    );
                    return false;
                });

    try {
        const invokedFrom = options.cwd ?? process.cwd();
        const cwd = await findWorkspaceRoot(invokedFrom);
        if (cwd !== invokedFrom) logger.log(`Found the repo-int workspace at ${cwd}`);
        logger.log(`Initializing ${cwd}`);
        await initializeGitRepository(cwd, runner, logger);
        const pkg = await readPackage(cwd);
        if (
            !selected.has("config") &&
            (!(await Bun.file(join(cwd, "vite.config.ts")).exists()) || !("workspaces" in pkg))
        ) {
            throw new Error(
                "The config template has not been applied here; run `repo-int config` first.",
            );
        }
        const owner = selected.has("config")
            ? await resolveGitHubOwner(runner, cwd, ownerFlag)
            : "";
        const web = join(cwd, "apps/web");
        const staticApp = join(cwd, "apps/static");
        const webExists = await pathExists(web);
        const tanstackDir = selected.has("tanstack")
            ? await resolveTanStackAppDir(cwd, appDirFlag, prompt, logger)
            : "";
        for (const name of ["ui", "assets"] as const) {
            if (!selected.has(name)) continue;
            const directory = join(cwd, "packages", name);
            if (
                (await pathExists(directory)) &&
                (await readPackage(directory)).name !== `@repo/${name}`
            ) {
                throw new Error(
                    `packages/${name} exists and is not @repo/${name}; move it before running the ${name} template.`,
                );
            }
        }
        const existingUi = (await readPackage(join(cwd, "packages/ui"))).name === "@repo/ui";
        const existingBase = existingUi ? await readUiBase(join(cwd, "packages/ui")) : undefined;
        if (uiBaseFlag !== undefined && existingBase !== undefined && uiBaseFlag !== existingBase) {
            throw new Error(
                `packages/ui already uses ${existingBase}. Switching to ${uiBaseFlag} requires migrating its components; repo-int will not overwrite them, even with --yes.`,
            );
        }
        const uiBase = uiBaseFlag ?? existingBase ?? "radix";
        if (selected.has("ui") || existingUi) await checkUiAppCompatibility(cwd, uiBase);
        let astroDir = "";
        if (selected.has("astro")) {
            if (await hasDependency(web, "astro")) astroDir = "web";
            else if (await hasDependency(staticApp, "astro")) astroDir = "static";
            else if (!webExists && !selected.has("tanstack")) astroDir = "web";
            else if (tanstackDir !== "static" && !(await pathExists(staticApp)))
                astroDir = "static";
            else
                throw new Error(
                    tanstackDir === "static"
                        ? "apps/static is reserved for the TanStack app; choose another --app-dir before running the astro template."
                        : "apps/web and apps/static are both taken; move one before running the astro template.",
                );
        }
        const versions = existingCatalog(pkg);
        // Bun's registry lookup requires a package.json even before dependencies are installed.
        if (!(await Bun.file(join(cwd, "package.json")).exists())) {
            await updatePackageJson(cwd, {}, confirm, logger);
        }
        const specs = new Map(
            TEMPLATE_ORDER.filter((name) => selected.has(name)).flatMap((name) =>
                catalogSpecs(name, uiBase).map((entry) => [entry.package, entry.spec] as const),
            ),
        );
        logger.log(
            `Resolving ${[...specs.keys()].filter((name) => !(name in versions)).length} package versions...`,
        );
        for (const [name, spec] of specs) {
            if (name in versions || spec === "alchemy-peer") continue;
            versions[name] = catalogRange(
                spec === "effect"
                    ? await resolveEffectVersion(runner, cwd)
                    : await resolveVersion(runner, cwd, spec),
            );
        }
        if (
            specs.has("@alchemy.run/frontend-frameworks") &&
            !("@alchemy.run/frontend-frameworks" in versions)
        ) {
            const alchemy = versions.alchemy;
            if (!alchemy) throw new Error("Alchemy version is missing.");
            versions["@alchemy.run/frontend-frameworks"] = alchemy;
        }
        const repoName = defaultPackageName(cwd);
        const stackName = repoName
            .split(/[^a-z0-9]+/i)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");
        const resolved: ResolvedTemplate[] = [];
        for (const name of TEMPLATE_ORDER) {
            if (!selected.has(name)) continue;
            const template = await resolveTemplate(
                name,
                {
                    cwd,
                    repoName,
                    stackName,
                    owner,
                    uiBase,
                    appDir: name === "tanstack" ? tanstackDir : name === "astro" ? astroDir : "",
                },
                versions,
            );
            resolved.push(template);
            for (const file of template.files)
                await synchronizeManagedFile(cwd, file, confirm, logger);
            await updatePackageJson(cwd, template.packageJson, confirm, logger);
            await mergeCodeRabbitPathFilters(cwd, template.codeRabbitPathFilters, logger);
        }
        await integrateWorkspacePackages(cwd, confirm, logger, uiBase);
        const install = [process.execPath, "install"];
        requireSuccess(install, await runner(install, { cwd, stdio: "inherit" }));
        if (selected.has("convex")) {
            logger.warn(
                "[skipped] convex codegen (run `bun run --cwd packages/backend codegen` after `convex dev` links a deployment)",
            );
        }
        for (const template of resolved) {
            for (const step of template.postInstall) {
                logger.log(step.description);
                const result = await runner(step.command, {
                    cwd: join(cwd, step.cwd),
                    stdio: "inherit",
                });
                if (template.name === "tanstack" && result.exitCode !== 0) {
                    logger.warn(
                        `[skipped] TanStack build failed; run \`bun run --cwd apps/${tanstackDir} dev\` to regenerate the route tree.`,
                    );
                } else requireSuccess(step.command, result);
            }
        }
        if (selected.has("config"))
            logger.log("Next: alchemy login --profile admin, then bun run deploy:github");
        if (selected.has("convex"))
            logger.log("Next: bun run --cwd packages/backend dev:convex to link a deployment");
        if (selected.has("tanstack")) logger.log(`Next: bun run --cwd apps/${tanstackDir} dev`);
        if (selected.has("astro")) logger.log(`Next: bun run --cwd apps/${astroDir} dev`);
        if (selected.has("ui"))
            logger.log("Next: bun x --bun shadcn@latest add input --cwd packages/ui");
        if (selected.has("assets"))
            logger.log(
                "Next: configure packages/assets/.env, generate the image manifest, then deploy and upload assets",
            );
        logger.log("Repository initialization complete.");
        return 0;
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        readline?.close();
    }
}
