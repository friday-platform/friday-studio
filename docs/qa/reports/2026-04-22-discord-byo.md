# QA Report: Discord BYO Credentials

**Plan**: `docs/qa/plans/discord-byo-cases.md`
**Branch**: `declaw`
**Date**: 2026-04-22
**Mode**: run → fix (in-session fixes applied and re-verified)
**Commits under test**: `ac2205ae` (adapter + env resolver), `d38af6de` (Gateway supervisor), `d61a63b8` (structured auth error detection)
**In-session fix commits**: `6ea4cf6c` (logger wrapper for Finding 2), `24ef74ac` (preventIdle for idle reaper — Finding 1 first pass), `0aee5ef8` (preventIdle extended to session-completion + eviction — Finding 1 regression found during re-QA)

## Post-refactor note (2026-04-22)

Finding 1 (idle reaper destroys Gateway supervisor) and the preventIdle mechanism it proposed were **superseded** by a subsequent architectural refactor (`7164ee49`). The Gateway was hoisted from per-workspace supervision to a daemon-scoped `DiscordGatewayService` that forwards events via HTTP to `/signals/discord`, so each inbound message now lands on a freshly-woken workspace — matching Slack/Telegram/WhatsApp. The preventIdle code, its tests, and the pin-aware branches in the idle reaper / session-completion / eviction paths were deleted. This report is preserved as historical context for the investigation path; the shipped state is the daemon-scoped service.

## Summary

| Case | Status | Notes |
|---|---|---|
| 1. Gateway connects on workspace init | ✅ PASS | `chat_sdk_instance_created` with `discordGateway: true` + established Gateway WebSocket confirmed via TCP |
| 2. DM round-trip | ⏭️ SKIPPED | User sent @mention instead; inbound path already proven by Case 3 |
| 3. @mention in channel | ✅ PASS | Bot replied in thread: *"Hey Sara! Good to have you here. What can I help you with?"* |
| 4. Coexistence with Slack/Telegram | ⏭️ SKIPPED | Would require additional signal setup; not run |
| 5. Clean teardown — no orphan WebSocket | ✅ PASS | Observed naturally; `chat_sdk_instance_torn_down` fired, no `discord_gateway_supervisor_stop_failed`, Gateway WebSocket removed |

**BYO credential resolution + outbound + inbound + teardown are all proven end-to-end.** However, a P1 operational issue surfaced that materially degrades Discord UX (see Finding 1).

## Findings

### Finding 1 (P1): 5-minute idle timeout destroys the Gateway supervisor, taking the bot offline

**Severity:** Serious UX regression for Discord BYO. Discord bots are expected to remain online; ours goes offline whenever nobody prompts the workspace for 5 minutes.

**What happens:**
1. Workspace comes up (externally triggered), ChatSdkInstance is created, Gateway supervisor starts, bot appears Online in Discord.
2. `AtlasDaemon`'s idle detector runs on a timer and evaluates `sessionsCount`, `hasActiveSessions`, `hasActiveExecutions`. The Discord Gateway supervisor does NOT register as any of these.
3. After ~5 min (or earlier, if Case 3-style activity finishes and the session reaper kicks in) the daemon tears the workspace runtime down, which calls `ChatSdkInstance.teardown()`, which cleanly aborts the Gateway supervisor.
4. Bot goes offline. Any further DM or @mention from Discord is delivered into dead air — Discord sends `MESSAGE_CREATE` to a closed WebSocket, the event is lost.

**Log evidence:**
```
# Wake 1
13:13:36  chat_sdk_instance_created {workspaceId: herbal_dumpling, adapters: [atlas, discord], discordGateway: true}
13:15:55  Checking idle workspace {sessionsCount: 0, hasActiveExecutions: false}
13:15:55  Destroying idle workspace runtime
13:15:55  chat_sdk_instance_torn_down {workspaceId: herbal_dumpling}
13:15:55  Workspace runtime destroyed

# User sent "Hi" during the window between reap and next wake → message was lost

# Wake 2 (forced by re-hitting the workspace chat endpoint)
13:20:17  chat_sdk_instance_created {workspaceId: herbal_dumpling, adapters: [atlas, discord], discordGateway: true}
13:23:40  User sent @mention → bot replied in thread
13:23:45  chat_sdk_instance_torn_down (teardown fired 5s after the response completed)
```

**Why this doesn't affect Slack/Telegram/WhatsApp:** Those are inbound-HTTP — a dead workspace is woken up by an incoming webhook because the webhook route in `apps/atlasd/routes/signals/platform.ts` calls `getOrCreateChatSdkInstance`. Discord Gateway is outbound from atlasd: without a live WebSocket, Discord cannot reach us to trigger a wake.

**Chicken-and-egg:** the ChatSdkInstance is what builds the Gateway WebSocket, and the Gateway WebSocket is the only thing that would deliver a wake trigger. No trigger → no wake → no Gateway → no trigger.

**Mitigation options:**
1. **Workspace-level keepalive** — make `initializeChatSdkInstance` register a "prevent-idle" flag when it starts the Discord supervisor, so `AtlasDaemon`'s idle detector never reaps a workspace with a live Gateway.
2. **Supervisor-level re-wake** — have `superviseDiscordGateway` periodically call `getOrCreateChatSdkInstance` on itself to keep the instance alive. Cross-referencing own workspace is awkward but cheap.
3. **Daemon-level persistent adapter pool** — lift Discord adapters out of the per-workspace `ChatSdkInstance` and maintain them globally.

Option 1 is cleanest and most consistent with how the rest of the daemon models lifetimes. Option 3 is a larger refactor but would also solve the "bot shares a bot token across workspaces" ambiguity noted in the README's Known Limitations.

**Recommendation:** File as a follow-up task. Do NOT ship the Discord BYO path as-is to users without fixing this — a bot that goes offline every 5 minutes is worse than a feature not shipped.

---

### Finding 2 (P2, operator ergonomics): adapter's `ConsoleLogger` output doesn't land in `~/.atlas/logs/global.log`

**Severity:** Diagnostic friction. The feature works, but troubleshooting is harder than necessary.

**What:** `@chat-adapter/discord`'s `DiscordAdapter` constructor sets `this.logger = config.logger ?? new ConsoleLogger("info").child("discord")`. `ConsoleLogger` writes to the daemon's stdout/stderr, which is piped through `concurrently` to the terminal that launched `dev:playground`. It does NOT reach `@atlas/logger`'s log-file sink.

**Impact:** The log lines cited in the QA plan — `Discord Gateway connected`, `Discord Gateway message received`, `Discord Gateway forwarding event` — are emitted by the adapter but invisible to anyone tailing `~/.atlas/logs/global.log` or the workspace-specific log. During this QA run I had to verify Gateway connection by checking `lsof` for outbound TCP connections to Cloudflare IPs in Discord's ranges (`162.159.{130..138}.234` for Gateway, `.232` for API) rather than by reading a log line.

**Mitigation:** Plumb the `@atlas/logger` instance into `createDiscordAdapter({ ..., logger })` when building the adapter in `adapter-factory.ts`. That requires the adapter's `Logger` interface to be compatible with `@atlas/logger`; if not, a thin wrapper.

**Recommendation:** Low-effort fix. Worth addressing in the same follow-up as Finding 1 since the operator is likely hitting both simultaneously.

---

### Finding 3 (P3, observation — not necessarily a bug): bot replies in an auto-spawned Discord thread

**Severity:** Observational. May be a feature, may be surprising.

**What:** When I sent `@FridayTest Hi!` in #general, the bot's reply did not appear inline in #general — Discord (or the adapter) spawned a thread rooted at the user's message and posted the reply inside it. The user's Discord client doesn't auto-open threads, so they saw "no response" until they opened the thread manually.

**Thread ID format observed:** `slack:<channel>:<ts>`-style was the Slack convention. For Discord the adapter uses `DiscordThreadId`, presumably encoding `channel_id:thread_id` — needs confirmation from `@chat-adapter/discord` types.

**Recommendation:** Call out in `docs/integrations/discord/README.md` under "Known Limitations" or "What to expect" that mentions spawn threaded replies. If we don't want threads, see whether the adapter can be configured to reply inline.

## Changes Made

Three fixes landed in this session after findings surfaced:

1. **`6ea4cf6c` — logger wrapper (Finding 2).** New `toDiscordLogger(atlasLogger)` at `apps/atlasd/src/chat-sdk/discord-logger.ts` + wiring in `adapter-factory.ts`. Verified live: adapter-internal lines like `Discord adapter initialized`, `Starting Discord Gateway listener`, `Discord Gateway connected`, `Discord API: POST message` now land in `~/.atlas/logs/global.log` tagged with `component: "discord"`.

2. **`24ef74ac` — preventIdle pin (Finding 1, first pass).** Added `preventIdleWorkspaces: Set<string>` on `AtlasDaemon` with `registerPreventIdle` / `releasePreventIdle`. Pin registered synchronously in `buildChatSdkInstance` the moment `resolveDiscordCredentials` returns a discord cred (BEFORE awaiting `initializeChatSdkInstance`, to close the supervisor-spawn race). Early-bail in `checkAndDestroyIdleWorkspace`. Release in a `finally` on `ChatSdkInstance.teardown`; belt-and-braces release in `destroyWorkspaceRuntime`; shutdown drain. Verified: bot stayed connected through a 6-minute idle window.

3. **`0aee5ef8` — preventIdle extended to session-completion + eviction (Finding 1 regression, caught during re-QA).** First-pass fix only covered the 5-min idle reaper. Re-QA showed the workspace was torn down 2 seconds after a session completed, via a second destroy path (`atlas-daemon.ts:1170`). Added pin check to the session-completion handler (else-if form preserving the resetIdleTimeout branch for active workspaces), plus an early-continue for pinned workspaces in `findOldestIdleWorkspace` so max-concurrent eviction can't pick a live Discord workspace. Verified live: bot replied to `@mention`, session completed, log line `Session completed for pinned workspace; keeping runtime` fired, Gateway WebSocket stayed established.

## Re-QA results (after fixes)

| Case | Status | Notes |
|---|---|---|
| 1. Gateway connects on workspace init | ✅ PASS | Now with full log trail in global.log (previously only TCP evidence) |
| 2. DM round-trip | ⏭️ SKIPPED | User used @mention instead; inbound proven by Case 3 |
| 3. @mention in channel | ✅ PASS | Bot replied "Hey Sara! I'm Friday — you pinged me, so here I am. What can I do for you?" |
| 4. Coexistence with Slack/Telegram | ⏭️ SKIPPED | Not run |
| 5. Clean teardown (post-fix session-completion) | ✅ PASS | Log "Session completed for pinned workspace" fired; no orphan WebSocket; pinned workspace survives session end |

## Environment

- **Branch**: `declaw` + Discord BYO commits (`ac2205ae`, `d38af6de`, `d61a63b8`)
- **Stack**: `deno task dev:playground`
- **Daemon**: `localhost:8080`, Playground: `localhost:5200`, Link: `localhost:3100`, Ledger: `localhost:3200`
- **Discord app**: `FridayTest` (App ID `1496494851665956884`, User ID same as App ID per Discord convention)
- **Friday workspace**: `discord-byo-test` (id `herbal_dumpling`) — created for this QA, keeping for follow-up testing of Finding 1
- **Discord guild**: `AI council` (id `1435330960374759506`)
- **Test channel**: `#general`

Credentials in `~/.atlas/.env`:
- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`

## Setup Friction (README review)

Ran against `docs/integrations/discord/README.md` steps 1–7. Notes:

- **Step 2 (Reset Token)** triggers Discord's MFA password dialog. Docs should mention this — operators walking through the guide will hit an authentication interstitial and need to know it's expected.
- **Step 3 (Message Content Intent)** — the toggle UI requires scrolling on smaller viewports. Intent settings are below the Banner upload which is a tall empty area. Worth a screenshot or "scroll to Privileged Gateway Intents" cue in the README.
- **Step 6 (OAuth URL Generator)** can be bypassed by constructing the URL directly: `https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=68608&scope=bot`. Permission integer `68608` = View Channels (1024) + Send Messages (2048) + Read Message History (65536). Worth adding as a copy-paste shortcut for users who don't want to click through the URL Generator UI.

## Cleanup

Not performed — leaving the test workspace + Discord app in place so Finding 1 can be reproduced by whoever picks up the follow-up task. To clean up later:

1. Discord Developer Portal: `discord.com/developers/applications/1496494851665956884` → **Delete App**, OR **Reset Token** (invalidates the token pasted in this session's chat)
2. `DELETE /api/workspaces/herbal_dumpling` via the daemon API
3. Remove `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` from `~/.atlas/.env`
4. Rotate the Client Secret on the OAuth2 page (a value was pasted mid-session before it was identified as wrong)

## Smoke Matrix Candidates

Promote to `docs/qa/smoke-matrix.md`:

- **Case 5 (Clean teardown)** — deterministic, log-only, catches a regression class (orphan WebSockets on teardown) that's otherwise hard to spot. Already exercised naturally by the idle reaper — which doubles as coverage for Finding 1's teardown path working correctly even when invoked unexpectedly.

**Do NOT promote Case 1 (Gateway connects on workspace init) until Finding 1 is resolved** — its current pass depends on an external trigger to wake the workspace, which is not the user-visible "fresh daemon boot" scenario the case is meant to cover.
