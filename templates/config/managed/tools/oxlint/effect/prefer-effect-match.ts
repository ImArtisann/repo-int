import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type ExpressionNode = ESTree.ConditionalExpression["alternate"];
type BinaryExpressionNode = Extract<
    ESTree.ConditionalExpression["test"],
    { type: "BinaryExpression" }
>;

const isLiteral = (node: ExpressionNode) =>
    node.type === "Literal" || (node.type === "TemplateLiteral" && node.expressions.length === 0);

const getComparedValue = ({
    node,
    getText,
}: {
    node: ESTree.ConditionalExpression["test"];
    getText: (node: ExpressionNode) => string;
}) => {
    if (
        node.type !== "BinaryExpression" ||
        (node.operator !== "==" &&
            node.operator !== "===" &&
            node.operator !== "!=" &&
            node.operator !== "!==")
    ) {
        return undefined;
    }

    const binaryNode: BinaryExpressionNode = node;
    if (isLiteral(binaryNode.left)) {
        return getText(binaryNode.right);
    }

    if (isLiteral(binaryNode.right)) {
        return getText(binaryNode.left);
    }

    return undefined;
};

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Use Match from effect for chained literal ternaries over the same value.",
        },
        messages: {
            preferMatch: "Use Match from effect instead of a chained literal ternary.",
        },
    },
    create(context) {
        const sourceCode = context.sourceCode;
        const getText = (node: ExpressionNode) => sourceCode.getText(node);

        return {
            ConditionalExpression(node) {
                if (node.parent?.type === "ConditionalExpression") {
                    return;
                }

                const comparedValue = getComparedValue({
                    node: node.test,
                    getText,
                });

                if (comparedValue === undefined) {
                    return;
                }

                let alternate = node.alternate;
                let literalChecks = 1;

                while (alternate.type === "ConditionalExpression") {
                    const alternateComparedValue = getComparedValue({
                        node: alternate.test,
                        getText,
                    });

                    if (alternateComparedValue !== comparedValue) {
                        return;
                    }

                    literalChecks += 1;
                    alternate = alternate.alternate;
                }

                if (literalChecks > 1) {
                    context.report({
                        node,
                        messageId: "preferMatch",
                    });
                }
            },
        };
    },
});

export default rule;
