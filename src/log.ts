import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface LogInterface {
    readonly log: (message: string) => Effect.Effect<void>;
    readonly warn: (message: string) => Effect.Effect<void>;
    readonly error: (message: string) => Effect.Effect<void>;
}

export class Log extends Context.Service<Log, LogInterface>()("repo-int/Log") {}

export const layer = Layer.succeed(Log, {
    log: (message) => Console.log(message),
    warn: (message) => Console.warn(message),
    error: (message) => Console.error(message),
});

/** Test seam: the synchronous logger shape tests inject. */
export interface Logger {
    error(message: string): void;
    log(message: string): void;
    warn(message: string): void;
}

export const fromLogger = (logger: Logger): Layer.Layer<Log> =>
    Layer.succeed(Log, {
        log: (message) => Effect.sync(() => logger.log(message)),
        warn: (message) => Effect.sync(() => logger.warn(message)),
        error: (message) => Effect.sync(() => logger.error(message)),
    });
