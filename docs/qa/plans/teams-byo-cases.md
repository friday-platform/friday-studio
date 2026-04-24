# QA Plan: Microsoft Teams BYO (end-to-end)

**Context**: Bring-your-own Teams credentials — `resolveTeamsCredentials` reads
`TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` / `TEAMS_APP_TENANT_ID` from env, with
per-workspace `workspace.yml` overrides. All-or-nothing guard (partial creds →
`null` + `teams_missing_credentials` log). `SingleTenant` apps fail-fast if
`app_tenant_id` is absent. Inbound activities hit `POST /signals/teams` through
`webhook-tunnel`; the route extracts `activity.recipient.id` (format
`28:<appId>`), strips the prefix, and matches against each teams workspace's
`app_id`. Coexists with Slack / Telegram / WhatsApp / Discord.
**Branch**: `declaw`
**Date**: 2026-04-22
**Related docs**: `docs/integrations/teams/README.md` (user setup guide)

## Prerequisites

### Environment

- Full dev stack: `deno task dev:playground`
  - daemon on `:8080`
  - link on `:3100` (running but unused by Teams BYO)
  - playground on `:5200`
  - `webhook-tunnel` REQUIRED — Azure Bot Service only accepts a public HTTPS
    messaging endpoint. `dev:playground` starts a Cloudflare quick-tunnel that
    exposes `:8080` externally; the URL is logged at startup (grep
    `tunnel_ready` or watch the terminal)
- Credentials file writable: `~/.atlas/.env`

### Accounts / external

- **Azure subscription** (F0 pricing tier is free, sufficient)
- **Microsoft 365 tenant** where you can sideload a custom Teams app
  (personal M365 Developer Program account works; many corporate tenants
  block custom app upload)
- Teams desktop or web client logged in to that tenant

### Artifacts to have ready before cases run

After setup, you should have:
- **Two** Azure Bot resources (call them `friday-qa-alpha` and `friday-qa-beta`)
  with their own App IDs, client secrets, and — if SingleTenant —
  Directory IDs. Case 4 requires both; cases 1–3, 5, 6 only need the first.
- `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID` for the alpha bot
  in `~/.atlas/.env`
- Messaging endpoint on each Azure Bot pointed at
  `https://<tunnel>/platform/teams` (same URL for both — routing happens by
  `app_id`)
- Teams channel enabled on each Azure Bot
- Two sideloaded Teams apps (manifest.json with `bots[].botId` set to each bot's
  App ID respectively), uploaded via Teams **Apps → Manage your apps → Upload
  a custom app**
- Two Friday test workspaces (e.g. `teams-qa-alpha`, `teams-qa-beta`) with a
  `teams-chat` signal in each `workspace.yml`:
  ```yaml
  signals:
    teams-chat:
      title: "Chat via Teams"
      description: "Receives DMs and @mentions from Microsoft Teams"
      provider: teams
      config:
        app_id: "<alpha-app-id>"       # MUST match the Azure Bot's App ID
        app_type: "MultiTenant"        # or SingleTenant; see README § SingleTenant vs MultiTenant
  ```
  `teams-qa-beta` uses the beta App ID. Leaving `app_password` out of
  `workspace.yml` is fine for the alpha workspace because `~/.atlas/.env`
  supplies it; the beta workspace needs `app_password` inline (env can only
  hold one secret).

## Setup Walkthrough (not test cases — prep before running)

Follow `docs/integrations/teams/README.md` Steps 1–8 exactly. If anything
in that README is unclear or broken, **that is itself a finding** — flag it
in the report under "Setup friction." Don't silently work around it.

Rough path for the alpha bot:

1. [portal.azure.com](https://portal.azure.com) → Create a resource → **Azure
   Bot** → F0 tier → **Type of App: SingleTenant** (recommended for dev) →
   Create new Microsoft App ID → Review + create
2. Bot resource → **Configuration** → copy **Microsoft App ID**
3. **Manage Password** → **Certificates & secrets** → **New client secret** →
   copy the **Value** (shown once; if you miss it, delete + recreate)
4. Overview → copy **Directory (tenant) ID**
5. Write to `~/.atlas/.env`:
   ```bash
   TEAMS_APP_ID=<alpha-app-id>
   TEAMS_APP_PASSWORD=<alpha-client-secret>
   TEAMS_APP_TENANT_ID=<alpha-tenant-id>
   ```
6. Bot resource → **Configuration** → **Messaging endpoint** →
   `https://<tunnel>/platform/teams` → **Apply**
7. **Channels** → Microsoft Teams → Accept ToS → **Apply**
8. Create workspace via playground UI; edit `workspace.yml` to add the
   `teams-chat` signal with `app_id: <alpha-app-id>`
9. Restart daemon so the workspace reloads
10. Build manifest.json (see README § Build the Teams app package), zip it
    with the two icon PNGs, sideload into Teams (**Apps → Manage your apps
    → Upload a custom app**)

For the beta bot (case 4 only): repeat steps 1–4 and 6–10 with different
names. Put the beta credentials inline in `teams-qa-beta/workspace.yml`
(`app_password`, `app_tenant_id`) since the env vars are already bound to
alpha.

### Daemon log tail to keep open during testing

```bash
tail -f ~/.atlas/logs/global.log | grep -iE "teams|chat_sdk"
```

### DO NOT test via Azure Portal's "Test in Web Chat" panel

`@chat-adapter/teams` is layered on `@microsoft/teams.apps`, whose `App.send()`
hardcodes `channelId: 'msteams'` and `serviceUrl: this.api.serviceUrl` (defaults
to `https://smba.trafficmanager.net/teams`). Azure Portal's Test in Web Chat
channel delivers activities via `https://webchat.botframework.com/` — the
conversation ID doesn't exist on the Teams endpoint, so every outbound reply
401s with `{"message":"Authorization has been denied for this request."}`.

This isn't a credential or wiring bug. The adapter is Teams-only by design and
ignores the inbound activity's `serviceUrl`. Validate round-trips via the real
Microsoft Teams client after sideloading the manifest (case 2 below).

### Tunnel URL sanity check

Before starting cases, hit the tunnel URL from outside the laptop (phone
hotspot, another machine) to confirm Azure can reach it:

```bash
curl -i https://<tunnel>/platform/teams -X POST \
  -H 'Content-Type: application/json' \
  -d '{"recipient":{"id":"28:not-a-real-bot"}}'
```

Expect HTTP 404 with `{"error":"No workspace configured for Teams"}` (the
bot id doesn't match anything). Anything else (connection refused, 502, 5xx
from Cloudflare) means the tunnel isn't up.

## Cases

### 1. Daemon loads teams workspace + passes credential guard

**Smoke candidate — strong.** Deterministic, runs in ~5s, covers resolver +
factory wiring in one shot. No human Teams interaction required.

**Trigger**: Restart the daemon with `TEAMS_*` env vars set and the
`teams-qa-alpha` workspace.yml in place.

```bash
deno task atlas daemon stop
deno task atlas daemon start --detached
# or wait for dev-watcher to respawn if running dev:playground
```

**Expect**:
- Daemon logs `chat_sdk_instance_created` for `teams-qa-alpha` with `adapters`
  containing `["atlas", "teams"]`
- **No** `teams_missing_credentials` log for this workspace
- **No** thrown `ValidationError` from the `@microsoft/teams.apps` `App`
  constructor (if this fires, the resolver let partial creds through — a real
  regression)
- `GET http://localhost:8080/api/workspaces/teams-qa-alpha` returns the workspace

**If broken**:
- `teams_missing_credentials` with `missing` listing fields → env not loaded;
  `dev:playground` reads `~/.atlas/.env` so verify it's written there, not
  just exported in your shell
- `App` constructor throws → resolver guard has a hole; check recent edits
  to `resolveTeamsCredentials` in `apps/atlasd/src/chat-sdk/chat-sdk-instance.ts`
- Workspace loads but `adapters` is just `["atlas"]` → `findChatProviders`
  didn't pick up `provider: teams`, or `buildAdapter` threw silently; search
  logs for `platform_adapter_skipped_no_credentials`

### 2. DM round-trip

**Trigger**: In Teams, find the sideloaded alpha bot under **Apps → Built for
your org** (or wherever your tenant surfaces custom apps). Open a 1:1 chat
with it. Send "hello friday".

**Expect**:
- Within ~2–3s, a new chat appears in http://localhost:5200/platform/user/chat
  tagged with a **TEAMS** badge
- The user message records your Teams user ID and display name
- Session runs, `chat` signal fires on `teams-qa-alpha`
- Bot posts a reply back in the DM (any reply proves the round-trip)
- Daemon log shows `teams_signal_received` with
  `{ workspaceId: "teams-qa-alpha", appId: "<alpha-app-id>" }`

**If broken**:
- Azure Bot's **Test in Web Chat** panel shows 401 / 403 / "Endpoint
  unauthorized" → JWT validation failed inside the adapter. Most common
  causes: `TEAMS_APP_PASSWORD` is stale (client secret was rotated), or
  `app_type: SingleTenant` in workspace.yml but the Azure Bot is
  MultiTenant-registered (or vice versa)
- Activity reaches atlasd (`teams_signal_received` logged) but no chat in
  UI → adapter accepted the JWT but the message handler errored downstream;
  look for `thread_post_failed` or `chat_sdk_append_message_failed`
- No `teams_signal_received` log at all → tunnel didn't forward the request.
  Check the `webhook-tunnel` log for 4xx at `/platform/teams`, and verify
  the Azure Bot's Messaging endpoint value is exactly the current tunnel URL
- 500 response logged by `teams_webhook_handler_failed` → adapter threw
  (expired secret is the usual suspect)
- Reply never appears in Teams but the chat recorded correctly in the UI →
  outbound send failed; the adapter needs the cached `serviceUrl` which DMs
  usually receive naturally on the first inbound activity. If this is the
  first message ever, retry once

### 3. @mention in a Teams channel

**Trigger**: Add the alpha bot to a Team (the sideloaded app should offer
**Add to a team** in its install dialog). Post in any channel: `@<bot-name>
ping` (use Teams autocomplete so it renders as a mention pill, not plain
text).

**Expect**:
- Same flow as case 2 — chat appears in Friday UI with a **TEAMS** badge,
  bot replies in the same channel
- The chat metadata contains a non-DM conversation id (DM case would be
  a 1:1 conversation). `recipient.id` should still match alpha's App ID

**If broken**:
- Bot silent even though case 2 worked → check **Resource-Specific Consent**
  in the manifest. Without `ChannelMessage.Read.Group` or similar, Teams
  bots only receive messages when directly @mentioned. If the mention
  rendered as plain text (Discord-style), Teams won't deliver the event
- Bot replies but the reply doesn't appear in the channel → tenant policy
  blocks posting into channels. Test in a team you own
- Chat appears under the WRONG workspace → almost certainly a case 4 issue
  bleeding into the single-workspace test; double-check only `teams-qa-alpha`
  is active right now

### 4. Multi-workspace routing by `recipient.id` → `app_id`

**The Teams-unique case.** No other chat adapter in Friday routes this way.

**Prerequisite**: BOTH alpha AND beta bots created, sideloaded, and both
Friday workspaces (`teams-qa-alpha`, `teams-qa-beta`) wired up with their
respective `app_id` values in `workspace.yml`.

**Trigger**: Send a DM to the **alpha** bot: "alpha hello". Then, within
~30 seconds, send a DM to the **beta** bot: "beta hello".

**Expect**:
- Two separate chats in http://localhost:5200/platform/user/chat, each with
  a **TEAMS** badge
- One chat belongs to `teams-qa-alpha`, the other to `teams-qa-beta` — check
  the workspace badge / breadcrumb in the chat UI, or the workspace scope on
  the chat detail page
- Daemon logs show two `teams_signal_received` entries with distinct
  `{ workspaceId, appId }` pairs
- **No** `teams_no_app_id_fallback` or `teams_app_id_mismatch_fallback`
  warnings — both activities should hit the primary `findWorkspaceByProvider`
  match, not any fallback path

**If broken**:
- Both messages land in the same workspace → `findWorkspaceByProvider(…
  "app_id" …)` isn't matching. Check that the `app_id` in each
  `workspace.yml` is the exact Azure App ID (GUID format, no `28:` prefix —
  that prefix only appears in the inbound activity's `recipient.id`)
- `teams_app_id_mismatch_fallback` fires on either message → workspace.yml's
  `app_id` doesn't match the activity's `recipient.id`. Typo somewhere;
  compare the logged `appId` against the configured value
- One bot's messages never reach atlasd → that bot's Messaging endpoint in
  Azure wasn't updated with the current tunnel URL, OR `app_password` for
  the beta bot isn't in `teams-qa-beta/workspace.yml` (env holds alpha's
  password only)

### 5. `teams_app_id_mismatch_fallback` log fires on workspace.yml typo

**Trigger**: Edit `teams-qa-alpha/workspace.yml` and change the `app_id` to
a deliberate typo (append `-typo`):

```yaml
signals:
  teams-chat:
    provider: teams
    config:
      app_id: "<alpha-app-id>-typo"    # intentional mismatch
      app_type: "MultiTenant"
```

Restart the daemon. Ensure `teams-qa-beta` is NOT present (this case needs
exactly one teams workspace). Send a DM to the alpha bot: "hi after typo".

**Expect**:
- The message still reaches the Friday UI (single-workspace fallback keeps
  env-only setups working)
- Daemon log shows `teams_app_id_mismatch_fallback` with the real activity's
  appId and the workspaceId we fell back to — this is the review-fix log
  that previously was silent
- `teams_signal_received` fires AFTER the fallback, with the resolved
  `workspaceId` (review fix #4 moved it past routing)

**If broken**:
- No `teams_app_id_mismatch_fallback` log at all → regression in
  `apps/atlasd/routes/signals/platform.ts:355-361`; the review fix was
  reverted or never landed (confirm commit `624c69fbf`)
- Log fires but still routes to the wrong workspace → the fallback is
  selecting the wrong candidate. With only one teams workspace configured
  it can't, so this means you actually have two (check `workspaces/` dir)
- Activity returns 404 even though there's one teams workspace → the
  `listWorkspacesByProvider` filter changed shape; check that
  `teams-qa-alpha/workspace.yml` still has `provider: teams` (some editors
  can mangle YAML on save)

**Don't forget**: revert the typo after this case, restart the daemon, and
re-run case 2 to confirm normal routing still works before case 6.

### 6. Clean daemon shutdown

**Trigger**: With the daemon running and at least one teams workspace active
(alpha), stop the daemon:

```bash
deno task atlas daemon stop
# or: pkill -f atlasd
```

**Expect**:
- Daemon exits cleanly within ~2s (no hang)
- `chat_sdk_instance_torn_down` log fires for every teams workspace
- **No** `chat_sdk_instance_teardown_failed`
- Bot's **Azure Bot resource health** still reports healthy (Teams doesn't
  push presence like Discord, so there's nothing visible in the Teams UI —
  the check is log-based)
- Sending a message to the bot after shutdown: Azure's Test in Web Chat or
  Teams client shows a delivery failure (expected — no endpoint to receive)

**If broken**:
- `chat_sdk_instance_teardown_failed` → the adapter's shutdown path threw.
  Inspect the embedded error; the Teams adapter has no long-lived WebSocket
  (unlike Discord) so this is rare, but the `@microsoft/teams.apps` `App`
  holds HTTP client pool state
- Daemon process hangs after `daemon stop` → shutdown upstream of chat-sdk
  is blocking; not a teams-specific regression. Run `pkill -f atlasd` and
  investigate separately

## Cleanup

1. Azure portal → delete both Azure Bot resources, OR **Reset Password** on
   each so the leaked dev client secrets are invalidated
2. Teams client → **Apps → Manage your apps** → remove the two sideloaded
   apps
3. Remove `TEAMS_*` vars from `~/.atlas/.env`
4. Delete the two test Friday workspaces via playground UI (or
   `DELETE /api/workspaces/<id>`)
5. `deno task atlas daemon stop`

## Smoke Candidates

- **Case 1 (Daemon loads teams workspace)** — strong candidate. Deterministic,
  ~5s runtime, log-based (no Teams UI interaction needed), catches resolver
  + factory regressions. Worth adding to `docs/qa/smoke-matrix.md` as a
  recurring check gating PRs that touch `apps/atlasd/src/chat-sdk/` or
  `packages/config/src/signals.ts`.
- **Case 5 (mismatch-fallback log)** — adjacent candidate if we extract the
  curl probe against the tunnel URL from case 1. Can run in <1s without any
  Teams UI; verifies the review-fix is still in place. Good guard against
  future "simplification" that reverts the behavior.

Cases 2, 3, 4, 6 require real Teams interaction and can't run as smoke. Run
them before any PR touching:
- `apps/atlasd/routes/signals/platform.ts` (the route)
- `apps/atlasd/src/chat-sdk/chat-sdk-instance.ts` (resolver)
- `apps/atlasd/src/chat-sdk/adapter-factory.ts` (factory)
- `@chat-adapter/teams` dependency bump in `apps/atlasd/package.json`
