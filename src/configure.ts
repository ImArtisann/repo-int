import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface Logger {
    error(message: string): void;
    log(message: string): void;
    warn(message: string): void;
}

export type Confirm = (question: string) => Promise<boolean>;

export interface ManagedTemplate {
    tool: string;
    destination: string;
    source: string;
    createOnly?: boolean;
    mergeIgnorePatterns?: boolean;
    mergePathFilters?: boolean;
}

export interface LoadedTemplate extends ManagedTemplate {
    content: string;
}

export type FileStatus = "created" | "unchanged" | "updated" | "skipped";

export interface PackageJsonSpec {
    /** Set only when the field is missing. */
    packageManager?: string;
    /** Missing globs are appended; array and `{ packages: [] }` object forms are supported. */
    workspaces?: readonly string[];
    /** Added when missing, never overwritten. Written to the top-level `catalog`, unless
     * object-form workspaces already carry a `catalog` key (never both). */
    catalog?: Readonly<Record<string, string>>;
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
    scripts?: Readonly<Record<string, string>>;
    imports?: Readonly<Record<string, string>>;
}

async function fileExists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
}

async function writeManagedFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
}

const GITIGNORE_MERGE_HEADER = "# repo-int managed ignores";

function gitignorePatterns(content: string): string[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function mergeGitignorePatterns(
    destination: string,
    template: LoadedTemplate,
    logger: Logger,
): Promise<FileStatus> {
    const existing = await readFile(destination, "utf8");
    const existingPatterns = new Set(gitignorePatterns(existing));
    const templateSections = template.content
        .split(/\r?\n(?:[ \t]*\r?\n)+/)
        .map(gitignorePatterns)
        .filter((patterns) => patterns.length > 0);
    const missingPatterns = templateSections.flatMap((patterns) => {
        const missing = patterns.filter((pattern) => !existingPatterns.has(pattern));
        if (missing.length === 0) return [];
        return [
            ...missing,
            ...patterns.filter((pattern) => pattern.startsWith("!") && !missing.includes(pattern)),
        ];
    });
    if (missingPatterns.length === 0) {
        logger.log(`[unchanged] ${template.destination}`);
        return "unchanged";
    }

    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const hasHeader = existing.split(/\r?\n/).includes(GITIGNORE_MERGE_HEADER);
    const addition = [...(!hasHeader ? [GITIGNORE_MERGE_HEADER] : []), ...missingPatterns].join(
        eol,
    );
    const separator =
        existing.length === 0
            ? ""
            : existing.endsWith(`${eol}${eol}`)
              ? ""
              : existing.endsWith(eol)
                ? eol
                : `${eol}${eol}`;
    await writeFile(destination, `${existing}${separator}${addition}${eol}`);
    logger.log(`[updated] ${template.destination}`);
    return "updated";
}

function codeRabbitPathFilterItems(patterns: readonly string[], indent: string): string[] {
    return patterns.map((pattern) => `${indent}- "${pattern}"`);
}

function parseCodeRabbitPathFilters(text: string): string[] {
    const parsed: unknown = Bun.YAML.parse(text);
    const reviews =
        typeof parsed === "object" && parsed !== null && "reviews" in parsed
            ? parsed.reviews
            : undefined;
    const pathFilters =
        typeof reviews === "object" && reviews !== null && "path_filters" in reviews
            ? reviews.path_filters
            : undefined;
    return Array.isArray(pathFilters) && pathFilters.every((item) => typeof item === "string")
        ? pathFilters
        : [];
}

function insertCodeRabbitPathFilters(text: string, patterns: readonly string[]): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const reviewsIndex = lines.findIndex((line) => /^reviews:\s*$/.test(line));
    if (reviewsIndex === -1) {
        const body = text.length === 0 ? "" : text.endsWith(eol) ? text : `${text}${eol}`;
        const block = [
            "reviews:",
            "    path_filters:",
            ...codeRabbitPathFilterItems(patterns, "        "),
        ];
        return `${body}${block.join(eol)}${eol}`;
    }

    let blockEnd = lines.length;
    for (let index = reviewsIndex + 1; index < lines.length; index += 1) {
        if (/^\S/.test(lines[index]!)) {
            blockEnd = index;
            break;
        }
    }

    let pathFiltersIndex = -1;
    for (let index = reviewsIndex + 1; index < blockEnd; index += 1) {
        if (/^(\s*)path_filters:\s*$/.test(lines[index]!)) {
            pathFiltersIndex = index;
            break;
        }
    }

    if (pathFiltersIndex === -1) {
        lines.splice(
            reviewsIndex + 1,
            0,
            "    path_filters:",
            ...codeRabbitPathFilterItems(patterns, "        "),
        );
        return lines.join(eol);
    }

    const indent = `${/^(\s*)path_filters:\s*$/.exec(lines[pathFiltersIndex]!)?.[1] ?? ""}    `;
    let insertAt = pathFiltersIndex + 1;
    while (insertAt < blockEnd && /^\s*- /.test(lines[insertAt]!)) insertAt += 1;
    lines.splice(insertAt, 0, ...codeRabbitPathFilterItems(patterns, indent));
    return lines.join(eol);
}

async function mergePathFiltersIntoTemplate(
    destination: string,
    template: LoadedTemplate,
    confirm: Confirm,
    logger: Logger,
): Promise<FileStatus> {
    const existing = await readFile(destination, "utf8");
    let desired = template.content;
    if (existing !== template.content) {
        try {
            // Existing path filters are unioned into the template so re-running the config
            // template never resets filters appended by other templates.
            const templateFilters = parseCodeRabbitPathFilters(template.content);
            const extras = parseCodeRabbitPathFilters(existing).filter(
                (pattern) => !templateFilters.includes(pattern),
            );
            if (extras.length > 0) desired = insertCodeRabbitPathFilters(template.content, extras);
        } catch {
            // Unparsable YAML keeps the regular create/confirm/overwrite behavior.
        }
    }
    if (existing === desired) {
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

    await writeManagedFile(destination, desired);
    logger.log(`[updated] ${template.destination}`);
    return "updated";
}

export async function synchronizeManagedFile(
    cwd: string,
    template: LoadedTemplate,
    confirm: Confirm,
    logger: Logger,
): Promise<FileStatus> {
    const destination = resolve(cwd, template.destination);
    const destinationExists = await fileExists(destination);
    if (template.mergeIgnorePatterns && destinationExists) {
        return mergeGitignorePatterns(destination, template, logger);
    }
    if (template.mergePathFilters && destinationExists) {
        return mergePathFiltersIntoTemplate(destination, template, confirm, logger);
    }

    if (!destinationExists) {
        await writeManagedFile(destination, template.content);
        logger.log(`[created] ${template.destination}`);
        return "created";
    }
    if (template.createOnly) {
        logger.log(`[unchanged] ${template.destination}`);
        return "unchanged";
    }

    const existing = await readFile(destination, "utf8");
    if (existing === template.content) {
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

    await writeManagedFile(destination, template.content);
    logger.log(`[updated] ${template.destination}`);
    return "updated";
}

export function defaultPackageName(cwd: string): string {
    const normalized = basename(cwd)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+|[._-]+$/g, "");
    return normalized || "bun-app";
}

function formatPackageJson(value: Record<string, unknown>, original: string | undefined): string {
    const eol = original?.includes("\r\n") ? "\r\n" : "\n";
    const indentation = original?.match(/\n([\t ]+)"/)?.[1] ?? "    ";
    return `${JSON.stringify(value, null, indentation).replaceAll("\n", eol)}${eol}`;
}

function workspacesPackages(path: string, workspaces: unknown): string[] {
    if (Array.isArray(workspaces)) {
        if (!workspaces.every((entry) => typeof entry === "string")) {
            throw new Error(`${path} has a non-string "workspaces" entry.`);
        }
        return workspaces;
    }
    if (typeof workspaces !== "object" || workspaces === null) {
        throw new Error(`${path} has an invalid "workspaces" field.`);
    }
    // Object form; every member is validated before use and other keys are preserved.
    const record = workspaces as Record<string, unknown>;
    const packages = record["packages"];
    if (packages === undefined) {
        const created: string[] = [];
        record["packages"] = created;
        return created;
    }
    if (!Array.isArray(packages)) {
        throw new Error(`${path} has a non-array "workspaces.packages" field.`);
    }
    if (!packages.every((entry) => typeof entry === "string")) {
        throw new Error(`${path} has a non-string "workspaces.packages" entry.`);
    }
    return packages;
}

function mergeWorkspaces(
    path: string,
    packageJson: Record<string, unknown>,
    desired: readonly string[],
): boolean {
    const value = packageJson["workspaces"];
    if (value === undefined) {
        if (desired.length === 0) return false;
        packageJson["workspaces"] = [...desired];
        return true;
    }
    const packages = workspacesPackages(path, value);
    const missing = desired.filter((glob) => !packages.includes(glob));
    if (missing.length === 0) return false;
    packages.push(...missing);
    return true;
}

function mergeCatalog(
    path: string,
    packageJson: Record<string, unknown>,
    desired: Readonly<Record<string, string>>,
): boolean {
    const entries = Object.entries(desired);
    if (entries.length === 0) return false;
    const workspaces = packageJson["workspaces"];
    // Object-form workspaces that already carry a `catalog` key own the catalog;
    // repo-int never writes both locations.
    const target =
        typeof workspaces === "object" && workspaces !== null && "catalog" in workspaces
            ? (workspaces as Record<string, unknown>)
            : packageJson;
    const existing = target["catalog"];
    if (existing === undefined) {
        target["catalog"] = Object.fromEntries(entries);
        return true;
    }
    if (existing === null || Array.isArray(existing) || typeof existing !== "object") {
        throw new Error(`${path} has a non-object "catalog" field.`);
    }
    const catalog = existing as Record<string, unknown>;
    let changed = false;
    for (const [name, version] of entries) {
        if (catalog[name] !== undefined) continue;
        catalog[name] = version;
        changed = true;
    }
    return changed;
}

const PACKAGE_JSON_ENTRY_LABELS = {
    dependencies: "dependency",
    devDependencies: "devDependency",
    scripts: "script",
    imports: "import",
} as const;

type PackageJsonEntryField = keyof typeof PACKAGE_JSON_ENTRY_LABELS;

async function mergePackageJsonEntries(
    path: string,
    packageJson: Record<string, unknown>,
    field: PackageJsonEntryField,
    desired: Readonly<Record<string, string>>,
    confirm: Confirm,
    logger: Logger,
): Promise<boolean> {
    const value = packageJson[field];
    if (value === undefined) {
        if (Object.keys(desired).length === 0) return false;
        packageJson[field] = { ...desired };
        return true;
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error(`${path} has a non-object "${field}" field.`);
    }
    const entries = value as Record<string, unknown>;
    const label = PACKAGE_JSON_ENTRY_LABELS[field];
    let changed = false;
    for (const [name, version] of Object.entries(desired)) {
        const existing = entries[name];
        if (existing === undefined) {
            entries[name] = version;
            changed = true;
            continue;
        }
        if (existing === version) continue;
        const accepted = await confirm(
            `package.json ${label} "${name}" differs from repo-int. Change it from ${JSON.stringify(existing)} to ${JSON.stringify(version)}?`,
        );
        if (accepted) {
            entries[name] = version;
            changed = true;
        } else {
            logger.warn(`[kept] package.json ${label} "${name}"`);
        }
    }
    return changed;
}

export async function updatePackageJson(
    cwd: string,
    desired: PackageJsonSpec,
    confirm: Confirm,
    logger: Logger,
): Promise<FileStatus> {
    const path = resolve(cwd, "package.json");
    const exists = await fileExists(path);
    const original = exists ? await readFile(path, "utf8") : undefined;
    let packageJson: Record<string, unknown>;

    if (original === undefined) {
        packageJson = {
            name: defaultPackageName(cwd),
            version: "0.0.0",
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
    if (desired.packageManager !== undefined && packageJson["packageManager"] === undefined) {
        packageJson["packageManager"] = desired.packageManager;
        changed = true;
    }
    if (desired.workspaces !== undefined) {
        changed = mergeWorkspaces(path, packageJson, desired.workspaces) || changed;
    }
    if (desired.catalog !== undefined) {
        changed = mergeCatalog(path, packageJson, desired.catalog) || changed;
    }
    for (const field of ["dependencies", "devDependencies", "scripts", "imports"] as const) {
        const entries = desired[field];
        if (entries === undefined) continue;
        changed =
            (await mergePackageJsonEntries(path, packageJson, field, entries, confirm, logger)) ||
            changed;
    }

    if (!changed) {
        logger.log("[unchanged] package.json");
        return "unchanged";
    }

    await writeFile(path, formatPackageJson(packageJson, original));
    const status: FileStatus = exists ? "updated" : "created";
    logger.log(`[${status}] package.json`);
    return status;
}

export async function mergeCodeRabbitPathFilters(
    cwd: string,
    patterns: readonly string[],
    logger: Logger,
): Promise<FileStatus> {
    const destination = resolve(cwd, ".coderabbit.yaml");
    if (!(await fileExists(destination))) {
        const content = [
            "reviews:",
            "    path_filters:",
            ...codeRabbitPathFilterItems(patterns, "        "),
        ].join("\n");
        await writeManagedFile(destination, `${content}\n`);
        logger.log("[created] .coderabbit.yaml");
        return "created";
    }

    const original = await readFile(destination, "utf8");
    const existing = parseCodeRabbitPathFilters(original);
    const missing = patterns.filter((pattern) => !existing.includes(pattern));
    if (missing.length === 0) {
        logger.log("[unchanged] .coderabbit.yaml");
        return "unchanged";
    }

    const merged = insertCodeRabbitPathFilters(original, missing);
    await writeFile(destination, merged);
    const persisted = parseCodeRabbitPathFilters(merged);
    const absent = patterns.filter((pattern) => !persisted.includes(pattern));
    if (absent.length > 0) {
        throw new Error(`.coderabbit.yaml merge failed for: ${absent.join(", ")}`);
    }
    logger.log("[updated] .coderabbit.yaml");
    return "updated";
}
