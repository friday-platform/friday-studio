# QA Plan: Discord BYO Credentials (end-to-end)

**Context**: Bring-your-own Discord credentials — `resolvePlatformCredentials`
reads `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID`
from env vars (all-or-nothing, partial env → null + `discord_missing_credentials`
log). At daemon startup, `DiscordGatewayService` opens ONE Gateway WebSocket per
daemon (not per workspace) in forwarding mode — every event is HTTP-POSTed to
`/signals/discord`, which routes it to the workspace's `DiscordAdapter`.
Per-listener session runs 12h, respawns on clean exit, 30s-sleeps on thrown
error, stops-hard on auth failure. Coexists with Slack / Telegram / WhatsApp.
**Branch**: `declaw`
**Date**: 2026-04-22
**Related docs**: `docs/integrations/discord/README.md` (user setup guide)

## Prerequisites

### Environment

- Full dev stack: `deno task dev:playground`
  - daemon on `:8080`
  - link on `:3100` (running but unused by Discord BYO)
  - playground on `:5200`
  - `webhook-tunnel` not required for Discord (Gateway is outbound-only)
- Credentials file writable: `~/.atlas/.env`

### Accounts / external

- Discord account that can create applications at
  [discord.com/developers/applications](https://discord.com/developers/applications)
- A Discord server (guild) where you have Manage Server permission to invite
  the bot

### Artifacts to have ready before cases run

After setup, you should have:
- Discord application created, Bot Token, Public Key, Application ID
- `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` set in
  `~/.atlas/.env`
- **Message Content Intent** toggled ON in the Developer Portal's **Bot** page
- Bot invited to a test server with at least Read Messages / Send Messages /
  Read Message History permissions
- Test Friday workspace (e.g. `discord-byo-test`) with a `discord-chat` signal
  in its `workspace.yml`

## Setup Walkthrough (not test cases — prep before running)

Follow `docs/integrations/discord/README.md` Steps 1–7 exactly. If anything
in that README is unclear or broken, **that is itself a finding** — flag it
in the report under "Setup friction." Don't silently work around it.

Rough path:
1. Create Discord application at discord.com/developers/applications
2. Copy Application ID + Public Key from **General Information**
3. **Bot** page → Reset Token → copy bot token
4. **Bot** page → toggle **Message Content Intent** on
5. Add `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` to
   `~/.atlas/.env`
6. Create Friday workspace (playground UI or CLI), add to its `workspace.yml`:
   ```yaml
   signals:
     discord-chat:
       title: "Chat via Discord"
       description: "Receives DMs and @mentions from Discord"
       provider: discord
       config:
         application_id: "1234567890123456789"
   ```
7. Restart daemon so the new workspace.yml is picked up
8. **OAuth2 → URL Generator**: scope `bot`, permissions
   *Read Messages/View Channels*, *Send Messages*, *Read Message History*;
   open the generated URL and invite the bot to a test server

### Daemon log tail to keep open during testing

```bash
tail -f ~/.atlas/logs/global.log | grep -iE "discord|chat_sdk|gateway"
```

## Cases

### 1. Gateway connects on daemon start

**Smoke candidate — strong.** Deterministic, runs in ~10s, covers the whole
BYO resolve + daemon-scoped service startup path with no human Discord
interaction.

**Trigger**: Restart the daemon with `DISCORD_*` env vars set. (No workspace
signal precondition — the service starts as long as env is present. An
inbound message before a workspace is wired returns 404 at the route.)

```bash
lsof -i:8080 -sTCP:LISTEN -t | xargs kill
# wait for dev-watcher to respawn atlasd
```

**Expect**:
- Daemon logs `discord_gateway_service_started` with the `forwardUrl`
  (should be `http://localhost:<daemonPort>/signals/discord`) and
  `applicationId`
- Within ~5s the adapter's `Discord Gateway connected` log appears (info
  level, emitted from the discord.js client `ClientReady` event)
- **No** `discord_gateway_not_configured`, `discord_gateway_auth_failed`, or
  `discord_gateway_listener_error` in the log tail
- Bot shows as **Online** in the test Discord server's member list

**If broken**:
- `discord_gateway_not_configured` → one or more of
  `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` not
  present in the env the daemon inherits. `dev:playground` reads
  `~/.atlas/.env` — verify the vars are actually written there, not just
  exported in your shell
- `discord_gateway_auth_failed` → bot token is wrong or was regenerated
  without updating `~/.atlas/.env`. Service stops permanently; restart
  the daemon after fixing
- No `Discord Gateway connected` log within ~30s and no error → Gateway
  WebSocket blocked at the network layer; see Case 5's broken-network path

### 2. DM round-trip

**Trigger**: In Discord, open a DM with your bot (member list → bot name →
**Message**). Send "hello friday".

**Expect**:
- Within ~1–2s, a new chat appears in http://localhost:5200/platform/user/chat
  tagged with a **DISCORD** badge
- The user message is recorded with your Discord user ID and username
- Session runs, `chat` signal fires on the test workspace
- Bot posts a reply back in the DM (content doesn't matter — any reply proves
  the round-trip)

**If broken**:
- No chat in UI, no log activity → Message Content Intent disabled; the
  adapter receives events but `content` is empty. Toggle it on in the
  Developer Portal's **Bot** page and restart the daemon (the Gateway needs
  to re-handshake with new intents)
- Chat appears but no reply → outbound failure; check daemon logs for
  adapter-side errors (e.g. missing Send Messages permission in the target
  channel). DMs usually work without explicit permission grants, but if
  you're on a server with tight privacy settings the bot may need explicit
  rights
- Chat appears in the *wrong* workspace → two workspaces share the same
  bot (they both resolve the same env credentials); the adapter can only
  deliver to one

### 3. @mention in a channel

**Trigger**: In a channel on the test server where the bot has Read Messages
/ Send Messages, post `@<bot-name> ping` (use Discord's autocomplete to make
sure the mention is resolved to a proper user mention, not plain text).

**Expect**:
- Same flow as case 2 — chat appears in the Friday UI with a **DISCORD**
  badge, bot replies in the same channel
- The `_discord` metadata on the signal payload includes a non-null
  `guildId` (DM case would have `guildId: null`)

**If broken**:
- Bot doesn't respond even though the DM in Case 2 worked → mention wasn't
  actually parsed as a user mention (e.g. pasted as plain text). Retype
  with Discord's autocomplete so it renders as a blue-highlighted pill
- Bot responds but the reply doesn't appear in Discord → bot lacks Send
  Messages in that channel. Check role permissions on the server
- `operation_not_supported` or similar in logs → bot lacks Read Message
  History (needed to fetch context). Re-invite with the OAuth URL from
  README Step 6 which includes it

### 4. Coexistence with Slack or Telegram in same workspace

**Trigger**: Add a second platform signal to the same test workspace. For
example, add a Slack signal (see `docs/integrations/slack/README.md` Steps
1–6) or a Telegram signal (`docs/integrations/telegram/README.md`). Restart
the daemon. Then DM both bots at roughly the same time.

**Expect**:
- `chat_sdk_instance_created` log shows `adapters` containing both
  `"discord"` and `"slack"` (or `"telegram"`) plus `"atlas"`
- Both DMs produce separate chats in http://localhost:5200/platform/user/chat
  — one with the **DISCORD** badge, one with **SLACK** / **TELEGRAM**
- Both bots reply independently; no cross-talk (a Slack user message doesn't
  trigger the Discord bot or vice versa)
- Only one Gateway connection is opened daemon-wide (one
  `discord_gateway_service_started` + one `Discord Gateway connected` log
  line, not per workspace or per signal)

**If broken**:
- Only one platform works → `resolvePlatformCredentials` short-circuited;
  check for `discord_missing_credentials` or `slack_signal_no_*` /
  `telegram_no_bot_token` in logs depending on which side failed
- Discord chat appears but Slack / Telegram don't, or vice versa → check
  that env vars for both platforms are actually present in the daemon's
  environment (shell env is not enough — must be in `~/.atlas/.env` if the
  daemon is spawned via `dev:playground`)
- Two `Discord Gateway connected` logs per workspace restart → supervisor
  is being double-instantiated; regression in `initializeChatSdkInstance`

### 5. Clean teardown — no orphan WebSocket on daemon shutdown

**Trigger**: With the daemon running and the Gateway connected (per Case 1),
stop the daemon:

```bash
deno task atlas daemon stop
# or: pkill -f atlasd
```

**Expect**:
- Daemon log shows `discord_gateway_service_stopped` within ~1–2s of the
  stop
- **No** `Error stopping Discord Gateway service` entry
- Bot transitions to **Offline** in the Discord server within ~30s (Discord's
  presence timeout after the WebSocket closes)
- No WebSocket file descriptors leaked before the daemon exits:

  ```bash
  lsof -p $(pgrep -f atlasd) | grep -i 'gateway.discord'
  # expect: no matches while the stop is in flight
  ```

**If broken**:
- `Error stopping Discord Gateway service` → the service's
  `Promise.allSettled` path failed. Inspect the embedded error — usually
  means the listener threw during its in-flight `startGatewayListener`
  call and the rejection leaked past the catch block in the loop
- Bot stays Online for more than ~60s after stop → service didn't
  actually abort; the `AbortController` signal isn't being threaded through
  to `startGatewayListener`. Regression in the service's `stop()` flow
- Daemon process lingers after `daemon stop` → shutdown path itself hung;
  something upstream of the service stop is blocking

## Cleanup

1. Discord Developer Portal: delete the test application (**General
   Information** → **Delete App**) or, if you want to keep the app for
   re-use, at minimum **Reset Token** so the leaked dev token is invalidated
2. Remove `DISCORD_*` vars from `~/.atlas/.env`
3. Delete the test Friday workspace via playground UI (or
   `DELETE /api/workspaces/<id>`)
4. `deno task atlas daemon stop`

## Smoke Candidates

- **Case 1 (Gateway connects on workspace init)** — strong candidate.
  Deterministic, runs in ~10s, purely log-based (no human-in-the-loop
  Discord interaction), covers the whole BYO resolve + supervisor startup
  path in one shot. Worth adding to `docs/qa/smoke-matrix.md` as a recurring
  check that gates PRs touching `apps/atlasd/src/chat-sdk/`.
- **Case 5 (Clean teardown)** — adjacent candidate. Also log-based, also
  fast, and catches a regression class (leaked WebSockets) that's otherwise
  hard to notice until production log volume spikes.

Cases 2/3/4 require human-in-the-loop Discord UI interaction → not smoke
candidates, but worth running before every PR that touches
`apps/atlasd/src/chat-sdk/` or `@chat-adapter/discord`.
