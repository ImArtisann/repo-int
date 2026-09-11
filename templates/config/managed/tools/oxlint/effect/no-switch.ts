import { defineRule } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Disallow switch statements. Use Match from effect instead.",
        },
        messages: {
            noSwitch: "Switch statements are banned. Use Match from effect.",
        },
    },
    create(context) {
        return {
            SwitchStatement(node) {
                context.report({
                    node,
                    messageId: "noSwitch",
                });
            },
        };
    },
});

export default rule;
