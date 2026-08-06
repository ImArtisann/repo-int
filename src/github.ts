import type { Logger } from "./configure.ts";
import type { CommandResult, CommandRunner } from "./process.ts";

const API_HEADERS = [
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
] as const;

export const MAIN_BRANCH_PROTECTION = {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: true,
} as const;

function isNotFound(result: CommandResult): boolean {
    return /(?:HTTP|status(?: code)?)[ /:]?404\b|\b404 Not Found\b/i.test(
        `${result.stderr}\n${result.stdout}`,
    );
}

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

export async function protectMainBranch(
    cwd: string,
    runner: CommandRunner,
    logger: Logger,
): Promise<"protected" | "skipped" | "unchanged"> {
    let repository: CommandResult;
    try {
        repository = await runner(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            { cwd, stdio: "capture" },
        );
    } catch (error) {
        logger.warn(
            `[skipped] GitHub branch protection: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "skipped";
    }

    const slug = repository.stdout.trim();
    if (repository.exitCode !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(slug)) {
        logger.warn(
            "[skipped] GitHub branch protection: this directory is not connected to an accessible GitHub repository.",
        );
        return "skipped";
    }

    const branchEndpoint = `repos/${slug}/branches/main`;
    const branch = await runner(["gh", "api", ...API_HEADERS, branchEndpoint], {
        cwd,
        stdio: "capture",
    });
    if (branch.exitCode !== 0) {
        logger.warn(
            `[skipped] GitHub branch protection: ${isNotFound(branch) ? "the remote main branch does not exist yet" : "unable to inspect the remote main branch"}.`,
        );
        return "skipped";
    }

    const protectionEndpoint = `${branchEndpoint}/protection`;
    const classicProtection = await runner(["gh", "api", ...API_HEADERS, protectionEndpoint], {
        cwd,
        stdio: "capture",
    });
    if (classicProtection.exitCode === 0) {
        logger.log("[unchanged] GitHub main branch protection");
        return "unchanged";
    }
    if (!isNotFound(classicProtection)) {
        logger.warn(
            "[skipped] GitHub branch protection: unable to determine the existing classic protection settings.",
        );
        return "skipped";
    }

    const activeRules = await runner(
        ["gh", "api", ...API_HEADERS, `repos/${slug}/rules/branches/main`],
        { cwd, stdio: "capture" },
    );
    if (activeRules.exitCode === 0) {
        let rules: unknown;
        try {
            rules = JSON.parse(activeRules.stdout);
        } catch {
            logger.warn(
                "[skipped] GitHub branch protection: GitHub returned invalid active-rules data.",
            );
            return "skipped";
        }
        if (!Array.isArray(rules)) {
            logger.warn(
                "[skipped] GitHub branch protection: GitHub returned unexpected active-rules data.",
            );
            return "skipped";
        }
        if (rules.length > 0) {
            logger.log("[unchanged] GitHub main branch is protected by an active ruleset");
            return "unchanged";
        }
    } else if (!isNotFound(activeRules)) {
        logger.warn(
            "[skipped] GitHub branch protection: unable to determine whether a ruleset already protects main.",
        );
        return "skipped";
    }

    const update = await runner(
        ["gh", "api", "--method", "PUT", ...API_HEADERS, protectionEndpoint, "--input", "-"],
        {
            cwd,
            input: `${JSON.stringify(MAIN_BRANCH_PROTECTION)}\n`,
            stdio: "capture",
        },
    );
    if (update.exitCode !== 0) {
        const detail = update.stderr.trim() || update.stdout.trim();
        logger.warn(
            `[skipped] GitHub branch protection could not be enabled${detail ? `: ${detail}` : "."}`,
        );
        return "skipped";
    }

    const verification = await runner(["gh", "api", ...API_HEADERS, protectionEndpoint], {
        cwd,
        stdio: "capture",
    });
    if (verification.exitCode !== 0) {
        throw new Error(
            "GitHub accepted branch protection, but the setting could not be verified.",
        );
    }

    logger.log("[protected] GitHub main branch");
    return "protected";
}
