import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

import { Id } from "./_generated/id";
import notes from "./_generated/tables/notes";

export default GroupSpec.make()
    .addFunction(
        FunctionSpec.publicQuery({
            name: "list",
            returns: () => Schema.Array(notes.Doc),
        }),
    )
    .addFunction(
        FunctionSpec.publicMutation({
            name: "create",
            args: () => ({ text: Schema.String }),
            returns: () => Id("notes"),
        }),
    );
