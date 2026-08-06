import { describe, expect, test } from "bun:test";
import type { Logger } from "./configure.ts";
import { MAIN_BRANCH_PROTECTION, protectMainBranch } from "./github.ts";
import type { CommandResult, CommandRunner } from "./process.ts";

const logger: Logger = { error() {}, log() {}, warn() {} };

function success(stdout = ""): CommandResult {
    return { exitCode: 0, stderr: "", stdout };
}

function notFound(): CommandResult {
    return { exitCode: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" };
}

describe("GitHub main branch protection", () => {
    test("does not update existing classic protection", async () => {
        const calls: readonly string[][] = [];
        const runner: CommandRunner = async (command) => {
            (calls as string[][]).push([...command]);
            if (command[1] === "repo") return success("owner/repo\n");
            if (command.at(-1)?.endsWith("/protection")) return success("{}\n");
            return success("{}\n");
        };

        const status = await protectMainBranch("/tmp/project", runner, logger);

        expect(status).toBe("unchanged");
        expect(calls.some((command) => command.includes("PUT"))).toBeFalse();
    });

    test("does not add classic protection over an active ruleset", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (command) => {
            calls.push([...command]);
            if (command[1] === "repo") return success("owner/repo\n");
            if (command.at(-1)?.endsWith("/protection")) return notFound();
            if (command.at(-1)?.includes("/rules/branches/main")) {
                return success('[{"type":"pull_request"}]\n');
            }
            return success("{}\n");
        };

        const status = await protectMainBranch("/tmp/project", runner, logger);

        expect(status).toBe("unchanged");
        expect(calls.some((command) => command.includes("PUT"))).toBeFalse();
    });

    test("creates and verifies protection only when main has no protection", async () => {
        const calls: string[][] = [];
        let protectionReads = 0;
        let requestBody = "";
        const runner: CommandRunner = async (command, options) => {
            calls.push([...command]);
            if (command[1] === "repo") return success("owner/repo\n");
            if (command.includes("PUT")) {
                requestBody = options.input ?? "";
                return success("{}\n");
            }
            if (command.at(-1)?.endsWith("/protection")) {
                protectionReads += 1;
                return protectionReads === 1 ? notFound() : success("{}\n");
            }
            if (command.at(-1)?.includes("/rules/branches/main")) return success("[]\n");
            return success("{}\n");
        };

        const status = await protectMainBranch("/tmp/project", runner, logger);

        expect(status).toBe("protected");
        expect(calls.filter((command) => command.includes("PUT"))).toHaveLength(1);
        expect(JSON.parse(requestBody)).toEqual(MAIN_BRANCH_PROTECTION);
        expect(protectionReads).toBe(2);
    });

    test("does not mutate protection when existing settings cannot be read", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (command) => {
            calls.push([...command]);
            if (command[1] === "repo") return success("owner/repo\n");
            if (command.at(-1)?.endsWith("/protection")) {
                return { exitCode: 1, stderr: "gh: Forbidden (HTTP 403)", stdout: "" };
            }
            return success("{}\n");
        };

        const status = await protectMainBranch("/tmp/project", runner, logger);

        expect(status).toBe("skipped");
        expect(calls.some((command) => command.includes("PUT"))).toBeFalse();
    });
});
