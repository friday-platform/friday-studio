# WhatsApp Integration

Connect a WhatsApp Business number to any Friday workspace so users can chat
with it over WhatsApp. Wired through the [Vercel Chat SDK's WhatsApp adapter](https://www.npmjs.com/package/@chat-adapter/whatsapp),
which speaks the [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).

> **Important — this is NOT WhatsApp Web.**
> `web.whatsapp.com` is the consumer client. Bots can't be built on top of it;
> you need the *Business Cloud API*, which is a separate Meta developer
> product. You'll create an app at [developers.facebook.com](https://developers.facebook.com/apps).

## How it works

```
WhatsApp Cloud (Meta)    ┌── webhook-tunnel ──┐    ┌── atlasd ────────────┐
                         │                    │    │                       │
  user DM  ──POST──────▶ │  /platform/whatsapp│───▶│  /signals/whatsapp    │
  verify   ──GET────────▶│  (preserves query, │    │     │                 │
         (hub.challenge) │   raw body, sig)   │    │     ▼                 │
                         └────────────────────┘    │  Chat SDK webhooks    │
                                                   │   .whatsapp()         │
                                                   │    • GET → echo       │
                                                   │      hub.challenge    │
                                                   │    • POST → verify    │
                                                   │      X-Hub-Sig-256    │
                                                   │    • fires "chat"     │
                                                   └───────────────────────┘
```

The `/platform/...` prefix only exists on the tunnel side — it's an explicit
pass-through so each platform provider can add future routing logic without
touching atlasd. atlasd itself only ever sees `/signals/...`.

Meta hits your webhook in two modes:

- `GET` during initial registration and every periodic re-verification —
  responds to the `hub.challenge` query param after checking `hub.verify_token`
- `POST` for every incoming event (messages, delivery receipts, reactions),
  signed with HMAC-SHA256 of the raw body using your App Secret

Meta only allows **one webhook URL per app**, so the daemon routes to the
right workspace by matching:

- `hub.verify_token` (GET) against each whatsapp workspace's `verify_token`
- `metadata.phone_number_id` (POST body) against each workspace's
  `phone_number_id`

## Prerequisites

- A Meta developer account → [developers.facebook.com](https://developers.facebook.com)
- A Facebook Business Manager (free to create)
- A phone number you can receive SMS/calls on for OTP verification (for
  production use). For dev, Meta gives you a **free test number** that can
  message up to 5 verified recipients.
- `apps/webhook-tunnel` running for a public HTTPS URL, or a real HTTPS domain

## Step 1 — Create a Meta app

The 2026 Meta developer console uses a **use-case-first** wizard instead of the
old "add product" flow. Expect five screens.

1. Open [developers.facebook.com/apps](https://developers.facebook.com/apps) and
   click **Create app**.
2. **App details** — pick an app name. *Don't* include the words `WhatsApp`,
   `FB`, `Face`, `Book`, `Insta`, `Gram`, or `Rift` — Meta's trademark filter
   rejects them silently (the Next button just stays disabled). A generic
   product name like "Friday Atlas" works.
3. **Use cases** — choose **Other** → **Business** → then tick
   **Connect with customers through WhatsApp**.
4. **Business portfolio** — select an existing Business portfolio *or* click
   **create a new one**. The sub-wizard asks for a portfolio name + contact
   first/last name. Pick **Verify later** unless you already have the business
   paperwork ready; dev flows don't require verification.
5. **Requirements → Overview → Create app.** Meta re-prompts for your Facebook
   password before finalizing — this happens even if you logged in minutes ago.
6. On the "Welcome to WhatsApp Business Platform" page, accept the
   **Facebook Terms for WhatsApp Business** + **Meta Hosting Terms** and click
   **Continue**.
7. Meta then asks you to **Choose the WhatsApp accounts you want \<app\> to
   access** — keep the default **Opt in to all current and future WhatsApp
   accounts**, then **Continue** → **Save**. The "connected to …" confetti
   page means the app is live. Click **Got it**.

## Step 2 — Collect four credentials from the Meta dashboard

You'll end up with four values. Copy each one the moment the dashboard shows
it — some are rotated/regenerated easily and won't be shown again.

| Name                  | Where in the dashboard                                 | Env var                     |
|-----------------------|--------------------------------------------------------|-----------------------------|
| **Access Token**      | Business Settings → System Users (see Step 2a)         | `WHATSAPP_ACCESS_TOKEN`     |
| **Phone Number ID**   | WhatsApp → API Setup → *Phone number ID* (not the number itself) | `WHATSAPP_PHONE_NUMBER_ID` |
| **App Secret**        | App Settings → Basic → *App Secret* → **Show** (extract via DOM, don't OCR — `6c` looks like `c`) | `WHATSAPP_APP_SECRET` |
| **Verify Token**      | *You choose this.* Any random string (≥ 32 chars).     | `WHATSAPP_VERIFY_TOKEN`     |

### Step 2a — Create a permanent access token

> **Important.** The big green **Generate access token** button on the
> WhatsApp → API Setup page gives you a *temporary* token that stops working
> after 24 hours. You don't want that. Do this once instead and you'll never
> have to rotate again.

1. Open **[business.facebook.com](https://business.facebook.com/latest/settings/system_users)**
   and make sure the right business is selected at the top-left (it should
   say your company name next to the small "F" icon).
2. In the left sidebar: **Users** → **System users**.
3. Click the blue **Add** button.
   - If a "Non-discrimination policy" pop-up appears first, read it and
     click **I accept**.
4. Fill in the "Create system user" form:
   - **Name:** *Friday Atlas Daemon* (spaces are fine; avoid hyphens — Meta
     silently rejects names with too many).
   - **Role:** **Admin**.
   - Click **Create system user**.
5. The new user opens on the right. Click **Assign assets**.
   - On the left, pick **WhatsApp accounts**.
   - Check the box next to your WhatsApp Business Account.
   - On the right, toggle **Everything** on.
   - Click **Assign assets**, then **Done**.
6. The System User also needs permission on your Meta app. Open
   **Accounts → Apps** in the sidebar, click your app (e.g. *Friday Atlas*),
   then **Assign people**.
   - Check **Friday Atlas Daemon (System user)**.
   - Toggle **Manage app** on (Full control).
   - Click **Assign**, then **Done**.
7. Go back to **Users → System users → Friday Atlas Daemon** and click
   **Generate token**:
   - **Select app:** your Meta app → **Next**.
   - **Set expiration:** **Never** → **Next**.
   - **Assign permissions:** tick both `whatsapp_business_messaging` and
     `whatsapp_business_management` → **Generate token**.
   - A pop-up shows the token **once**. Click the copy icon right now —
     if you close the pop-up without copying, you have to regenerate.

### Step 2b — Copy the other three values

Still in the Meta dashboard:

- **Phone number ID**: go to **WhatsApp → API Setup**, find *Phone number ID*
  (not the phone number itself). Click the small copy icon next to it.
- **App Secret**: **App settings → Basic**, click **Show** next to *App
  Secret*. Meta will ask for your Facebook password. Click the copy icon.
  (Don't retype it — hex fonts make `6c` look like `c`; any single wrong
  character breaks signature verification.)
- **Verify token**: you make this one up. It's any long random string you'll
  also paste into Meta's webhook configuration later. Generate one in a
  terminal:
  ```bash
  openssl rand -hex 32
  ```

### Step 2c — Save the four values

Paste all four into `~/.atlas/.env` (the daemon loads this file automatically
on every restart):

```bash
# append to ~/.atlas/.env (create the file if it doesn't exist)
WHATSAPP_ACCESS_TOKEN=EAA...          # Step 2a, System User token
WHATSAPP_PHONE_NUMBER_ID=15551234567  # Step 2b, from API Setup
WHATSAPP_APP_SECRET=0ad6c116...       # Step 2b, from App settings → Basic
WHATSAPP_VERIFY_TOKEN=<your-random-string>  # Step 2b, openssl output
```

If you're on the Tempest team, store them in 1Password too (vault
*Engineering*, item title `WhatsApp — <app-name>`) so others can find them.

### Temporary token (fallback only)

If you really just want WhatsApp working for the next couple of hours —
for a one-off demo and nothing more — click **Generate access token** on
**WhatsApp → API Setup** instead of doing Step 2a. The resulting token
works for **24 hours**, then every outbound reply fails with
`(#131005) Access denied` until you regenerate. See Troubleshooting.

## Step 3 — Declare the signal in the workspace

Edit your workspace's `workspace.yml` (usually
`~/.atlas/workspaces/<name>/workspace.yml`) and add a `whatsapp-chat` signal.
Because you put the credentials into `~/.atlas/.env` in Step 2c, the signal
config can stay empty — the daemon reads the env vars automatically:

```yaml
signals:
  whatsapp-chat:
    title: "Chat via WhatsApp"
    description: "Receives WhatsApp messages for the business number"
    provider: whatsapp
    config: {}  # credentials read from WHATSAPP_* env vars in ~/.atlas/.env
```

**Only** put credentials directly in `workspace.yml` if you run multiple
WhatsApp business numbers from the same daemon and need per-workspace
overrides:

```yaml
signals:
  whatsapp-chat:
    title: "Chat via WhatsApp"
    description: "Receives WhatsApp messages for the business number"
    provider: whatsapp
    config:
      access_token:    "${WHATSAPP_ACCESS_TOKEN}"   # env interpolation works
      app_secret:      "${WHATSAPP_APP_SECRET}"
      phone_number_id: "${WHATSAPP_PHONE_NUMBER_ID}"
      verify_token:    "${WHATSAPP_VERIFY_TOKEN}"
      api_version:     v21.0            # optional; default v21.0
```

| Field             | Env fallback               | Required | Notes                                                       |
|-------------------|----------------------------|----------|-------------------------------------------------------------|
| `access_token`    | `WHATSAPP_ACCESS_TOKEN`    | Yes      | Meta Graph API token                                        |
| `app_secret`      | `WHATSAPP_APP_SECRET`      | Yes      | HMAC key for `X-Hub-Signature-256`                          |
| `phone_number_id` | `WHATSAPP_PHONE_NUMBER_ID` | Yes      | From WhatsApp → API Setup (not the number in E.164)         |
| `verify_token`    | `WHATSAPP_VERIFY_TOKEN`    | Yes      | You choose it; must match what you paste in the dashboard   |
| `api_version`     | —                          | No       | Defaults to `v21.0`                                         |

## Step 4 — Expose atlasd and register the webhook

```bash
# Terminal 1 — start everything (daemon + link + ledger + playground + tunnel)
deno task dev:playground

# Terminal 2 — grab the tunnel URL (webhook-tunnel listens on :9090)
curl -s http://localhost:9090 | jq .url
# → "https://<random>.trycloudflare.com"
```

Then in the Meta dashboard, left nav **Configuration** (under "Connect on
WhatsApp" use case). The Webhook panel opens with two empty fields:

1. **Callback URL:** `https://<random>.trycloudflare.com/platform/whatsapp`
2. **Verify token:** paste the value you stored as `WHATSAPP_VERIFY_TOKEN`
3. Click **Verify and save**. The button is disabled until both fields have
   content. Meta fires a `GET` with `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
   to the callback URL; the webhook-tunnel forwards it to atlasd, which looks
   up the workspace by `verify_token` and echoes the challenge back.
4. On success the page briefly spins, reloads the left nav, and then the
   **Webhook fields** table appears under the Callback/Verify inputs. That
   table is the "Verify and save succeeded" signal — it's invisible until
   verification passes.
5. Scroll the fields table until you see `messages`. Toggle its **Subscribe**
   switch — the row goes blue and a green toast reads "Successfully subscribed
   to the messages v25.0 webhook field". Optionally do the same for
   `message_status` / `message_echoes`.

### If the fields table doesn't appear

The page silently reloads after clicking **Verify and save** — sometimes the
right-hand panel goes blank. Click **Configuration** in the left nav again;
the panel rehydrates with the filled Callback URL, masked Verify token, and
the webhook fields table. That's normal.

## Step 5 — Add recipients (test number only)

If you're using Meta's free test number, WhatsApp will only deliver messages
sent *from* the business number to **pre-verified** recipients. Inbound
(phone → business) is unrestricted; outbound needs each recipient OTP-verified.

1. Left nav → **API Setup**.
2. The main panel shows "Step 1: Select phone numbers" with a **From** combobox
   pre-filled with your test number (e.g. `Test number: +1 555 170 3316`) and
   a **To** combobox reading "Select a recipient phone number".
3. Click the **To** combobox → a dropdown opens with a single button:
   **Manage phone number list**. Click it.
4. A modal "Add a recipient phone number / You can have up to 5 phone numbers
   to receive free test messages." opens.
5. Leave the country selector as `US +1` (or change it) and type the 10-digit
   national number. Meta validates live — a blue checkmark appears when the
   format is good and the **Next** button enables.
6. Click **Next**. Meta sends a **WhatsApp** message to that number with a
   **5-digit verification code** ("Code sent successfully" toast appears).
   *Note: this is WhatsApp, not SMS — the recipient device must have WhatsApp
   installed and be online.*
7. Enter the 5 digits into the verification modal. On success the modal closes,
   the new number appears in the **To** combobox, and the `curl` snippet in
   Step 2 updates with `"to":"<number>"`.

With a production number (once registered and approved), anyone can message
you and you can reply within a 24-hour customer-service window. Outside the
window you must use approved templates — out of scope for this doc.

## Step 6 — Talk to your bot

From the verified WhatsApp number on your phone, send a message to the
business number (e.g. `+1 555 170 3316`). It should appear in Friday Studio
chat list with a green **WHATSAPP** badge, and replies flow back to WhatsApp
automatically.

To confirm the wiring end-to-end without leaving the terminal:

```bash
# Simulate Meta's GET verification handshake
TUNNEL="https://<random>.trycloudflare.com"
VERIFY="$WHATSAPP_VERIFY_TOKEN"
curl -s "$TUNNEL/platform/whatsapp?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=ping"
# → prints: ping
```

A 200 response echoing your challenge means the tunnel → webhook-tunnel →
atlasd → Chat SDK adapter path is healthy.

## Troubleshooting

**"The callback URL or verify token couldn't be validated" (Meta dashboard).**
Meta's GET reached the daemon but either (a) the tunnel URL is wrong, (b) the
verify token doesn't match what you stored, or (c) no workspace has
`provider: whatsapp` yet. Check atlasd logs for `whatsapp_verify_no_workspace`
or `whatsapp_no_adapter_for_workspace`.

**"Invalid signature" in logs.**
`app_secret` doesn't match the App Secret under **App Settings → Basic**.
Regenerate or re-copy; the adapter uses `timingSafeEqual` so any whitespace or
truncation fails.

**`Unsupported post request` from Meta.**
The access token doesn't have `whatsapp_business_messaging` permission, or
the phone number ID isn't associated with the access token's Business
Account. In API Setup, use the *Copy* buttons rather than retyping.

**Messages arrive but don't trigger the signal.**
Check that the `workspace.yml` signal is named and `provider: whatsapp`, and
that the daemon was restarted after the edit. Look for
`whatsapp_signal_received` → `workspace_id` in logs to confirm routing.

**Test number recipient limit (5).**
Production requires registering a real business number with OTP — free test
numbers are capped at 5 approved recipients and cannot be promoted.

**`thread_post_failed` with `(#131005) Access denied` (HTTP 403).**
You're using the 24-hour *temporary* access token from **WhatsApp → API
Setup** and it expired. Follow Step 2a to create a permanent System User
token — once. Replace `WHATSAPP_ACCESS_TOKEN` in `~/.atlas/.env` and restart
the daemon; this error goes away for good.

## Production notes

- Meta rotates App Secrets on request under **App Settings → Basic →
  Reset**. Coordinate the rotation with a daemon restart, otherwise signature
  verification will start rejecting live traffic.
- WhatsApp message history **cannot** be fetched via the Cloud API — the
  adapter caches recent messages in memory (`persistMessageHistory: true`) to
  give the LLM conversational context. Restarting the daemon clears that
  cache.
- You can't edit or delete already-sent WhatsApp messages. Streaming replies
  are *buffered* (assembled in memory, then sent once complete) rather than
  updated in place.
