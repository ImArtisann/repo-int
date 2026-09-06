import type { WebsiteEnv } from "../alchemy.run.ts";

declare global {
    namespace App {
        interface Locals {
            runtime: { env: WebsiteEnv };
        }
    }
}

export {};
