import { createInterface } from "node:readline/promises";
import {
    configurePackageJson,
    loadTemplates,
    synchronizeManagedFile,
    type Confirm,
    type Logger,
} from "./configure.ts";
import { initializeGitRepository, protectMainBranch } from "./github.ts";
import { requireSuccess, runCommand, type CommandRunner } from "./process.ts";

const TOOL_PACKAGES = ["oxfmt", "oxlint", "husky", "lint-staged"] as const;

export interface CliOptions {
    args?: readonly string[];
    confirm?: Confirm;
    cwd?: string;
    logger?: Logger;
    runner?: CommandRunner;
}

const HELP = `repo-int

Usage:
  bun x @imartisann/repo-int [--yes]

Options:
  -y, --yes  Replace every differing managed configuration without prompting
  -h, --help Show this help
`;

export async function runCli(options: CliOptions = {}): Promise<number> {
    const args = options.args ?? [];
    const unknown = args.filter((arg) => !["--yes", "-y", "--help", "-h"].includes(arg));
    const logger = options.logger ?? console;
    if (unknown.length > 0) {
        logger.error(`Unknown option: ${unknown.join(", ")}\n\n${HELP}`);
        return 1;
    }
    if (args.includes("--help") || args.includes("-h")) {
        logger.log(HELP);
        return 0;
    }

    const cwd = options.cwd ?? process.cwd();
    const runner = options.runner ?? runCommand;
    const assumeYes = args.includes("--yes") || args.includes("-y");
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    const readline =
        !options.confirm && interactive
            ? createInterface({ input: process.stdin, output: process.stdout })
            : undefined;
    const confirm: Confirm =
        options.confirm ??
        (assumeYes
            ? async () => true
            : interactive && readline
              ? async (question) => {
                    const answer = await readline.question(`${question} [y/N] `);
                    return /^(?:y|yes)$/i.test(answer.trim());
                }
              : async (question) => {
                    logger.warn(
                        `[kept] ${question} Non-interactive input; use --yes to replace it.`,
                    );
                    return false;
                });

    try {
        logger.log(`Initializing ${cwd}`);
        await initializeGitRepository(cwd, runner, logger);

        const templates = await loadTemplates();
        const lintStaged = templates.find(({ tool }) => tool === "lint-staged");
        if (!lintStaged) throw new Error("The packaged lint-staged template is missing.");

        const desiredLintStaged = JSON.parse(lintStaged.content) as unknown;
        const { manageLintStagedFile } = await configurePackageJson(
            cwd,
            desiredLintStaged,
            confirm,
            logger,
        );

        for (const template of templates) {
            if (template.tool === "lint-staged" && !manageLintStagedFile) continue;
            await synchronizeManagedFile(cwd, template, confirm, logger);
        }

        const installCommand = [process.execPath, "add", "--dev", ...TOOL_PACKAGES] as const;
        logger.log(`Installing ${TOOL_PACKAGES.join(", ")}...`);
        const installed = await runner(installCommand, { cwd, stdio: "inherit" });
        requireSuccess(installCommand, installed);

        const huskyCommand = [process.execPath, "x", "--bun", "husky"] as const;
        const husky = await runner(huskyCommand, { cwd, stdio: "inherit" });
        requireSuccess(huskyCommand, husky);
        logger.log("[configured] Husky Git hooks");

        await protectMainBranch(cwd, runner, logger);
        logger.log("Repository initialization complete.");
        return 0;
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        readline?.close();
    }
}
