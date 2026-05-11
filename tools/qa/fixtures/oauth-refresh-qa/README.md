# `oauth-refresh-qa` fixture

Test workspace that drives the OAuth refresh resilience QA scenarios
(see `docs/plans/2026-05-11-oauth-refresh-resilience-qa.md`).

A single workspace exercises both the interactive (direct chat) and
non-interactive (cron + HTTP webhook) refresh paths against the same
Google provider family.

## Surface

- **Workspace id:** `oauth-refresh-qa`
- **MCP servers**
  - `google-calendar` — `http://localhost:8001/mcp`, bearer token from
    the Link `google-calendar` provider.
  - `google-gmail` — `http://localhost:8002/mcp`, bearer token from
    the Link `google-gmail` provider.
- **Agents**
  - `workspace-chat` — `type: system, agent: workspace-chat`, scoped
    to the calendar + gmail read tools so chat-driven calls hit the
    interactive refresh path.
- **Signals**
  - `chat` — auto-injected by the runtime (no entry in this file).
  - `every-minute` — cron `* * * * *`, `onMissed: skip`.
  - `refresh-webhook` — HTTP `POST /oauth-refresh-qa/webhook`.
- **Jobs**
  - `handle-chat` — auto-injected by the runtime.
  - `calendar-cron-check` — cron-triggered, calls
    `google-calendar/list_calendars`.
  - `gmail-webhook-check` — webhook-triggered, calls
    `google-gmail/search_gmail_messages`.

## How the QA runner uses it

1. Start the mock Cloud Function (see
   `tools/qa/fixtures/oauth-mock-server/`).
2. Export the mock URIs:
   ```
   FRIDAY_OAUTH_MOCK_EXCHANGE_URI=http://localhost:<port>/callback
   FRIDAY_OAUTH_MOCK_REFRESH_URI=http://localhost:<port>/refreshToken
   ```
3. Load the pre-recorded credentials under
   `<getFridayHome()>/credentials/test-user/...` so the daemon starts
   "logged in" to both Google providers.
4. Register the workspace by pointing the daemon at this directory:
   ```
   POST /api/workspaces { "path": "tools/qa/fixtures/oauth-refresh-qa" }
   ```
5. Drive the three paths:
   - **Interactive (chat):** `POST /api/workspaces/oauth-refresh-qa/chat`
     with a message that requires Google tools (e.g. "list my
     calendars" or "check unread mail").
   - **Cron:** trigger manually via
     `POST /api/workspaces/oauth-refresh-qa/signals/every-minute` (or
     wait one minute).
   - **Webhook:** `POST /oauth-refresh-qa/webhook` with an empty JSON
     body.
6. Switch the mock's refresh mode between scenarios via the mock's
   `POST /control/mode` endpoint.

## Notes

- The signal name `every-minute` is intentionally not `schedule` —
  signal names are free-form; `provider: schedule` is what binds the
  cron behavior.
- The chat signal is reserved (the runtime rejects a `chat:` entry
  under `signals:`) and the `handle-chat` job is auto-injected, so
  neither appears here.
- Job FSMs are minimal: one LLM action that calls one tool and emits
  a marker JSON. The QA scenarios assert on session status (FAILED
  vs SKIPPED vs success) and on the UI chip / elicitation rendering,
  not on the LLM's tool-call output.
