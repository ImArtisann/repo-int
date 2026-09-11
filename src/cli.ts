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

        yield* Effect.forEach(
            [
                [
                    Option.isSome(input.uiBase) && !selected.has("ui"),
                    "--ui-base requires the ui template.",
                ],
                [
                    Option.isSome(input.appDir) && !selected.has("tanstack"),
                    "--app-dir requires the tanstack template.",
                ],
                [input.xstate && !selected.has("config"), "--xstate requires the config template."],
            ] as const,
            ([violated, message]) =>
                Effect.fail(new UsageError({ message })).pipe(
                    Effect.when(Effect.succeed(violated)),
                ),
            { discard: true },
        );

        const invokedFrom = yield* InvocationDirectory;
        const cwd = yield* findWorkspaceRoot(invokedFrom);

        yield* log
            .log(`Found the repo-int workspace at ${cwd}`)
            .pipe(Effect.when(Effect.succeed(cwd !== invokedFrom)));
        yield* log.log(`Initializing ${cwd}`);
        yield* initializeGitRepository(cwd);
        const document = yield* loadPackageJson(pathService.join(cwd, "package.json"));
        const pkg = Option.isSome(document) ? document.value.raw : {};
        const viteConfig = pathService.join(cwd, "vite.config.ts");

        const configured = yield* fs.exists(viteConfig).pipe(
            Effect.map((exists) => exists && pkg["workspaces"] !== undefined),
            Effect.when(Effect.succeed(!selected.has("config"))),
        );

        yield* Effect.fail(
            new WorkspaceError({
                message:
                    "The config template has not been applied here; run `repo-int config` first.",
            }),
        ).pipe(Effect.when(Effect.succeed(Option.getOrElse(configured, () => true) === false)));

        const owner = selected.has("config") ? yield* resolveGitHubOwner(cwd, input.owner) : "";

        const features: ReadonlySet<TemplateFeature> = yield* hasXStateRules(cwd).pipe(
            Effect.map((installed) =>
                input.xstate || installed
                    ? new Set<TemplateFeature>(["xstate"])
                    : new Set<TemplateFeature>(),
            ),
        );

        const web = pathService.join(cwd, "apps/web");
        const staticApp = pathService.join(cwd, "apps/static");
        const webExists = yield* fs.exists(web);

        const tanstackDir = yield* resolveTanStackAppDir(cwd, input.appDir).pipe(
            Effect.when(Effect.succeed(selected.has("tanstack"))),
            Effect.map(Option.getOrElse(() => "")),
        );

        yield* Effect.forEach(
            ["ui", "assets"] as const,
            (name) =>
                Effect.gen(function* () {
                    const directory = pathService.join(cwd, "packages", name);

                    const occupied =
                        (yield* fs.exists(directory)) &&
                        (yield* readPackage(directory))["name"] !== `@repo/${name}`;

                    yield* Effect.fail(
                        new WorkspaceError({
                            message: `packages/${name} exists and is not @repo/${name}; move it before running the ${name} template.`,
                        }),
                    ).pipe(Effect.when(Effect.succeed(occupied)));
                }).pipe(Effect.when(Effect.succeed(selected.has(name)))),
            { discard: true },
        );

        const existingUi =
            (yield* readPackage(pathService.join(cwd, "packages/ui")))["name"] === "@repo/ui";

        const existingBase = existingUi
            ? yield* readUiBase(pathService.join(cwd, "packages/ui"))
            : undefined;

        yield* Effect.suspend(
            () =>
                new WorkspaceError({
                    message: `packages/ui already uses ${existingBase}. Switching to ${Option.getOrElse(input.uiBase, () => "radix")} requires migrating its components; repo-int will not overwrite them, even with --yes.`,
                }),
        ).pipe(
            Effect.when(
                Effect.succeed(
                    Option.isSome(input.uiBase) &&
                        existingBase !== undefined &&
                        input.uiBase.value !== existingBase,
                ),
            ),
        );

        const uiBase = Option.getOrElse(input.uiBase, () => existingBase ?? "radix");

        yield* checkUiAppCompatibility(cwd, uiBase).pipe(
            Effect.when(Effect.succeed(selected.has("ui") || existingUi)),
        );

        const astroDir = yield* Effect.suspend(() =>
            Effect.findFirst(
                [
                    ["web", hasDependency(web, "astro")],
                    ["static", hasDependency(staticApp, "astro")],
                    ["web", Effect.succeed(!webExists && !selected.has("tanstack"))],
                    [
                        "static",
                        fs
                            .exists(staticApp)
                            .pipe(Effect.map((exists) => tanstackDir !== "static" && !exists)),
                    ],
                ] as const,
                ([, candidate]) => candidate,
            ).pipe(
                Effect.flatMap(
                    Option.match({
                        onNone: () =>
                            Effect.fail(
                                new WorkspaceError({
                                    message: Match.value(tanstackDir).pipe(
                                        Match.when(
                                            "static",
                                            () =>
                                                "apps/static is reserved for the TanStack app; choose another --app-dir before running the astro template.",
                                        ),
                                        Match.orElse(
                                            () =>
                                                "apps/web and apps/static are both taken; move one before running the astro template.",
                                        ),
                                    ),
                                }),
                            ),
                        onSome: ([dir]) => Effect.succeed(dir),
                    }),
                ),
            ),
        ).pipe(
            Effect.when(Effect.succeed(selected.has("astro"))),
            Effect.map(Option.getOrElse(() => "")),
        );

        const versions = existingCatalog(Option.map(document, (loaded) => loaded.fields));

        // Bun's registry lookup requires a package.json even before dependencies are installed.
        yield* updatePackageJson(cwd, {}).pipe(
            Effect.when(Effect.succeed(Option.isNone(document))),
        );

        const specs = new Map(
            TEMPLATE_ORDER.filter((name) => selected.has(name)).flatMap((name) =>
                catalogSpecs(name, uiBase).map((entry) => [entry.package, entry.spec] as const),
            ),
        );

        yield* log.log(
            `Resolving ${[...specs.keys()].filter((name) => versions[name] === undefined).length} package versions...`,
        );

        yield* Effect.forEach(
            specs,
            ([name, spec]) =>
                Effect.gen(function* () {
                    const resolved = yield* Match.value(spec).pipe(
                        Match.when("effect", () => resolveEffectVersion(cwd)),
                        Match.orElse(() => resolveVersion(cwd, spec)),
                    );

                    versions[name] = catalogRange(resolved);
                }).pipe(
                    Effect.when(
                        Effect.succeed(versions[name] === undefined && spec !== "alchemy-peer"),
                    ),
                ),
            { concurrency: "unbounded", discard: true },
        );

        yield* Effect.suspend(() =>
            Option.match(Option.fromNullishOr(versions["alchemy"]), {
                onNone: () =>
                    Effect.fail(new WorkspaceError({ message: "Alchemy version is missing." })),
                onSome: (alchemy) =>
                    Effect.sync(() => {
                        versions["@alchemy.run/frontend-frameworks"] = alchemy;
                    }),
            }),
        ).pipe(
            Effect.when(
                Effect.succeed(
                    specs.has("@alchemy.run/frontend-frameworks") &&
                        versions["@alchemy.run/frontend-frameworks"] === undefined,
                ),
            ),
        );

        const repoName = yield* defaultPackageName(cwd);

        const stackName = repoName
            .split(/[^a-z0-9]+/i)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");

        const resolved: Array<ResolvedTemplate> = [];

        yield* Effect.forEach(
            TEMPLATE_ORDER,
            (name) =>
                Effect.gen(function* () {
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

                    yield* Effect.forEach(
                        template.files,
                        (file) => synchronizeManagedFile(cwd, file),
                        { discard: true },
                    );
                    yield* updatePackageJson(cwd, template.packageJson);
                    yield* mergeCodeRabbitPathFilters(cwd, template.codeRabbitPathFilters);
                }).pipe(Effect.when(Effect.succeed(selected.has(name)))),
            { discard: true },
        );

        yield* integrateWorkspacePackages(cwd, uiBase);
        const install: ReadonlyArray<string> = [process.execPath, "install"];
        yield* requireSuccess(install, yield* runner.run(install, { cwd, stdio: "inherit" }));

        yield* log
            .warn(
                "[skipped] convex codegen (run `bun run --cwd packages/backend codegen` after `convex dev` links a deployment)",
            )
            .pipe(Effect.when(Effect.succeed(selected.has("convex"))));

        yield* Effect.forEach(
            resolved,
            (template) =>
                Effect.forEach(
                    template.postInstall,
                    (step) =>
                        Effect.gen(function* () {
                            yield* log.log(step.description);

                            const result = yield* runner.run(step.command, {
                                cwd: pathService.join(cwd, step.cwd),
                                stdio: "inherit",
                            });

                            yield* Match.value(
                                template.name === "tanstack" && result.exitCode !== 0,
                            ).pipe(
                                Match.when(true, () =>
                                    log.warn(
                                        `[skipped] TanStack build failed; run \`bun run --cwd apps/${tanstackDir} dev\` to regenerate the route tree.`,
                                    ),
                                ),
                                Match.orElse(() => requireSuccess(step.command, result)),
                            );
                        }),
                    { discard: true },
                ),
            { discard: true },
        );

        const nextSteps: ReadonlyArray<readonly [TemplateName, string]> = [
            ["config", "Next: alchemy login --profile admin, then bun run deploy:github"],
            ["convex", "Next: bun run --cwd packages/backend dev:convex to link a deployment"],
            ["tanstack", `Next: bun run --cwd apps/${tanstackDir} dev`],
            ["astro", `Next: bun run --cwd apps/${astroDir} dev`],
            ["ui", "Next: bun x --bun shadcn@latest add input --cwd packages/ui"],
            [
                "assets",
                "Next: configure packages/assets/.env, generate the image manifest, then deploy and upload assets",
            ],
        ];

        yield* Effect.forEach(
            nextSteps,
            ([name, message]) =>
                log.log(message).pipe(Effect.when(Effect.succeed(selected.has(name)))),
            { discard: true },
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

                    return yield* Option.match(Cause.findErrorOption(cause), {
                        onNone: () => log.error(Cause.pretty(cause)).pipe(Effect.as(1)),
                        onSome: (error) =>
                            Match.value(error).pipe(
                                Match.when(CliError.isCliError, (cliError) =>
                                    Effect.succeed(Runtime.getErrorExitCode(cliError)),
                                ),
                                Match.orElse((failure) =>
                                    log.error(failure.message).pipe(Effect.as(1)),
                                ),
                            ),
                    });
                }),
        }),
        Effect.provide(services.pipe(Layer.provideMerge(BunServices.layer))),
    );

    return Effect.runPromise(program);
};
