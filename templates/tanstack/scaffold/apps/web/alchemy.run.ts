import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export class Website extends Cloudflare.Website.Vite<Website>()("Website", {
    env: {
        GREETING: "Hello from TanStack Start on Cloudflare!",
    },
}) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
    "__STACK_NAME__Web",
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const website = yield* Website;
        return { url: website.url };
    }),
);
