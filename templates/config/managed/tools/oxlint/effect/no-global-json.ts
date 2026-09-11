import { defineRule } from "@oxlint/plugins";

type Node = {
    readonly [key: string]: unknown;
    readonly type: string;
};

const isNode = (value: unknown): value is Node =>
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "type") &&
    typeof Reflect.get(value, "type") === "string";

const nodeField = ({ field, node }: { field: string; node: Node }) => node[field];

const isIdentifier = ({ name, node }: { name: string; node: unknown }) =>
    isNode(node) && node.type === "Identifier" && nodeField({ field: "name", node }) === name;

const isGlobalJson = (node: unknown): boolean => {
    if (isIdentifier({ name: "JSON", node })) {
        return true;
    }

    if (!isNode(node) || node.type !== "MemberExpression") {
        return false;
    }

    return (
        isIdentifier({
            name: "globalThis",
            node: nodeField({ field: "object", node }),
        }) &&
        isIdentifier({
            name: "JSON",
            node: nodeField({ field: "property", node }),
        })
    );
};

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Avoid global JSON APIs; encode and decode JSON with Effect Schema.",
        },
        messages: {
            globalJson:
                "Do not use the global JSON API. Use Effect Schema encode/decode APIs instead.",
        },
    },
    create(context) {
        return {
            MemberExpression(node) {
                if (!isGlobalJson(node.object)) {
                    return;
                }

                context.report({
                    node,
                    messageId: "globalJson",
                });
            },
        };
    },
});

export default rule;
