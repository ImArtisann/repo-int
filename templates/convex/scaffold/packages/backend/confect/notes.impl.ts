import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import databaseSchema from "./_generated/schema";
import { DatabaseReader, DatabaseWriter } from "./_generated/services";
import notes from "./notes.spec";

const list = FunctionImpl.make(databaseSchema, notes, "list", () =>
    Effect.gen(function* () {
        const reader = yield* DatabaseReader;

        return yield* reader.table("notes").index("by_creation_time", "desc").collect();
    }).pipe(Effect.orDie),
);

const create = FunctionImpl.make(databaseSchema, notes, "create", ({ text }) =>
    Effect.gen(function* () {
        const writer = yield* DatabaseWriter;

        return yield* writer.table("notes").insert({ text });
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, notes).pipe(
    Layer.provide(list),
    Layer.provide(create),
    GroupImpl.finalize,
);
