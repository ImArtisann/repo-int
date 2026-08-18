import { basename, dirname, resolve } from "node:path";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

export interface Logger {
    error(message: string): void;
    log(message: string): void;
    warn(message: string): void;
}

export type Confirm = (question: string) => Promise<boolean>;

export interface ManagedTemplate {
    alternatives: readonly string[];
    destination: string;
    createOnly?: boolean;
    executable?: boolean;
    source: string;
    tool: string;
}

export interface LoadedTemplate extends ManagedTemplate {
    content: string;
}

export type FileStatus = "created" | "unchanged" | "updated" | "skipped";
export interface TemplateOptions {
    effect?: boolean;
}

export const MANAGED_TEMPLATES: readonly ManagedTemplate[] = [
    {
        tool: "oxfmt",
        destination: "oxfmt.config.ts",
        alternatives: [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.mts"],
        source: "oxfmt.config.ts",
    },
    {
        tool: "oxlint",
        destination: "oxlint.config.ts",
        alternatives: [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.mts"],
        source: "oxlint.default.config.ts",
    },
    {
        tool: "lint-staged",
        destination: ".lintstagedrc.json",
        alternatives: [
            ".lintstagedrc",
            ".lintstagedrc.yaml",
            ".lintstagedrc.yml",
            ".lintstagedrc.js",
            ".lintstagedrc.cjs",
            ".lintstagedrc.mjs",
            "lint-staged.config.js",
            "lint-staged.config.cjs",
            "lint-staged.config.mjs",
            "lint-staged.config.ts",
        ],
        source: "lintstagedrc.json",
    },
    {
        tool: "husky",
        destination: ".husky/pre-commit",
        alternatives: [],
        executable: true,
        source: "pre-commit",
    },
    {
        tool: "Dependabot",
        destination: ".github/dependabot.yml",
        alternatives: [],
        source: "dependabot.yml",
    },
];
const EFFECT_TSCONFIG_TEMPLATE: ManagedTemplate = {
    tool: "Effect TypeScript",
    destination: "tsconfig.json",
    alternatives: [],
    createOnly: true,
    source: "tsconfig.effect.json",
};

const DESIRED_SCRIPTS: Readonly<Record<string, string>> = {
    format: "oxfmt --write .",
    "format:check": "oxfmt --check .",
    lint: "oxlint . --no-error-on-unmatched-pattern",
    "lint:fix": "oxlint --fix . --no-error-on-unmatched-pattern",
    prepare: "bunx --bun husky",
};
const EFFECT_PATCH_SCRIPT = "effect-tsgo patch --typescript --oxlint";

async function fileExists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
}

async function writeManagedFile(path: string, content: string, executable: boolean): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, executable ? { mode: 0o755 } : undefined);
    if (executable) await chmod(path, 0o755);
}

async function loadTemplateDirectory(
    templateRoot: string,
    directory: string,
    tool: string,
): Promise<LoadedTemplate[]> {
    const entries = await readdir(resolve(templateRoot, directory), { withFileTypes: true });
    const loaded = await Promise.all(
        entries
            .toSorted((left, right) => left.name.localeCompare(right.name))
            .map(async (entry): Promise<LoadedTemplate[]> => {
                const source = `${directory}/${entry.name}`;
                if (entry.isDirectory()) {
                    return loadTemplateDirectory(templateRoot, source, tool);
                }
                if (!entry.isFile()) return [];
                return [
                    {
                        tool,
                        destination: source,
                        alternatives: [],
                        source,
                        content: await readFile(resolve(templateRoot, source), "utf8"),
                    },
                ];
            }),
    );
    return loaded.flat();
}

export async function loadTemplates(options: TemplateOptions = {}): Promise<LoadedTemplate[]> {
    const templateRoot = resolve(import.meta.dir, "../templates");
    const effect = options.effect === true;
    const configuredTemplates = MANAGED_TEMPLATES.map((template) =>
        effect && template.tool === "oxlint"
            ? { ...template, source: "oxlint.effect.config.ts" }
            : template,
    );
    const managedTemplates = effect
        ? [...configuredTemplates, EFFECT_TSCONFIG_TEMPLATE]
        : configuredTemplates;
    const groups = await Promise.all([
        Promise.all(
            managedTemplates.map(async (template) => ({
                ...template,
                content: await readFile(resolve(templateRoot, template.source), "utf8"),
            })),
        ),
        loadTemplateDirectory(templateRoot, "tools/oxlint/anti-slop", "anti-slop"),
        ...(effect
            ? [loadTemplateDirectory(templateRoot, "tools/oxlint/effect", "Effect Oxlint")]
            : []),
    ]);
    return groups.flat();
}

export async function synchronizeManagedFile(
    cwd: string,
    template: LoadedTemplate,
    confirm: Confirm,
    logger: Logger,
): Promise<FileStatus> {
    const destination = resolve(cwd, template.destination);
    const destinationExists = await fileExists(destination);
    const existingAlternatives: { content: string; relativePath: string }[] = [];

    for (const relativePath of template.alternatives) {
        const path = resolve(cwd, relativePath);
        if (await fileExists(path)) {
            existingAlternatives.push({ content: await readFile(path, "utf8"), relativePath });
        }
    }

    if (!destinationExists && existingAlternatives.length === 1) {
        const existing = existingAlternatives[0];
        if (existing?.content === template.content) {
            logger.log(`[unchanged] ${existing.relativePath}`);
            return "unchanged";
        }
    }

    if (existingAlternatives.length > 0) {
        const paths = [
            ...(destinationExists ? [template.destination] : []),
            ...existingAlternatives.map(({ relativePath }) => relativePath),
        ];
        const accepted = await confirm(
            `${template.tool} configuration exists at ${paths.join(", ")} and differs from repo-int. Replace it with ${template.destination}?`,
        );
        if (!accepted) {
            logger.warn(`[kept] ${paths.join(", ")}`);
            return "skipped";
        }

        await writeManagedFile(destination, template.content, template.executable === true);
        await Promise.all(
            existingAlternatives.map(({ relativePath }) =>
                rm(resolve(cwd, relativePath), { force: true }),
            ),
        );
        logger.log(`[updated] ${template.destination}`);
        return "updated";
    }

    if (!destinationExists) {
        await writeManagedFile(destination, template.content, template.executable === true);
        logger.log(`[created] ${template.destination}`);
        return "created";
    }
    if (template.createOnly) {
        logger.log(`[unchanged] ${template.destination}`);
        return "unchanged";
    }

    const existing = await readFile(destination, "utf8");
    if (existing === template.content) {
        if (template.executable) await chmod(destination, 0o755);
        logger.log(`[unchanged] ${template.destination}`);
        return "unchanged";
    }

    const accepted = await confirm(
        `${template.destination} differs from the repo-int template. Overwrite it?`,
    );
    if (!accepted) {
        logger.warn(`[kept] ${template.destination}`);
        return "skipped";
    }

    await writeManagedFile(destination, template.content, template.executable === true);
    logger.log(`[updated] ${template.destination}`);
    return "updated";
}

function defaultPackageName(cwd: string): string {
    const normalized = basename(cwd)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+|[._-]+$/g, "");
    return normalized || "bun-app";
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
        );
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}

function formatPackageJson(value: Record<string, unknown>, original: string | undefined): string {
    const eol = original?.includes("\r\n") ? "\r\n" : "\n";
    const indentation = original?.match(/\n([\t ]+)"/)?.[1] ?? "    ";
    return `${JSON.stringify(value, null, indentation).replaceAll("\n", eol)}${eol}`;
}

export async function configurePackageJson(
    cwd: string,
    desiredLintStaged: unknown,
    confirm: Confirm,
    logger: Logger,
    options: TemplateOptions = {},
): Promise<{ manageLintStagedFile: boolean }> {
    const path = resolve(cwd, "package.json");
    const exists = await fileExists(path);
    const original = exists ? await readFile(path, "utf8") : undefined;
    let packageJson: Record<string, unknown>;

    if (original === undefined) {
        packageJson = {
            name: defaultPackageName(cwd),
            version: "0.1.0",
            private: true,
            type: "module",
        };
    } else {
        let parsed: unknown;
        try {
            parsed = JSON.parse(original);
        } catch (error) {
            throw new Error(
                `Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
            throw new Error(`${path} must contain a JSON object.`);
        }
        packageJson = parsed as Record<string, unknown>;
    }

    let changed = !exists;
    let manageLintStagedFile = true;
    const embeddedLintStaged = packageJson["lint-staged"];
    if (embeddedLintStaged !== undefined) {
        if (stableJson(embeddedLintStaged) === stableJson(desiredLintStaged)) {
            manageLintStagedFile = false;
            logger.log("[unchanged] package.json lint-staged configuration");
        } else if (
            await confirm(
                "package.json contains a lint-staged configuration that differs from repo-int. Replace it with .lintstagedrc.json?",
            )
        ) {
            delete packageJson["lint-staged"];
            changed = true;
        } else {
            manageLintStagedFile = false;
            logger.warn("[kept] package.json lint-staged configuration");
        }
    }

    const scriptsValue = packageJson.scripts;
    if (
        scriptsValue !== undefined &&
        (scriptsValue === null || Array.isArray(scriptsValue) || typeof scriptsValue !== "object")
    ) {
        throw new Error(`${path} has a non-object "scripts" field.`);
    }
    const scripts = (scriptsValue ?? {}) as Record<string, unknown>;
    if (scriptsValue === undefined) {
        packageJson.scripts = scripts;
        changed = true;
    }

    const effect = options.effect === true;
    const desiredScripts = {
        ...DESIRED_SCRIPTS,
        ...(effect ? { prepare: `${DESIRED_SCRIPTS.prepare} && ${EFFECT_PATCH_SCRIPT}` } : {}),
    };
    for (const [name, desired] of Object.entries(desiredScripts)) {
        const existing = scripts[name];
        if (existing === undefined) {
            scripts[name] = desired;
            changed = true;
            continue;
        }
        const hasHusky =
            name === "prepare" &&
            typeof existing === "string" &&
            /(^|\s|&&)husky($|\s|&&)/.test(existing);
        const hasEffectPatch =
            typeof existing === "string" && existing.includes(EFFECT_PATCH_SCRIPT);
        if (
            existing === desired ||
            (name === "prepare" && hasHusky && (!effect || hasEffectPatch))
        ) {
            continue;
        }

        const proposed =
            name === "prepare" && typeof existing === "string"
                ? [
                      existing,
                      ...(!hasHusky ? [DESIRED_SCRIPTS.prepare] : []),
                      ...(effect && !hasEffectPatch ? [EFFECT_PATCH_SCRIPT] : []),
                  ].join(" && ")
                : desired;
        const accepted = await confirm(
            `package.json script "${name}" differs from repo-int. Change it from ${JSON.stringify(existing)} to ${JSON.stringify(proposed)}?`,
        );
        if (accepted) {
            scripts[name] = proposed;
            changed = true;
        } else {
            logger.warn(`[kept] package.json script "${name}"`);
        }
    }

    if (changed) {
        await writeFile(path, formatPackageJson(packageJson, original));
        logger.log(`[${exists ? "updated" : "created"}] package.json`);
    } else {
        logger.log("[unchanged] package.json");
    }

    return { manageLintStagedFile };
}
