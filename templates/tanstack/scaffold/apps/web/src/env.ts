import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../alchemy.run.ts";

export const env = new Proxy(
    // SAFETY: bindings arrive after module evaluation; reads forward to the live WebsiteEnv.
    {} as WebsiteEnv,
    {
        get(_target, property) {
            // SAFETY: WebsiteEnv keys are exactly the bindings declared in alchemy.run.ts.
            return cf.env[property as keyof typeof cf.env];
        },
    },
);
