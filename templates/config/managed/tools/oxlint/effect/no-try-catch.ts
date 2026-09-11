import { defineRule } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid try/catch; use Effect.try, Effect.tryPromise, or explicit error channels.",
        },
        messages: {
            tryCatch:
                "Do not use try/catch. Use Effect.try, Effect.tryPromise, or explicit error channels instead.",
        },
    },
    create(context) {
        return {
            TryStatement(node) {
                context.report({
                    node,
                    messageId: "tryCatch",
                });
            },
        };
    },
});

export default rule;
