import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Path } from "effect/Path";
import * as Terminal from "effect/Terminal";
import { Prompt } from "effect/unstable/cli";
import { Log } from "./log.ts";

interface InteractionInterface {
    /** Destructive confirmation; false when declined or non-interactive without --yes. */
    readonly confirm: (
        question: string,
    ) => Effect.Effect<boolean, Terminal.QuitError, FileSystem | Path | Terminal.Terminal>;
    /** Free-form question; none when no interactive input exists. */
    readonly prompt: (
        question: string,
    ) => Effect.Effect<
        Option.Option<string>,
        Terminal.QuitError,
        FileSystem | Path | Terminal.Terminal
    >;
}

/**
 * @effect-expect-leaking FileSystem | Path | Terminal
 * The interactive layer resolves these at construction; the test seam
 * (fromCallbacks) never touches them.
 */
export class Interaction extends Context.Service<Interaction, InteractionInterface>()(
    "repo-int/Interaction",
) {}

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

export const layer = (
    assumeYes: boolean,
): Layer.Layer<Interaction, never, Log | Terminal.Terminal | FileSystem | Path> =>
    Layer.effect(
        Interaction,
        Effect.gen(function* () {
            const log = yield* Log;

            return {
                confirm: (question) =>
                    assumeYes
                        ? Effect.succeed(true)
                        : interactive
                          ? Prompt.run(Prompt.Confirm({ message: question, initial: false }))
                          : log
                                .warn(
                                    `[kept] ${question} Non-interactive input; use --yes to replace it.`,
                                )
                                .pipe(Effect.as(false)),
                // A directory name is never a destructive answer, so --yes still asks.
                prompt: (question) =>
                    interactive
                        ? Prompt.run(Prompt.String({ message: question })).pipe(Effect.asSome)
                        : Effect.succeedNone,
            };
        }),
    );

/** Test seam: promise-based confirmation callback. */
export type ConfirmCallback = (question: string) => Promise<boolean>;

/** Test seam: promise-based free-form answer callback. */
export type PromptCallback = (question: string) => Promise<string>;

export interface InteractionCallbacks {
    readonly assumeYes: boolean;
    confirm?: ConfirmCallback;
    prompt?: PromptCallback;
}

export const fromCallbacks = (
    options: InteractionCallbacks,
): Layer.Layer<Interaction, never, Log> =>
    Layer.effect(
        Interaction,
        Effect.gen(function* () {
            const log = yield* Log;

            return {
                confirm: (question) =>
                    options.confirm !== undefined
                        ? Effect.promise(
                              () => options.confirm?.(question) ?? Promise.resolve(false),
                          )
                        : options.assumeYes
                          ? Effect.succeed(true)
                          : log
                                .warn(
                                    `[kept] ${question} Non-interactive input; use --yes to replace it.`,
                                )
                                .pipe(Effect.as(false)),
                prompt: (question) =>
                    options.prompt !== undefined
                        ? Effect.promise(
                              () => options.prompt?.(question) ?? Promise.resolve(""),
                          ).pipe(Effect.asSome)
                        : Effect.succeedNone,
            };
        }),
    );
