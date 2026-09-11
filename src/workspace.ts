import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import { defaultPackageName, synchronizeManagedFile, updatePackageJson } from "./configure.ts";
import { ManifestError, WorkspaceError } from "./errors.ts";
import { Interaction } from "./interaction.ts";
import { Log } from "./log.ts";
import { loadPackageJson, type PackageJson, readComponentsStyle } from "./manifest.ts";
import { resolvePackageIntegration, type UiBase } from "./templates.ts";

/**
 * Walks up from the invocation directory so `repo-int convex` inside apps/web
 * configures the workspace instead of nesting a second one. A directory counts
 * as the workspace root when it has a vite.config.ts and a package.json with a
 * `workspaces` field. The search never leaves the enclosing Git repository, and
 * an unconfigured tree keeps its own directory as the root. A malformed
 * package.json is not a root here; the invocation directory is revalidated
 * later with its original error.
 */
export const findWorkspaceRoot = (
    cwd: string,
): Effect.Effect<string, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const original = pathService.resolve(cwd);
        let directory = original;

        while (true) {
            if (yield* fs.exists(pathService.join(directory, "vite.config.ts"))) {
                const document = yield* loadPackageJson(
                    pathService.join(directory, "package.json"),
                ).pipe(
                    Effect.catchTag("repo-int/ManifestError", () => Effect.succeed(Option.none())),
                );

                if (Option.isSome(document) && document.value.raw["workspaces"] !== undefined)
                    return directory;
            }

            const parent = pathService.dirname(directory);

            if (parent === directory || (yield* fs.exists(pathService.join(directory, ".git"))))
                return original;
            directory = parent;
        }
    });

/** True when a previous `--xstate` run installed the XState lint rules. */
export const hasXStateRules = (
    cwd: string,
): Effect.Effect<boolean, PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;

        return yield* fs.exists(pathService.join(cwd, "tools/oxlint/xstate/index.ts"));
    });

export const readPackage = (
    cwd: string,
): Effect.Effect<
    Record<string, Schema.MutableJson>,
    ManifestError | PlatformError,
    FileSystem | Path
> =>
    Effect.gen(function* () {
        const pathService = yield* Path;
        const document = yield* loadPackageJson(pathService.join(cwd, "package.json"));

        return Option.isSome(document) ? document.value.raw : {};
    });

export const hasDependency = (
    cwd: string,
    name: string,
): Effect.Effect<boolean, ManifestError | PlatformError, FileSystem | Path> =>
    Effect.map(readPackage(cwd), (pkg) => {
        const dependencies = pkg["dependencies"];

        return (
            Predicate.isObject(dependencies) &&
            !Array.isArray(dependencies) &&
            Object.hasOwn(dependencies, name)
        );
    });

/** Rejects traversal, absolute paths, and anything that is not one plain segment. */
export const appDirIssue = (value: string): string | undefined => {
    if (value === "") return "an application directory name is required.";

    if (value.length > 64) return `"${value}" is longer than 64 characters.`;

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
        return `"${value}" must be a single directory name under apps/ using letters, digits, ".", "_", or "-".`;

    return undefined;
};

/** True when apps/<name> is free or already holds a TanStack Start app. */
export const isTanStackAppDir = (
    cwd: string,
    name: string,
): Effect.Effect<boolean, ManifestError | PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const directory = pathService.join(cwd, "apps", name);

        if (!(yield* fs.exists(directory))) return true;

        return yield* hasDependency(directory, "@tanstack/react-start");
    });

/**
 * apps/web is the default; when something else already owns it the caller must
 * name another directory. Neither --yes nor a plain rerun ever overwrites the
 * occupant.
 */
export const resolveTanStackAppDir = (
    cwd: string,
    flag: Option.Option<string>,
): Effect.Effect<
    string,
    WorkspaceError | ManifestError | PlatformError,
    FileSystem | Path | Log | Interaction | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const log = yield* Log;
        const interaction = yield* Interaction;

        if (Option.isSome(flag)) {
            const issue = appDirIssue(flag.value);

            if (issue !== undefined)
                return yield* new WorkspaceError({ message: `--app-dir ${issue}` });

            if (!(yield* isTanStackAppDir(cwd, flag.value)))
                return yield* new WorkspaceError({
                    message: `apps/${flag.value} exists and is not a TanStack Start app; pass --app-dir with a free directory name.`,
                });

            return flag.value;
        }

        if (yield* isTanStackAppDir(cwd, "web")) return "web";

        while (true) {
            const answer = yield* interaction
                .prompt(
                    "apps/web is taken. Directory name for the TanStack app under apps/ (empty to cancel):",
                )
                .pipe(Effect.catchTag("QuitError", () => Effect.succeed(Option.none<string>())));

            if (Option.isNone(answer))
                return yield* new WorkspaceError({
                    message:
                        "apps/web exists and is not a TanStack Start app; pass --app-dir <name> to scaffold the app in another directory under apps/.",
                });
            const name = answer.value.trim();

            if (name === "")
                return yield* new WorkspaceError({
                    message:
                        "No TanStack application directory was chosen; rerun with --app-dir <name> to scaffold the app under apps/.",
                });
            const issue = appDirIssue(name);

            if (issue !== undefined) {
                yield* log.warn(`[rejected] ${issue}`);
                continue;
            }

            if (!(yield* isTanStackAppDir(cwd, name))) {
                yield* log.warn(`[rejected] apps/${name} exists and is not a TanStack Start app.`);
                continue;
            }

            return name;
        }
    });

export const readUiBase = (
    directory: string,
): Effect.Effect<UiBase | undefined, ManifestError | PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const file = pathService.join(directory, "components.json");

        if (!(yield* fs.exists(file))) return undefined;

        const style = yield* readComponentsStyle(directory);

        if (Option.isSome(style)) {
            if (style.value.startsWith("base-")) return "base";

            if (
                style.value.startsWith("radix-") ||
                style.value === "new-york" ||
                style.value === "default"
            )
                return "radix";
        }

        return yield* new ManifestError({
            message: `Cannot determine the shadcn base from ${file}.`,
        });
    });

export const checkUiAppCompatibility = (
    cwd: string,
    uiBase: UiBase,
): Effect.Effect<void, WorkspaceError | ManifestError | PlatformError, FileSystem | Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const appsRoot = pathService.join(cwd, "apps");

        if (!(yield* fs.exists(appsRoot))) return;

        for (const app of yield* fs.readDirectory(appsRoot)) {
            const directory = pathService.join(appsRoot, app);
            const info = yield* fs.stat(directory);

            if (info.type !== "Directory") continue;

            if (!(yield* hasDependency(directory, "@tanstack/react-start"))) continue;
            const appBase = yield* readUiBase(directory);

            if (appBase !== undefined && appBase !== uiBase) {
                return yield* new WorkspaceError({
                    message: `apps/${app}/components.json uses ${appBase}, but the shared UI uses ${uiBase}. Migrate the app's shadcn configuration and components before continuing.`,
                });
            }
        }
    });

export const integrateWorkspacePackages = (
    cwd: string,
    uiBase: UiBase,
): Effect.Effect<
    void,
    WorkspaceError | ManifestError | PlatformError | Terminal.QuitError,
    FileSystem | Path | Log | Interaction | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const log = yield* Log;

        const ui =
            (yield* readPackage(pathService.join(cwd, "packages/ui")))["name"] === "@repo/ui";

        const assets =
            (yield* readPackage(pathService.join(cwd, "packages/assets")))["name"] ===
            "@repo/assets";

        const appsRoot = pathService.join(cwd, "apps");

        if ((!ui && !assets) || !(yield* fs.exists(appsRoot))) return;

        const apps = (yield* fs.readDirectory(appsRoot)).toSorted((left, right) =>
            left.localeCompare(right),
        );

        for (const app of apps) {
            const appRoot = pathService.join(appsRoot, app);
            const info = yield* fs.stat(appRoot);

            if (info.type !== "Directory") continue;
            const pkg = yield* readPackage(appRoot);
            const dependencies = pkg["dependencies"];

            if (!Predicate.isObject(dependencies) || Array.isArray(dependencies)) continue;

            const framework = Object.hasOwn(dependencies, "@tanstack/react-start")
                ? ("tanstack" as const)
                : Object.hasOwn(dependencies, "astro")
                  ? ("astro" as const)
                  : undefined;

            if (framework === undefined) continue;
            const desired: Record<string, string> = {};
            const packages: Array<"ui" | "assets"> = [];

            if (ui && framework === "tanstack") {
                packages.push("ui");
                desired["@repo/ui"] = "workspace:*";
            }

            if (assets) {
                packages.push("assets");
                desired["@repo/assets"] = "workspace:*";
                desired[framework === "tanstack" ? "@unpic/react" : "@unpic/astro"] = "catalog:";
            }

            if (packages.length === 0) continue;

            for (const name of packages) {
                const files = yield* resolvePackageIntegration(name, framework, {
                    cwd,
                    appDir: app,
                    repoName: yield* defaultPackageName(cwd),
                    stackName: "",
                    owner: "",
                    uiBase,
                    features: new Set(),
                });

                for (const file of files) yield* synchronizeManagedFile(cwd, file);
            }

            yield* updatePackageJson(
                appRoot,
                ui && framework === "tanstack"
                    ? {
                          dependencies: desired,
                          imports: {
                              "#components/*": "./src/components/*.tsx",
                              "#lib/*": "./src/lib/*.ts",
                          },
                      }
                    : { dependencies: desired },
            );

            if (ui && framework === "tanstack") {
                const stylesheet = pathService.join(appRoot, "src/styles.css");

                const content = (yield* fs.exists(stylesheet))
                    ? yield* fs.readFileString(stylesheet)
                    : "";

                const importRule = '@import "@repo/ui/styles/globals.css";';

                if (!/@import\s+["']@repo\/ui\/styles\/globals\.css["']/.test(content)) {
                    const localStyles = content.replace(
                        /^@import\s+["']tailwindcss["'];\r?\n?/gm,
                        "",
                    );

                    yield* fs.writeFileString(stylesheet, `${importRule}\n${localStyles}`);
                    yield* log.log(`[updated] apps/${app}/src/styles.css (shared UI import)`);
                }
            }
        }
    });

/**
 * The catalog already present in the workspace package.json. When `workspaces`
 * is an object its `catalog` wins over a top-level one, matching the merge
 * target updatePackageJson writes into.
 */
export const existingCatalog = (pkg: Option.Option<PackageJson>) => {
    if (Option.isNone(pkg)) return {};
    const fields = pkg.value;
    const workspaces = fields.workspaces;

    const catalog =
        Predicate.isObject(workspaces) && !Array.isArray(workspaces)
            ? (workspaces.catalog ?? fields.catalog)
            : fields.catalog;

    return { ...catalog };
};
