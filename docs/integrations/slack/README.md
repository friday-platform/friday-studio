# Slack Integration (BYO)

Connect a Slack app to any Friday workspace so users can chat with the
workspace over DM or `@mentions`. Friday uses the [Vercel Chat SDK's Slack adapter](https://www.npmjs.com/package/@chat-adapter/slack)
behind the scenes — the daemon receives Slack events, verifies the
signature, and routes messages into the same pipeline the web chat uses.

> **BYO vs managed.** This guide is for **bring-your-own** Slack apps —
> you create the app yourself at [api.slack.com/apps](https://api.slack.com/apps)
> and paste the credentials into Friday. If you'd rather have Friday
> install and manage the app for you (OAuth flow, credential rotation),
> use the **Connect Slack** button in the workspace settings UI instead;
> that path goes through the Link service and needs no YAML editing.

## How it works

```
Slack                    ┌── webhook-tunnel ──┐    ┌── atlasd ────────────┐
                         │                    │    │                       │
  events     ──POST────▶ │  /platform/slack   │───▶│  /signals/slack       │
  verify     ──POST──▶   │  (preserves raw    │    │     │                 │
         (url_verify)    │   body + sig hdrs) │    │     ▼                 │
                         └────────────────────┘    │  Chat SDK webhooks    │
                                                   │   .slack()            │
                                                   │    • X-Slack-Signature│
                                                   │      HMAC verify      │
                                                   │    • url_verification │
                                                   │      handshake        │
                                                   │    • fires "chat"     │
                                                   └───────────────────────┘
```

The `/platform/...` prefix only exists on the tunnel side — it's an explicit
pass-through so each platform provider can add future routing logic without
touching atlasd. atlasd itself only ever sees `/signals/...`.

Slack only allows **one Request URL per app**, so the daemon routes to the
right workspace by matching `api_app_id` in the event payload against each
Slack workspace's configured `app_id`. That means **every Slack signal
must declare its `app_id`** — without it, inbound events get a 404.

Slack requires a public HTTPS URL for the webhook. In development
Friday ships with `apps/webhook-tunnel` (a Cloudflare quick-tunnel) that
exposes your local daemon to the internet automatically when you run
`deno task dev:playground`.

## Known limitations

- **`invalid_thread_ts` on outbound replies** (`@chat-adapter/slack` ≤ 4.26.0).
  When Friday replies to a top-level Slack DM, the adapter passes an empty
  `thread_ts` to Slack's streaming API and the call fails with
  `invalid_thread_ts` / `invalid_arguments`. Upstream fix is merged at
  [vercel/chat#292](https://github.com/vercel/chat/pull/292) (2026-04-17) but
  not yet published. Watch npm for `@chat-adapter/slack@4.27.0`; until then
  a local patch in `node_modules` is required. See the troubleshooting
  section below.
- **URL verification requires atlasd with the `/signals/slack` url_verification
  handler.** Added to this branch (see `apps/atlasd/routes/signals/platform.ts`).
  Older atlasd builds rejected Slack's handshake POST with 400 because it has
  no `api_app_id`. If you're not running `dev:playground`, make sure your
  atlasd is recent enough.

## Prerequisites

- A Slack workspace where you can install apps (admin or a workspace
  that allows member-installed apps).
- Friday running locally: `deno task dev:playground`.

## Step 1 — Create a Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps) and click
   **Create New App** → **From scratch**.
2. **App Name**: anything (e.g. *Friday Atlas*). **Workspace**: pick the
   Slack workspace you want to install into.
3. On the app's landing page, note two things you'll need later:
   - **App ID** (under *Basic Information* → *App Credentials*, e.g.
     `A01234567`)
   - **Signing Secret** (same section, click **Show** to reveal)

> Treat the Signing Secret like a password — anyone with it can forge
> requests to your webhook. Scope it to a password manager now.

### Alternative: App Manifest (faster)

Steps 2 and 6 below click through the UI to set scopes + event
subscriptions one at a time. If you'd rather paste a manifest and get it
done in 30 seconds:

1. After creating the app, go to **Features** → **App Manifest** in the
   left sidebar.
2. Paste this (replace the `request_url` with your tunnel URL — see Step 6
   for how to grab it):
   ```json
   {
     "display_information": { "name": "friday-bot" },
     "features": {
       "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
       "bot_user": { "display_name": "friday-bot", "always_online": true }
     },
     "oauth_config": {
       "scopes": {
         "bot": [
           "app_mentions:read", "chat:write", "chat:write.public",
           "channels:history", "channels:read", "groups:history", "groups:read",
           "im:history", "im:read", "im:write",
           "mpim:history", "mpim:read", "mpim:write",
           "reactions:write", "users:read"
         ]
       }
     },
     "settings": {
       "event_subscriptions": {
         "request_url": "https://<your-tunnel>.trycloudflare.com/platform/slack",
         "bot_events": ["message.im", "app_mention"]
       },
       "org_deploy_enabled": false,
       "socket_mode_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```
3. Click **Save Changes**. Slack will try to verify the URL (yellow
   "URL isn't verified" banner is expected — see Step 6 to complete
   verification after Friday is running).
4. Skip to **Step 3 — Install the app** below. Steps 2 and 6 are already
   done by the manifest.

## Step 2 — Set OAuth scopes

Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:

```
app_mentions:read     chat:write            chat:write.public
channels:history      channels:read         groups:history
groups:read           im:history            im:read
im:write              mpim:history          mpim:read
mpim:write            reactions:write       users:read
```

These match the manifest Friday uses for managed installs, so behavior
is identical between BYO and managed apps.

## Step 3 — Install the app and grab the bot token

1. Still under **OAuth & Permissions**, scroll to the top and click
   **Install to Workspace**. Approve the OAuth prompt.
2. Slack returns you to the same page with a **Bot User OAuth Token**
   starting with `xoxb-…`. Copy it. (Not the *User* OAuth Token — that's
   a different one; always use `xoxb-`.)

## Step 4 — Save the credentials

Paste the three values into `~/.atlas/.env` so the daemon picks them up
on every restart:

```bash
# Append to ~/.atlas/.env (create the file if it doesn't exist)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=<signing secret from Step 1>
SLACK_APP_ID=A01234567
```

If you're on the Tempest team, also save them to 1Password (vault
*Engineering*, item `Slack App — <app-name>`) so you don't lose them if
your laptop gets wiped.

## Step 5 — Declare the signal in the workspace

Open the workspace's `workspace.yml` (usually
`~/.atlas/workspaces/<name>/workspace.yml`) and add a `slack-chat`
signal. Because the credentials are in `~/.atlas/.env`, the config only
needs `app_id` (required for webhook routing):

```yaml
signals:
  slack-chat:
    title: "Chat via Slack"
    description: "Receives messages and @mentions from Slack"
    provider: slack
    config:
      app_id: A01234567  # from Step 1, matched against api_app_id in every inbound event
      # bot_token read from SLACK_BOT_TOKEN env var
      # signing_secret read from SLACK_SIGNING_SECRET env var
```

If you prefer to inline the credentials instead of using env vars (e.g.
for a dedicated per-workspace bot), all three can live in `config`:

```yaml
signals:
  slack-chat:
    title: "Chat via Slack"
    description: "Receives messages and @mentions from Slack"
    provider: slack
    config:
      app_id: A01234567
      bot_token: xoxb-...
      signing_secret: <signing secret>
```

Save and restart the daemon. You don't need to kill the whole
`dev:playground` stack — just the atlasd process will do:

```bash
lsof -i:8080 -sTCP:LISTEN -t | xargs kill
```

`dev-watcher` respawns atlasd automatically with a fresh process that
re-reads `~/.atlas/.env`. The tunnel URL stays the same, so you don't
have to re-register with Slack.

## Step 6 — Point Slack at your laptop

Slack needs a public HTTPS URL to deliver events to. When Friday is
running, `webhook-tunnel` already has one ready for you.

1. Grab the current tunnel URL:
   ```bash
   curl -s http://localhost:9090 | python3 -m json.tool
   ```
   Look for the `"url"` field — something like
   `https://<random>.trycloudflare.com`. Copy it.
2. In the Slack app dashboard, go to **Event Subscriptions** and toggle
   **Enable Events** on.
3. Set **Request URL** to `<tunnel>/platform/slack`, e.g.
   `https://<random>.trycloudflare.com/platform/slack`. Slack will
   immediately POST a `url_verification` challenge; atlasd's
   `/signals/slack` route echoes the challenge back without
   requiring an `api_app_id` or workspace lookup, and you should see
   a green **Verified** check.
4. Expand **Subscribe to bot events** and add:
   - `message.im` — DMs to your bot
   - `app_mention` — `@bot-name` in any channel it's in
5. Hit **Save Changes** at the bottom.
6. If you're changing scopes on an already-installed app, Slack will
   prompt you to reinstall so the new event scopes take effect — do
   that. (Users who took the **App Manifest** path in Step 1 set scopes
   before install, so no reinstall needed.)

## Step 7 — Talk to your bot

1. In Slack, find your app under **Apps** in the sidebar, or DM it by
   name.
2. Send a message. The first message creates a chat in your workspace
   — it should appear in the Friday Studio chat list
   (http://localhost:5200/platform/user/chat) with a blue **SLACK**
   badge, and replies flow back to Slack automatically.
3. To mention the bot in a channel, invite it first (`/invite @bot-name`),
   then `@bot-name hello`.

## Troubleshooting

**Slack shows "Your URL didn't respond" during Request URL verification.**
Check that `webhook-tunnel` is actually running (`curl http://localhost:9090`
should return JSON). If the tunnel just restarted, Cloudflare assigns a
new URL — paste the fresh one into Event Subscriptions.

**Request URL verifies, but messages don't trigger anything.**
Check the Friday daemon logs for `slack_no_workspace_for_app_id`. This
means the `api_app_id` in the incoming event doesn't match any
workspace's `signals.*.config.app_id` — fix Step 5. Also check
`slack_no_adapter_for_workspace`: that means the workspace resolved but
the bot token or signing secret didn't load — usually missing env vars.

**Signature verification fails (`slack_webhook_handler_failed` with
`invalid_signature`).**
The `signing_secret` in your env/config doesn't match the one shown
under *Basic Information*. Slack rotates it when you click **Regenerate**
— copy the new value and restart the daemon.

**Bot doesn't respond to `@mentions` in channels.**
The bot must be invited to the channel (`/invite @bot-name`), and the
app must have reinstalled after adding `app_mentions:read` to its
scopes.

**Bot receives my DM but never replies (daemon logs show
`thread_post_failed` with `invalid_thread_ts` or `invalid_arguments`).**
Known bug in `@chat-adapter/slack` ≤ 4.26.0 — see "Known limitations"
at the top of this doc. Upstream fix is at
[vercel/chat#292](https://github.com/vercel/chat/pull/292), merged
2026-04-17, awaiting next npm release. Until `4.27.0` ships, apply this
local patch to `node_modules/.deno/@chat-adapter+slack@4.25.0/node_modules/@chat-adapter/slack/dist/index.js`:

- Around line 1483 (`handleMessageEvent`), change
  `const threadTs = isDM ? event.thread_ts || "" : event.thread_ts || event.ts;`
  to `const threadTs = event.thread_ts || event.ts;`
- At each `thread_ts: threadTs,` call site for `postMessage` /
  `chatStream` / `chat.update`, add `|| void 0`.

The patch lives in `node_modules` so it evaporates on any `deno cache`
re-resolve or fresh clone — plan to drop it as soon as `4.27.0`
releases and the package is bumped in `apps/atlasd/package.json`.

**Bot DMs itself on every restart.**
You've probably wired two workspaces to the same `app_id`. Slack can
only deliver to one, and the adapter will post twice if the Chat SDK
ends up with two instances. Make `app_id` unique per workspace.

**Webhook URL keeps changing.**
The Cloudflare quick-tunnel is ephemeral — it gets a new random URL
whenever `webhook-tunnel` restarts. For production, swap it out for a
tunnel with a stable hostname (named Cloudflare tunnel, ngrok paid, or
a real reverse proxy on a real domain) so you don't have to re-register
with Slack after every deploy.

## Production notes

- Rotate the signing secret by clicking **Regenerate** under *Basic
  Information* → *App Credentials*. The old secret immediately stops
  working, so update `~/.atlas/.env`, restart the daemon, and verify
  Slack events still arrive in quick succession.
- Rotate the bot token by clicking **Reinstall App** under *OAuth &
  Permissions*. Same drill: copy the new `xoxb-…`, update env, restart.
- Slack retries failed deliveries (non-2xx, timeout) up to three times
  within about a minute. If the daemon can't parse an event, it returns
  400 so Slack drops it quickly and doesn't flood with retries.
- BYO apps don't go through the Link service, so Slack credentials for
  BYO workspaces are **not** stored in the Link credential store or
  visible in the workspace settings *Connections* panel. Rotation and
  revocation happen entirely in the Slack app dashboard + your env
  file.
