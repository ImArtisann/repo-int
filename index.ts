#!/usr/bin/env bun

import { runCli } from "./src/cli.ts";

if (import.meta.main) {
    process.exitCode = await runCli({ args: Bun.argv.slice(2) });
}
