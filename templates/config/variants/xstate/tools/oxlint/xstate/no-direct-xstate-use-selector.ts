import { defineRule } from "@oxlint/plugins";

const isStringArray = (value: unknown): value is Array<string> =>
    Array.isArray(value) &&
    value.every((entry: unknown): entry is string => typeof entry === "string");

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Import typed selector hooks from a repository-owned facade instead of using XState useSelector directly.",
        },
        messages: {
            directUseSelector:
                "Use selector hooks from {{preferredModule}} instead of XState useSelector directly.",
        },
        schema: [
            {
                type: "object",
                properties: {
                    preferredModule: { type: "string" },
                    selectorModules: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                additionalProperties: false,
            },
        ],
        defaultOptions: [{ selectorModules: ["@xstate/react", "@xstate/store/react"] }],
    },
    create(context) {
        const rawOptions = context.options[0];
        const options =
            rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions)
                ? rawOptions
                : null;
        const selectorModulesValue = options?.["selectorModules"];
        const preferredModuleValue = options?.["preferredModule"];
        const xstateSelectorModules = new Set(
            isStringArray(selectorModulesValue)
                ? selectorModulesValue
                : ["@xstate/react", "@xstate/store/react"],
        );
        const preferredModule =
            typeof preferredModuleValue === "string"
                ? preferredModuleValue
                : "a repository-owned typed selector facade";
        const isXstateSelectorModule = ({ value }: { value: unknown }) =>
            typeof value === "string" && xstateSelectorModules.has(value);
        const namespaceNames = new Set<string>();

        return {
            ImportDeclaration(node) {
                if (!isXstateSelectorModule({ value: node.source.value })) {
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
                        specifier.imported.name === "useSelector"
                    ) {
                        context.report({
                            node: specifier,
                            messageId: "directUseSelector",
                            data: { preferredModule },
                        });
                    }
                }
            },
            MemberExpression(node) {
                const isDirectNamespaceSelector =
                    node.object.type === "Identifier" &&
                    namespaceNames.has(node.object.name) &&
                    node.property.type === "Identifier" &&
                    node.property.name === "useSelector";

                if (!isDirectNamespaceSelector) {
                    return;
                }

                context.report({
                    node,
                    messageId: "directUseSelector",
                    data: { preferredModule },
                });
            },
        };
    },
});

export default rule;
