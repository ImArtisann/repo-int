import { defineRule } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Create XState machines with setup().createMachine() to define their typed dependencies.",
        },
        messages: {
            directCreateMachine:
                "Do not use createMachine directly. Define machines with setup().createMachine().",
        },
    },
    create(context) {
        const namespaceNames = new Set<string>();

        return {
            ImportDeclaration(node) {
                if (node.source.value !== "xstate") {
                    return;
                }

                for (const specifier of node.specifiers) {
                    if (specifier.type === "ImportNamespaceSpecifier") {
                        namespaceNames.add(specifier.local.name);
                        continue;
                    }

                    if (
                        specifier.type === "ImportSpecifier" &&
                        specifier.imported.type === "Identifier" &&
                        specifier.imported.name === "createMachine"
                    ) {
                        context.report({
                            node: specifier,
                            messageId: "directCreateMachine",
                        });
                    }
                }
            },
            MemberExpression(node) {
                if (
                    node.object.type === "Identifier" &&
                    namespaceNames.has(node.object.name) &&
                    node.property.type === "Identifier" &&
                    node.property.name === "createMachine"
                ) {
                    context.report({
                        node,
                        messageId: "directCreateMachine",
                    });
                }
            },
        };
    },
});

export default rule;
