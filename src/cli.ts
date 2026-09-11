import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Runtime from "effect/Runtime";
import * as Terminal from "effect/Terminal";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { BunServices } from "@effect/platform-bun";
import packageJson from "../package.json" with { type: "json" };
import {
    defaultPackageName,
    mergeCodeRabbitPathFilters,
    synchronizeManagedFile,
    updatePackageJson,
} from "./configure.ts";
import {
    CommandFailed,
    CommandUnavailable,
    ManifestError,
    UsageError,
    WorkspaceError,
} from "./errors.ts";
import { initializeGitRepository, resolveGitHubOwner } from "./git.ts";
import {
    type ConfirmCallback,
    fromCallbacks as interactionFromCallbacks,
    Interaction,
    layer as interactionLayer,
    type PromptCallback,
} from "./interaction.ts";
import { fromLogger, layer as logLayer, Log, type Logger } from "./log.ts";
import { loadPackageJson } from "./manifest.ts";
import {
    type CommandRunner,
    fromFunction as runnerFromFunction,
    layer as runnerLayer,
    requireSuccess,
    Runner,
} from "./runner.ts";
import {
    catalogSpecs,
    type ResolvedTemplate,
    TEMPLATE_NAMES,
    TEMPLATE_ORDER,
    type TemplateFeature,
    type TemplateName,
    type UiBase,
    resolveTemplate,
} from "./templates.ts";
import { catalogRange, resolveEffectVersion, resolveVersion } from "./versions.ts";
import {
    checkUiAppCompatibility,
    existingCatalog,
    findWorkspaceRoot,
    hasDependency,
    hasXStateRules,
    integrateWorkspacePackages,
    readPackage,
    readUiBase,
    resolveTanStackAppDir,
} from "./workspace.ts";

export interface CliOptions {
    args?: readonly string[];
    confirm?: ConfirmCallback;
    cwd?: string;
    logger?: Logger;
    prompt?: PromptCallback;
    runner?: CommandRunner;
}

/** The directory the CLI was invoked from; tests override it via a layer. */
export const InvocationDirectory = Context.Reference<string>("repo-int/InvocationDirectory", {
    defaultValue: () => process.cwd(),
});

const templates = Argument.Literals("template", TEMPLATE_NAMES).pipe(
    Argument.variadic({ min: 1 }),
    Argument.withDescription(
        `Templates to apply; always applied in ${TEMPLATE_ORDER.join(" → ")} order`,
    ),
);

const owner = Flag.String("owner").pipe(
    Flag.optional,
    Flag.withDescription(
        "GitHub owner for the config template (defaults to the authenticated gh user)",
    ),
);

const uiBase = Flag.Literals("ui-base", ["radix", "base"]).pipe(
    Flag.optional,
    Flag.withDescription(
        "Shadcn primitives for the ui template (default: existing choice, or radix)",
    ),
);

const appDir = Flag.String("app-dir").pipe(
    Flag.optional,
    Flag.withDescription("Directory under apps/ for the tanstack template (default: web)"),
);

const xstate = Flag.Boolean("xstate").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Install the XState lint rules with the config template"),
);

const yes = Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDefault(false),
    Flag.withDescription("Replace every differing managed configuration without prompting"),
);

type ProgramError =
    | UsageError
    | WorkspaceError
    | ManifestError
    | PlatformError
    | Terminal.QuitError
    | CommandFailed
    | CommandUnavailable;

const program = (input: {
    readonly templates: ReadonlyArray<TemplateName>;
    readonly owner: Option.Option<string>;
    readonly uiBase: Option.Option<UiBase>;
    readonly appDir: Option.Option<string>;
    readonly xstate: boolean;
}): Effect.Effect<
    void,
    ProgramError,
    FileSystem | Path | Log | Interaction | Runner | Terminal.Terminal
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const pathService = yield* Path;
        const log = yield* Log;
        const runner = yield* Runner;
        const selected = new Set<TemplateName>(input.templates);

        if (Option.isSome(input.uiBase) && !selected.has("ui")) {
            return yield* new UsageError({
                message: "--ui-base requires the ui template.",
            });
        }

        if (Option.isSome(input.appDir) && !selected.has("tanstack")) {
            return yield* new UsageError({
                message: "--app-dir requires the tanstack template.",
            });
        }

        if (input.xstate && !selected.has("config")) {
            return yield* new UsageError({
                message: "--xstate requires the config template.",
            });
        }

        const invokedFrom = yield* InvocationDirectory;
        const cwd = yield* findWorkspaceRoot(invokedFrom);

        if (cwd !== invokedFrom) yield* log.log(`Found the repo-int workspace at ${cwd}`);
        yield* log.log(`Initializing ${cwd}`);
        yield* initializeGitRepository(cwd);
        const document = yield* loadPackageJson(pathService.join(cwd, "package.json"));
        const pkg = Option.isSome(document) ? document.value.raw : {};
        const viteConfig = pathService.join(cwd, "vite.config.ts");

        if (
            !selected.has("config") &&
            (!(yield* fs.exists(viteConfig)) || pkg["workspaces"] === undefined)
        ) {
            return yield* new WorkspaceError({
                message:
                    "The config template has not been applied here; run `repo-int config` first.",
            });
        }

        const owner = selected.has("config") ? yield* resolveGitHubOwner(cwd, input.owner) : "";

        const features: ReadonlySet<TemplateFeature> =
            input.xstate || (yield* hasXStateRules(cwd)) ? new Set(["xstate"]) : new Set();

        const web = pathService.join(cwd, "apps/web");
        const staticApp = pathService.join(cwd, "apps/static");
        const webExists = yield* fs.exists(web);

        const tanstackDir = selected.has("tanstack")
            ? yield* resolveTanStackAppDir(cwd, input.appDir)
            : "";

        for (const name of ["ui", "assets"] as const) {
            if (!selected.has(name)) continue;
            const directory = pathService.join(cwd, "packages", name);

            if (
                (yield* fs.exists(directory)) &&
                (yield* readPackage(directory))["name"] !== `@repo/${name}`
            ) {
                return yield* new WorkspaceError({
                    message: `packages/${name} exists and is not @repo/${name}; move it before running the ${name} template.`,
                });
            }
        }

        const existingUi =
            (yield* readPackage(pathService.join(cwd, "packages/ui")))["name"] === "@repo/ui";

        const existingBase = existingUi
            ? yield* readUiBase(pathService.join(cwd, "packages/ui"))
            : undefined;

        if (
            Option.isSome(input.uiBase) &&
            existingBase !== undefined &&
            input.uiBase.value !== existingBase
        ) {
            return yield* new WorkspaceError({
                message: `packages/ui already uses ${existingBase}. Switching to ${input.uiBase.value} requires migrating its components; repo-int will not overwrite them, even with --yes.`,
            });
        }

        const uiBase = Option.getOrElse(input.uiBase, () => existingBase ?? "radix");

        if (selected.has("ui") || existingUi) yield* checkUiAppCompatibility(cwd, uiBase);
        let astroDir = "";

        if (selected.has("astro")) {
            if (yield* hasDependency(web, "astro")) astroDir = "web";
            else if (yield* hasDependency(staticApp, "astro")) astroDir = "static";
            else if (!webExists && !selected.has("tanstack")) astroDir = "web";
            else if (tanstackDir !== "static" && !(yield* fs.exists(staticApp)))
                astroDir = "static";
            else
                return yield* new WorkspaceError({
                    message:
                        tanstackDir === "static"
                            ? "apps/static is reserved for the TanStack app; choose another --app-dir before running the astro template."
                            : "apps/web and apps/static are both taken; move one before running the astro template.",
                });
        }

        const versions = existingCatalog(Option.map(document, (loaded) => loaded.fields));

        // Bun's registry lookup requires a package.json even before dependencies are installed.
        if (Option.isNone(document)) {
            yield* updatePackageJson(cwd, {});
        }

        const specs = new Map(
            TEMPLATE_ORDER.filter((name) => selected.has(name)).flatMap((name) =>
                catalogSpecs(name, uiBase).map((entry) => [entry.package, entry.spec] as const),
            ),
        );

        yield* log.log(
            `Resolving ${[...specs.keys()].filter((name) => versions[name] === undefined).length} package versions...`,
        );

        for (const [name, spec] of specs) {
            if (versions[name] !== undefined || spec === "alchemy-peer") continue;
            versions[name] = catalogRange(
                spec === "effect"
                    ? yield* resolveEffectVersion(cwd)
                    : yield* resolveVersion(cwd, spec),
            );
        }

        if (
            specs.has("@alchemy.run/frontend-frameworks") &&
            versions["@alchemy.run/frontend-frameworks"] === undefined
        ) {
            const alchemy = versions["alchemy"];

            if (alchemy === undefined)
                return yield* new WorkspaceError({ message: "Alchemy version is missing." });
            versions["@alchemy.run/frontend-frameworks"] = alchemy;
        }

        const repoName = yield* defaultPackageName(cwd);

        const stackName = repoName
            .split(/[^a-z0-9]+/i)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");

        const resolved: Array<ResolvedTemplate> = [];

        for (const name of TEMPLATE_ORDER) {
            if (!selected.has(name)) continue;

            const template = yield* resolveTemplate(
                name,
                {
                    cwd,
                    repoName,
                    stackName,
                    owner,
                    uiBase,
                    appDir: Match.value(name).pipe(
                        Match.when("tanstack", () => tanstackDir),
                        Match.when("astro", () => astroDir),
                        Match.orElse(() => ""),
                    ),
                    features,
                },
                versions,
            );

            resolved.push(template);

            for (const file of template.files) yield* synchronizeManagedFile(cwd, file);
            yield* updatePackageJson(cwd, template.packageJson);
            yield* mergeCodeRabbitPathFilters(cwd, template.codeRabbitPathFilters);
        }

        yield* integrateWorkspacePackages(cwd, uiBase);
        const install: ReadonlyArray<string> = [process.execPath, "install"];
        yield* requireSuccess(install, yield* runner.run(install, { cwd, stdio: "inherit" }));

        if (selected.has("convex")) {
            yield* log.warn(
                "[skipped] convex codegen (run `bun run --cwd packages/backend codegen` after `convex dev` links a deployment)",
            );
        }

        for (const template of resolved) {
            for (const step of template.postInstall) {
                yield* log.log(step.description);

                const result = yield* runner.run(step.command, {
                    cwd: pathService.join(cwd, step.cwd),
                    stdio: "inherit",
                });

                if (template.name === "tanstack" && result.exitCode !== 0) {
                    yield* log.warn(
                        `[skipped] TanStack build failed; run \`bun run --cwd apps/${tanstackDir} dev\` to regenerate the route tree.`,
                    );
                } else yield* requireSuccess(step.command, result);
            }
        }

        if (selected.has("config"))
            yield* log.log("Next: alchemy login --profile admin, then bun run deploy:github");

        if (selected.has("convex"))
            yield* log.log("Next: bun run --cwd packages/backend dev:convex to link a deployment");

        if (selected.has("tanstack")) yield* log.log(`Next: bun run --cwd apps/${tanstackDir} dev`);

        if (selected.has("astro")) yield* log.log(`Next: bun run --cwd apps/${astroDir} dev`);

        if (selected.has("ui"))
            yield* log.log("Next: bun x --bun shadcn@latest add input --cwd packages/ui");

        if (selected.has("assets"))
            yield* log.log(
                "Next: configure packages/assets/.env, generate the image manifest, then deploy and upload assets",
            );
        yield* log.log("Repository initialization complete.");
    });

const makeCommand = (
    interaction: (
        assumeYes: boolean,
    ) => Layer.Layer<Interaction, never, Log | Terminal.Terminal | FileSystem | Path>,
) =>
    Command.make("repo-int", { templates, owner, uiBase, appDir, xstate, yes }, (input) =>
        program(input),
    ).pipe(
        Command.withDescription(packageJson.description),
        Command.provide((input) => interaction(input.yes)),
    );

export const runCli = (options: CliOptions = {}): Promise<number> => {
    const providedLogLayer = options.logger !== undefined ? fromLogger(options.logger) : logLayer;

    const interaction =
        options.confirm !== undefined || options.prompt !== undefined
            ? (assumeYes: boolean) =>
                  interactionFromCallbacks({
                      assumeYes,
                      confirm: options.confirm,
                      prompt: options.prompt,
                  }).pipe(Layer.provide(providedLogLayer))
            : interactionLayer;

    const services = Layer.mergeAll(
        providedLogLayer,
        options.runner !== undefined ? runnerFromFunction(options.runner) : runnerLayer,
        Layer.succeed(InvocationDirectory, options.cwd ?? process.cwd()),
    );

    const program = Command.runWith(makeCommand(interaction), {
        version: packageJson.version,
    })(options.args ?? []).pipe(
        Effect.matchCauseEffect({
            onSuccess: () => Effect.succeed(0),
            onFailure: (cause) =>
                Effect.gen(function* () {
                    const log = yield* Log;
                    const error = Cause.findErrorOption(cause);

                    if (Option.isNone(error)) {
                        yield* log.error(Cause.pretty(cause));

                        return 1;
                    }

                    if (CliError.isCliError(error.value))
                        return Runtime.getErrorExitCode(error.value);
                    yield* log.error(error.value.message);

                    return 1;
                }),
        }),
        Effect.provide(services),
        Effect.provide(BunServices.layer),
    );

    return Effect.runPromise(program);
};
