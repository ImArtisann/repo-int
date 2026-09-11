import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { CommandOptions, CommandRunner } from "./runner.ts";
import { run } from "./testkit.ts";
import { catalogRange, resolveEffectVersion, resolveVersion } from "./versions.ts";

type ViewAnswers = Record<string, string | Error>;

function viewRunner(answers: ViewAnswers, specs: string[] = []): CommandRunner {
    return async (command) => {
        if (command[1] !== "pm" || command[2] !== "view") {
            throw new Error(`unexpected command: ${command.join(" ")}`);
        }

        const spec = command[3] ?? "";
        specs.push(spec);
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

    test("falls back to latest when a next dist-tag is gone", async () => {
        const specs: string[] = [];

        const runner = viewRunner(
            {
                "@confect/core@next": new Error("No match found for version next"),
                "@confect/core@latest": "10.0.0",
            },
            specs,
        );

        expect(await run(resolveVersion("target", "@confect/core@next"), { runner })).toBe(
            "10.0.0",
        );
        expect(specs).toEqual(["@confect/core@next", "@confect/core@latest"]);
    });

    test("falls back to latest when a next dist-tag resolves to nothing", async () => {
        const runner = viewRunner({ "@confect/core@next": "", "@confect/core@latest": "10.0.0" });

        expect(await run(resolveVersion("target", "@confect/core@next"), { runner })).toBe(
            "10.0.0",
        );
    });

    test("propagates failures for specs without a next tag", async () => {
        const runner = viewRunner({ "alchemy@latest": new Error("404 Not Found") });

        const error = await run(Effect.flip(resolveVersion("target", "alchemy@latest")), {
            runner,
        });

        expect(error.message).toContain("Command failed");
    });
});

describe("resolveEffectVersion", () => {
    test("picks the rc line when latest is below the alchemy peer range", async () => {
        const specs: string[] = [];

        const runner = viewRunner(
            { "effect@latest": "3.22.1", "effect@rc": "4.0.0-rc.112" },
            specs,
        );

        expect(await run(resolveEffectVersion("target"), { runner })).toBe("4.0.0-rc.112");
        expect(specs).toEqual(["effect@latest", "effect@rc"]);
    });

    test("keeps latest once it satisfies the peer range", async () => {
        const specs: string[] = [];
        const runner = viewRunner({ "effect@latest": "4.0.0" }, specs);

        expect(await run(resolveEffectVersion("target"), { runner })).toBe("4.0.0");
        expect(specs).toEqual(["effect@latest"]);
    });

    test("picks the rc line while latest is on an older prerelease", async () => {
        const runner = viewRunner({
            "effect@latest": "4.0.0-rc.111",
            "effect@rc": "4.0.0-rc.112",
        });

        expect(await run(resolveEffectVersion("target"), { runner })).toBe("4.0.0-rc.112");
    });
});

describe("catalogRange", () => {
    test("keeps prereleases exact and caret-ranges releases", () => {
        expect(catalogRange("2.0.0-beta.76")).toBe("2.0.0-beta.76");
        expect(catalogRange("19.2.8")).toBe("^19.2.8");
    });
});
