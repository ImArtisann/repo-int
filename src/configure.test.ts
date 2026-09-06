import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    defaultPackageName,
    mergeCodeRabbitPathFilters,
    synchronizeManagedFile,
    updatePackageJson,
    type LoadedTemplate,
    type Logger,
} from "./configure.ts";

const temporaryDirectories: string[] = [];
const logger: Logger = { error() {}, log() {}, warn() {} };
const template: LoadedTemplate = {
    content: "repo-int\n",
    destination: ".toolrc",
    source: "unused",
    tool: "test-tool",
};
const gitignoreTemplate: LoadedTemplate = {
    content: "# environment variables\n.env\n.env.*\n!.env.example\n!.env.*.example\n",
    destination: ".gitignore",
    mergeIgnorePatterns: true,
    source: "gitignore",
    tool: "gitignore",
};
const codeRabbitContent = [
    "# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json",
    "language: en-US",
    "",
    "reviews:",
    "    profile: assertive",
    "    path_filters:",
    '        - "!bun.lock"',
    '        - "!**/dist/**"',
    "",
    "chat:",
    "    auto_reply: true",
    "",
].join("\n");
const codeRabbitTemplate: LoadedTemplate = {
    content: codeRabbitContent,
    destination: ".coderabbit.yaml",
    mergePathFilters: true,
    source: "coderabbit.yaml",
    tool: "CodeRabbit",
};

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "repo-int-test-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function writePackageJson(cwd: string, value: unknown): Promise<void> {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
}

describe("managed configuration files", () => {
    test("creates a missing configuration", async () => {
        const cwd = await temporaryDirectory();

        const status = await synchronizeManagedFile(cwd, template, async () => false, logger);

        expect(status).toBe("created");
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe(template.content);
    });

    test("reports an identical configuration as unchanged without prompting", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, ".toolrc"), template.content);

        const status = await synchronizeManagedFile(
            cwd,
            template,
            async () => {
                throw new Error("An identical configuration must not prompt.");
            },
            logger,
        );

        expect(status).toBe("unchanged");
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe(template.content);
    });

    test("preserves a differing configuration when replacement is rejected", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, ".toolrc"), "custom\n");

        const status = await synchronizeManagedFile(cwd, template, async () => false, logger);

        expect(status).toBe("skipped");
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe("custom\n");
    });

    test("replaces a differing configuration when replacement is accepted", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, ".toolrc"), "custom\n");

        const status = await synchronizeManagedFile(cwd, template, async () => true, logger);

        expect(status).toBe("updated");
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe(template.content);
    });

    test("never overwrites a create-only configuration", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, ".toolrc"), "custom\n");

        const status = await synchronizeManagedFile(
            cwd,
            { ...template, createOnly: true },
            async () => true,
            logger,
        );

        expect(status).toBe("unchanged");
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe("custom\n");
    });

    test("creates a missing gitignore merge target from the template", async () => {
        const cwd = await temporaryDirectory();

        const status = await synchronizeManagedFile(
            cwd,
            gitignoreTemplate,
            async () => false,
            logger,
        );

        expect(status).toBe("created");
        expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(gitignoreTemplate.content);
    });

    test("adds missing gitignore patterns without replacing existing rules", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".gitignore");
        await writeFile(path, "custom-generated/\n.env\n!.env.example\n!.env.*.example\n");

        const status = await synchronizeManagedFile(
            cwd,
            gitignoreTemplate,
            async () => {
                throw new Error("Merging ignore patterns must not prompt.");
            },
            logger,
        );
        const merged = await readFile(path, "utf8");

        expect(status).toBe("updated");
        expect(merged).toContain("custom-generated/");
        expect(merged).toContain("# repo-int managed ignores");
        expect(merged).toContain(".env.*");
        expect(merged).toContain("!.env.example");
        expect(merged).toContain("!.env.*.example");
        expect(merged.split(/\r?\n/).filter((line) => line === ".env")).toHaveLength(1);
        const mergedLines = merged.split(/\r?\n/);
        expect(mergedLines.lastIndexOf("!.env.example")).toBeGreaterThan(
            mergedLines.lastIndexOf(".env.*"),
        );
        expect(mergedLines.lastIndexOf("!.env.*.example")).toBeGreaterThan(
            mergedLines.lastIndexOf(".env.*"),
        );

        expect(
            await synchronizeManagedFile(cwd, gitignoreTemplate, async () => false, logger),
        ).toBe("unchanged");
        expect(await readFile(path, "utf8")).toBe(merged);
    });
});

describe("CodeRabbit path filter preservation", () => {
    test("treats a template with appended path filters as unchanged", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        const withExtra = codeRabbitContent.replace(
            '        - "!**/dist/**"\n',
            '        - "!**/dist/**"\n        - "!apps/web/.tanstack/**"\n',
        );
        await writeFile(path, withExtra);

        const status = await synchronizeManagedFile(
            cwd,
            codeRabbitTemplate,
            async () => {
                throw new Error("Preserved path filters must not prompt.");
            },
            logger,
        );

        expect(status).toBe("unchanged");
        expect(await readFile(path, "utf8")).toBe(withExtra);
    });

    test("unions existing path filters into an accepted overwrite", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        const edited = codeRabbitContent
            .replace("language: en-US", "language: de-DE")
            .replace(
                '        - "!**/dist/**"\n',
                '        - "!**/dist/**"\n        - "!packages/backend/convex/**"\n',
            );
        await writeFile(path, edited);

        const status = await synchronizeManagedFile(
            cwd,
            codeRabbitTemplate,
            async () => true,
            logger,
        );
        const merged = await readFile(path, "utf8");

        expect(status).toBe("updated");
        expect(merged).toContain("language: en-US");
        expect(merged).not.toContain("language: de-DE");
        expect(merged).toContain('        - "!packages/backend/convex/**"\n');
    });

    test("keeps a rejected CodeRabbit overwrite, including unparsable YAML", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(path, "reviews: [broken\n");

        const status = await synchronizeManagedFile(
            cwd,
            codeRabbitTemplate,
            async () => false,
            logger,
        );

        expect(status).toBe("skipped");
        expect(await readFile(path, "utf8")).toBe("reviews: [broken\n");
    });

    test("stays unchanged when other templates appended filters and the template re-runs", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        const appended = ["!apps/web/.tanstack/**", "!apps/web/.astro/**"];
        await writeFile(path, codeRabbitContent);
        await synchronizeManagedFile(cwd, codeRabbitTemplate, async () => true, logger);

        expect(await mergeCodeRabbitPathFilters(cwd, appended, logger)).toBe("updated");
        expect(
            await synchronizeManagedFile(
                cwd,
                codeRabbitTemplate,
                async () => {
                    throw new Error("Re-running the template must not prompt.");
                },
                logger,
            ),
        ).toBe("unchanged");
        expect(await mergeCodeRabbitPathFilters(cwd, appended, logger)).toBe("unchanged");
    });
});

describe("defaultPackageName", () => {
    test("normalizes the directory name and falls back when empty", () => {
        expect(defaultPackageName(join(tmpdir(), "My_App!"))).toBe("my_app");
        expect(defaultPackageName("/")).toBe("bun-app");
    });
});

describe("updatePackageJson", () => {
    test("creates a missing package.json named after the directory and applies the spec", async () => {
        const parent = await temporaryDirectory();
        const cwd = join(parent, "Repo.Int Demo");
        await mkdir(cwd);

        const status = await updatePackageJson(
            cwd,
            {
                packageManager: "bun@1.4.2",
                workspaces: ["apps/*", "packages/*"],
                catalog: { alchemy: "2.0.0-beta.76" },
                devDependencies: { typescript: "7.0.2" },
                scripts: { check: "vp check" },
            },
            async () => false,
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("created");
        expect(packageJson["name"]).toBe("repo.int-demo");
        expect(packageJson["version"]).toBe("0.0.0");
        expect(packageJson["private"]).toBe(true);
        expect(packageJson["type"]).toBe("module");
        expect(packageJson["packageManager"]).toBe("bun@1.4.2");
        expect(packageJson["workspaces"]).toEqual(["apps/*", "packages/*"]);
        expect(packageJson["catalog"]).toEqual({ alchemy: "2.0.0-beta.76" });
        expect(packageJson["devDependencies"]).toEqual({ typescript: "7.0.2" });
        expect(packageJson["scripts"]).toEqual({ check: "vp check" });
    });

    test("keeps an existing catalog entry and adds missing ones", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, {
            name: "existing",
            catalog: { alchemy: "2.0.0-beta.1", effect: "4.0.0-rc.112" },
        });

        const status = await updatePackageJson(
            cwd,
            { catalog: { alchemy: "2.0.0-beta.76", lefthook: "^1.2.3" } },
            async () => {
                throw new Error("Existing catalog entries must not prompt.");
            },
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["catalog"]).toEqual({
            alchemy: "2.0.0-beta.1",
            effect: "4.0.0-rc.112",
            lefthook: "^1.2.3",
        });
    });

    test("adds missing workspaces globs to an existing array without duplicates", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, {
            name: "existing",
            workspaces: ["packages/*", "tools/*"],
        });

        const status = await updatePackageJson(
            cwd,
            { workspaces: ["apps/*", "packages/*"] },
            async () => false,
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["workspaces"]).toEqual(["packages/*", "tools/*", "apps/*"]);
    });

    test("adds missing globs to object-form workspaces and preserves sibling keys", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, {
            name: "existing",
            workspaces: { packages: ["packages/*"], nohoist: ["**/react"] },
        });

        const status = await updatePackageJson(
            cwd,
            { workspaces: ["apps/*", "packages/*"] },
            async () => false,
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["workspaces"]).toEqual({
            packages: ["packages/*", "apps/*"],
            nohoist: ["**/react"],
        });
    });

    test("creates the packages array for object-form workspaces without one", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, { name: "existing", workspaces: { nohoist: ["**/react"] } });

        const status = await updatePackageJson(
            cwd,
            { workspaces: ["apps/*"] },
            async () => false,
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["workspaces"]).toEqual({ nohoist: ["**/react"], packages: ["apps/*"] });
    });

    test("merges the catalog into object-form workspaces that already carry one", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, {
            name: "existing",
            workspaces: { packages: ["packages/*"], catalog: { alchemy: "2.0.0-beta.1" } },
        });

        const status = await updatePackageJson(
            cwd,
            { catalog: { alchemy: "9.9.9", effect: "4.0.0-rc.112" } },
            async () => {
                throw new Error("Existing workspaces catalog entries must not prompt.");
            },
            logger,
        );
        const packageJson = await readPackageJson(cwd);
        const workspaces = packageJson["workspaces"] as Record<string, unknown>;

        expect(status).toBe("updated");
        expect(workspaces["catalog"]).toEqual({
            alchemy: "2.0.0-beta.1",
            effect: "4.0.0-rc.112",
        });
        expect(packageJson["catalog"]).toBeUndefined();
    });

    test("leaves an already-satisfied package.json untouched without prompting", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, "package.json");
        await writePackageJson(cwd, {
            name: "existing",
            packageManager: "pnpm@9.0.0",
            workspaces: ["apps/*"],
            catalog: { alchemy: "2.0.0-beta.76" },
            dependencies: { react: "^19.0.0" },
            scripts: { check: "vp check" },
        });
        const original = await readFile(path, "utf8");

        const status = await updatePackageJson(
            cwd,
            {
                packageManager: "bun@1.4.2",
                workspaces: ["apps/*"],
                catalog: { alchemy: "2.0.0-beta.76" },
                dependencies: { react: "^19.0.0" },
                scripts: { check: "vp check" },
            },
            async () => {
                throw new Error("A satisfied spec must not prompt.");
            },
            logger,
        );

        expect(status).toBe("unchanged");
        expect(await readFile(path, "utf8")).toBe(original);
    });

    test("keeps a differing dependency when the replacement is rejected", async () => {
        const cwd = await temporaryDirectory();
        const warnings: string[] = [];
        const recordingLogger: Logger = {
            error() {},
            log() {},
            warn(message) {
                warnings.push(message);
            },
        };
        await writePackageJson(cwd, {
            name: "existing",
            dependencies: { react: "^18.0.0" },
        });

        const status = await updatePackageJson(
            cwd,
            { dependencies: { react: "^19.0.0", scheduler: "0.1.0" } },
            async () => false,
            recordingLogger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["dependencies"]).toEqual({ react: "^18.0.0", scheduler: "0.1.0" });
        expect(warnings).toEqual(['[kept] package.json dependency "react"']);
    });

    test("replaces a differing script when the replacement is accepted", async () => {
        const cwd = await temporaryDirectory();
        await writePackageJson(cwd, { name: "existing", scripts: { build: "webpack" } });

        const status = await updatePackageJson(
            cwd,
            { scripts: { build: "vite build", test: "vp test" } },
            async () => true,
            logger,
        );
        const packageJson = await readPackageJson(cwd);

        expect(status).toBe("updated");
        expect(packageJson["scripts"]).toEqual({ build: "vite build", test: "vp test" });
    });

    test("preserves unknown fields and the original indentation", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, "package.json");
        await writeFile(
            path,
            `${JSON.stringify({ name: "existing", custom: true, engines: { bun: ">=1.4.0" } }, null, 4)}\n`,
        );

        const status = await updatePackageJson(
            cwd,
            { scripts: { check: "vp check" } },
            async () => false,
            logger,
        );
        const text = await readFile(path, "utf8");

        expect(status).toBe("updated");
        expect(text).toContain('"custom": true');
        expect(text).toContain('"engines"');
        expect(text).toContain('    "scripts": {');
    });

    test("throws on a non-object catalog field and leaves the file untouched", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, "package.json");
        const original = `${JSON.stringify({ name: "existing", catalog: "managed-elsewhere" }, null, 2)}\n`;
        await writeFile(path, original);

        await expect(
            updatePackageJson(
                cwd,
                { catalog: { alchemy: "2.0.0-beta.76" } },
                async () => true,
                logger,
            ),
        ).rejects.toThrow('has a non-object "catalog" field');
        expect(await readFile(path, "utf8")).toBe(original);
    });

    test("throws on a malformed workspaces field and leaves the file untouched", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, "package.json");
        const original = `${JSON.stringify({ name: "existing", workspaces: "apps/*" }, null, 2)}\n`;
        await writeFile(path, original);

        await expect(
            updatePackageJson(cwd, { workspaces: ["apps/*"] }, async () => true, logger),
        ).rejects.toThrow('has an invalid "workspaces" field');
        expect(await readFile(path, "utf8")).toBe(original);
    });

    test("throws on malformed JSON", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, "package.json"), "{ not json\n");

        await expect(updatePackageJson(cwd, {}, async () => true, logger)).rejects.toThrow(
            "Cannot parse",
        );
    });
});

describe("mergeCodeRabbitPathFilters", () => {
    test("creates the file with a path_filters block when missing", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");

        const status = await mergeCodeRabbitPathFilters(cwd, ["!bun.lock", "!**/dist/**"], logger);

        expect(status).toBe("created");
        expect(await readFile(path, "utf8")).toBe(
            'reviews:\n    path_filters:\n        - "!bun.lock"\n        - "!**/dist/**"\n',
        );
    });

    test("inserts only missing patterns and preserves the surrounding text", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(
            path,
            [
                "# managed by repo-int",
                "language: en-US",
                "",
                "reviews:",
                "    profile: assertive",
                "    path_filters:",
                '        - "!**/dist/**"',
                "",
                "chat:",
                "    auto_reply: true",
                "",
            ].join("\n"),
        );
        const patterns = ["!bun.lock", "!**/dist/**", "!tools/oxlint/**"];

        const status = await mergeCodeRabbitPathFilters(cwd, patterns, logger);

        expect(status).toBe("updated");
        const merged = await readFile(path, "utf8");
        expect(merged.split("\n")).toEqual([
            "# managed by repo-int",
            "language: en-US",
            "",
            "reviews:",
            "    profile: assertive",
            "    path_filters:",
            '        - "!**/dist/**"',
            '        - "!bun.lock"',
            '        - "!tools/oxlint/**"',
            "",
            "chat:",
            "    auto_reply: true",
            "",
        ]);
        expect(await mergeCodeRabbitPathFilters(cwd, patterns, logger)).toBe("unchanged");
        expect(await readFile(path, "utf8")).toBe(merged);
    });

    test("creates the path_filters block when reviews has none", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(path, "language: en-US\nreviews:\n    profile: assertive\n");

        const status = await mergeCodeRabbitPathFilters(cwd, ["!bun.lock"], logger);

        expect(status).toBe("updated");
        expect(await readFile(path, "utf8")).toBe(
            'language: en-US\nreviews:\n    path_filters:\n        - "!bun.lock"\n    profile: assertive\n',
        );
    });

    test("inserts items directly after an empty path_filters header", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(path, "reviews:\n    path_filters:\nchat:\n    auto_reply: true\n");

        const status = await mergeCodeRabbitPathFilters(cwd, ["!bun.lock"], logger);

        expect(status).toBe("updated");
        expect(await readFile(path, "utf8")).toBe(
            'reviews:\n    path_filters:\n        - "!bun.lock"\nchat:\n    auto_reply: true\n',
        );
    });

    test("appends a reviews block when the file has none", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(path, "language: en-US\n");

        const status = await mergeCodeRabbitPathFilters(cwd, ["!bun.lock"], logger);

        expect(status).toBe("updated");
        expect(await readFile(path, "utf8")).toBe(
            'language: en-US\nreviews:\n    path_filters:\n        - "!bun.lock"\n',
        );
    });

    test("preserves CRLF line endings when merging", async () => {
        const cwd = await temporaryDirectory();
        const path = join(cwd, ".coderabbit.yaml");
        await writeFile(path, 'reviews:\r\n    path_filters:\r\n        - "!**/dist/**"\r\n');

        const status = await mergeCodeRabbitPathFilters(cwd, ["!**/dist/**", "!bun.lock"], logger);

        expect(status).toBe("updated");
        expect(await readFile(path, "utf8")).toBe(
            'reviews:\r\n    path_filters:\r\n        - "!**/dist/**"\r\n        - "!bun.lock"\r\n',
        );
    });
});
