export interface CommandOptions {
    cwd: string;
    input?: string;
    stdio?: "capture" | "inherit";
}

export interface CommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export type CommandRunner = (
    command: readonly string[],
    options: CommandOptions,
) => Promise<CommandResult>;

export async function runCommand(
    command: readonly string[],
    options: CommandOptions,
): Promise<CommandResult> {
    const capture = options.stdio !== "inherit";
    const input =
        options.input === undefined ? (capture ? "ignore" : "inherit") : Buffer.from(options.input);
    const child = Bun.spawn([...command], {
        cwd: options.cwd,
        stdin: input,
        stdout: capture ? "pipe" : "inherit",
        stderr: capture ? "pipe" : "inherit",
    });

    const stdout = capture ? new Response(child.stdout).text() : Promise.resolve("");
    const stderr = capture ? new Response(child.stderr).text() : Promise.resolve("");
    const [exitCode, stdoutText, stderrText] = await Promise.all([child.exited, stdout, stderr]);

    return { exitCode, stderr: stderrText, stdout: stdoutText };
}

export function requireSuccess(command: readonly string[], result: CommandResult): void {
    if (result.exitCode === 0) return;

    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
        `Command failed (${result.exitCode}): ${command.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
}
