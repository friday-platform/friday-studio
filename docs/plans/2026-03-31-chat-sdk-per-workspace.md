# Chat SDK Per Workspace

Shipped on branch `slack-to-workspace`. Adopts [Chat SDK](https://chat-sdk.dev)
as the runtime for every workspace's chat job, unifying the reply pipeline
across platforms (Slack, web UI) and absorbing Gateway-side Slack processing
into the adapter.

Each workspace owns a `Chat` instance that wires the web adapter (plus a Slack
adapter if credentials exist) to a shared message handler. The handler fires
the `"chat"` signal, which routes to `workspace-chat.agent.ts` — same agent,
same storage, same FSM, regardless of whether the message came from Slack or
the web client. The Signal Gateway shrinks to a near-stateless proxy; all
Slack verification, parsing, and dedup moves to `SlackAdapter` inside atlasd.

## What Changed

### `apps/atlasd/src/chat-sdk/`

New module holding per-workspace Chat SDK lifecycle:

- **`chat-sdk-instance.ts`** — `initializeChatSdkInstance()` constructs a
  `Chat` with the adapter map, a `ChatSdkStateAdapter`, and
  `concurrency: "concurrent"` + `dedupeTtlMs: 600_000`. Registers the shared
  handler on both `onNewMention` and `onSubscribedMessage`. `teardown()` calls
  `chat.shutdown()` to fan `disconnect()` out to every adapter (Slack holds
  keep-alive pools and user caches, so this matters).

  Also exports `createMessageHandler(...)` (the shared per-message pipeline)
  and `resolvePlatformCredentials(workspaceId)` which hits Link service
  `/internal/v1/slack-apps/by-workspace/{id}` and returns
  `{ botToken, signingSecret, appId }` (or `null` for pending/missing).

- **`adapter-factory.ts`** — `buildChatSdkAdapters()` always returns
  `{ atlas: AtlasWebAdapter }` and adds a platform adapter from
  `platformAdapterFactories` if the workspace has a chat-capable signal
  (`provider: "slack"`) AND credentials resolved. Adding a new platform =
  one entry in the factory map.

- **`atlas-web-adapter.ts`** — Custom `Adapter` for the Atlas web UI.
  `handleWebhook()` parses the POST body, validates the full `AtlasUIMessage`
  (preserving non-text parts like `data-artifact-attached`), dispatches via
  `chat.processMessage()`, and returns an SSE `Response` bound to
  `StreamRegistry`. `postMessage`, `editMessage`, `deleteMessage`,
  `addReaction`, `removeReaction`, `startTyping`, `fetchMessages`,
  `fetchThread` are intentional no-op stubs — real web delivery never goes
  through `thread.post()`. The stubs are the trade-off for adapter-polymorphic
  handler code.

### `packages/core/src/chat/chat-sdk-state-adapter.ts`

Implements Chat SDK's `StateAdapter` interface:

- `subscribe(threadId)` → `ChatStorage.createChat({ chatId, userId,
  workspaceId, source })`
- `isSubscribed(threadId)` → existence check on the chat file
- `unsubscribe(threadId)` → `ChatStorage.deleteChat(...)`
- `get`/`set`/`setIfNotExists` → in-memory `Map` with TTL for Chat SDK's
  dedup cache
- `setSource(threadId, source)` / `clearSource(threadId)` — pre-stash the
  `"slack" | "discord" | "atlas"` source before `subscribe()` runs, because
  the thread ID reaches the state adapter without adapter context. The shared
  handler calls `setSource` before `thread.subscribe()` and `clearSource` if
  subscribe throws (so the pre-set entry doesn't leak).
- `connect`/`disconnect`, lock/list/queue methods are no-ops — Chat SDK
  doesn't call them under `concurrency: "concurrent"`.

Internal `cache` and `threadSources` maps are bounded on leaky writes (see
`adc35c591`).

### `packages/workspace/src/signal-to-stream.ts`

`signalToStream(triggerFn, signalName, payload, streamId, onRawEvent?)`
returns a `ReadableStream` that bridges the callback-based
`triggerSignalWithSession` API to a single stream for `thread.post()`.

The `onRawEvent` tap is the hinge: every chunk flows **both** to the tap
(used to push client-safe events into `StreamRegistry` for the web SSE feed)
and into the stream controller (which platform adapters consume via
`thread.post()` → `fromFullStream`, text-only). One signal invocation, two
delivery paths.

### `apps/atlasd/src/atlas-daemon.ts`

- `chatSdkInstances: Map<string, Promise<ChatSdkInstance>>` — cached per
  workspace, lazily built on first request (NOT eagerly during workspace
  init). Failed builds evict themselves so the next caller retries.
- `getOrCreateChatSdkInstance(workspaceId)` — public accessor used by the
  Slack signal route and the web chat route.
- `buildChatSdkInstance(...)` — resolves Link credentials (tolerates failure
  with a warn), plumbs a `triggerFn` that wraps
  `runtime.triggerSignalWithSession`, and hands the whole thing to
  `initializeChatSdkInstance`.
- `evictChatSdkInstance(workspaceId)` — awaits the pending promise and calls
  `teardown()`. Used by workspace config mutations, workspace delete, and
  Slack connect/disconnect so a stale adapter (with revoked creds) doesn't
  linger.

### `apps/atlasd/routes/signals/platform.ts`

Single route: `POST /signals/slack`. Clones the request (SlackAdapter needs
the raw body for HMAC verification), parses `api_app_id` from the body,
finds the workspace by scanning configured signals, and calls
`chat.webhooks.slack(request)`. The adapter owns everything from verification
through handler dispatch. No normalization, no event parsing, no subtype
filtering in atlasd — all of it is in `SlackAdapter`.

### `apps/atlasd/routes/workspaces/chat.ts`

`POST /` delegates to `chat.webhooks.atlas`. The route only overrides the
`X-Atlas-User-Id` header (using the ATLAS_KEY JWT subject) to prevent a
client from smuggling a forged identity into analytics/audit logs. Everything
else — validation, storage, signal firing, SSE — runs inside the adapter.

`GET /:chatId/stream` still serves SSE reconnection via `StreamRegistry`
directly (unchanged).

### `apps/signal-gateway/service/slack_perapp.go`

~220 lines → ~85 lines. What remains:

- Route registration (`POST /webhook/slack/{userID}/{appID}`)
- Retry ack (`X-Slack-Retry-Num` → immediate 200)
- `url_verification` — peek at the JSON envelope, echo `challenge` synchronously
- Extract `userID` from URL, build atlasd URL from the existing template
- Ack 200, forward raw body + `X-Slack-Request-Timestamp` + `X-Slack-Signature`
  + `Content-Type` async

**Deleted**: DB lookup (`slack_app_webhook` table + LRU cache), signature
verification, user ID validation against DB, event type parsing/dispatch,
bot message and subtype filtering, `AtlasSlackPayload` normalization, the
`slack`/`slackevents` Go package imports, DB connection, `repo` dependency.
Gateway is now fully stateless — no DB, no cache, no secrets.

### Deleted

- `SlackSignalRegistrar` — Chat SDK adapter setup replaced it
- `postSlackMessage` helper in `slack-client.ts`
- Platform-specific normalization in the old `/signals/slack` route
- Gateway's ~135 lines of Slack processing + `slack_app_webhook` DB access
- `slack` from planner signal types (`01effb61a`)

## Key Decisions

**Lazy Chat SDK instances, not eager.** The v4 plan said "create during
workspace init for every workspace." In practice, instances are built on
demand via `getOrCreateChatSdkInstance(workspaceId)` and cached as
`Promise<ChatSdkInstance>`. This tolerates late credential wiring (Slack
connect flow), avoids work for unused workspaces, and lets config mutations
evict cleanly via `evictChatSdkInstance`. The `chat` job is still present on
every workspace; what changed is **when** the runtime is instantiated.

**AtlasWebAdapter bypasses `thread.post()` for outbound.** Chat SDK's
`fromFullStream` normalization strips non-text chunks (tool calls, reasoning,
`data-*` events) — fine for Slack, fatal for the web client which needs the
full `AtlasUIMessageChunk` stream. So `handleWebhook` returns an SSE Response
driven by `StreamRegistry` directly, and the `onRawEvent` tap in
`signalToStream` fans events into the registry in parallel with the
text-only stream that `thread.post()` consumes. One signal, two consumers,
zero branching in the handler.

**The handler fires one signal (`"chat"`), regardless of source.** Slack and
web both land in `workspace-chat.agent.ts`. The adapter name (`thread.adapter.name`)
is recorded as the chat `source` via `ChatSdkStateAdapter.setSource()` before
`subscribe()` creates the file, so the agent can tailor formatting per
platform via chat metadata without branching on transport.

**Pre-validated `AtlasUIMessage` stashed on `Message.raw.uiMessage`.** The
web adapter validates the full UI message at the webhook boundary (including
`data-artifact-attached` parts) and attaches it to `message.raw`. The shared
handler prefers that over rebuilding from `Message.text`, so non-text parts
survive into `ChatStorage.appendMessage`. Slack falls through to
`toAtlasUIMessage(message)` because Slack messages are text-only.

**Slack reaction ack happens in the handler, not the adapter.** When
`adapterName === "slack"`, the handler fires
`thread.adapter.addReaction(threadId, messageId, "eyes")` as a fire-and-forget
so users see immediate acknowledgement that the bot received the message.
Failure is logged but non-fatal.

**`X-Atlas-User-Id` is set server-side on the web chat route.** A malicious
client could otherwise smuggle any user ID into the SSE webhook and forge
analytics/audit logs. The route strips any client-supplied header and sets
it from the ATLAS_KEY JWT before calling `chat.webhooks.atlas(request)`.
Atlas-web-adapter reads the header and trusts it (`b24faa320`).

**Gateway handles `url_verification` inline.** The only Slack-specific code
still in the Gateway. Slack requires a **synchronous** challenge response
during webhook setup, which conflicts with the Gateway's async
ack-then-forward pattern. It's ~10 lines, idempotent, and only fires during
deliberate app configuration — attack surface is negligible. Everything else
(signature verification, event parsing) moves to `SlackAdapter` in atlasd,
which is a strict superset of what the Gateway did (7+ event types, richer
parsing, stricter 5-minute timestamp window).

**Per-workspace signing secrets via existing `credential_id` flow.**
`resolvePlatformCredentials` hits Link service's
`/internal/v1/slack-apps/by-workspace/{id}`, fetches the full credential,
and returns `{ botToken, signingSecret, appId }`. Same flow
`SlackSignalRegistrar` used — no new credential management APIs. Credential
resolution only runs for workspaces with a chat-capable platform signal;
the web adapter needs no credentials.

**Chat SDK dedup only; workspace runtime handles concurrency.**
`concurrency: "concurrent"` disables Chat SDK's per-thread locking because
workspace runtime already enforces session mutual exclusion. Chat SDK's
`dedupeTtlMs: 600_000` still filters duplicate platform webhooks (Slack
sends both `message` and `app_mention` for the same event). The chat signal
also **bypasses the workspace concurrency guard** so reply streams don't
deadlock against concurrent chat turns (`ac710154a`).

## Error Handling

- **Webhook signature failure** — SlackAdapter rejects 401, handler never runs.
- **Link service down / credential pending** — `resolvePlatformCredentials`
  returns `null` or warns; the adapter is simply not added to the factory
  map. Web chat still works; Slack chat is effectively disabled until creds
  resolve and the instance is evicted + rebuilt.
- **Workspace missing** — `buildChatSdkInstance` throws
  `WorkspaceNotFoundError`, the cached promise self-evicts, and the signal
  route returns 404.
- **Invalid web webhook body** — `handleWebhook` returns 400/403 with a JSON
  error; non-user-role messages (assistant/system) are rejected 403 to
  prevent prompt injection by seeding forged turns.
- **Signal / FSM / agent error during reply** — propagates through the
  `ReadableStream` controller (`controller.error(err)`); web sees
  `data-error` event (unchanged), Slack adapter swallows post failures and
  logs.
- **SSE client disconnects mid-stream** — `StreamRegistry` keeps buffering
  (unchanged); consumer can reconnect via `GET /:chatId/stream`.
- **Chat SDK instance teardown failure** — logged, but eviction still
  removes the cache entry so the next caller rebuilds fresh
  (`d455c42a3`).

## Out of Scope

- **Slack Communicator agent** — proactive outbound ("post this summary to
  #general") stays as-is; Chat SDK only owns conversational replies.
- **Cards, modals, slash commands** — Chat SDK supports them; not wired.
- **Discord and other platforms beyond Slack** — architecture supports them
  via one entry in `platformAdapterFactories` + a new entry in Link service
  credentials. `ChatSdkStateAdapter.setSource` already recognizes `"discord"`.
- **Chat history migration** — existing chats keep their IDs; new chats get
  a `source` stamp from the adapter name.
- **ChatStorage format changes** — same JSON files, unchanged structure.
- **Web client UI changes** — SSE contract is identical from the browser's
  perspective.
- **Thread ID prefixes** — the v4 plan floated `atlas:` / `slack:C1234:ts`
  prefixes but `AtlasWebAdapter.encodeThreadId` is a pass-through and Slack
  uses `SlackAdapter`'s native encoding. Adapter owns its namespace; no
  central prefix scheme was needed.

## Test Coverage

- **`apps/atlasd/src/chat-sdk/chat-sdk-instance.test.ts`** — `createMessageHandler`
  end-to-end. Mocks only at `ChatStorage` (filesystem boundary); real
  `StreamRegistry`, real `signalToStream`, real `isClientSafeEvent`.
  Covers: subscribe then append, source pre-set for slack/discord,
  source cleanup on subscribe failure, handler fires `"chat"` signal with
  correct payload, stream fan-out to both tap and iterable, SSE finish on
  exception.
- **`apps/atlasd/src/chat-sdk/atlas-web-adapter.test.ts`** — webhook body
  validation, role check (non-user rejected 403), `X-Atlas-User-Id`
  extraction, SSE response wiring via `StreamRegistry`, `parseMessage`
  shape, stub verification (Chat SDK can call them without crashing).
- **`apps/atlasd/src/chat-sdk/adapter-factory.test.ts`** — workspace with
  Slack signal + creds → both adapters. Slack signal without creds →
  `atlas` only + warn. No chat-capable signal → `atlas` only. Unknown
  provider → `atlas` only.
- **`packages/core/src/chat/chat-sdk-state-adapter.test.ts`** — subscribe
  creates chat with correct source, unsubscribe deletes, cache TTL
  semantics, `setIfNotExists` dedup, `setSource`/`clearSource` leak
  prevention.
- **`packages/workspace/src/signal-to-stream.test.ts`** — tap fires for
  every chunk, iterable yields chunks in order, iterable closes on
  completion, errors propagate via `controller.error`.
- **`apps/atlasd/routes/signals/platform.test.ts`** — `/signals/slack`
  resolves workspace from `api_app_id`, delegates to adapter webhook,
  returns 404 for unknown `app_id`, handles missing adapter gracefully.
- **`apps/atlasd/routes/workspaces/chat.test.ts`** — `POST /` delegates
  to `chat.webhooks.atlas`, user ID header is stamped from JWT not client,
  workspace missing → 404.
- **`apps/atlasd/routes/workspaces/slack-connect.test.ts`** — connect and
  disconnect flows call `evictChatSdkInstance` so the next request rebuilds
  with fresh credentials.
- **`apps/signal-gateway/service/slack_perapp_test.go`** — `url_verification`
  handled inline (challenge echo, no forwarding), retries acked immediately,
  callback events forwarded with Slack headers intact, `userID` maps to
  atlasd URL via the existing template.
