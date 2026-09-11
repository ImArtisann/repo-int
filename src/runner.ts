import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CommandFailed, CommandUnavailable } from "./errors.ts";

export interface CommandOptions {
    readonly cwd: string;
    readonly stdio: "capture" | "inherit";
}

export interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Test seam: the promise-based runner shape tests inject. */
export type CommandRunner = (
    command: ReadonlyArray<string>,
    options: CommandOptions,
) => Promise<CommandResult>;

interface RunnerInterface {
    readonly run: (
        command: ReadonlyArray<string>,
        options: CommandOptions,
    ) => Effect.Effect<CommandResult, CommandUnavailable>;
}

export class Runner extends Context.Service<Runner, RunnerInterface>()("repo-int/Runner") {}

const unavailable = (command: ReadonlyArray<string>, error: { message: string }) =>
    new CommandUnavailable({ message: `Cannot run ${command.join(" ")}: ${error.message}` });

export const layer: Layer.Layer<Runner, never, ChildProcessSpawner.ChildProcessSpawner> =
    Layer.effect(
        Runner,
        Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

            return {
                run: (command, options) =>
                    Effect.scoped(
                        Effect.gen(function* () {
                            const handle = yield* spawner.spawn(
                                ChildProcess.make(command[0] ?? "", command.slice(1), {
                                    cwd: options.cwd,
                                    stdin: options.stdio === "inherit" ? "inherit" : "ignore",
                                    stdout: options.stdio === "inherit" ? "inherit" : "pipe",
                                    stderr: options.stdio === "inherit" ? "inherit" : "pipe",
                                }),
                            );

                            const collected = yield* Effect.all(
                                {
                                    exitCode: handle.exitCode,
                                    stdout:
                                        options.stdio === "inherit"
                                            ? Effect.succeed("")
                                            : Stream.mkString(Stream.decodeText(handle.stdout)),
                                    stderr:
                                        options.stdio === "inherit"
                                            ? Effect.succeed("")
                                            : Stream.mkString(Stream.decodeText(handle.stderr)),
                                },
                                { concurrency: "unbounded" },
                            );

                            return {
                                exitCode: Number(collected.exitCode),
                                stdout: collected.stdout,
                                stderr: collected.stderr,
                            };
                        }),
                    ).pipe(Effect.mapError((error) => unavailable(command, error))),
            };
        }),
    );

export const fromFunction = (runner: CommandRunner): Layer.Layer<Runner> =>
    Layer.succeed(Runner, {
        run: (command, options) =>
            Effect.tryPromise({
                try: () => runner(command, options),
                catch: (error) =>
                    unavailable(
                        command,
                        error instanceof Error ? error : { message: String(error) },
                    ),
            }),
    });

export const requireSuccess = (
    command: ReadonlyArray<string>,
    result: CommandResult,
): Effect.Effect<CommandResult, CommandFailed> => {
    if (result.exitCode === 0) return Effect.succeed(result);
    const detail = result.stderr.trim() || result.stdout.trim();

    return Effect.fail(
        new CommandFailed({
            message: `Command failed (${result.exitCode}): ${command.join(" ")}${detail ? `\n${detail}` : ""}`,
        }),
    );
};
