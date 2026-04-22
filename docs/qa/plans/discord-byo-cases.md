# QA Plan: Discord BYO Credentials (end-to-end)

**Context**: Bring-your-own Discord credentials — `resolvePlatformCredentials`
reads `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID`
from env vars (all-or-nothing, partial env → null + `discord_missing_credentials`
log). `initializeChatSdkInstance` calls `chat.initialize()` explicitly when a
`DiscordAdapter` is present and spins up `superviseDiscordGateway`, which keeps
a Gateway WebSocket open for 12h per run and respawns on clean exit / 30s-sleep
on thrown error / stops-hard on auth failure. Coexists with Slack / Telegram /
WhatsApp.
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

### 1. Gateway connects on workspace init

**Smoke candidate — strong.** Deterministic, runs in ~10s, covers the whole
BYO resolve + supervisor startup path with no human Discord interaction.

**Trigger**: Restart the daemon with `DISCORD_*` env vars set and a workspace
containing a `discord-chat` signal:

```bash
lsof -i:8080 -sTCP:LISTEN -t | xargs kill
# wait for dev-watcher to respawn atlasd
```

**Expect**:
- Daemon logs `chat_sdk_instance_created` for the test workspace with
  `adapters` including `"discord"` and `discordGateway: true`
- Within ~5s the adapter's `Discord Gateway connected` log appears (info
  level, emitted from `setupLegacyGatewayHandlers` in the adapter)
- **No** `discord_missing_credentials`, `discord_gateway_auth_failed`, or
  `discord_gateway_listener_error` in the log tail
- Bot shows as **Online** in the test Discord server's member list

**If broken**:
- `discord_missing_credentials` with a `missing` array → one or more of
  `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` not
  present in the env the daemon inherits. `dev:playground` reads
  `~/.atlas/.env` — verify the vars are actually written there, not just
  exported in your shell
- `chat_sdk_instance_created` fires but `discordGateway: false` → no
  `discord` signal on the workspace, or the resolver returned null (check
  logs one line earlier for `discord_missing_credentials`)
- `discord_gateway_auth_failed` → bot token is wrong or was regenerated
  without updating `~/.atlas/.env`. Supervisor stops permanently; restart
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
  `"discord"` and `"slack"` (or `"telegram"`) plus `"atlas"`, and
  `discordGateway: true`
- Both DMs produce separate chats in http://localhost:5200/platform/user/chat
  — one with the **DISCORD** badge, one with **SLACK** / **TELEGRAM**
- Both bots reply independently; no cross-talk (a Slack user message doesn't
  trigger the Discord bot or vice versa)
- Only one Gateway connection is opened (one `Discord Gateway connected`
  log line per workspace, not per signal or per platform)

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

### 5. Clean teardown — no orphan WebSocket

**Trigger**: With the test workspace running (Gateway connected per Case 1),
delete the workspace:

```bash
curl -X DELETE http://localhost:8080/api/workspaces/<workspace-id>
```

Or remove its directory from `~/.atlas/workspaces/` and restart the daemon.

**Expect**:
- Daemon log shows `chat_sdk_instance_torn_down` for the workspace within
  ~1–2s of the delete
- **No** `discord_gateway_supervisor_stop_failed` error
- **No** further `discord_gateway_listener_error` or `Discord Gateway
  connected` logs for that workspace after teardown (no zombie supervisor)
- Bot transitions to **Offline** in the Discord server within ~30s (Discord's
  presence timeout after the WebSocket closes)
- No WebSocket file descriptors leaked:

  ```bash
  lsof -p $(pgrep -f atlasd) | grep -i 'gateway.discord'
  # expect: no matches after teardown
  ```

**If broken**:
- `discord_gateway_supervisor_stop_failed` → the supervisor's
  `Promise.allSettled` path failed. Inspect the embedded error — usually
  means the listener threw during its in-flight `startGatewayListener`
  call and the rejection leaked past the catch block in the loop
- Bot stays Online for more than ~60s after teardown → supervisor didn't
  actually abort; the `AbortController` signal isn't being threaded through
  to `startGatewayListener`. Regression in the supervisor's `stop()` flow
- `chat_sdk_instance_torn_down` never fires → teardown path itself hung;
  `chat.shutdown()` is blocking on something (likely an in-flight adapter
  operation), unrelated to Discord

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
