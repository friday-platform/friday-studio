# Microsoft Teams Integration (BYO)

Connect a Microsoft Teams bot to any Friday workspace so users can chat with the
workspace over DM or `@mentions` inside a Team. Friday uses the
[Vercel Chat SDK's Teams adapter](https://www.npmjs.com/package/@chat-adapter/teams)
behind the scenes — Teams posts activities to your public HTTPS endpoint, the
adapter verifies and normalizes them, and they flow into the same pipeline the
web chat uses.

> **BYO only.** Teams is currently only available as a **bring-your-own**
> integration — you create the Azure Bot yourself at
> [portal.azure.com](https://portal.azure.com), build a Teams app package, and
> paste the credentials into `~/.atlas/.env` (or into `workspace.yml` for
> per-workspace overrides). There is no managed _Connect Teams_ button in the
> workspace settings UI yet.

## How it works

```
Teams / Azure Bot Service   ┌── webhook-tunnel ──┐    ┌── atlasd ───────────────┐
                            │                    │    │                          │
  activity  ──POST─────────▶│  /platform/teams   │───▶│  /signals/teams          │
  (message, mention,        │  (raw body, auth   │    │     │                    │
   reaction, typing)        │   header preserved)│    │     ▼                    │
                            └────────────────────┘    │  Chat SDK                │
                                                      │   webhooks.teams()       │
                                                      │    • verifies JWT from   │
                                                      │      Authorization       │
                                                      │    • matches activity.   │
                                                      │      recipient.id →      │
                                                      │      workspace app_id    │
                                                      │    • fires "chat"        │
                                                      └──────────────────────────┘
```

The `/platform/...` prefix only exists on the tunnel side — it's an explicit
pass-through so each platform provider can add future routing logic without
touching atlasd. atlasd itself only ever sees `/signals/...`.

**One endpoint per daemon — no per-bot URL suffix.** Unlike Telegram (which
routes via `/platform/telegram/<token-suffix>`), every Teams bot posts to the
same `/platform/teams` URL. atlasd matches each inbound activity to a workspace
by comparing `activity.recipient.id` against each teams workspace's `app_id`.
That means you can host multiple Teams bots on one daemon — each gets its own
`app_id` in `workspace.yml`, and the router dispatches without any URL
gymnastics.

Azure Bot Service requires a public HTTPS URL for the messaging endpoint. In
development Friday ships with `apps/webhook-tunnel` (a Cloudflare quick-tunnel)
that exposes your local daemon to the internet automatically when you run
`deno task dev:playground`.

## Known limitations

- **No reactions.** The adapter's `addReaction` and `removeReaction` both throw
  `NotImplementedError` — the Teams SDK does not yet expose the underlying API.
  Friday can _receive_ reactions as inbound events, but any outbound
  acknowledgment-reaction UX (thumbs-up on seen, etc.) silently errors out.
- **No slash commands.** The adapter's HTTP Interactions / invoke path for
  messaging extensions and slash commands is not wired into atlasd. Teams
  `@mentions` and DMs work; `/atlas chat` and similar commands do not.
- **`openDM` requires a prior @mention.** Teams does not let a bot open a 1:1
  conversation from a cold userId — the adapter first needs the user's
  `tenantId` and `serviceUrl`, which are only captured when that user @mentions
  the bot somewhere (DM or channel). `openDM` throws a `ValidationError` with
  _"tenant ID not found. User must interact with the bot first"_ until the cache
  is populated.
- **BYO only, no Link service tracking.** Credential rotation and revocation
  happen entirely through the Azure portal and your env file — there's no
  _Connections_ panel entry to remove.

## Prerequisites

- An Azure account with an active subscription (the **F0** pricing tier for
  Azure Bot is free and sufficient for development).
- Admin rights in a Microsoft 365 tenant that you can sideload a custom Teams
  app into. Teams is **required** — a Microsoft personal account ("Teams free")
  does not work, you need a work/school tenant. Options that work: a corporate
  tenant where you have admin rights, a paid M365 Business Basic license
  (~$6/user/mo, disposable), or the
  [Microsoft 365 Developer Program](https://developer.microsoft.com/microsoft-365/dev-program)
  if you qualify (eligibility tightened in 2024 — requires a Visual Studio
  subscription or partner status). The adapter cannot be validated end-to-end
  without a real Teams client sending messages through a real Microsoft 365
  tenant.
- `apps/webhook-tunnel` running for a public HTTPS URL, or a real HTTPS domain.
  Azure Bot Service will not accept an `http://` messaging endpoint.
- Friday running locally: `deno task dev:playground`.

## Step 1 — Create an Azure Bot resource

1. Open [portal.azure.com](https://portal.azure.com) and click **Create a
   resource**.
2. Search for **Azure Bot** and select it from the Marketplace.
3. Click **Create** and fill in:
   - **Bot handle:** a unique identifier for your bot (e.g. `friday-atlas-bot`).
   - **Subscription:** your Azure subscription.
   - **Resource group:** create new or use existing.
   - **Pricing tier:** **F0** (free) for testing.
   - **Type of App:** **Single Tenant** (recommended for dev against one M365
     tenant) or **Multi Tenant** (if you plan to install the same bot across
     multiple tenants). This choice is important — see
     [SingleTenant vs MultiTenant](#singletenant-vs-multitenant).
   - **Creation type:** **Create new Microsoft App ID**.
4. Click **Review + create**, then **Create**. Provisioning takes 30–60 s.

## Step 2 — Collect three credentials

Once the Bot resource is live, you need three values from the portal.

| Name                      | Where in the portal                                                                   | Env var               |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------- |
| **Microsoft App ID**      | Bot resource → **Configuration** → _Microsoft App ID_                                 | `TEAMS_APP_ID`        |
| **Client secret value**   | **Manage Password** → _Certificates & secrets_ → **New client secret** → copy _Value_ | `TEAMS_APP_PASSWORD`  |
| **Directory (tenant) ID** | App Registration → **Overview** → _Directory (tenant) ID_ (SingleTenant only)         | `TEAMS_APP_TENANT_ID` |

Step-by-step:

1. In the Bot resource, open **Configuration** and copy **Microsoft App ID**
   into `TEAMS_APP_ID`.
2. Click **Manage Password** next to the App ID — the portal redirects to the
   underlying App Registration.
3. Go to **Certificates & secrets** → **New client secret**. Add a description,
   choose an expiry (24 months is the default max for most tenants), and click
   **Add**.
4. Copy the **Value** column **immediately** — Azure shows it exactly once.
   Paste it into `TEAMS_APP_PASSWORD`. If you miss it, you have to delete the
   secret and create a new one.
5. Go to **Overview** in the same App Registration and copy **Directory (tenant)
   ID** into `TEAMS_APP_TENANT_ID`. (Only required for SingleTenant bots — see
   below.)

### SingleTenant vs MultiTenant

This is the most common failure mode for first-time Teams setup. Pick one:

- **SingleTenant** (recommended for dev): the bot only works inside the Azure AD
  tenant that owns it. You **must** set `TEAMS_APP_TENANT_ID` — the adapter
  fails auth without it. This is what most internal/enterprise bots want.
- **MultiTenant**: the bot works across any tenant that installs your app. Omit
  `TEAMS_APP_TENANT_ID`. Only pick this if you genuinely need cross-tenant
  distribution (e.g. a SaaS product).

**⚠️ The Azure Bot's "Type of App" is immutable after creation.** The dropdown
is greyed out on the Configuration page of an existing bot — you cannot flip a
SingleTenant bot to MultiTenant (or vice versa) without deleting and recreating
the Azure Bot resource. Pick carefully in Step 1.

Flipping only the App Registration's _Supported account types_ (Entra ID →
Authentication) from Single to Multi-tenant is **not** enough. Inbound JWT
validation will start accepting MT-style tokens, but outbound replies still 401
because the Bot Service still validates tokens against its original registered
type. The symptom: inbound `teams_signal_received` logs fine, Friday processes
the message, then `thread_post_failed` with
`Authorization has been denied for this request` when posting the reply to
`smba.trafficmanager.net`.

The `app_type` in `workspace.yml` must match what the **Bot Service** is
registered as — not what the App Registration says. If in doubt, check Bot
resource → Configuration → _Type of App_. That's the source of truth for runtime
auth. Mechanics:

| app_type in workspace.yml | OAuth token endpoint used                                      | When it works                          |
| ------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `SingleTenant`            | `login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`      | Bot Service registered as SingleTenant |
| `MultiTenant`             | `login.microsoftonline.com/botframework.com/oauth2/v2.0/token` | Bot Service registered as MultiTenant  |

## Step 3 — Save the credentials

Paste the values into `~/.atlas/.env` so the daemon picks them up on every
restart:

```bash
# Append to ~/.atlas/.env (create the file if it doesn't exist)
TEAMS_APP_ID=00000000-0000-0000-0000-000000000000
TEAMS_APP_PASSWORD=<client-secret-value>
TEAMS_APP_TENANT_ID=00000000-0000-0000-0000-000000000000  # SingleTenant only
```

If you're on the Tempest team, also save them to 1Password (vault _Engineering_,
item `Teams Bot — <bot-name>`) so you don't lose them if your laptop gets wiped,
and because the client secret is unrecoverable after first view.

## Step 4 — Declare the signal in the workspace

Open the workspace's `workspace.yml` (usually
`~/.atlas/workspaces/<name>/workspace.yml`) and add a `teams-chat` signal.

If you've put the credentials in `~/.atlas/.env`, the config block can stay
empty — the daemon reads the env vars automatically:

```yaml
signals:
  teams-chat:
    title: "Chat via Microsoft Teams"
    description: "Receives DMs and @mentions from Teams"
    provider: teams
    config: {} # credentials read from TEAMS_* env vars in ~/.atlas/.env
```

For multi-workspace setups — one daemon hosting two Teams bots with different
app IDs — declare the credentials inline so the router can tell them apart:

```yaml
signals:
  teams-chat:
    title: "Chat via Microsoft Teams"
    description: "Receives DMs and @mentions from Teams"
    provider: teams
    config:
      app_id: "${TEAMS_APP_ID}" # env interpolation works
      app_password: "${TEAMS_APP_PASSWORD}"
      app_tenant_id: "${TEAMS_APP_TENANT_ID}" # required for SingleTenant
      app_type: "SingleTenant" # or "MultiTenant"; must match Azure Bot's "Type of App"
```

| Field           | Env fallback          | Required         | Notes                                                                                                                                                                               |
| --------------- | --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_id`        | `TEAMS_APP_ID`        | Yes              | Azure Bot Microsoft App ID; also the router match key                                                                                                                               |
| `app_password`  | `TEAMS_APP_PASSWORD`  | Yes              | Client secret _Value_ (not the secret ID)                                                                                                                                           |
| `app_tenant_id` | `TEAMS_APP_TENANT_ID` | For SingleTenant | Directory (tenant) ID from the App Registration Overview                                                                                                                            |
| `app_type`      | —                     | Yes in practice  | `"SingleTenant"` or `"MultiTenant"` — must match the Bot Service's "Type of App" (immutable after creation). Default is `MultiTenant`, but most Azure Bots are created SingleTenant |

Save and restart the daemon (kill the `deno task dev:playground` process and run
it again; the supervisor will pick up the new config).

## Step 5 — Point Azure at your laptop

Azure Bot Service needs a public HTTPS URL for the messaging endpoint. When
Friday is running, `webhook-tunnel` already has one ready for you.

1. Grab the current tunnel URL:
   ```bash
   curl -s http://localhost:9090 | python3 -m json.tool
   ```
   Look for the `"url"` field — something like
   `https://<random>.trycloudflare.com`. Copy it.
2. In the Azure portal, open your Bot resource → **Configuration**.
3. Set **Messaging endpoint** to:
   ```
   https://<random>.trycloudflare.com/platform/teams
   ```
   Note: there is **no per-bot suffix** on this URL — every Teams bot uses the
   same `/platform/teams` path, and atlasd routes by `app_id`.
4. Click **Apply**. Azure does not verify the endpoint at save time, so a 200
   response only shows up when real traffic arrives.
5. Still in the Bot resource, open **Channels** and click **Microsoft Teams**.
   Accept the terms of service and click **Apply**. Without this, Teams clients
   will not deliver messages to your bot even if the manifest is correct.

## Step 6 — Build the Teams app package

A messaging endpoint alone isn't enough — Teams clients will not surface the bot
until it's installed as an app. Create a `manifest.json` file:

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "packageName": "com.yourcompany.atlas",
  "developer": {
    "name": "Your Company",
    "websiteUrl": "https://your-domain.com",
    "privacyUrl": "https://your-domain.com/privacy",
    "termsOfUseUrl": "https://your-domain.com/terms"
  },
  "name": {
    "short": "Friday Atlas",
    "full": "Friday Atlas Bot"
  },
  "description": {
    "short": "Friday workspace bot",
    "full": "Chat with your Friday workspace from Microsoft Teams."
  },
  "icons": {
    "outline": "outline.png",
    "color": "color.png"
  },
  "accentColor": "#FFFFFF",
  "bots": [
    {
      "botId": "00000000-0000-0000-0000-000000000000",
      "scopes": ["personal", "team", "groupchat"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": ["your-domain.com"]
}
```

Both `id` and `bots[].botId` must equal your **Microsoft App ID** (the
`TEAMS_APP_ID` value from Step 2). They are two different Teams concepts (app ID
vs bot ID) that happen to take the same value for a single-bot app.

Add two icons next to the manifest:

- `outline.png` — 32×32, transparent background, monochrome white
- `color.png` — 192×192, full-color

Zip the three files (manifest + both icons) at the **root** of the archive — do
not put them inside a subfolder, or Teams rejects the upload with a vague
"invalid app package" error.

## Step 7 — Sideload the app into Teams

For development testing:

1. Open Microsoft Teams (desktop or web).
2. Click **Apps** in the left sidebar.
3. Click **Manage your apps**, then **Upload an app**.
4. Click **Upload a custom app** and select your zip file.
5. In the install dialog, click **Add** to install to your personal scope, or
   **Add to a team** / **Add to a chat** to install into a shared context.

If your tenant hides **Upload a custom app**, custom app sideloading is disabled
by admin policy. Either ask your admin to enable it for your account, or use a
[Microsoft 365 Developer Program](https://developer.microsoft.com/microsoft-365/dev-program)
tenant where you are the admin.

For organization-wide deployment, upload to the
[Teams Admin Center](https://admin.teams.microsoft.com) → **Teams apps** →
**Manage apps** → **Upload new app**. Out of scope for local dev.

## Step 8 — Talk to your bot

1. In Teams, open the installed app (personal scope) or go to a channel where
   you added it.
2. Send **"hello friday"** as a DM, or `@Friday Atlas hello` in a channel.
3. Within a second or two, atlasd should log an inbound `/signals/teams` hit,
   followed by a new chat in http://localhost:5200/platform/user/chat with a
   **TEAMS** badge.

The first @mention from each user populates the adapter's tenantId / serviceUrl
cache — only after that can Friday initiate new DMs to that user via `openDM`.

## Troubleshooting

**`Unauthorized` / 401 in atlasd logs on every inbound activity.** The Bot
Framework rejected the JWT from the `Authorization` header. Most likely the
**client secret expired or was rotated** in the portal — check _App Registration
→ Certificates & secrets_; expired secrets do not auto-delete, they just stop
signing. Generate a new client secret, update `TEAMS_APP_PASSWORD` in
`~/.atlas/.env`, and restart the daemon. Other causes: `app_type` mismatch
(workspace.yml says `SingleTenant` but Azure has MultiTenant, or vice versa), or
a missing `app_tenant_id` on a SingleTenant bot.

**Inbound works but outbound replies 401
(`thread_post_failed: Authorization has been denied for this request`).** You're
seeing `teams_signal_received` log fine with the right `appId`, the agent runs
to completion, and then the POST to `smba.trafficmanager.net/.../activities`
comes back 401. Root cause: the `app_type` in `workspace.yml` does not match the
Bot Service's registered "Type of App". Our adapter mints the OAuth token
against different endpoints per type (see the table above in
[SingleTenant vs MultiTenant](#singletenant-vs-multitenant)), and
`smba.trafficmanager.net` validates the token against whatever the Bot Service
was registered as at creation time. Fix: check Azure Bot resource →
Configuration → _Type of App_ (the greyed-out field) and set `app_type` in
`workspace.yml` to the same value, then restart the daemon. Flipping the App
Registration's _Supported account types_ in Entra ID does **not** fix this —
only the Bot Service's registered type matters for outbound auth, and it's
immutable.

**Bot is installed in Teams but receives no messages.** The most common cause is
the **Teams channel is not enabled** in Azure. Go to Bot resource → **Channels**
→ click **Microsoft Teams** → accept ToS → **Apply**. Without this step Teams
accepts the manifest install but silently drops every outbound message to your
bot.

**Multiple Teams bots on one daemon; the wrong workspace handles a message.**
atlasd routes by `activity.recipient.id` — the inbound Teams activity's
`recipient.id` field is the target bot's Microsoft App ID. Make sure each
workspace's `config.app_id` (or the daemon's `TEAMS_APP_ID` if only one bot)
exactly matches the App ID of the bot whose messages you expect it to receive.
App IDs are case-sensitive GUIDs; copy them with the portal's copy button rather
than retyping.

**`openDM` throws _"tenant ID not found. User must interact with the bot
first"_.** Expected behavior on cold userIds — Teams does not expose a bot →
user DM flow without prior contact. The user must @mention the bot at least once
(in any scope) so the adapter can cache their `tenantId` and `serviceUrl`. After
that, `openDM` works indefinitely for that user.

**Adaptive cards or buttons render but reactions silently fail.** Reactions are
not supported (`addReaction` / `removeReaction` throw `NotImplementedError` —
see [Known limitations](#known-limitations)). If an agent prompts reactions as
acknowledgment, expect errors in logs and switch the agent to a text
acknowledgment instead.

**Tunnel URL keeps changing.** The Cloudflare quick-tunnel is ephemeral — it
gets a new random URL whenever `webhook-tunnel` restarts. Each restart requires
updating the **Messaging endpoint** in the Azure portal. For stable dev, use a
named Cloudflare tunnel, ngrok paid, or a real reverse proxy on a real domain.

**Bot Framework Emulator refuses to connect / can't authenticate.** Don't bother
— the Bot Framework Emulator was archived by Microsoft in late 2024 (as of
2026-04) and is not maintained. It also cannot authenticate against a
SingleTenant bot (no tenant-ID field in settings), and for MultiTenant bots it
requires credentials that many Azure setups reject. End-to-end validation
against a real Microsoft Teams client in an M365 tenant is the only reliable
test path.

Azure Portal's _Test in Web Chat_ also won't round-trip: `@chat-adapter/
teams`
encodes each activity's `serviceUrl` into the threadId on inbound, but the reply
path (`app.send()` in `@microsoft/teams.apps`) ignores the decoded value and
sends to the **app-wide** `serviceUrl` configured at construction (default:
`https://smba.trafficmanager.net/teams`). Inbound activities from Web Chat reach
Friday, but replies go to the Teams channel URL instead of back to Web Chat, so
you never see them.

## Production notes

- **Rotate the client secret** under _App Registration → Certificates &
  secrets_. Azure does not let you edit an existing secret — create a new one,
  update `TEAMS_APP_PASSWORD`, restart the daemon, then delete the old secret.
  Plan for the rotation: every outbound reply fails with `Unauthorized` between
  the portal change and the daemon restart.
- **Watch secret expiry.** The default expiry is 24 months but tenants can
  enforce shorter windows. Put a calendar reminder two weeks before expiry — the
  adapter has no proactive warning, failures just start returning 401 on the
  expiry date.
- **Messaging endpoint is HTTPS only.** Azure does not allow `http://` messaging
  endpoints even in development, which is why `webhook-tunnel` or a real HTTPS
  domain is mandatory.
- **BYO apps are not tracked by the Link service.** Credential rotation and
  revocation happen entirely through the Azure portal and your env file —
  there's no _Connections_ panel entry to remove.
