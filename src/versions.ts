import * as Effect from "effect/Effect";
import { CommandFailed, CommandUnavailable, WorkspaceError } from "./errors.ts";
import { requireSuccess, Runner } from "./runner.ts";

/**
 * Mutually compatible toolchain pins; bump them together or not at all.
 */
export const TOOLCHAIN = {
    // Bundles oxlint 1.85.0, oxlint-tsgolint 7.0.2003, oxfmt 0.70.0, vitest 5.0.1.
    "vite-plus": "1.0.0",
    // Supports oxlint 1.82.0–1.86.0, oxlint-tsgolint 7.0.2001/7.0.2003, and typescript 7.0.2.
    "@effect/tsgo": "0.48.0",
    // Must equal the @oxlint/plugins version pinned inside vite-plus.
    "@oxlint/plugins": "1.79.0",
    typescript: "7.0.2",
} as const;

type VersionError = WorkspaceError | CommandFailed | CommandUnavailable;

/**
 * Resolves a `bun pm view` spec to one published version: a dist-tag such as
 * "alchemy@latest" yields the tagged version, and a semver range such as
 * "effect@^4.0.0" yields the highest matching release.
 */
export const resolveVersion = (
    cwd: string,
    spec: string,
): Effect.Effect<string, VersionError, Runner> =>
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
 * Catalog entries stay exact for prereleases (caret ranges skip them) and use a
 * caret otherwise.
 */
export const catalogRange = (version: string): string =>
    version.includes("-") ? version : `^${version}`;
