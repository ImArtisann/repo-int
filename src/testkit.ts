import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
    fromCallbacks,
    type ConfirmCallback,
    type InteractionCallbacks,
    type PromptCallback,
} from "./interaction.ts";
import { fromLogger, type Logger } from "./log.ts";
import { fromFunction, type CommandRunner } from "./runner.ts";

export const silentLogger: Logger = { error() {}, log() {}, warn() {} };

export interface TestServices {
    readonly logger?: Logger;
    readonly runner?: CommandRunner;
    readonly confirm?: ConfirmCallback;
    readonly prompt?: PromptCallback;
}

/**
 * Runs an effect against the real filesystem with injectable log, runner, and
 * interaction callbacks — the same seams runCli exposes.
 */
export const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    services: TestServices = {},
): Promise<A> => {
    const logLayer = fromLogger(services.logger ?? silentLogger);

    const interactionCallbacks: InteractionCallbacks = { assumeYes: false };

    if (services.confirm !== undefined) interactionCallbacks.confirm = services.confirm;

    if (services.prompt !== undefined) interactionCallbacks.prompt = services.prompt;
    const interactionLayer = fromCallbacks(interactionCallbacks).pipe(Layer.provide(logLayer));

    const layers = Layer.mergeAll(
        logLayer,
        interactionLayer,
        ...(services.runner !== undefined ? [fromFunction(services.runner)] : []),
    ).pipe(Layer.provideMerge(BunServices.layer));

    // SAFETY: the merged layer provides every service the CLI modules require; the
    // residual R is erased because test callers only pass effects built on them.
    return Effect.runPromise(
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- test seam: the merged layer covers every service CLI modules require
        Effect.provide(effect, layers) as Effect.Effect<A, E>,
    );
};
