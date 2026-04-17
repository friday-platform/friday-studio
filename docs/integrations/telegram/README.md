# Telegram Integration

Connect a Telegram bot to any Friday workspace so users can chat with the
workspace over DM. Friday uses the [Vercel Chat SDK's Telegram adapter](https://www.npmjs.com/package/@chat-adapter/telegram)
behind the scenes — the daemon receives Telegram updates, verifies them,
and routes messages into the same pipeline the web chat uses.

## How it works

```
Telegram Cloud           ┌── webhook-tunnel ──────┐    ┌── atlasd ───────────────┐
                         │                        │    │                          │
  bot updates  ──POST──▶ │  /platform/telegram/   │───▶│  /signals/telegram/      │
                         │  <token_suffix>        │    │  <token_suffix>          │
                         │  (raw body forwarded)  │    │      │                   │
                         └────────────────────────┘    │      ▼                   │
                                                       │  Chat SDK                │
                                                       │   webhooks.telegram()    │
                                                       │    • verifies            │
                                                       │      X-Telegram-…-Token  │
                                                       │    • parses update       │
                                                       │    • fires "chat"        │
                                                       └──────────────────────────┘
```

The `/platform/...` prefix only exists on the tunnel side — it's an explicit
pass-through so each platform provider can add future routing logic without
touching atlasd. atlasd itself only ever sees `/signals/...`.

Telegram requires a public HTTPS URL for the webhook. In development
Friday ships with `apps/webhook-tunnel` (a Cloudflare quick-tunnel) that
exposes your local daemon to the internet automatically when you run
`deno task dev:playground`.

## Prerequisites

- A Telegram account on your phone (the one that will own the bot).
- Friday running locally: `deno task dev:playground`.

## Step 1 — Create a bot with BotFather

1. Open the **Telegram** app on your phone and search for **BotFather**
   (official account, blue checkmark). Message him by tapping **Start**.
2. Send `/newbot`.
3. Choose a **display name** (what users see, e.g. *Friday Atlas*).
4. Choose a **username** ending in `bot` (e.g. `friday_atlas_xxxxx_bot`).
5. BotFather replies with a message that includes a token like
   `123456789:ABC-DEF-GHIJKLM...`. **That's the one.** Treat it like a
   password — anyone with it controls the bot.

> The token has two halves separated by a colon: the numeric bot ID
> before `:`, and a random secret after. Friday uses the secret half in
> the webhook URL so multiple bots can coexist on the same daemon.

## Step 2 — Save the token

Paste the token into `~/.atlas/.env` so the daemon picks it up on every
restart:

```bash
# Append to ~/.atlas/.env (create the file if it doesn't exist)
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF-GHIJKLM...
```

If you're on the Tempest team, also save it to 1Password (vault
*Engineering*, item `Telegram Bot — <bot-name>`) so you don't lose it if
your laptop gets wiped.

## Step 3 — Declare the signal in the workspace

Open the workspace's `workspace.yml` (usually
`~/.atlas/workspaces/<name>/workspace.yml`) and add a `telegram-chat`
signal. Because the token is in `~/.atlas/.env`, the config stays empty:

```yaml
signals:
  telegram-chat:
    title: "Chat via Telegram"
    description: "Receives DM messages from the Telegram bot"
    provider: telegram
    config: {}  # bot_token read from TELEGRAM_BOT_TOKEN env var in ~/.atlas/.env
```

Save and restart the daemon (kill the `deno task dev:playground` process
and run it again; the supervisor will pick up the new config).

## Step 4 — Point Telegram at your laptop

Telegram needs a public HTTPS URL to deliver messages to. When Friday is
running, `webhook-tunnel` already has one ready for you.

1. Grab the current tunnel URL:
   ```bash
   curl -s http://localhost:9090 | python3 -m json.tool
   ```
   Look for the `"url"` field — something like
   `https://<random>.trycloudflare.com`. Copy it.
2. Register the webhook with Telegram. Run this in a terminal (replace
   the two `…` placeholders):
   ```bash
   TELEGRAM_BOT_TOKEN="123456789:ABC-..."
   TUNNEL_URL="https://<random>.trycloudflare.com"

   SUFFIX="${TELEGRAM_BOT_TOKEN#*:}"
   curl -s -X POST \
     "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=${TUNNEL_URL}/platform/telegram/${SUFFIX}"
   ```
   You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.
3. Confirm the webhook sticks:
   ```bash
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
     | python3 -m json.tool
   ```
   `last_error_date` should be `0`. If it's non-zero, re-check that the
   tunnel URL matches what `http://localhost:9090` reports right now —
   the Cloudflare tunnel gets a new URL each time `webhook-tunnel`
   restarts.

## Step 5 — Talk to your bot

In Telegram, search for your bot by username (`@friday_atlas_xxxxx_bot`)
and tap **Start** or send a message. The first message creates a chat in
your workspace. It should appear in the Friday Studio chat list
(http://localhost:5200/platform/user/chat) with a green **TELEGRAM**
badge, and replies flow back to Telegram automatically.

## Troubleshooting

**Bot doesn't respond at all.**
Run `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`. If
`last_error_message` mentions SSL or 404, the tunnel URL is wrong
(probably because `webhook-tunnel` restarted and got a new URL) — re-run
Step 4.2. If `pending_update_count` keeps climbing, updates are queued
but the daemon is dropping them — check the Friday daemon logs for
`telegram_webhook_handler_failed`.

**"No workspace configured for Telegram".**
The daemon couldn't find a workspace with `provider: telegram`. Double-
check `workspace.yml` (Step 3) and restart the daemon. If you run
multiple Telegram bots behind one daemon, make sure each signal's
`config.bot_token` matches the token whose suffix is in its webhook URL.

**Single-bot shortcut.**
If you only have one Telegram workspace and Telegram hits
`/platform/telegram` with no suffix, the daemon falls back to that single
workspace. Fine for development; in production always register the full
suffix so routing is explicit.

**Webhook URL keeps changing.**
The Cloudflare quick-tunnel is ephemeral — it gets a new random URL
whenever `webhook-tunnel` restarts. For production, swap it out for a
tunnel with a stable hostname (named Cloudflare tunnel, ngrok paid, or a
real reverse proxy on a real domain) so you don't have to re-register
with Telegram after every deploy.

## Production notes

- Rotate the bot token by messaging BotFather `/token` → pick your bot →
  **Revoke current token**. The old token immediately stops working, so
  update `~/.atlas/.env`, restart the daemon, and re-register the
  webhook (Step 4) in quick succession.
- Set `TELEGRAM_WEBHOOK_SECRET` to any random string (`openssl rand -hex
  32`). Telegram will include it in every request as
  `X-Telegram-Bot-Api-Secret-Token`, and the adapter rejects requests
  that don't carry it. This guards against someone guessing your webhook
  URL and forging updates.
- Telegram retries failed deliveries (5xx responses) for several minutes
  before giving up. If the daemon can't parse an update, it returns 400
  instead so Telegram drops it quickly and doesn't flood with retries.
