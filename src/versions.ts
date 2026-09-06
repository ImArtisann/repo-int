import { requireSuccess, type CommandRunner } from "./process.ts";

/**
 * Mutually compatible toolchain pins; bump them together or not at all.
 */
export const TOOLCHAIN = {
    // Bundles oxlint 1.79.0, oxlint-tsgolint 7.0.2001, oxfmt 0.64.0, vitest 4.1.11.
    "vite-plus": "0.3.0",
    // Supports oxlint 1.79.0/1.81.0, tsgolint 7.0.2001, and typescript 7.0.2.
    "@effect/tsgo": "0.41.0",
    // Must equal the @oxlint/plugins version pinned inside vite-plus.
    "@oxlint/plugins": "1.79.0",
    typescript: "7.0.2",
} as const;

/** Peer range alchemy 2.0.0-beta declares for effect. */
export const EFFECT_MINIMUM = ">=4.0.0-rc.112";

async function viewVersion(runner: CommandRunner, cwd: string, spec: string): Promise<string> {
    const command: readonly string[] = [process.execPath, "pm", "view", spec, "version"];
    const result = await runner(command, { cwd, stdio: "capture" });
    requireSuccess(command, result);
    const version = result.stdout.trim();
    if (version === "") throw new Error(`bun pm view ${spec} version returned no version.`);
    return version;
}

/**
 * Resolves a dist-tag spec such as "alchemy@latest" to its published version.
 * A failed or empty `@next` lookup retries `@latest` for that package only, so
 * `@confect/*` packages keep resolving after their next tag disappears.
 */
export async function resolveVersion(
    runner: CommandRunner,
    cwd: string,
    spec: string,
): Promise<string> {
    try {
        return await viewVersion(runner, cwd, spec);
    } catch (error) {
        if (!spec.endsWith("@next")) throw error;
        return viewVersion(runner, cwd, `${spec.slice(0, -"@next".length)}@latest`);
    }
}

/**
 * Resolves the effect version satisfying {@link EFFECT_MINIMUM}: latest once it
 * reaches the 4.x line, otherwise the rc tag alchemy and @confect/* peer on.
 */
export async function resolveEffectVersion(runner: CommandRunner, cwd: string): Promise<string> {
    const latest = await resolveVersion(runner, cwd, "effect@latest");
    return Bun.semver.satisfies(latest, EFFECT_MINIMUM)
        ? latest
        : resolveVersion(runner, cwd, "effect@rc");
}

/**
 * Catalog entries stay exact for prereleases (caret ranges skip them) and use a
 * caret otherwise.
 */
export function catalogRange(version: string): string {
    return version.includes("-") ? version : `^${version}`;
}
