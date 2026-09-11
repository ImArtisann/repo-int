import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Match from "effect/Match";
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

    const firstTopLevel = lines.findIndex(
        (line, index) => index > reviewsIndex && /^\S/.test(line),
    );

    if (firstTopLevel !== -1) blockEnd = firstTopLevel;

    const pathFiltersIndex = lines.findIndex(
        (line, index) =>
            index > reviewsIndex && index < blockEnd && /^(\s*)path_filters:\s*$/.test(line),
    );

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

    const firstNonItem = lines.findIndex(
        (line, index) => index > pathFiltersIndex && index < blockEnd && !/^\s*- /.test(line),
    );

    const insertAt = firstNonItem === -1 ? blockEnd : firstNonItem;

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

        // Existing path filters are unioned into the template so re-running the config
        // template never resets filters appended by other templates.
        const desired = yield* Effect.gen(function* () {
            const templateFilters = yield* parseCodeRabbitPathFilters(template.content);
            const existingFilters = yield* parseCodeRabbitPathFilters(existing);
            const extras = existingFilters.filter((pattern) => !templateFilters.includes(pattern));

            return extras.length === 0
                ? template.content
                : insertCodeRabbitPathFilters(template.content, extras);
        }).pipe(
            Effect.when(Effect.succeed(existing !== template.content)),
            Effect.map(Option.getOrElse(() => template.content)),
        );

        return yield* Match.value(existing === desired).pipe(
            Match.when(true, () =>
                log
                    .log(`[unchanged] ${template.destination}`)
                    .pipe(Effect.as("unchanged" as const)),
            ),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const accepted = yield* interaction.confirm(
                        `${template.destination} differs from the repo-int template. Overwrite it?`,
                    );

                    return yield* Match.value(accepted).pipe(
                        Match.when(false, () =>
                            log
                                .warn(`[kept] ${template.destination}`)
                                .pipe(Effect.as("skipped" as const)),
                        ),
                        Match.orElse(() =>
                            Effect.gen(function* () {
                                yield* writeManagedFile(destination, desired);
                                yield* log.log(`[updated] ${template.destination}`);

                                return "updated" as const;
                            }),
                        ),
                    );
                }),
            ),
        );
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

        return yield* Match.value({
            mergeIgnore: template.mergeIgnorePatterns === true && destinationExists,
            mergeFilters: template.mergePathFilters === true && destinationExists,
            missing: !destinationExists,
            createOnly: template.createOnly === true,
        }).pipe(
            Match.when({ mergeIgnore: true }, () => mergeGitignorePatterns(destination, template)),
            Match.when({ mergeFilters: true }, () =>
                mergePathFiltersIntoTemplate(destination, template),
            ),
            Match.when({ missing: true }, () =>
                Effect.gen(function* () {
                    yield* writeManagedFile(destination, template.content);
                    yield* log.log(`[created] ${template.destination}`);

                    return "created" as const;
                }),
            ),
            Match.when({ createOnly: true }, () =>
                log
                    .log(`[unchanged] ${template.destination}`)
                    .pipe(Effect.as("unchanged" as const)),
            ),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const existing = yield* fs.readFileString(destination);

                    return yield* Match.value(existing === template.content).pipe(
                        Match.when(true, () =>
                            log
                                .log(`[unchanged] ${template.destination}`)
                                .pipe(Effect.as("unchanged" as const)),
                        ),
                        Match.orElse(() =>
                            Effect.gen(function* () {
                                const accepted = yield* interaction.confirm(
                                    `${template.destination} differs from the repo-int template. Overwrite it?`,
                                );

                                return yield* Match.value(accepted).pipe(
                                    Match.when(false, () =>
                                        log
                                            .warn(`[kept] ${template.destination}`)
                                            .pipe(Effect.as("skipped" as const)),
                                    ),
                                    Match.orElse(() =>
                                        Effect.gen(function* () {
                                            yield* writeManagedFile(destination, template.content);
                                            yield* log.log(`[updated] ${template.destination}`);

                                            return "updated" as const;
                                        }),
                                    ),
                                );
                            }),
                        ),
                    );
                }),
            ),
        );
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
): Effect.Effect<Array<string>, ManifestError> =>
    Match.value(workspaces).pipe(
        Match.when(Array.isArray, (entries) =>
            entries.every(Predicate.isString)
                ? Effect.succeed(entries)
                : Effect.fail(invalidField(path, 'has a non-string "workspaces" entry.')),
        ),
        Match.when(isMutableJsonObject, (object) => {
            // Object form; every member is validated before use and other keys are preserved.
            const packages = object["packages"];

            return Match.value(packages).pipe(
                Match.when(undefined, () =>
                    Effect.sync(() => {
                        const created: Array<string> = [];
                        object["packages"] = created;

                        return created;
                    }),
                ),
                Match.when(Array.isArray, (entries) =>
                    entries.every(Predicate.isString)
                        ? Effect.succeed(entries)
                        : Effect.fail(
                              invalidField(path, 'has a non-string "workspaces.packages" entry.'),
                          ),
                ),
                Match.orElse(() =>
                    Effect.fail(invalidField(path, 'has a non-array "workspaces.packages" field.')),
                ),
            );
        }),
        Match.orElse(() => Effect.fail(invalidField(path, 'has an invalid "workspaces" field.'))),
    );

const mergeWorkspaces = (
    path: string,
    packageJson: Record<string, Schema.MutableJson>,
    desired: ReadonlyArray<string>,
): Effect.Effect<boolean, ManifestError> => {
    const value = packageJson["workspaces"];

    return Option.match(Option.fromNullishOr(value), {
        onNone: () =>
            Effect.sync(() => {
                if (desired.length === 0) return false;
                packageJson["workspaces"] = [...desired];

                return true;
            }),
        onSome: (workspaces) =>
            Effect.map(workspacesPackages(path, workspaces), (packages) => {
                const missing = desired.filter((glob) => !packages.includes(glob));

                if (missing.length === 0) return false;
                packages.push(...missing);

                return true;
            }),
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

    return Match.value(existing).pipe(
        Match.when(undefined, () =>
            Effect.sync(() => {
                target["catalog"] = Object.fromEntries(entries);

                return true;
            }),
        ),
        Match.when(isMutableJsonObject, (catalog) =>
            Effect.sync(() => {
                const missing = entries.filter(([name]) => catalog[name] === undefined);

                for (const [name, version] of missing) catalog[name] = version;

                return missing.length > 0;
            }),
        ),
        Match.orElse(() => Effect.fail(invalidField(path, 'has a non-object "catalog" field.'))),
    );
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

        return yield* Match.value(value).pipe(
            Match.when(undefined, () =>
                Effect.sync(() => {
                    if (Object.keys(desired).length === 0) return false;
                    packageJson[field] = { ...desired };

                    return true;
                }),
            ),
            Match.when(isMutableJsonObject, (object) =>
                Effect.gen(function* () {
                    const label = PACKAGE_JSON_ENTRY_LABELS[field];

                    const changes = yield* Effect.forEach(
                        Object.entries(desired),
                        ([name, version]) =>
                            Match.value(object[name]).pipe(
                                Match.when(undefined, () =>
                                    Effect.sync(() => {
                                        object[name] = version;

                                        return true;
                                    }),
                                ),
                                Match.when(version, () => Effect.succeed(false)),
                                Match.orElse((existing) =>
                                    Effect.gen(function* () {
                                        const accepted = yield* interaction.confirm(
                                            `package.json ${label} "${name}" differs from repo-int. Change it from ${jsonString(existing)} to ${jsonString(version)}?`,
                                        );

                                        return yield* Match.value(accepted).pipe(
                                            Match.when(true, () =>
                                                Effect.sync(() => {
                                                    object[name] = version;

                                                    return true;
                                                }),
                                            ),
                                            Match.orElse(() =>
                                                log
                                                    .warn(`[kept] package.json ${label} "${name}"`)
                                                    .pipe(Effect.as(false)),
                                            ),
                                        );
                                    }),
                                ),
                            ),
                    );

                    return changes.some(Boolean);
                }),
            ),
            Match.orElse(() =>
                Effect.fail(invalidField(path, `has a non-object "${field}" field.`)),
            ),
        );
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

        const packageManagerChanged = yield* Option.match(
            Option.fromNullishOr(desired.packageManager),
            {
                onNone: () => Effect.succeed(false),
                onSome: (packageManager) =>
                    Effect.sync(() => {
                        if (packageJson["packageManager"] !== undefined) return false;
                        packageJson["packageManager"] = packageManager;

                        return true;
                    }),
            },
        );

        const workspacesChanged = yield* Option.match(Option.fromNullishOr(desired.workspaces), {
            onNone: () => Effect.succeed(false),
            onSome: (workspaces) => mergeWorkspaces(path, packageJson, workspaces),
        });

        const catalogChanged = yield* Option.match(Option.fromNullishOr(desired.catalog), {
            onNone: () => Effect.succeed(false),
            onSome: (catalog) => mergeCatalog(path, packageJson, catalog),
        });

        const entryChanges = yield* Effect.forEach(
            ["dependencies", "devDependencies", "scripts", "imports"] as const,
            (field) =>
                Option.match(Option.fromNullishOr(desired[field]), {
                    onNone: () => Effect.succeed(false),
                    onSome: (entries) => mergePackageJsonEntries(path, packageJson, field, entries),
                }),
        );

        const changed =
            !exists ||
            packageManagerChanged ||
            workspacesChanged ||
            catalogChanged ||
            entryChanges.some(Boolean);

        return yield* Match.value(changed).pipe(
            Match.when(false, () =>
                log.log("[unchanged] package.json").pipe(Effect.as("unchanged" as const)),
            ),
            Match.orElse(() =>
                Effect.gen(function* () {
                    yield* savePackageJson({
                        path,
                        original: exists ? document.value.original : "",
                        raw: packageJson,
                    });
                    const status: FileStatus = exists ? "updated" : "created";
                    yield* log.log(`[${status}] package.json`);

                    return status;
                }),
            ),
        );
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

        return yield* Match.value(yield* fs.exists(destination)).pipe(
            Match.when(false, () =>
                Effect.gen(function* () {
                    const content = [
                        "reviews:",
                        "    path_filters:",
                        ...codeRabbitPathFilterItems(patterns, "        "),
                    ].join("\n");

                    yield* writeManagedFile(destination, `${content}\n`);
                    yield* log.log("[created] .coderabbit.yaml");

                    return "created" as const;
                }),
            ),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const original = yield* fs.readFileString(destination);
                    const existing = yield* parseCodeRabbitPathFiltersStrict(original);
                    const missing = patterns.filter((pattern) => !existing.includes(pattern));

                    return yield* Match.value(missing.length === 0).pipe(
                        Match.when(true, () =>
                            log
                                .log("[unchanged] .coderabbit.yaml")
                                .pipe(Effect.as("unchanged" as const)),
                        ),
                        Match.orElse(() =>
                            Effect.gen(function* () {
                                const merged = insertCodeRabbitPathFilters(original, missing);
                                const persisted = yield* parseCodeRabbitPathFiltersStrict(merged);

                                const absent = patterns.filter(
                                    (pattern) => !persisted.includes(pattern),
                                );

                                yield* Effect.fail(
                                    new ManifestError({
                                        message: `.coderabbit.yaml merge failed for: ${absent.join(", ")}`,
                                    }),
                                ).pipe(Effect.when(Effect.succeed(absent.length > 0)));

                                yield* fs.writeFileString(destination, merged);
                                yield* log.log("[updated] .coderabbit.yaml");

                                return "updated" as const;
                            }),
                        ),
                    );
                }),
            ),
        );
    });
