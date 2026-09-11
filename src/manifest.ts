import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ManifestError } from "./errors.ts";

export const StringRecord = Schema.Record(Schema.String, Schema.String);

export const JsonRecord = Schema.Record(Schema.String, Schema.mutableKey(Schema.MutableJson));

export const WorkspacesObject = Schema.Struct({
    packages: Schema.optionalKey(Schema.Array(Schema.String)),
    catalog: Schema.optionalKey(StringRecord),
});

export const PackageJson = Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    packageManager: Schema.optionalKey(Schema.String),
    workspaces: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), WorkspacesObject])),
    catalog: Schema.optionalKey(StringRecord),
    dependencies: Schema.optionalKey(StringRecord),
    devDependencies: Schema.optionalKey(StringRecord),
    scripts: Schema.optionalKey(StringRecord),
    imports: Schema.optionalKey(JsonRecord),
});

export interface PackageJson extends Schema.Struct.Type<typeof PackageJson.fields> {}

/**
 * A loaded package.json: `raw` is the order-preserving mutable JSON object
 * merges write into (existing keys keep their position, new keys append);
 * `fields` is the typed validated view decoded from it.
 */
export interface PackageJsonDocument {
    readonly path: string;
    readonly original: string;
    readonly raw: Record<string, Schema.MutableJson>;
    readonly fields: PackageJson;
}

const manifestError = (path: string, error: { message: string }) =>
    new ManifestError({ message: `Cannot parse ${path}: ${error.message}` });

export const loadPackageJson = (
    path: string,
): Effect.Effect<Option.Option<PackageJsonDocument>, ManifestError, FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;

        const exists = yield* fs
            .exists(path)
            .pipe(Effect.mapError((error) => manifestError(path, error)));

        return yield* Match.value(exists).pipe(
            Match.when(false, () => Effect.succeedNone),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const original = yield* fs.readFileString(path);

                    const raw = yield* Schema.decodeEffect(Schema.fromJsonString(JsonRecord))(
                        original,
                    );

                    const fields = yield* Schema.decodeEffect(PackageJson)(raw);

                    return Option.some({ path, original, raw, fields });
                }).pipe(Effect.mapError((error) => manifestError(path, error))),
            ),
        );
    });

export const savePackageJson = (
    document: Pick<PackageJsonDocument, "path" | "original" | "raw">,
): Effect.Effect<void, PlatformError, FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const eol = document.original.includes("\r\n") ? "\r\n" : "\n";
        const indentation = /\n([\t ]+)"/.exec(document.original)?.[1] ?? "    ";

        const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(JsonRecord, { space: indentation }),
        )(document.raw).pipe(Effect.orDie);

        yield* fs.writeFileString(document.path, `${encoded.replaceAll("\n", eol)}${eol}`);
    });

export const ComponentsJson = Schema.Struct({ style: Schema.optionalKey(Schema.String) });

export const readComponentsStyle = (
    directory: string,
): Effect.Effect<Option.Option<string>, ManifestError, FileSystem | Path> =>
    Effect.gen(function* () {
        const path = yield* Path;
        const fs = yield* FileSystem;
        const file = path.join(directory, "components.json");

        const exists = yield* fs
            .exists(file)
            .pipe(Effect.mapError((error) => manifestError(file, error)));

        return yield* Match.value(exists).pipe(
            Match.when(false, () => Effect.succeedNone),
            Match.orElse(() =>
                Effect.gen(function* () {
                    const text = yield* fs.readFileString(file);

                    const config = yield* Schema.decodeEffect(
                        Schema.fromJsonString(ComponentsJson),
                    )(text);

                    return Option.fromNullishOr(config.style);
                }).pipe(Effect.mapError((error) => manifestError(file, error))),
            ),
        );
    });

export const CodeRabbitConfig = Schema.Struct({
    reviews: Schema.optionalKey(
        Schema.Struct({ path_filters: Schema.optionalKey(Schema.Array(Schema.String)) }),
    ),
});

/** Lenient parse: any YAML or shape failure yields no filters. */
export const parseCodeRabbitPathFilters = (text: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.try(() => Bun.YAML.parse(text)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CodeRabbitConfig)),
        Effect.map((config) => config.reviews?.path_filters ?? []),
        Effect.orElseSucceed(() => []),
    );

/**
 * Strict parse used before rewriting an existing .coderabbit.yaml: a document
 * whose YAML cannot be parsed must fail the run instead of being merged into.
 * Shape mismatches still yield no filters — only syntax errors abort.
 */
export const parseCodeRabbitPathFiltersStrict = (
    text: string,
): Effect.Effect<ReadonlyArray<string>, ManifestError> =>
    Effect.try(() => Bun.YAML.parse(text)).pipe(
        Effect.mapError(
            (error) =>
                new ManifestError({
                    message: `Cannot parse .coderabbit.yaml: ${error.message}`,
                }),
        ),
        Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(CodeRabbitConfig)(value).pipe(
                Effect.map((config) => config.reviews?.path_filters ?? []),
                Effect.orElseSucceed(() => []),
            ),
        ),
    );
