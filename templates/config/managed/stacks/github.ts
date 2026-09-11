import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const OWNER = "__OWNER__";

const REPOSITORY = "__REPO_NAME__";

/**
 * One-shot stack for https://github.com/__OWNER__/__REPO_NAME__: converges the
 * repository settings, mints a scoped Cloudflare deployment token, and stores it
 * as GitHub Actions secrets. Deploy with `bun run deploy:github` after
 * `alchemy login --profile admin`.
 */
export default Alchemy.Stack(
    "__STACK_NAME__GitHub",
    {
        providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        yield* GitHub.Repository("Repository", {
            owner: OWNER,
            name: REPOSITORY,
            visibility: "private",
            hasWiki: false,
            hasProjects: false,
            hasDiscussions: false,
            allowMergeCommit: false,
            allowRebaseMerge: false,
            allowSquashMerge: true,
            deleteBranchOnMerge: true,
        });

        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

        const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("DeploymentToken", {
            accountId,
            policies: [
                {
                    effect: "allow",
                    permissionGroups: [
                        "Secrets Store Write",
                        "Workers Scripts Write",
                        "Workers KV Storage Write",
                        "Workers R2 Storage Write",
                        "D1 Write",
                        "Queues Write",
                        "Account Settings Write",
                        "Workers Tail Read",
                    ],
                    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                },
            ],
        });

        yield* GitHub.Secret("CloudflareApiToken", {
            owner: OWNER,
            repository: REPOSITORY,
            name: "CLOUDFLARE_API_TOKEN",
            value: apiToken.value,
        });

        yield* GitHub.Secret("CloudflareAccountId", {
            owner: OWNER,
            repository: REPOSITORY,
            name: "CLOUDFLARE_ACCOUNT_ID",
            value: Redacted.make(accountId),
        });
    }),
);
