import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { CommandOptions, CommandRunner } from "./runner.ts";
import { run } from "./testkit.ts";
import { catalogRange, resolveVersion } from "./versions.ts";

type ViewAnswers = Record<string, string | Error>;

function viewRunner(answers: ViewAnswers): CommandRunner {
    return async (command) => {
        if (command[1] !== "pm" || command[2] !== "view") {
            throw new Error(`unexpected command: ${command.join(" ")}`);
        }

        const spec = command[3] ?? "";
        const answer = answers[spec];

        if (answer === undefined) throw new Error(`unexpected pm view spec: ${spec}`);

        if (answer instanceof Error) return { exitCode: 1, stdout: "", stderr: answer.message };

        return { exitCode: 0, stdout: `${answer}\n`, stderr: "" };
    };
}

describe("resolveVersion", () => {
    test("returns the trimmed version for a dist-tag spec", async () => {
        const calls: { command: readonly string[]; options: CommandOptions }[] = [];

        const runner: CommandRunner = async (command, options) => {
            calls.push({ command: [...command], options });

            return { exitCode: 0, stdout: "2.0.0-beta.76\n", stderr: "" };
        };

        expect(await run(resolveVersion("target", "alchemy@latest"), { runner })).toBe(
            "2.0.0-beta.76",
        );

        expect(calls).toEqual([
            {
                command: [process.execPath, "pm", "view", "alchemy@latest", "version"],
                options: { cwd: "target", stdio: "capture" },
            },
        ]);
    });

    test("propagates registry lookup failures", async () => {
        const runner = viewRunner({ "alchemy@latest": new Error("404 Not Found") });

        const error = await run(Effect.flip(resolveVersion("target", "alchemy@latest")), {
            runner,
        });

        expect(error.message).toContain("Command failed");
    });
});

describe("catalogRange", () => {
    test("keeps prereleases exact and caret-ranges releases", () => {
        expect(catalogRange("2.0.0-beta.76")).toBe("2.0.0-beta.76");
        expect(catalogRange("19.2.8")).toBe("^19.2.8");
    });
});
