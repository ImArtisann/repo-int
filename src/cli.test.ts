import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import type { Logger } from "./configure.ts";
import type { CommandResult, CommandRunner } from "./process.ts";

const temporaryDirectories: string[] = [];
const logger: Logger = { error() {}, log() {}, warn() {} };

function success(stdout = ""): CommandResult {
    return { exitCode: 0, stderr: "", stdout };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "repo-int-cli-test-"));
    temporaryDirectories.push(directory);
    return directory;
}

function recordingRunner(calls: string[][]): CommandRunner {
    return async (command) => {
        calls.push([...command]);
        if (command[0] === "git") return success("true\n");
        return success();
    };
}

function installCall(calls: readonly string[][]): readonly string[] {
    const command = calls.find((candidate) => candidate[1] === "add");
    if (!command) throw new Error("Expected the tool installation command.");
    return command;
}

describe("CLI initialization profiles", () => {
    test("installs TypeScript-Go 7 and anti-slop by default", async () => {
        const cwd = await temporaryDirectory();
        const calls: string[][] = [];

        const status = await runCli({
            args: ["--yes"],
            cwd,
            logger,
            runner: recordingRunner(calls),
        });

        expect(status).toBe(0);
        expect(installCall(calls)).toContain("typescript@7.0.2");
        expect(installCall(calls)).toContain("oxlint-tsgolint@7.0.2001");
        expect(installCall(calls)).toContain("@oxlint/plugins@1.77.0");
        expect(installCall(calls)).not.toContain("@effect/tsgo@0.36.4");
        expect(await Bun.file(join(cwd, "tools/oxlint/anti-slop/index.ts")).exists()).toBeTrue();
        expect(await Bun.file(join(cwd, "tools/oxlint/effect/index.ts")).exists()).toBeFalse();
        const oxlintConfig = await readFile(join(cwd, "oxlint.config.ts"), "utf8");
        expect(oxlintConfig).toContain('name: "anti-slop"');
        expect(oxlintConfig).not.toContain("@effect/tsgo");
        expect(calls.some((command) => command.includes("effect-tsgo"))).toBeFalse();
    });

    test("adds Effect TypeScript and Oxlint integrations with --effect", async () => {
        const cwd = await temporaryDirectory();
        const calls: string[][] = [];

        const status = await runCli({
            args: ["--effect", "--yes"],
            cwd,
            logger,
            runner: recordingRunner(calls),
        });

        expect(status).toBe(0);
        expect(installCall(calls)).toContain("@effect/tsgo@0.36.4");
        const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
            scripts: Record<string, string>;
        };
        expect(packageJson.scripts.prepare).toBe(
            "bunx --bun husky && effect-tsgo patch --typescript --oxlint",
        );
        const tsconfig = await readFile(join(cwd, "tsconfig.json"), "utf8");
        expect(tsconfig).toContain('"name": "@effect/language-service"');
        expect(tsconfig).toContain('"diagnostics": false');
        expect(await Bun.file(join(cwd, "tools/oxlint/effect/index.ts")).exists()).toBeTrue();
        const effectPlugin = await readFile(join(cwd, "tools/oxlint/effect/index.ts"), "utf8");
        expect(effectPlugin).toContain('name: "effect"');
        const oxlintConfig = await readFile(join(cwd, "oxlint.config.ts"), "utf8");
        expect(oxlintConfig).toContain("@effect/tsgo/oxlint-presets");
        expect(oxlintConfig).toContain('"effect/no-cascading-layer-provide": "error"');
        expect(calls).toContainEqual([
            process.execPath,
            "x",
            "--bun",
            "effect-tsgo",
            "setup",
            "--project",
            "tsconfig.json",
            "--non-interactive",
            "--accept-defaults",
            "--apply",
            "--typescript",
            "--oxlint",
        ]);
        expect(calls).toContainEqual([
            process.execPath,
            "x",
            "--bun",
            "effect-tsgo",
            "patch",
            "--typescript",
            "--oxlint",
        ]);
    });

    test("documents and accepts the effect option", async () => {
        const messages: string[] = [];
        const status = await runCli({
            args: ["--help"],
            logger: {
                error(message) {
                    if (message) messages.push(message);
                },
                log(message) {
                    if (message) messages.push(message);
                },
                warn(message) {
                    if (message) messages.push(message);
                },
            },
        });

        expect(status).toBe(0);
        expect(messages.join("\n")).toContain("--effect");
    });
});
