# Slack apikey provider migration — team-lead learnings

Branch: `feature/slack-apikey-provider`. Session ran T17–T25 (T24 absorbed into T23 mid-flight).

## Codebase quirks

- **friday-studio is SQLite-only.** `supabase/` was deliberately pruned in commit `2aea5692`. Any task description or audit report that references `supabase/migrations/` is wrong for this repo. The `PostgresCommunicatorWiringRepository` class still exists gated on `POSTGRES_CONNECTION` env, but anyone running it has rolled their own schema. Likely worth a CLAUDE.md note so future migration tasks don't presuppose Postgres infra.
- **Hono RPC types resolve at the type level from route definitions.** Deleting a route's mount immediately removes its path from `client.foo.bar` types in any consumer package. Cross-package consumers TS-fail in the same commit, even if they live in `packages/core`. Practical rule: when deleting a Hono route group, audit `rg "client\.<path>"` across the whole repo and stage callers + routes in a single commit. T24 was merged into T23 mid-flight because of this — there's no clean intermediate state.
- **`deno task lint` runs biome auto-fix on unrelated files.** Three teammates (Almond, Ellie, Jinju-2) hit this independently. Always `git status` after lint and revert collateral on files outside your task's scope. Worth a CLAUDE.md note in the git workflow section.
- **`deno check` is hook-blocked in friday-studio.** Use `deno task typecheck` (runs `deno check` + `svelte-check` across workspace members). A single-file `deno check` would miss unused-import errors in `.svelte` files.
- **Pre-existing typecheck baseline:** 4 errors in `packages/system/agents/workspace-chat/tools/job-tools.test.ts` (TS2741 `onError` missing, TS18048 `callArgs` possibly undefined). Not from this work; teammates correctly filtered them out by stashing diffs and re-running.

## Patterns worth keeping

- **Routing-key schema vs full-secret schema as separate Zod objects.** In `apps/atlasd/src/services/communicator-wiring.ts`, `SlackCredentialSecretSchema = { app_id }` is the routing-key extraction shape. In `apps/atlasd/src/chat-sdk/chat-sdk-instance.ts`, `SlackLinkSecretSchema = { bot_token, signing_secret, app_id }` is the full-shape needed for resolution. These can't be the same schema — using the routing-key version for resolution would silently accept partial secrets. Storm caught this footgun in T19 and the discord/teams/whatsapp helpers follow the same split.
- **Single-element `z.discriminatedUnion` collapses to `z.object`.** Once `AppInstallCredentialSecretSchema` had only the `github` branch left, Ellie collapsed it from `z.discriminatedUnion("platform", [GitHubAppCredentialSecretSchema])` to a plain `z.object({ platform: z.literal("github"), ... })`. Clearer types, fewer chained narrowings, no surprises with `z.infer`. Generic principle: discriminated unions earn their keep with multiple branches.
- **Atomic deletion preferred over multi-commit orphan-import cycles.** Storm deleted `apps/atlasd/src/services/slack-credentials.ts` in T19 alongside removing its imports rather than punting to T23/T24, which would have left orphaned imports across intermediate commits. CLAUDE.md hard-rule on dead code is "remove entirely when fixing lint errors" — extend that to "delete in the same commit as the last consumer's removal."

## Recurring teammate mistakes (none worth a CLAUDE.md change)

- Each teammate wrote their first attempt assuming `deno check` was the right verification command and had to switch to `deno task typecheck`. The teammate-prompt template uses `deno check <changed-files>` — could be updated to use `deno task typecheck` since that's what actually works in friday-studio.

## Process notes

- **Stale teammate from prior session.** Mid-T25, an "unsolicited" task assignment arrived from a stale "Jinju" teammate left over from a previous team-led session. They tried to act as a peer-to-peer assigner. Cleaned up via `shutdown_request`. Worth a heads-up in `implementing-tasks` skill: when reusing an existing team (TeamCreate fails with "already leading"), check the team config's `members` for stale entries before proceeding.
- **Plan-approval gate worth keeping.** T17 was the only Tracer Bullet in this session. Po's plan caught two design decisions (where the auth.test call lives, what schema parses the response) that would have been harder to fix post-implementation. The 1-message plan-review cycle was cheap and high-value.
