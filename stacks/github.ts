import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";

const OWNER = "ImArtisann";

const REPOSITORY = "repo-int";

/**
 * One-shot stack for https://github.com/ImArtisann/repo-int: converges the
 * repository settings. Publishing uses npm trusted publishing (OIDC), so no
 * Actions secrets are managed here. Deploy with `bun run deploy:github`.
 */
export default Alchemy.Stack(
    "RepoIntGitHub",
    { providers: GitHub.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
        yield* GitHub.Repository("Repository", {
            owner: OWNER,
            name: REPOSITORY,
            description:
                "Scaffold a Bun + Vite+ monorepo with Effect tooling, Alchemy stacks, Convex/Confect, shadcn UI, R2 assets, TanStack Start, and Astro templates.",
            visibility: "public",
            hasWiki: false,
            hasProjects: false,
            hasDiscussions: false,
            allowMergeCommit: false,
            allowRebaseMerge: false,
            allowSquashMerge: true,
            deleteBranchOnMerge: true,
        });
    }),
);
