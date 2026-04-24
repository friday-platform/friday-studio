# Team Lead Learnings — Teams Adapter BYO (declaw, 2026-04-22)

## Session summary

Wiring `@chat-adapter/teams` as the 5th BYO chat adapter in Friday (after Discord landed the same day). Six-task plan: schema → adapter factory → resolver → tracer-bullet route → docs → tests.

## Observations worth remembering

- **Chat source union lives in three places that must move together.** `StoredChatSchema` enum (storage.ts:34), the `createChat()` param type (storage.ts:100), and `ChatSdkStateAdapter.threadSources` Map + `setSource()` param (chat-sdk-state-adapter.ts:20, :31). Storm caught the createChat case; the original task description only listed two of the three. Consider adding a "when adding a chat source, update these three sites" note to CLAUDE.md gotchas.
- **Playground's `chat-list-panel.svelte` holds a fourth copy of the source union** that the Deno typecheck doesn't reach (Svelte scope). Low blast radius because deno task typecheck runs svelte-check separately, but worth documenting so future additions don't silently drift.
- **`@chat-adapter/teams` pulls in 19 transitive npm deps** — the full `@microsoft/teams.*` stack plus `msal-node`. Worth a one-liner in CLAUDE.md gotchas if bundle size or cold-start latency ever becomes a concern for atlasd.
- **`deno add npm:<pkg>@<version>` updates package.json + deno.lock in one shot.** No separate lock-refresh step needed. Good to document so teammates don't manually edit lockfiles.
- **Teams adapter config fields pass through as `undefined` safely** — `toAppOptions()` in the adapter uses `config.appTenantId ?? process.env.TEAMS_APP_TENANT_ID` for env fallback, so the factory can blindly forward optional fields without guards.
- **Tracer-bullet plan gate paid off on Task 4.** Ferox's plan surfaced one subtle issue before coding: `!chat.webhooks.teams` truthy check vs typed function check. They adopted the slack-mirrored truthy pattern, which matches how `chat.webhooks.<provider>` types surface (function | undefined on the Chat SDK side). One-round approval, clean commit.
- **`withTeamsEnv` fixture pattern for env var isolation.** Luka wrote a manual save/restore helper (vs `vi.stubEnv`) that's explicit about which keys it touches. Safer for tests that need guaranteed cleanup even when the assertion throws mid-test. Worth lifting to a shared test util if we add a 6th provider.
- **Route test for clone behavior: assert the Authorization header survives `c.req.raw.clone()`.** Luka proactively added this check to the primary-routing test. Catches a whole class of regressions where someone mutates the request before clone (the adapter needs the JWT header intact for validation). Good pattern to document.
