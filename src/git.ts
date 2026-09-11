import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { CommandUnavailable, WorkspaceError } from "./errors.ts";
import { Log } from "./log.ts";
import { Runner } from "./runner.ts";

export const initializeGitRepository = (
    cwd: string,
): Effect.Effect<void, WorkspaceError | CommandUnavailable, Runner | Log> =>
    Effect.gen(function* () {
        const runner = yield* Runner;
        const log = yield* Log;

        const probe = yield* runner.run(["git", "rev-parse", "--is-inside-work-tree"], {
            cwd,
            stdio: "capture",
        });

        yield* Match.value(probe.exitCode === 0 && probe.stdout.trim() === "true").pipe(
            Match.when(true, () => log.log("[unchanged] Git repository")),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const command: ReadonlyArray<string> = ["git", "init", "-b", "main"];

                    const initialized = yield* runner.run(command, {
                        cwd,
                        stdio: "inherit",
                    });

                    yield* Effect.fail(
                        new WorkspaceError({
                            message: `Unable to initialize Git repository (exit ${initialized.exitCode}).`,
                        }),
                    ).pipe(Effect.when(Effect.succeed(initialized.exitCode !== 0)));

                    yield* log.log("[created] Git repository with main as the initial branch");
                }),
            ),
        );
    });

export const resolveGitHubOwner = (
    cwd: string,
    flag: Option.Option<string>,
): Effect.Effect<string, WorkspaceError, Runner> =>
    Option.match(flag, {
        onSome: (value) =>
            Match.value(/^[A-Za-z0-9-]+$/.test(value)).pipe(
                Match.when(true, () => Effect.succeed(value)),
                Match.orElse(() =>
                    Effect.fail(new WorkspaceError({ message: `Invalid --owner "${value}"` })),
                ),
            ),
        onNone: () =>
            Effect.gen(function* () {
                const message =
                    "Cannot determine the GitHub owner: pass --owner <login> or authenticate gh.";

                const runner = yield* Runner;

                const result = yield* runner
                    .run(["gh", "api", "user", "--jq", ".login"], {
                        cwd,
                        stdio: "capture",
                    })
                    .pipe(
                        Effect.catchTag("repo-int/CommandUnavailable", () =>
                            Effect.fail(new WorkspaceError({ message })),
                        ),
                    );

                const login = result.stdout.trim();

                return yield* Match.value(
                    result.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(login),
                ).pipe(
                    Match.when(true, () => Effect.succeed(login)),
                    Match.orElse(() => Effect.fail(new WorkspaceError({ message }))),
                );
            }),
    });
