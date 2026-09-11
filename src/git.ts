import * as Effect from "effect/Effect";
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

        if (probe.exitCode === 0 && probe.stdout.trim() === "true") {
            yield* log.log("[unchanged] Git repository");

            return;
        }

        const command: ReadonlyArray<string> = ["git", "init", "-b", "main"];
        const initialized = yield* runner.run(command, { cwd, stdio: "inherit" });

        if (initialized.exitCode !== 0) {
            return yield* new WorkspaceError({
                message: `Unable to initialize Git repository (exit ${initialized.exitCode}).`,
            });
        }

        yield* log.log("[created] Git repository with main as the initial branch");
    });

export const resolveGitHubOwner = (
    cwd: string,
    flag: Option.Option<string>,
): Effect.Effect<string, WorkspaceError, Runner> =>
    Effect.gen(function* () {
        if (Option.isSome(flag)) {
            if (!/^[A-Za-z0-9-]+$/.test(flag.value)) {
                return yield* new WorkspaceError({
                    message: `Invalid --owner "${flag.value}"`,
                });
            }

            return flag.value;
        }

        const message =
            "Cannot determine the GitHub owner: pass --owner <login> or authenticate gh.";

        const runner = yield* Runner;

        const result = yield* runner
            .run(["gh", "api", "user", "--jq", ".login"], { cwd, stdio: "capture" })
            .pipe(
                Effect.catchTag("repo-int/CommandUnavailable", () =>
                    Effect.fail(
                        new WorkspaceError({
                            message,
                        }),
                    ),
                ),
            );

        if (result.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(result.stdout.trim())) {
            return result.stdout.trim();
        }

        return yield* new WorkspaceError({ message });
    });
