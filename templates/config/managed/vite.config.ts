import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

const ignorePatterns = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.output/**",
    "**/.alchemy/**",
    "**/.wrangler/**",
    "**/.tanstack/**",
    "**/.nitro/**",
    "**/.astro/**",
    "**/.convex/**",
    "**/_generated/**",
    "**/*.gen.ts",
    "packages/backend/convex/**",
    "packages/backend/AGENTS.md",
    "packages/backend/CLAUDE.md",
    "packages/backend/.agents/**",
    "packages/backend/.claude/**",
    "packages/backend/skills-lock.json",
    "bun.lock",
    "tools/oxlint/**",
];

export default defineConfig({
    run: { cache: true },
    test: { passWithNoTests: true },
    lint: {
        extends: [recommended],
        options: { typeAware: true, typeCheck: true },
        jsPlugins: [
            { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
            { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
            { name: "effect", specifier: "./tools/oxlint/effect/index.ts" },
            { name: "xstate", specifier: "./tools/oxlint/xstate/index.ts" }, // repo-int:xstate
        ],
        rules: {
            "oxc/no-accumulating-spread": "error",
            "anti-slop/no-array-filter-map": "error",
            "anti-slop/no-chained-type-assertions": "error",
            "anti-slop/no-conditional-empty-object-spread": "error",
            "anti-slop/no-known-value-widening": "error",
            "anti-slop/no-module-mocking": "error",
            "anti-slop/no-object-parameters": "error",
            "anti-slop/no-reduce-accumulator-copy": "error",
            "anti-slop/no-reflect-apply": "error",
            "anti-slop/no-reflect-get": "error",
            "anti-slop/no-runtime-typeof": "error",
            "anti-slop/no-shape-in-symbol-names": "error",
            "anti-slop/no-unknown-parameters": "error",
            "anti-slop/no-unknown-returns": "error",
            "anti-slop/no-unknown-type-aliases": "error",
            "anti-slop/no-unsafe-dictionary-type": "error",
            "anti-slop/no-widen-then-assert": "error",
            "anti-slop/require-readable-spacing": "error",
            "anti-slop/require-safety-comment-for-type-assertion": "error",
            "anti-slop-effect/no-manual-effect-error-tag": "error",
            "anti-slop-effect/no-manual-tag-comparison": "error",
            "anti-slop-effect/no-manual-tagged-construction": "error",
            "anti-slop-effect/no-service-constructor-imports": "error",
            "effect/no-ambient-nondeterminism": [
                "error",
                { allowedDateExtensions: [".tsx", ".astro"] },
            ],
            "effect/no-cascading-layer-provide": "error",
            "effect/no-direct-browser-storage": "error",
            "effect/no-direct-fetch": "error",
            "effect/no-disable-validation": "error",
            "effect/no-effect-asvoid": "error",
            "effect/no-global-json": "error",
            "effect/no-in-operator": "error",
            "effect/no-nested-effect-array-methods": "error",
            "effect/no-nested-layer-provide": "error",
            "effect/no-service-option": "error",
            "effect/no-shadowed-standard-array-static": "error",
            "effect/no-silent-error-swallow": "error",
            "effect/no-static-effect-service-forwarders": "error",
            "effect/no-switch": "error",
            "effect/no-try-catch": "error",
            "effect/no-typeof-object": "error",
            "effect/pipe-max-arguments": "error",
            "effect/prefer-effect-match": "error",
            "effect/prefer-option-from-nullable": "error",
            "effect/require-context-service-in-services": "error",
            "xstate/no-direct-xstate-create-machine": "error", // repo-int:xstate
            "xstate/no-direct-xstate-use-selector": "error", // repo-int:xstate
            "xstate/no-multiple-xstate-hooks": "error", // repo-int:xstate
            "xstate/no-single-use-xstate-actions": "error", // repo-int:xstate
            "xstate/no-single-use-xstate-guards": "error", // repo-int:xstate
            "xstate/require-xstate-event-satisfies": "error", // repo-int:xstate
        },
        // bun:test callbacks and runner seams are legitimately async; tests also
        // use node:fs/node:path directly for temp-dir setup.
        overrides: [
            {
                files: ["**/*.test.ts", "**/*.test.tsx"],
                rules: {
                    "effecttsgo/async-function": "off",
                    "effecttsgo/node-builtin-import": "off",
                },
            },
        ],
        ignorePatterns,
    },
    fmt: {
        printWidth: 100,
        tabWidth: 4,
        semi: true,
        singleQuote: false,
        sortPackageJson: false,
        overrides: [{ files: ["**/*.md"], options: { printWidth: 80, proseWrap: "always" } }],
        ignorePatterns,
    },
});
