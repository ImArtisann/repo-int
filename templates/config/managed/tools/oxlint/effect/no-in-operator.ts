import { defineRule } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid object key checks with the in operator; refactor the check or use Predicate as a last resort.",
        },
        messages: {
            inOperator:
                'Do not use the "in" operator to check for object keys. Fix or refactor the code so this key check is not needed. Only use Predicate as a last-resort escape hatch.',
        },
    },
    create(context) {
        return {
            BinaryExpression(node) {
                if (node.operator !== "in") {
                    return;
                }

                context.report({
                    node,
                    messageId: "inOperator",
                });
            },
        };
    },
});

export default rule;
