# QA Plan: Slack BYO Credentials (end-to-end)

**Context**: Bring-your-own Slack credentials — `resolvePlatformCredentials`
reads `bot_token` + `signing_secret` from workspace.yml signal config or env
vars, with the Link-managed path demoted to fallback. Coexists with
Telegram/WhatsApp.
**Branch**: `declaw`
**Date**: 2026-04-21
**Related docs**: `docs/integrations/slack/README.md` (user setup guide)

## Prerequisites

### Environment

- Full dev stack: `deno task dev:playground`
  - daemon on `:8080`
  - link on `:3100` (running but we won't touch it for BYO)
  - playground on `:5200`
  - webhook-tunnel on `:9090` (public Cloudflare URL)
- Credentials file writable: `~/.atlas/.env`

### Accounts / external

- Personal Slack workspace where you can install a new app (user confirmed)
- api.slack.com/apps access

### Artifacts to have ready before cases run

After setup, you should have:
- Slack app created, `xoxb-…` bot token, signing secret, app ID (`A…`)
- Test Friday workspace (e.g. `slack-byo-test`) with a `slack-chat` signal
  declaring `app_id` (bot token + signing secret come from `~/.atlas/.env`)
- Tunnel URL registered in Slack's Event Subscriptions page, verified green

## Setup Walkthrough (not test cases — prep before running)

Follow `docs/integrations/slack/README.md` Steps 1–6 exactly. If anything in
that README is unclear or broken, **that is itself a finding** — flag it in
the report under "Setup friction." Don't silently work around it.

Rough path:
1. Create Slack app from-scratch at api.slack.com/apps
2. Add bot scopes (the full list from the README)
3. Install app → copy `xoxb-…` bot token
4. Copy signing secret + app ID from Basic Information
5. Add `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_ID` to `~/.atlas/.env`
6. Create Friday workspace via playground UI or CLI (pick simplest path), add to
   its `workspace.yml`:
   ```yaml
   signals:
     slack-chat:
       title: "Chat via Slack"
       description: "Receives messages and @mentions from Slack"
       provider: slack
       config:
         app_id: A01234567
   ```
7. Restart daemon so the new workspace.yml is picked up
8. Grab tunnel URL (`curl -s http://localhost:9090 | jq -r .url`)
9. In Slack's Event Subscriptions: paste `<tunnel>/platform/slack`, wait for
   green **Verified**, subscribe to `message.im` + `app_mention`, save + reinstall

### Daemon log tail to keep open during testing

```bash
tail -f ~/.atlas/logs/global.log | grep -iE "slack|chat_sdk|signal"
```

## Cases

### 1. Event Subscription URL verification

**Trigger**: In Slack's Event Subscriptions page (step 9 of setup), paste the
tunnel Request URL and click off the field (Slack auto-verifies).

**Expect**:
- Slack shows a green **Verified ✓** within ~2 seconds
- Daemon logs show `slack_signal_received` with the Slack challenge POST
- `chat_sdk_instance_created` fires for the test workspace with
  `adapters: [atlas, slack]` (proves BYO creds resolved end-to-end)
- Slack saves without error

**If broken**:
- Red "Your URL didn't respond in time" → `curl http://localhost:9090` to
  confirm tunnel is up; paste the current URL (Cloudflare quick-tunnels
  get new URLs on restart)
- `slack_no_workspace_for_app_id` in logs → `app_id` in workspace.yml
  doesn't match what Slack sent; double-check *Basic Information* page
- `slack_no_adapter_for_workspace` → bot_token or signing_secret missing
  from env; `echo $SLACK_BOT_TOKEN` from the shell the daemon was
  launched in (it must inherit the var — daemon spawned via dev:playground
  reads `~/.atlas/.env`)
- Signature mismatch inside `slack_webhook_handler_failed` → `SLACK_SIGNING_SECRET`
  in env doesn't match the Slack app's current secret

### 2. Inbound DM → appears in Friday web UI

**Trigger**: In Slack, open a DM with your bot (*Apps* sidebar → your bot →
*Messages*). Send "hello friday".

**Expect**:
- Within ~1-2 seconds, a new chat appears in http://localhost:5200/platform/user/chat
  tagged with a **SLACK** badge
- The user message is recorded with your Slack user ID
- Session runs, `chat` signal fires on the test workspace
- Bot posts a reply back in Slack (content doesn't matter — any reply proves
  the round-trip)

**If broken**:
- No chat in UI → daemon log `slack_signal_received` missing = inbound
  never arrived; check Slack's *Event Subscriptions → Recent Deliveries*
  panel for HTTP errors from the tunnel
- Chat appears but no reply → `thread_post_failed` in logs; adapter-side
  outbound failure (Slack API 4xx). Inspect the embedded error for
  `slack_error` → most common: bot hasn't been invited to the channel
  (DM should work without invite) or scopes missing `chat:write`
- Reply posts but as wrong user → workspace routing; check
  `findWorkspaceByProvider` matched the right workspace

### 3. @mention in a public channel

**Trigger**:
```
/invite @friday-test-bot
```
in any public channel, then message `@friday-test-bot ping`.

**Expect**:
- Same flow as case 2 — chat appears in Friday UI, bot replies in the
  channel (threaded reply to the mention)
- `data-session-start` and `text-delta` events flow into the SSE stream
  visible in the web UI

**If broken**:
- Bot joined but didn't respond → `app_mentions:read` scope missing;
  reinstall the app after adding scopes
- "operation_not_supported_in_channel_type" in logs → missing
  `channels:history` / `channels:read` for public channels

### 4. Coexistence: Telegram signal + Slack signal in same workspace (optional)

**Trigger**: Add a Telegram signal to the test workspace (see
`docs/integrations/telegram/README.md` steps 1–3 for a quick bot setup). Then
DM both bots — one Telegram, one Slack — at roughly the same time.

**Expect**:
- Both messages land in the Friday web UI as separate chats (one with
  **SLACK** badge, one with **TELEGRAM**)
- `chat_sdk_instance_created` log shows `adapters: [atlas, slack, telegram]`
  — confirms the cross-provider shadow was correctly dropped
- Both bots reply independently

**If broken**:
- Only one provider works → `resolvePlatformCredentials` returned fewer
  creds than expected; check logs for `slack_signal_no_*` or
  `telegram_no_bot_token`

### 5. Regression: Link-managed Slack still works when BYO not present (optional)

**Trigger**: In a **different** workspace with a managed Slack install
(installed via the playground *Connect Slack* button, not BYO), DM its bot.

**Expect**:
- Works exactly as before the BYO change — creds fetched from Link service,
  adapter wired, message round-trips
- `chat_sdk_instance_created` log does NOT show any `slack_signal_no_bot_token`
  (because the slack signal has no `bot_token` field, we go straight to Link)

**If broken**:
- `slack_signal_no_bot_token` → wait, this is actually an info-level
  rejection that falls through to `resolveSlackFromLink` — NOT a failure
  unless Link also fails
- Link path returns null → separate problem, not BYO-related; out of scope

### 6. Signature tampering rejected (optional security smoke)

**Trigger**: From terminal, forge a fake Slack event with a bad signature:
```bash
TUNNEL=$(curl -s http://localhost:9090 | jq -r .url)
curl -X POST "$TUNNEL/platform/slack" \
  -H "Content-Type: application/json" \
  -H "X-Slack-Request-Timestamp: $(date +%s)" \
  -H "X-Slack-Signature: v0=deadbeef" \
  -d '{"api_app_id":"A01234567","type":"event_callback","event":{"type":"message","text":"fake","user":"UFAKE","channel":"DFAKE","ts":"0"}}'
```

**Expect**:
- Response ≠ 200 (adapter rejects on HMAC mismatch)
- `slack_webhook_handler_failed` in logs with signature-related reason
- No chat created in Friday UI (forged event shouldn't trigger anything)

**If broken**:
- Reply is 200 and chat appears → signature verification is disabled or
  bypassed. Critical finding, halt testing and investigate.

## Cleanup

1. Slack dashboard: remove the test app (*Basic Information* → *Delete App*)
2. Remove `SLACK_*` vars from `~/.atlas/.env`
3. Delete the test Friday workspace via playground UI (or
   `DELETE /api/workspaces/<id>`)
4. `deno task atlas daemon stop`

## Smoke Candidates

- Case 1 (URL verification) — deterministic, runs in < 10s, covers the
  whole BYO resolve path in one shot without needing human interaction
  beyond the first verification click. Worth adding to
  `docs/qa/smoke-matrix.md` as a recurring check.
- Case 6 (signature tampering) — critical security guarantee, same URL
  mechanics, can be scripted.

Cases 2/3/4 require human-in-the-loop Slack UI interaction → not smoke
candidates, but worth running before every PR that touches
`apps/atlasd/src/chat-sdk/`.
