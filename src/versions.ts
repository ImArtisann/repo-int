import * as Effect from "effect/Effect";
import { CommandFailed, CommandUnavailable, WorkspaceError } from "./errors.ts";
import { requireSuccess, Runner } from "./runner.ts";

/**
 * Mutually compatible toolchain pins; bump them together or not at all.
 */
export const TOOLCHAIN = {
    // Bundles oxlint 1.79.0, oxlint-tsgolint 7.0.2001, oxfmt 0.64.0, vitest 4.1.11.
    "vite-plus": "0.3.0",
    // Supports oxlint 1.79.0/1.81.0, tsgolint 7.0.2001, and typescript 7.0.2.
    "@effect/tsgo": "0.41.0",
    // Must equal the @oxlint/plugins version pinned inside vite-plus.
    "@oxlint/plugins": "1.79.0",
    typescript: "7.0.2",
} as const;

/** Peer range alchemy 2.0.0-beta declares for effect. */
export const EFFECT_MINIMUM = ">=4.0.0-rc.112";

type VersionError = WorkspaceError | CommandFailed | CommandUnavailable;

const viewVersion = (cwd: string, spec: string): Effect.Effect<string, VersionError, Runner> =>
    Effect.gen(function* () {
        const runner = yield* Runner;
        const command: ReadonlyArray<string> = [process.execPath, "pm", "view", spec, "version"];
        const result = yield* runner.run(command, { cwd, stdio: "capture" });
        yield* requireSuccess(command, result);
        const version = result.stdout.trim();

        yield* Effect.fail(
            new WorkspaceError({
                message: `bun pm view ${spec} version returned no version.`,
            }),
        ).pipe(Effect.when(Effect.succeed(version === "")));

        return version;
    });

/**
 * Resolves a dist-tag spec such as "alchemy@latest" to its published version.
 * A failed or empty `@next` lookup retries `@latest` for that package only, so
 * `@confect/*` packages keep resolving after their next tag disappears.
 */
export const resolveVersion = (
    cwd: string,
    spec: string,
): Effect.Effect<string, VersionError, Runner> =>
    viewVersion(cwd, spec).pipe(
        Effect.catch((error) =>
            spec.endsWith("@next")
                ? viewVersion(cwd, `${spec.slice(0, -"@next".length)}@latest`)
                : Effect.fail(error),
        ),
    );

/**
 * Resolves the effect version satisfying {@link EFFECT_MINIMUM}: latest once it
 * reaches the 4.x line, otherwise the rc tag alchemy and @confect/* peer on.
 */
export const resolveEffectVersion = (cwd: string): Effect.Effect<string, VersionError, Runner> =>
    resolveVersion(cwd, "effect@latest").pipe(
        Effect.filterOrElse(
            (latest) => Bun.semver.satisfies(latest, EFFECT_MINIMUM),
            () => resolveVersion(cwd, "effect@rc"),
        ),
    );

/**
 * Catalog entries stay exact for prereleases (caret ranges skip them) and use a
 * caret otherwise.
 */
export const catalogRange = (version: string): string =>
    version.includes("-") ? version : `^${version}`;
