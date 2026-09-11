import * as Schema from "effect/Schema";

/** Command-line usage rejected before any filesystem or process work. */
export class UsageError extends Schema.TaggedError<UsageError>()("repo-int/UsageError", {
    message: Schema.String,
}) {}

/** Workspace discovery or validation failed. */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
    "repo-int/WorkspaceError",
    {
        message: Schema.String,
    },
) {}

/** package.json could not be parsed or failed schema validation. */
export class ManifestError extends Schema.TaggedError<ManifestError>()("repo-int/ManifestError", {
    message: Schema.String,
}) {}

/** A spawned command exited non-zero. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("repo-int/CommandFailed", {
    message: Schema.String,
}) {}

/** A command could not be spawned at all (missing binary, spawn failure). */
export class CommandUnavailable extends Schema.TaggedError<CommandUnavailable>()(
    "repo-int/CommandUnavailable",
    { message: Schema.String },
) {}

export type RepoIntError =
    | UsageError
    | WorkspaceError
    | ManifestError
    | CommandFailed
    | CommandUnavailable;
