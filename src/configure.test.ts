import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    configurePackageJson,
    synchronizeManagedFile,
    type LoadedTemplate,
    type Logger,
} from "./configure.ts";

const temporaryDirectories: string[] = [];
const logger: Logger = { error() {}, log() {}, warn() {} };
const template: LoadedTemplate = {
    alternatives: ["tool.config.ts"],
    content: "repo-int\n",
    destination: ".toolrc",
    source: "unused",
    tool: "test-tool",
};
const gitignoreTemplate: LoadedTemplate = {
    alternatives: [],
    content: "# environment variables\n.env\n.env.*\n!.env.example\n!.env.*.example\n",
    destination: ".gitignore",
    mergeIgnorePatterns: true,
    source: "gitignore",
    tool: "gitignore",
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

describe("managed configuration files", () => {
    test("creates a missing configuration", async () => {
        const cwd = await temporaryDirectory();
        const status = await synchronizeManagedFile(cwd, template, async () => false, logger);

        expect(status).toBe("created");
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

    test("removes an alternative config only after explicit replacement", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(join(cwd, "tool.config.ts"), "export default {}\n");

        const status = await synchronizeManagedFile(cwd, template, async () => true, logger);

        expect(status).toBe("updated");
        expect(await Bun.file(join(cwd, "tool.config.ts")).exists()).toBeFalse();
        expect(await readFile(join(cwd, ".toolrc"), "utf8")).toBe(template.content);
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

describe("package.json merging", () => {
    test("preserves unknown fields and rejected script conflicts", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(
            join(cwd, "package.json"),
            `${JSON.stringify({ name: "existing", scripts: { lint: "eslint ." }, custom: true }, null, 2)}\n`,
        );

        await configurePackageJson(cwd, { "*.ts": "oxlint" }, async () => false, logger);
        const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
            custom: boolean;
            scripts: Record<string, string>;
        };

        expect(packageJson.custom).toBeTrue();
        expect(packageJson.scripts.lint).toBe("eslint .");
        expect(packageJson.scripts.format).toBe("oxfmt --write .");
        expect(packageJson.scripts.prepare).toBe("bunx --bun husky");
    });

    test("does not create a second lint-staged config when the embedded one matches", async () => {
        const cwd = await temporaryDirectory();
        const desired = { "*.ts": ["oxfmt", "oxlint"] };
        await writeFile(
            join(cwd, "package.json"),
            `${JSON.stringify({ name: "existing", "lint-staged": desired }, null, 2)}\n`,
        );

        const result = await configurePackageJson(cwd, desired, async () => false, logger);

        expect(result.manageLintStagedFile).toBeFalse();
    });

    test("removes an incompatible Bun-init TypeScript peer dependency", async () => {
        const cwd = await temporaryDirectory();
        await writeFile(
            join(cwd, "package.json"),
            `${JSON.stringify(
                {
                    name: "existing",
                    peerDependencies: { react: "^19", typescript: "^5" },
                },
                null,
                2,
            )}\n`,
        );

        await configurePackageJson(cwd, {}, async () => true, logger);
        const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
            peerDependencies: Record<string, string>;
        };

        expect(packageJson.peerDependencies).toEqual({ react: "^19" });
    });

    test("does not continue with a rejected incompatible TypeScript peer", async () => {
        const cwd = await temporaryDirectory();
        const original = `${JSON.stringify(
            { name: "existing", peerDependencies: { typescript: "^5" } },
            null,
            2,
        )}\n`;
        await writeFile(join(cwd, "package.json"), original);

        await expect(configurePackageJson(cwd, {}, async () => false, logger)).rejects.toThrow(
            "Cannot install TypeScript 7.0.2",
        );
        expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(original);
    });
});
