import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import type { Logger } from "./configure.ts";
import type { CommandRunner } from "./process.ts";

const temporaryDirectories: string[] = [];
const logger: Logger = { error() {}, log() {}, warn() {} };
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
function recordingRunner(calls: { command: readonly string[]; cwd: string }[] = []): CommandRunner {
    return async (command, options) => {
        calls.push({ command: [...command], cwd: options.cwd });
        let stdout = "";
        if (command[0] === "git") stdout = "true\n";
        if (command[0] === "gh") stdout = "owner-from-gh\n";
        if (command[1] === "pm") {
            if (!(await Bun.file(join(options.cwd, "package.json")).exists())) {
                return { exitCode: 1, stdout: "", stderr: "No package.json was found" };
            }
            const spec = command[3] ?? "";
            const versions: Record<string, string> = {
                "alchemy@latest": "2.0.0-beta.76",
                "effect@latest": "3.22.1",
                "effect@rc": "4.0.0-rc.112",
            };
            stdout = versions[spec] ?? (spec.startsWith("@confect/") ? "10.0.0-next.21" : "1.2.3");
        }
        return { exitCode: 0, stdout, stderr: "" };
    };
}

describe("template CLI", () => {
    test("config produces a workspace toolchain with the requested GitHub owner", async () => {
        const cwd = await temporaryDirectory();
        expect(
            await runCli({
                args: ["config", "--yes", "--owner", "acme"],
                cwd,
                logger,
                runner: recordingRunner(),
            }),
        ).toBe(0);
        const pkg = await Bun.file(join(cwd, "package.json")).json();
        expect(pkg.workspaces).toEqual(["apps/*", "packages/*"]);
        expect(pkg.catalog).toMatchObject({
            alchemy: "2.0.0-beta.76",
            effect: "4.0.0-rc.112",
            lefthook: "^1.2.3",
        });
        expect(pkg.devDependencies.lefthook).toBe("catalog:");
        expect(pkg.devDependencies["vite-plus"]).toBe("0.3.0");
        expect(pkg.scripts.prepare).toBe(
            "lefthook install && effect-tsgo patch --typescript --oxlint",
        );
        expect(await Bun.file(join(cwd, "stacks/github.ts")).text()).toContain(
            'const OWNER = "acme"',
        );
        expect(await Bun.file(join(cwd, ".github/workflows/ci.yml")).exists()).toBeTrue();
        const filters = Bun.YAML.parse(await Bun.file(join(cwd, ".coderabbit.yaml")).text()) as {
            reviews: { path_filters: string[] };
        };
        expect(filters.reviews.path_filters).toContain("!tools/oxlint/**");
    });

    test("owner defaults to the authenticated GitHub user", async () => {
        const cwd = await temporaryDirectory();
        expect(
            await runCli({ args: ["config", "--yes"], cwd, logger, runner: recordingRunner() }),
        ).toBe(0);
        expect(await Bun.file(join(cwd, "stacks/github.ts")).text()).toContain(
            'const OWNER = "owner-from-gh"',
        );
    });

    test("frameworks require config before any scaffold writes", async () => {
        const cwd = await temporaryDirectory();
        const errors: string[] = [];
        expect(
            await runCli({
                args: ["convex", "--yes"],
                cwd,
                logger: { ...logger, error: (message) => errors.push(message ?? "") },
                runner: recordingRunner(),
            }),
        ).toBe(1);
        expect(errors.join("\n")).toContain("run `repo-int config` first");
        expect(await readdir(cwd)).toEqual([]);
    });

    test("canonical ordering reserves web for TanStack and static for Astro", async () => {
        const cwd = await temporaryDirectory();
        const calls: { command: readonly string[]; cwd: string }[] = [];
        expect(
            await runCli({
                args: ["astro", "tanstack", "config", "--yes"],
                cwd,
                logger,
                runner: recordingRunner(calls),
            }),
        ).toBe(0);
        const web = await Bun.file(join(cwd, "apps/web/package.json")).json();
        const astro = await Bun.file(join(cwd, "apps/static/package.json")).json();
        expect(web.name).toBe("@repo/web");
        expect(web.dependencies["@tanstack/react-start"]).toBe("catalog:");
        expect(astro.name).toBe("@repo/static");
        expect(astro.dependencies.astro).toBe("catalog:");
        const pkg = await Bun.file(join(cwd, "package.json")).json();
        expect(pkg.catalog["@alchemy.run/frontend-frameworks"]).toBe(pkg.catalog.alchemy);
        const filters = Bun.YAML.parse(await Bun.file(join(cwd, ".coderabbit.yaml")).text()) as {
            reviews: { path_filters: string[] };
        };
        expect(filters.reviews.path_filters).toContain("!apps/web/src/routeTree.gen.ts");
        expect(filters.reviews.path_filters).toContain("!apps/static/.astro/**");
        const buildIndex = calls.findIndex(
            ({ command }) => command[1] === "run" && command[2] === "build",
        );
        expect(buildIndex).toBeGreaterThan(
            calls.findIndex(({ command }) => command[1] === "install"),
        );
        expect(calls[buildIndex]?.cwd).toBe(join(cwd, "apps/web"));
    });

    test("backend code generation follows installation and excludes its generated targets", async () => {
        const cwd = await temporaryDirectory();
        const calls: { command: readonly string[]; cwd: string }[] = [];
        expect(
            await runCli({
                args: ["convex", "config", "--yes"],
                cwd,
                logger,
                runner: recordingRunner(calls),
            }),
        ).toBe(0);
        expect(
            await Bun.file(join(cwd, "packages/backend/confect/tables/notes.ts")).exists(),
        ).toBeTrue();
        const confect = calls.findIndex(
            ({ command }) => command.includes("confect") && command.includes("codegen"),
        );
        const ai = calls.findIndex(({ command }) => command.includes("ai-files"));
        expect(confect).toBeGreaterThan(calls.findIndex(({ command }) => command[1] === "install"));
        expect(ai).toBeGreaterThan(confect);
        expect(calls[confect]?.cwd).toBe(join(cwd, "packages/backend"));
        const pkg = await Bun.file(join(cwd, "package.json")).json();
        expect(pkg.catalog["@confect/core"]).toBe("10.0.0-next.21");
        const filters = Bun.YAML.parse(await Bun.file(join(cwd, ".coderabbit.yaml")).text()) as {
            reviews: { path_filters: string[] };
        };
        expect(filters.reviews.path_filters).toContain("!packages/backend/convex/**");
    });

    test("rerunning config preserves bytes and avoids catalog resolution", async () => {
        const cwd = await temporaryDirectory();
        const options = {
            args: ["config", "--yes", "--owner", "acme"],
            cwd,
            logger,
            runner: recordingRunner(),
        };
        expect(await runCli(options)).toBe(0);
        const before = await Bun.file(join(cwd, "package.json")).text();
        const calls: { command: readonly string[]; cwd: string }[] = [];
        const messages: string[] = [];
        expect(
            await runCli({
                ...options,
                runner: recordingRunner(calls),
                logger: { ...logger, log: (message) => messages.push(message ?? "") },
            }),
        ).toBe(0);
        expect(await Bun.file(join(cwd, "package.json")).text()).toBe(before);
        expect(messages.filter((message) => /\[(created|updated)\]/.test(message))).toEqual([]);
        expect(calls.filter(({ command }) => command[1] === "pm")).toEqual([]);
    });

    test("occupied app directories fail before modifying existing files", async () => {
        const cwd = await temporaryDirectory();
        await mkdir(join(cwd, "apps/web"), { recursive: true });
        await Bun.write(join(cwd, "apps/web/keep.txt"), "user content");
        expect(
            await runCli({
                args: ["config", "tanstack", "--owner", "acme", "--yes"],
                cwd,
                logger,
                runner: recordingRunner(),
            }),
        ).toBe(1);
        expect(await Bun.file(join(cwd, "package.json")).exists()).toBeFalse();
        expect(await Bun.file(join(cwd, "apps/web/keep.txt")).text()).toBe("user content");
    });

    test("all-template reruns preserve framework review exclusions without rewriting files", async () => {
        const cwd = await temporaryDirectory();
        const options = {
            args: ["config", "convex", "tanstack", "astro", "--owner", "acme", "--yes"],
            cwd,
            logger,
            runner: recordingRunner(),
        };
        expect(await runCli(options)).toBe(0);
        const before = await Bun.file(join(cwd, ".coderabbit.yaml")).text();
        const messages: string[] = [];
        expect(
            await runCli({
                ...options,
                logger: { ...logger, log: (message) => messages.push(message ?? "") },
            }),
        ).toBe(0);
        expect(await Bun.file(join(cwd, ".coderabbit.yaml")).text()).toBe(before);
        expect(messages.filter((message) => /\[(created|updated)\]/.test(message))).toEqual([]);
    });

    test("Astro alone uses web and preserves edited scaffold files on rerun", async () => {
        const cwd = await temporaryDirectory();
        const options = {
            args: ["config", "astro", "--owner", "acme", "--yes"],
            cwd,
            logger,
            runner: recordingRunner(),
        };
        expect(await runCli(options)).toBe(0);
        expect((await Bun.file(join(cwd, "apps/web/package.json")).json()).dependencies.astro).toBe(
            "catalog:",
        );
        const page = join(cwd, "apps/web/src/pages/index.astro");
        await Bun.write(page, "<h1>My edited page</h1>\n");
        expect(await runCli({ ...options, args: ["astro", "--yes"] })).toBe(0);
        expect(await Bun.file(page).text()).toBe("<h1>My edited page</h1>\n");
        expect(await Bun.file(join(cwd, "apps/static/package.json")).exists()).toBeFalse();
    });

    test("invalid owner fails before version lookups or file writes", async () => {
        const cwd = await temporaryDirectory();
        const calls: { command: readonly string[]; cwd: string }[] = [];
        expect(
            await runCli({
                args: ["config", "--owner", "acme/other", "--yes"],
                cwd,
                logger,
                runner: recordingRunner(calls),
            }),
        ).toBe(1);
        expect(await readdir(cwd)).toEqual([]);
        expect(calls.some(({ command }) => command[1] === "pm")).toBeFalse();
    });

    test("help succeeds without initializing a repository and missing positionals fail", async () => {
        expect(
            await runCli({
                args: ["--help"],
                logger,
                runner: async () => {
                    throw new Error("Help must not execute commands");
                },
            }),
        ).toBe(0);
        expect(await runCli({ args: [], logger })).toBe(1);
    });

    test("packages added before apps integrate both frontend frameworks", async () => {
        const cwd = await temporaryDirectory();
        const options = { cwd, logger, runner: recordingRunner() };
        expect(
            await runCli({ ...options, args: ["assets", "ui", "config", "--owner", "acme"] }),
        ).toBe(0);
        expect(await runCli({ ...options, args: ["astro", "tanstack"] })).toBe(0);
        const web = await Bun.file(join(cwd, "apps/web/package.json")).json();
        const astro = await Bun.file(join(cwd, "apps/static/package.json")).json();
        expect(web.dependencies).toMatchObject({
            "@repo/ui": "workspace:*",
            "@repo/assets": "workspace:*",
            "@unpic/react": "catalog:",
        });
        expect(astro.dependencies).toMatchObject({
            "@repo/assets": "workspace:*",
            "@unpic/astro": "catalog:",
        });
        expect(astro.dependencies["@repo/ui"]).toBeUndefined();
        expect(
            await Bun.file(join(cwd, "apps/web/src/components/AssetImage.tsx")).exists(),
        ).toBeTrue();
        expect(
            await Bun.file(join(cwd, "apps/static/src/components/AssetImage.astro")).exists(),
        ).toBeTrue();
    });

    test("adding packages to an existing app preserves edits and integrates only once", async () => {
        const cwd = await temporaryDirectory();
        const options = { cwd, logger, runner: recordingRunner() };
        expect(await runCli({ ...options, args: ["config", "tanstack", "--owner", "acme"] })).toBe(
            0,
        );
        const stylesheet = join(cwd, "apps/web/src/styles.css");
        const route = join(cwd, "apps/web/src/routes/index.tsx");
        const customCss = '@import "tailwindcss";\n.brand { color: red; }\n';
        await Bun.write(stylesheet, customCss);
        await Bun.write(route, "export const customRoute = true;\n");
        expect(await runCli({ ...options, args: ["ui", "assets"] })).toBe(0);
        const integratedCss = await Bun.file(stylesheet).text();
        expect(integratedCss).toBe(
            '@import "@repo/ui/styles/globals.css";\n.brand { color: red; }\n',
        );
        const image = join(cwd, "apps/web/src/components/AssetImage.tsx");
        await Bun.write(image, "export const customImage = true;\n");
        expect(await runCli({ ...options, args: ["assets", "ui", "--yes"] })).toBe(0);
        expect(await Bun.file(stylesheet).text()).toBe(integratedCss);
        expect(await Bun.file(route).text()).toBe("export const customRoute = true;\n");
        expect(await Bun.file(image).text()).toBe("export const customImage = true;\n");
    });

    test("occupied package directories fail before scaffolding", async () => {
        const cwd = await temporaryDirectory();
        await mkdir(join(cwd, "packages/assets"), { recursive: true });
        await Bun.write(join(cwd, "packages/assets/package.json"), '{"name":"my-assets"}');
        expect(
            await runCli({
                args: ["config", "assets", "--owner", "acme", "--yes"],
                cwd,
                logger,
                runner: recordingRunner(),
            }),
        ).toBe(1);
        expect(await Bun.file(join(cwd, "package.json")).exists()).toBeFalse();
        expect(await Bun.file(join(cwd, "packages/assets/package.json")).text()).toBe(
            '{"name":"my-assets"}',
        );
    });

    test("asset bucket defaults satisfy R2 naming limits for long npm-compatible names", async () => {
        const cwd = join(await temporaryDirectory(), `My.Project__${"x".repeat(70)}`);
        await mkdir(cwd);
        expect(
            await runCli({
                args: ["config", "assets", "--owner", "acme"],
                cwd,
                logger,
                runner: recordingRunner(),
            }),
        ).toBe(0);
        const { DEFAULT_ASSETS_BUCKET_NAME: bucket } = await import(
            join(cwd, "packages/assets/src/config.ts")
        );
        expect(bucket).toHaveLength(63);
        expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]*-assets$/);
        const { parseEnv } = await import("node:util");
        const example = parseEnv(await Bun.file(join(cwd, "packages/assets/.env.example")).text());
        expect(example.ASSETS_BUCKET_NAME).toBe(bucket);
    });
});
