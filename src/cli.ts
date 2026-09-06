import { createInterface } from "node:readline/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
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
    type TemplateName,
    type ResolvedTemplate,
} from "./templates.ts";
import { catalogRange, resolveEffectVersion, resolveVersion } from "./versions.ts";

export interface CliOptions {
    args?: readonly string[];
    confirm?: Confirm;
    cwd?: string;
    logger?: Logger;
    runner?: CommandRunner;
}

const HELP = `repo-int

Usage:
  bun x @artisann-studios/repo-int <template...> [--owner <login>] [--yes]

Templates: config, convex, tanstack, astro

Options:
      --owner   GitHub owner for the config template (defaults to authenticated gh user)
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
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === undefined) break;
        if (arg === "--owner") {
            ownerFlag = args[++index];
            if (!ownerFlag || ownerFlag.startsWith("-")) {
                logger.error("--owner requires a login.");
                return 1;
            }
        } else if (["--yes", "-y", "--help", "-h"].includes(arg)) {
            continue;
        } else if (arg === "config" || arg === "convex" || arg === "tanstack" || arg === "astro") {
            selected.add(arg);
        } else {
            logger.error(
                arg.startsWith("-")
                    ? `Unknown option: ${arg}\n\n${HELP}`
                    : `Unknown template "${arg}". Expected: config, convex, tanstack, astro.`,
            );
            return 1;
        }
    }
    if (args.includes("--help") || args.includes("-h")) {
        logger.log(HELP);
        return 0;
    }
    if (selected.size === 0) {
        logger.log(HELP);
        return 1;
    }

    const cwd = options.cwd ?? process.cwd();
    const runner = options.runner ?? runCommand;
    const assumeYes = args.includes("--yes") || args.includes("-y");
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    const readline =
        !options.confirm && interactive
            ? createInterface({ input: process.stdin, output: process.stdout })
            : undefined;
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
        if (
            selected.has("tanstack") &&
            webExists &&
            !(await hasDependency(web, "@tanstack/react-start"))
        ) {
            throw new Error(
                "apps/web exists and is not a TanStack Start app; move it before running the tanstack template.",
            );
        }
        let astroDir = "";
        if (selected.has("astro")) {
            if (await hasDependency(web, "astro")) astroDir = "web";
            else if (await hasDependency(staticApp, "astro")) astroDir = "static";
            else if (!webExists && !selected.has("tanstack")) astroDir = "web";
            else if (!(await pathExists(staticApp))) astroDir = "static";
            else
                throw new Error(
                    "apps/web and apps/static are both taken; move one before running the astro template.",
                );
        }
        const versions = existingCatalog(pkg);
        // Bun's registry lookup requires a package.json even before dependencies are installed.
        if (!(await Bun.file(join(cwd, "package.json")).exists())) {
            await updatePackageJson(cwd, {}, confirm, logger);
        }
        const specs = new Map(
            TEMPLATE_ORDER.filter((name) => selected.has(name)).flatMap((name) =>
                catalogSpecs(name).map((entry) => [entry.package, entry.spec] as const),
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
                    appDir: name === "tanstack" ? "web" : name === "astro" ? astroDir : "",
                },
                versions,
            );
            resolved.push(template);
            for (const file of template.files)
                await synchronizeManagedFile(cwd, file, confirm, logger);
            await updatePackageJson(cwd, template.packageJson, confirm, logger);
            await mergeCodeRabbitPathFilters(cwd, template.codeRabbitPathFilters, logger);
        }
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
                        "[skipped] TanStack build failed; run `bun run --cwd apps/web dev` to regenerate the route tree.",
                    );
                } else requireSuccess(step.command, result);
            }
        }
        if (selected.has("config"))
            logger.log("Next: alchemy login --profile admin, then bun run deploy:github");
        if (selected.has("convex"))
            logger.log("Next: bun run --cwd packages/backend dev:convex to link a deployment");
        if (selected.has("tanstack")) logger.log("Next: bun run --cwd apps/web dev");
        if (selected.has("astro")) logger.log(`Next: bun run --cwd apps/${astroDir} dev`);
        logger.log("Repository initialization complete.");
        return 0;
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        readline?.close();
    }
}
