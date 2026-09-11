import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type MemberExpressionNode = ESTree.MemberExpression;
type IdentifierNode =
    | ESTree.IdentifierName
    | ESTree.IdentifierReference
    | ESTree.BindingIdentifier
    | ESTree.LabelIdentifier
    | ESTree.TSThisParameter
    | ESTree.TSIndexSignatureName;

const isStringArray = (value: unknown): value is Array<string> =>
    Array.isArray(value) &&
    value.every((entry: unknown): entry is string => typeof entry === "string");

const memberPropertyName = ({ node }: { node: MemberExpressionNode }) =>
    node.property.type === "Identifier"
        ? node.property.name
        : node.property.type === "Literal" && typeof node.property.value === "string"
          ? node.property.value
          : undefined;

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Disallow ambient randomness and time in favor of Effect capabilities.",
        },
        messages: {
            ambientDate:
                "Do not read the current time from ambient Date. Use Effect Clock or DateTime capabilities.",
            ambientCrypto: "Do not use ambient crypto. Use Effect's Crypto capability instead.",
            ambientRandom:
                "Do not use ambient Math.random. Use Effect's Random capability instead.",
        },
        schema: [
            {
                type: "object",
                properties: {
                    allowedDateBasenames: {
                        type: "array",
                        items: { type: "string" },
                    },
                    allowedDateExtensions: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                additionalProperties: false,
            },
        ],
    },
    create(context) {
        const rawOptions = context.options[0];
        const options =
            rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions)
                ? rawOptions
                : null;
        const allowedDateBasenamesValue = options?.["allowedDateBasenames"];
        const allowedDateExtensionsValue = options?.["allowedDateExtensions"];
        const allowedDateBasenames = new Set(
            isStringArray(allowedDateBasenamesValue) ? allowedDateBasenamesValue : [],
        );
        const allowedDateExtensions = isStringArray(allowedDateExtensionsValue)
            ? allowedDateExtensionsValue
            : [".tsx"];
        const filename = (context.filename ?? "").replaceAll("\\", "/");
        const basename = filename.slice(filename.lastIndexOf("/") + 1);
        const allowAmbientDate =
            allowedDateExtensions.some((extension) => filename.endsWith(extension)) ||
            allowedDateBasenames.has(basename);

        const isGlobalIdentifier = ({ name, node }: { name: string; node: IdentifierNode }) => {
            if (node.name !== name) {
                return false;
            }

            let scope: ReturnType<typeof context.sourceCode.getScope> | null =
                context.sourceCode.getScope(node);

            while (scope !== null) {
                const variable = scope.set.get(name);

                if (variable !== undefined) {
                    return variable.defs.length === 0;
                }

                scope = scope.upper;
            }

            return true;
        };

        const isGlobalThisMember = ({ name, node }: { name: string; node: MemberExpressionNode }) =>
            node.object.type === "Identifier" &&
            isGlobalIdentifier({ name: "globalThis", node: node.object }) &&
            memberPropertyName({ node }) === name;

        const isGlobalObject = ({
            name,
            node,
        }: {
            name: string;
            node: MemberExpressionNode["object"];
        }) =>
            (node.type === "Identifier" &&
                isGlobalIdentifier({
                    name,
                    node,
                })) ||
            (node.type === "MemberExpression" &&
                isGlobalThisMember({
                    name,
                    node,
                }));

        return {
            CallExpression(node) {
                if (
                    allowAmbientDate ||
                    node.arguments.length !== 0 ||
                    node.callee.type !== "Identifier" ||
                    !isGlobalIdentifier({ name: "Date", node: node.callee })
                ) {
                    return;
                }

                context.report({
                    node,
                    messageId: "ambientDate",
                });
            },
            Identifier(node) {
                if (
                    node.parent?.type === "MemberExpression" &&
                    node.parent.property === node &&
                    node.parent.computed !== true
                ) {
                    return;
                }

                if (!isGlobalIdentifier({ name: "crypto", node })) {
                    return;
                }

                context.report({
                    node,
                    messageId: "ambientCrypto",
                });
            },
            MemberExpression(node) {
                const propertyName = memberPropertyName({ node });

                if (isGlobalThisMember({ name: "crypto", node })) {
                    context.report({
                        node,
                        messageId: "ambientCrypto",
                    });
                    return;
                }

                if (
                    propertyName === "random" &&
                    isGlobalObject({ name: "Math", node: node.object })
                ) {
                    context.report({
                        node,
                        messageId: "ambientRandom",
                    });
                    return;
                }

                if (
                    !allowAmbientDate &&
                    propertyName === "now" &&
                    isGlobalObject({ name: "Date", node: node.object })
                ) {
                    context.report({
                        node,
                        messageId: "ambientDate",
                    });
                }
            },
            NewExpression(node) {
                if (
                    allowAmbientDate ||
                    node.arguments.length !== 0 ||
                    node.callee.type !== "Identifier" ||
                    !isGlobalIdentifier({ name: "Date", node: node.callee })
                ) {
                    return;
                }

                context.report({
                    node,
                    messageId: "ambientDate",
                });
            },
        };
    },
});

export default rule;
