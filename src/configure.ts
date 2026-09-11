import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Terminal from "effect/Terminal";
import type { PlatformError } from "effect/PlatformError";
import { ManifestError } from "./errors.ts";
import { Interaction } from "./interaction.ts";
import { Log } from "./log.ts";
import {
    loadPackageJson,
    parseCodeRabbitPathFilters,
    parseCodeRabbitPathFiltersStrict,
    savePackageJson,
} from "./manifest.ts";

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
    workspaces?: ReadonlyArray<string>;
    /** Added when missing, never overwritten. Written to the top-level `catalog`, unless
     * object-form workspaces already carry a `catalog` key (never both). */
    catalog?: Readonly<Record<string, string>>;
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
    scripts?: Readonly<Record<string, string>>;
    imports?: Readonly<Record<string, string>>;
}

const writeManagedFile = (
    path: string,
    content: string,
): Effect.Effect<void, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        yield* fs.makeDirectory(pathService.dirname(path), { recursive: true });
        yield* fs.writeFileString(path, content);
    });

const GITIGNORE_MERGE_HEADER = "# repo-int managed ignores";

const gitignorePatterns = (content: string): Array<string> =>
    content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

const mergeGitignorePatterns = (
    destination: string,
    template: LoadedTemplate,
): Effect.Effect<FileStatus, PlatformError, FileSystem | Log> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const log = yield* Log;
        const existing = yield* fs.readFileString(destination);
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
                ...patterns.filter(
                    (pattern) => pattern.startsWith("!") && !missing.includes(pattern),
                ),
            ];
        });

        if (missingPatterns.length === 0) {
            yield* log.log(`[unchanged] ${template.destination}`);

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

        yield* fs.writeFileString(destination, `${existing}${separator}${addition}${eol}`);
        yield* log.log(`[updated] ${template.destination}`);

        return "updated";
    });

const codeRabbitPathFilterItems = (
    patterns: ReadonlyArray<string>,
    indent: string,
): Array<string> => patterns.map((pattern) => `${indent}- "${pattern}"`);

const insertCodeRabbitPathFilters = (text: string, patterns: ReadonlyArray<string>): string => {
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
        const line = lines[index];

        if (line !== undefined && /^\S/.test(line)) {
            blockEnd = index;
            break;
        }
    }

    let pathFiltersIndex = -1;

    for (let index = reviewsIndex + 1; index < blockEnd; index += 1) {
        const line = lines[index];

        if (line !== undefined && /^(\s*)path_filters:\s*$/.test(line)) {
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

    const pathFiltersLine = lines[pathFiltersIndex] ?? "";
    const indent = `${/^(\s*)path_filters:\s*$/.exec(pathFiltersLine)?.[1] ?? ""}    `;
    let insertAt = pathFiltersIndex + 1;

    while (insertAt < blockEnd) {
        const line = lines[insertAt];

        if (line === undefined || !/^\s*- /.test(line)) break;
        insertAt += 1;
    }

    lines.splice(insertAt, 0, ...codeRabbitPathFilterItems(patterns, indent));

    return lines.join(eol);
};

const mergePathFiltersIntoTemplate = (
    destination: string,
    template: LoadedTemplate,
): Effect.Effect<
    FileStatus,
    PlatformError | Terminal.QuitError,
    FileSystem | Path | Log | Interaction | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const log = yield* Log;
        const interaction = yield* Interaction;
        const existing = yield* fs.readFileString(destination);
        let desired = template.content;

        if (existing !== template.content) {
            // Existing path filters are unioned into the template so re-running the config
            // template never resets filters appended by other templates.
            const templateFilters = yield* parseCodeRabbitPathFilters(template.content);
            const existingFilters = yield* parseCodeRabbitPathFilters(existing);
            const extras = existingFilters.filter((pattern) => !templateFilters.includes(pattern));

            if (extras.length > 0) desired = insertCodeRabbitPathFilters(template.content, extras);
        }

        if (existing === desired) {
            yield* log.log(`[unchanged] ${template.destination}`);

            return "unchanged";
        }

        const accepted = yield* interaction.confirm(
            `${template.destination} differs from the repo-int template. Overwrite it?`,
        );

        if (!accepted) {
            yield* log.warn(`[kept] ${template.destination}`);

            return "skipped";
        }

        yield* writeManagedFile(destination, desired);
        yield* log.log(`[updated] ${template.destination}`);

        return "updated";
    });

export const synchronizeManagedFile = (
    cwd: string,
    template: LoadedTemplate,
): Effect.Effect<
    FileStatus,
    PlatformError | Terminal.QuitError,
    FileSystem | Path | Log | Interaction | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const log = yield* Log;
        const interaction = yield* Interaction;
        const destination = pathService.resolve(cwd, template.destination);
        const destinationExists = yield* fs.exists(destination);

        if (template.mergeIgnorePatterns === true && destinationExists) {
            return yield* mergeGitignorePatterns(destination, template);
        }

        if (template.mergePathFilters === true && destinationExists) {
            return yield* mergePathFiltersIntoTemplate(destination, template);
        }

        if (!destinationExists) {
            yield* writeManagedFile(destination, template.content);
            yield* log.log(`[created] ${template.destination}`);

            return "created";
        }

        if (template.createOnly === true) {
            yield* log.log(`[unchanged] ${template.destination}`);

            return "unchanged";
        }

        const existing = yield* fs.readFileString(destination);

        if (existing === template.content) {
            yield* log.log(`[unchanged] ${template.destination}`);

            return "unchanged";
        }

        const accepted = yield* interaction.confirm(
            `${template.destination} differs from the repo-int template. Overwrite it?`,
        );

        if (!accepted) {
            yield* log.warn(`[kept] ${template.destination}`);

            return "skipped";
        }

        yield* writeManagedFile(destination, template.content);
        yield* log.log(`[updated] ${template.destination}`);

        return "updated";
    });

export const defaultPackageName = (cwd: string): Effect.Effect<string, never, Path> =>
    Effect.map(Path, (pathService) => {
        const normalized = pathService
            .basename(cwd)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^[._-]+|[._-]+$/g, "");

        return normalized === "" ? "bun-app" : normalized;
    });

const invalidField = (path: string, message: string) =>
    new ManifestError({ message: `${path} ${message}` });

const isMutableJsonObject = (
    value: Schema.MutableJson | undefined,
): value is Schema.MutableJsonObject => Predicate.isObject(value) && !Array.isArray(value);

const workspacesPackages = (
    path: string,
    workspaces: Schema.MutableJson,
): Effect.Effect<Array<string>, ManifestError> => {
    if (Array.isArray(workspaces)) {
        if (!workspaces.every(Predicate.isString)) {
            return Effect.fail(invalidField(path, 'has a non-string "workspaces" entry.'));
        }

        return Effect.succeed(workspaces);
    }

    if (!isMutableJsonObject(workspaces)) {
        return Effect.fail(invalidField(path, 'has an invalid "workspaces" field.'));
    }

    // Object form; every member is validated before use and other keys are preserved.
    const packages = workspaces["packages"];

    if (packages === undefined) {
        const created: Array<string> = [];
        workspaces["packages"] = created;

        return Effect.succeed(created);
    }

    if (!Array.isArray(packages)) {
        return Effect.fail(invalidField(path, 'has a non-array "workspaces.packages" field.'));
    }

    if (!packages.every(Predicate.isString)) {
        return Effect.fail(invalidField(path, 'has a non-string "workspaces.packages" entry.'));
    }

    return Effect.succeed(packages);
};

const mergeWorkspaces = (
    path: string,
    packageJson: Record<string, Schema.MutableJson>,
    desired: ReadonlyArray<string>,
): Effect.Effect<boolean, ManifestError> => {
    const value = packageJson["workspaces"];

    if (value === undefined) {
        if (desired.length === 0) return Effect.succeed(false);
        packageJson["workspaces"] = [...desired];

        return Effect.succeed(true);
    }

    return Effect.map(workspacesPackages(path, value), (packages) => {
        const missing = desired.filter((glob) => !packages.includes(glob));

        if (missing.length === 0) return false;
        packages.push(...missing);

        return true;
    });
};

const mergeCatalog = (
    path: string,
    packageJson: Record<string, Schema.MutableJson>,
    desired: Readonly<Record<string, string>>,
): Effect.Effect<boolean, ManifestError> => {
    const entries = Object.entries(desired);

    if (entries.length === 0) return Effect.succeed(false);
    const workspaces = packageJson["workspaces"];

    // Object-form workspaces that already carry a `catalog` key own the catalog;
    // repo-int never writes both locations.
    const target =
        isMutableJsonObject(workspaces) && Object.hasOwn(workspaces, "catalog")
            ? workspaces
            : packageJson;

    const existing = target["catalog"];

    if (existing === undefined) {
        target["catalog"] = Object.fromEntries(entries);

        return Effect.succeed(true);
    }

    if (existing === null || !isMutableJsonObject(existing)) {
        return Effect.fail(invalidField(path, 'has a non-object "catalog" field.'));
    }

    let changed = false;

    for (const [name, version] of entries) {
        if (existing[name] !== undefined) continue;
        existing[name] = version;
        changed = true;
    }

    return Effect.succeed(changed);
};

const PACKAGE_JSON_ENTRY_LABELS = {
    dependencies: "dependency",
    devDependencies: "devDependency",
    scripts: "script",
    imports: "import",
} as const;

type PackageJsonEntryField = keyof typeof PACKAGE_JSON_ENTRY_LABELS;

const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.MutableJson));

const mergePackageJsonEntries = (
    path: string,
    packageJson: Record<string, Schema.MutableJson>,
    field: PackageJsonEntryField,
    desired: Readonly<Record<string, string>>,
): Effect.Effect<
    boolean,
    ManifestError | Terminal.QuitError,
    Log | Interaction | FileSystem | Path | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const log = yield* Log;
        const interaction = yield* Interaction;
        const value = packageJson[field];

        if (value === undefined) {
            if (Object.keys(desired).length === 0) return false;
            packageJson[field] = { ...desired };

            return true;
        }

        if (value === null || !isMutableJsonObject(value)) {
            return yield* invalidField(path, `has a non-object "${field}" field.`);
        }

        const label = PACKAGE_JSON_ENTRY_LABELS[field];
        let changed = false;

        for (const [name, version] of Object.entries(desired)) {
            const existing = value[name];

            if (existing === undefined) {
                value[name] = version;
                changed = true;
                continue;
            }

            if (existing === version) continue;

            const accepted = yield* interaction.confirm(
                `package.json ${label} "${name}" differs from repo-int. Change it from ${jsonString(existing)} to ${jsonString(version)}?`,
            );

            if (accepted) {
                value[name] = version;
                changed = true;
            } else {
                yield* log.warn(`[kept] package.json ${label} "${name}"`);
            }
        }

        return changed;
    });

export const updatePackageJson = (
    cwd: string,
    desired: PackageJsonSpec,
): Effect.Effect<
    FileStatus,
    ManifestError | PlatformError | Terminal.QuitError,
    FileSystem | Path | Log | Interaction | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const pathService = yield* Path;
        const log = yield* Log;
        const path = pathService.resolve(cwd, "package.json");
        const document = yield* loadPackageJson(path);
        const exists = Option.isSome(document);

        const packageJson: Record<string, Schema.MutableJson> = exists
            ? document.value.raw
            : {
                  name: yield* defaultPackageName(cwd),
                  version: "0.0.0",
                  private: true,
                  type: "module",
              };

        let changed = !exists;

        if (desired.packageManager !== undefined && packageJson["packageManager"] === undefined) {
            packageJson["packageManager"] = desired.packageManager;
            changed = true;
        }

        if (desired.workspaces !== undefined) {
            changed = (yield* mergeWorkspaces(path, packageJson, desired.workspaces)) || changed;
        }

        if (desired.catalog !== undefined) {
            changed = (yield* mergeCatalog(path, packageJson, desired.catalog)) || changed;
        }

        for (const field of ["dependencies", "devDependencies", "scripts", "imports"] as const) {
            const entries = desired[field];

            if (entries === undefined) continue;
            changed =
                (yield* mergePackageJsonEntries(path, packageJson, field, entries)) || changed;
        }

        if (!changed) {
            yield* log.log("[unchanged] package.json");

            return "unchanged";
        }

        yield* savePackageJson({
            path,
            original: exists ? document.value.original : "",
            raw: packageJson,
        });
        const status: FileStatus = exists ? "updated" : "created";
        yield* log.log(`[${status}] package.json`);

        return status;
    });

export const mergeCodeRabbitPathFilters = (
    cwd: string,
    patterns: ReadonlyArray<string>,
): Effect.Effect<FileStatus, ManifestError | PlatformError, FileSystem | Path | Log> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const log = yield* Log;
        const destination = pathService.resolve(cwd, ".coderabbit.yaml");

        if (!(yield* fs.exists(destination))) {
            const content = [
                "reviews:",
                "    path_filters:",
                ...codeRabbitPathFilterItems(patterns, "        "),
            ].join("\n");

            yield* writeManagedFile(destination, `${content}\n`);
            yield* log.log("[created] .coderabbit.yaml");

            return "created";
        }

        const original = yield* fs.readFileString(destination);
        const existing = yield* parseCodeRabbitPathFiltersStrict(original);
        const missing = patterns.filter((pattern) => !existing.includes(pattern));

        if (missing.length === 0) {
            yield* log.log("[unchanged] .coderabbit.yaml");

            return "unchanged";
        }

        const merged = insertCodeRabbitPathFilters(original, missing);
        const persisted = yield* parseCodeRabbitPathFiltersStrict(merged);
        const absent = patterns.filter((pattern) => !persisted.includes(pattern));

        if (absent.length > 0) {
            return yield* new ManifestError({
                message: `.coderabbit.yaml merge failed for: ${absent.join(", ")}`,
            });
        }

        yield* fs.writeFileString(destination, merged);
        yield* log.log("[updated] .coderabbit.yaml");

        return "updated";
    });
