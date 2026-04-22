# Discord Integration (BYO)

Connect a Discord bot to any Friday workspace so users can chat with the
workspace over DM or `@mentions`. Friday uses the [Vercel Chat SDK's Discord
adapter](https://www.npmjs.com/package/@chat-adapter/discord) behind the
scenes — the daemon opens a Gateway WebSocket, the adapter normalizes
incoming messages, and they flow into the same pipeline the web chat uses.

> **BYO only.** Discord is currently only available as a
> **bring-your-own** integration — you create the app yourself at
> [discord.com/developers/applications](https://discord.com/developers/applications)
> and paste the credentials into `~/.atlas/.env`. There is no managed
> *Connect Discord* button in the workspace settings UI yet.

## How it works

```
Discord Gateway                            ┌── atlasd (daemon-scoped) ─────────┐
                                           │                                    │
  MESSAGE_CREATE / MESSAGE_UPDATE          │  DiscordGatewayService             │
     │                                     │   ├─ one WebSocket per daemon      │
     ▼                                     │   ├─ startGatewayListener(url)     │
   WebSocket ◀──── 12h persistent ─────────┤   └─ forwards each event via HTTP  │
                                           │                       │             │
                                           │                       ▼             │
                                           │  POST /platform/discord             │
                                           │   ├─ finds workspace by signal      │
                                           │   ├─ getOrCreateChatSdkInstance     │
                                           │   └─ chat.webhooks.discord(req)     │
                                           │                       │             │
                                           │                       ▼             │
                                           │  DiscordAdapter (per workspace)     │
                                           │   • handleForwardedGatewayEvent     │
                                           │   • fires "chat" signal             │
                                           └─────────────────────────────────────┘
```

Unlike Slack / Telegram / WhatsApp, Discord's inbound path does **not** use
the `webhook-tunnel`. Regular messages and `@mentions` are only delivered
over the Gateway WebSocket — Discord's HTTP Interactions endpoint only
receives slash commands and button clicks, which we don't wire (see
[Known limitations](#known-limitations)).

The daemon opens **ONE** Gateway connection at startup (as long as all
three env vars are set and at least one workspace has a `discord`
signal). Each inbound event is HTTP-POSTed to the daemon's own
`/platform/discord` route, which looks up the target workspace and hands
the raw request to `chat.webhooks.discord` — exactly like the
Slack/Telegram/WhatsApp webhook flow. The service runs each listener
session for 12 hours, respawns immediately on clean exit, and waits 30 s
before respawning on thrown errors. Auth failures (`invalid token`,
`401`, `Unauthorized`) stop the service permanently to avoid Discord
rate-limiting the token.

Because the service is daemon-scoped, each inbound message lands on a
**fresh** workspace runtime via `getOrCreateChatSdkInstance` — there's no
long-lived per-workspace FSM being reused across signals.

## Architecture note: forwarding mode

We use the adapter's **forwarding mode** — we pass
`startGatewayListener(..., webhookUrl)` with
`webhookUrl = http://localhost:<daemonPort>/platform/discord`. Every raw
Gateway event is HTTP-POSTed back to our own route, which handles
workspace routing and dispatch. The per-workspace adapter's
`handleWebhook` (see
`opensrc/repos/github.com/vercel/chat/packages/adapter-discord/src/index.ts:168-182`)
branches on the `x-discord-gateway-token` header to distinguish forwarded
events from raw Interactions payloads.

This is the same pattern the upstream adapter README documents for
serverless environments — we just run it on a long-lived daemon instead.
The service lives at `apps/atlasd/src/discord-gateway-service.ts`.

## Known limitations

- **Messaging only — no slash commands or button handlers.** The Discord
  adapter's HTTP Interactions path (slash commands like `/atlas chat`,
  "Continue in DM" buttons, etc.) is not wired into atlasd. We do **not**
  set an *Interactions Endpoint URL* in the Developer Portal, and the
  daemon exposes no route to handle one. If you want slash-command UX
  you'll have to add it yourself.
- **Message Content Intent is a privileged intent.** You must toggle it
  on in the Developer Portal's Bot page or the bot receives empty
  `content` for every event. For bots in **100+ servers**, Discord
  additionally requires account verification and an intent review — below
  that threshold it's just a checkbox. See
  [Discord's privileged intents docs](https://support-dev.discord.com/hc/en-us/articles/6207308062871).
- **`DISCORD_PUBLIC_KEY` is required but unused in messaging-only mode.**
  The adapter's constructor calls `ValidationError` sync if any of
  `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, or `DISCORD_APPLICATION_ID`
  is missing, so you still have to set the public key. It's only
  actually consumed for Ed25519 signature verification on HTTP
  Interactions — which we don't use — but the workspace will fail to
  initialize without it. Our resolver logs `discord_missing_credentials`
  and returns `null` on partial env, which is quieter than the adapter's
  synchronous crash.
- **No per-workspace credential isolation.** All three env vars are
  process-global, so every workspace with a `discord` signal in the same
  daemon shares the same bot. If you want two independent bots, run two
  daemons.

## Prerequisites

- A Discord account that can create applications.
- A Discord server (guild) where you can invite the bot — if you don't
  have one, you can create a personal test server for free.
- Friday running locally: `deno task dev:playground` (you don't need
  `webhook-tunnel` for Discord — Gateway is outbound from atlasd, so no
  public URL is required).

## Step 1 — Create a Discord application

1. Open [discord.com/developers/applications](https://discord.com/developers/applications)
   and click **New Application**.
2. Pick a name (e.g. *Friday Atlas*) and accept the developer ToS.
3. On the **General Information** page, copy two values you'll need later:
   - **Application ID** — a long numeric string
   - **Public Key** — a 64-character hex string

> The Public Key is safe to paste into env vars — it's used to verify
> incoming HTTP interaction signatures. The Bot Token (Step 2) is the
> actual secret; treat it like a password.

## Step 2 — Create the bot user and copy its token

1. In the left sidebar, click **Bot**.
2. Click **Reset Token** (or **Add Bot** if this is the first time).
   Discord shows the token **once** — copy it immediately. It looks like
   `MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXXX`.
3. If you scroll down on the same page, you'll see the bot's display
   name and avatar — tweak if you want.

## Step 3 — Enable the Message Content Intent (privileged)

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and
toggle **Message Content Intent** to **on**. Save changes.

Without this toggle, your bot receives Gateway events with an empty
`content` field — every message looks like a blank string and nothing
triggers the signal.

> If you're running a bot that will eventually join 100+ servers, note
> that Discord requires verification + review before they'll let you
> keep the intent. For local testing that's not a concern.

## Step 4 — Save the credentials

Paste the three values into `~/.atlas/.env` so the daemon picks them up
on every restart:

```bash
# Append to ~/.atlas/.env (create the file if it doesn't exist)
DISCORD_BOT_TOKEN=MTIzNDU2Nzg5...
DISCORD_PUBLIC_KEY=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
DISCORD_APPLICATION_ID=1234567890123456789
```

All three are required, even though `DISCORD_PUBLIC_KEY` isn't used at
runtime in messaging-only mode (see [Known limitations](#known-limitations)).

If you're on the Tempest team, also save them to 1Password (vault
*Engineering*, item `Discord App — <app-name>`) so you don't lose them
if your laptop gets wiped.

## Step 5 — Declare the signal in the workspace

Open the workspace's `workspace.yml` (usually
`~/.atlas/workspaces/<name>/workspace.yml`) and add a `discord-chat`
signal. All credentials come from `~/.atlas/.env`, so the config only
exposes an informational `application_id`:

```yaml
signals:
  discord-chat:
    title: "Chat via Discord"
    description: "Receives DMs and @mentions from Discord"
    provider: discord
    config:
      application_id: "1234567890123456789"  # informational — creds read from env
```

The `application_id` field is optional and informational only — the
resolver reads credentials exclusively from
`DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID`.

Save and restart the daemon so the new workspace.yml is picked up:

```bash
lsof -i:8080 -sTCP:LISTEN -t | xargs kill
```

`dev-watcher` respawns atlasd automatically with a fresh process that
re-reads `~/.atlas/.env`.

## Step 6 — Invite the bot to a server

Discord bots can only DM users after both sides share at least one
server, and `@mentions` obviously require a channel to mention in.

1. In the Developer Portal, go to **OAuth2** → **URL Generator**.
2. Under **Scopes**, check **`bot`** (do **not** check
   `applications.commands` — we don't use slash commands).
3. Under **Bot Permissions**, check:
   - **Read Messages/View Channels**
   - **Send Messages**
   - **Read Message History**
4. Copy the **Generated URL** at the bottom of the page.
5. Open the URL in a browser, pick the server you want to add the bot
   to, and click **Authorize**. You'll need **Manage Server** permission
   on the target server.

## Step 7 — Talk to your bot

1. In Discord, DM the bot (click its name in your server's member list
   → **Message**). Send "hello friday".
2. Within a second or two, the daemon log should show the adapter's
   `Discord Gateway connected` message, followed by a new chat in
   http://localhost:5200/platform/user/chat with a **DISCORD** badge.
3. To `@mention` the bot in a channel, make sure the bot can read that
   channel (check role permissions) and post `@<bot-name> ping`.

## What to expect

- Bot replies to `@mention`s appear in a Discord thread off the original
  message, not inline in the channel.

## Troubleshooting

**Bot is online in Discord but silent on every message.**
The most common cause is **Message Content Intent disabled** (Step 3).
The adapter still receives `MESSAGE_CREATE` events, but the `content`
field is empty, so nothing matches a mention or subscription. Toggle
it on in the Developer Portal → **Bot** page and restart the daemon.

**Daemon log shows `discord_gateway_auth_failed` and the bot never
reconnects.**
The supervisor stops **permanently** on auth errors (matched on
`/invalid token|unauthor|\b401\b/i`) to avoid Discord rate-limiting or
banning the token. Regenerate the bot token in the Developer Portal,
update `DISCORD_BOT_TOKEN` in `~/.atlas/.env`, and restart the daemon
(the supervisor doesn't re-arm without a restart).

**Daemon did not crash but Discord features don't work.**
If any one of `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, or
`DISCORD_APPLICATION_ID` is missing, the resolver logs
`discord_missing_credentials` (debug level) with the list of missing
vars and returns `null` — so the adapter is never constructed and no
Gateway supervisor runs. Check:

```bash
tail ~/.atlas/logs/global.log | grep discord_missing_credentials
```

**Gateway never connects at all (no `Discord Gateway connected` log).**
Usually network-layer: outbound WebSocket to `gateway.discord.gg:443`
blocked by corporate firewall, VPN, or a strict egress policy. Test
from the same host:

```bash
curl -v https://discord.com/api/v10/gateway
```

If that succeeds but the WebSocket fails, the block is specifically on
WSS traffic — different egress rule.

**Bot appears to reply to its own messages in a loop.**
Shouldn't happen in our setup — the adapter filters out events where
`author.bot === true` before dispatching. If you do see it, the bot
account you're using may not actually be flagged as a bot (e.g. if
you're DMing it from the same Discord account that owns the app).
Create a dedicated bot via the Developer Portal's **Bot** page rather
than reusing a user account.

## Production notes

- **Rotate the bot token** by clicking **Reset Token** on the Developer
  Portal's **Bot** page. The old token stops working immediately — update
  `~/.atlas/.env` and restart the daemon, otherwise the supervisor will
  hit `discord_gateway_auth_failed` and stop.
- **Rotate the public key** via **General Information** → **Reset
  Public Key**. Update `DISCORD_PUBLIC_KEY` and restart. (In
  messaging-only mode this is only cosmetic — nothing checks the key at
  runtime — but keeping env and portal in sync avoids surprises if we
  ever wire the Interactions endpoint.)
- **Gateway is a persistent outbound WebSocket.** The supervisor
  respawns the listener every 12 hours by design; transient
  disconnects inside that window are handled by `discord.js` itself
  without daemon involvement. Watch for `discord_gateway_listener_error`
  spikes in logs if you suspect network flakiness.
- **BYO apps are not tracked by the Link service.** Credential rotation
  and revocation happen entirely through the Discord Developer Portal
  and your env file — there's no *Connections* panel entry to remove.
