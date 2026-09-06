import type { Logger } from "./configure.ts";
import type { CommandRunner } from "./process.ts";

export async function initializeGitRepository(
    cwd: string,
    runner: CommandRunner,
    logger: Logger,
): Promise<void> {
    const probe = await runner(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd,
        stdio: "capture",
    });
    if (probe.exitCode === 0 && probe.stdout.trim() === "true") {
        logger.log("[unchanged] Git repository");
        return;
    }

    const command = ["git", "init", "-b", "main"] as const;
    const initialized = await runner(command, { cwd, stdio: "inherit" });
    if (initialized.exitCode !== 0) {
        throw new Error(`Unable to initialize Git repository (exit ${initialized.exitCode}).`);
    }
    logger.log("[created] Git repository with main as the initial branch");
}

export async function resolveGitHubOwner(
    runner: CommandRunner,
    cwd: string,
    flag: string | undefined,
): Promise<string> {
    if (flag !== undefined) {
        if (!/^[A-Za-z0-9-]+$/.test(flag)) throw new Error(`Invalid --owner "${flag}"`);
        return flag;
    }
    const message = "Cannot determine the GitHub owner: pass --owner <login> or authenticate gh.";
    let result;
    try {
        result = await runner(["gh", "api", "user", "--jq", ".login"], { cwd, stdio: "capture" });
    } catch {
        throw new Error(message);
    }
    if (result.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(result.stdout.trim())) {
        return result.stdout.trim();
    }
    throw new Error(message);
}
