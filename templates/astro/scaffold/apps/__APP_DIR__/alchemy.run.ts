import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const Website = Cloudflare.Website.Astro("Website", {
    // Only hash the files that affect the build, so unchanged sources skip the deploy.
    memo: { include: ["src/**", "public/**", "package.json", "astro.config.ts"] },
    env: {
        GREETING: "Hello from Astro on Cloudflare!",
    },
});

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
    "__STACK_NAME____APP_STACK__",
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const website = yield* Website;

        return { url: website.url };
    }),
);
