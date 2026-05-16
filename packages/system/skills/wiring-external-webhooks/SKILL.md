---
name: wiring-external-webhooks
description: "Wires Bitbucket / Jira / custom webhooks to a workspace's HTTP signal via /hook/raw/. Use when a user asks how to configure Bitbucket/Jira to call a Friday signal, how to set the webhook URL, why their webhook isn't firing, or how an agent should parse the raw webhook body and verify the signature. Also use when authoring an agent that consumes a webhook payload or when avoiding webhook reply-loops."
---

# Wiring external webhooks to HTTP signals

A `provider: http` signal in `workspace.yml` exposes a URL. To make
something fire it you register the URL with the upstream system
(Bitbucket, Jira, custom). Friday's webhook-tunnel is the public entry
point — it forwards the request body to atlasd's signal endpoint, then
your workspace agent parses it.

## URL pattern — always `/hook/raw/`

```
https://<public-tunnel-url>/hook/raw/<workspaceId>/<signalId>
```

- `<workspaceId>` is the runtime id (e.g. `light_papaya`, not the friendly name).
- `<signalId>` is the signal's key in `workspace.yml`.

**Only `github` and `raw` providers ship built-in.** Bitbucket / Jira /
anything else go through `raw`. The raw provider:

- **Does not verify signatures.** If you need HMAC, do it in the agent
  (see "Verifying signatures in the agent" below).
- **Does not filter events.** Every webhook the upstream sends reaches
  the workspace; the agent decides what to act on.
- **Does not transform the payload.** The agent reads the full raw body
  via `ctx.input.config or ctx.input.raw`.

**Do NOT** point the external service at `/api/workspaces/.../signals/...` —
that's atlasd's internal direct path, not reachable through the tunnel.

## Fire-and-forget by default — `?nowait=true`

The webhook-tunnel posts to atlasd with `?nowait=true` so atlasd
publishes to JetStream and returns 202 immediately. The cascade runs
async on the CASCADES consumer; the tunnel doesn't hold the HTTP
connection open waiting for it.

This is the right shape for ANY caller that publishes a signal but
doesn't need the cascade's `output` to compose its own response —
webhooks, cron, fire-and-forget RPC. Avoids the failure mode where the
upstream (Bitbucket's 30s deadline, etc.) times out before a long
cascade finishes, even though the cascade itself runs to completion in
the background.

If you ARE building a custom forwarder or RPC client that needs to
follow the cascade, two options:

- Add `Accept: text/event-stream` to the POST — same publish, streams
  cascade events on the same response.
- Or use `?nowait=true` and then `GET
  /api/workspaces/<wsId>/signals/stream/<correlationId>` (SSE) with the
  correlationId returned from the 202.

See `friday-cli` skill section 3 for the full three-mode breakdown
(nowait / sync JSON / SSE).

## Env var that controls the secret

The webhook-tunnel reads exactly **one** env var for HMAC secrets:

```
WEBHOOK_SECRET
```

That's the literal name. It is set in `~/.atlas/.env` and applies to all
webhook providers that do signature verification (today: github).

There is no provider-prefixed variant. Do not invent one — if a user or
agent mentions `BITBUCKET_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`, or
`JIRA_WEBHOOK_SECRET`, those names do not exist in Friday's code and
will silently not be read. Correct them to `WEBHOOK_SECRET`.

## Get the tunnel URL in one call

```bash
curl -sk https://localhost:9090/status | jq
# → { "url": "https://...trycloudflare.com", "secret": "...",
#     "providers": ["github","raw"], ... }
```

`/status` is the single source of truth — it shows the current
`trycloudflare` URL (rotates on tunnel restart), the `WEBHOOK_SECRET`
(only used by the github provider), and which providers are registered.
Run it FIRST when something's wrong before guessing.

## Bitbucket Cloud — UI steps

1. Repo settings → **Webhooks** → **Add webhook**
2. **Title**: anything (e.g. `Friday`)
3. **URL**: paste `https://<tunnel-url>/hook/raw/<workspaceId>/<signalId>`
4. **Secret**: leave blank (the raw provider doesn't verify); set only if
   the agent will verify itself (see below)
5. **Status**: Active
6. **Triggers**: pick the events you want. Bitbucket's "Choose from a
   full list..." panel exposes ~23 trigger types; the ones most often
   useful for agents:
   - `repo:push` (body has `push.changes[]`)
   - `repo:commit_status_created` / `repo:commit_status_updated` (body
     has `commit_status` — failed builds, etc.)
   - `pullrequest:created` / `pullrequest:updated` / `pullrequest:approved`
     / `pullrequest:fulfilled` (body has `pullrequest`)
   - `pullrequest:comment_created` (body has `pullrequest` + `comment`)

   Bitbucket retries 3× on non-2xx. The event type itself only travels
   in the `x-event-key` header — and the raw provider does NOT forward
   headers, so the agent infers from payload shape.

## Verifying signatures in the agent

The raw provider drops request headers (no `x-hub-signature` reaches
the agent). If you need verification for a Bitbucket webhook today,
treat the cloudflared tunnel URL + workspace-id-in-path as the trust
boundary, OR set a Bitbucket secret you also store in the workspace
`.env` and compute the HMAC yourself on the body (the agent reads the
secret via `os.environ[...]` and the raw body via `ctx.input.config or
ctx.input.raw`). Pick an env var name that does NOT collide with
`WEBHOOK_SECRET` — e.g. `MY_WORKSPACE_BB_SECRET`.

## Reading the payload in the agent

The signal payload sits under `ctx.input.config` (the runtime auto-seeds
prepareResult from signal payloads under that key — see
`writing-friday-python-agents` Tier 0). Fallback to `ctx.input.raw` for
signal-direct invocations:

```python
payload = ctx.input.config or ctx.input.raw
```

Bitbucket's payload top-level keys depend on the event:
| Has key            | Event family                      |
|--------------------|-----------------------------------|
| `pullrequest`      | PR (created/updated/approved/etc.)|
| `commit_status`    | Build status                      |
| `push.changes`     | Push                              |
| `comment`          | Comment-related sub-event         |
| `approval`         | Approved / Unapproved sub-event   |

## Loop trap — do NOT subscribe to events your own agent creates

If your agent posts a PR comment in response to a webhook, **do not
subscribe to `pullrequest:comment_created`** — your own comment will
re-fire the webhook → re-trigger the agent → infinite loop.

If you must process comment events:

- Guard at the agent level: skip when the comment author is the same
  identity as your bot's bitbucket-mcp credential, OR
- Guard on the content: skip when the comment body matches an exact
  marker (`"ACK"`, `"/friday processed"`).

Observed in 2026-05-15 development: 18 spam comments before the agent
guard was patched in. Write the guard before the first send.

Friday's signal-level `concurrency: skip` default also blocks the
"agent acts → webhook fires → agent re-runs" cascade for the duration
of the first run, but it's a race-dependent backstop; the prompt/code
guard is the load-bearing one.

## Custom event mapping (advanced, rarely needed)

`WEBHOOK_MAPPINGS_PATH` is a YAML override for the **github** provider's
event list. It is NOT a way to register bitbucket/jira/etc. — those
providers were removed on 2026-05-15 and pointing the env at a YAML
with a `bitbucket:` block at the top level silently leaves the registry
with just `[raw]`. Schema for the github override:

```yaml
providers:                            # ← top-level key MUST be `providers:`
  github:
    event_header: x-github-event
    signature_header: x-hub-signature-256
    events:
      release:
        mapping:                      # ← key MUST be `mapping:`, NOT `extract:`
          tag: "release.tag_name"
          url: "release.html_url"
```

Common mistakes that produce `400 Unknown provider`:

- Top-level key is the provider name (`{"bitbucket": {...}}`) instead of
  wrapped in `providers:`.
- Each event uses `extract:` instead of `mapping:`.
- Field paths use JSONPath syntax (`$.repository.full_name`) instead of
  dot paths (`repository.full_name`).

Validate by hitting `/status` — `providers` should include any custom
provider you added (default is `[github, raw]`).

## Error catalog

| Tunnel response                                           | Cause | Fix |
|-----------------------------------------------------------|---|---|
| `400 Unknown provider: bitbucket. Available: github, raw` | Webhook URL points at the removed bitbucket provider. | Change the URL in the upstream system to `/hook/raw/<wsId>/<signalId>` (note: `raw`, NOT `bitbucket`). |
| `400 Unknown provider: X. Available: Y`                   | `WEBHOOK_MAPPINGS_PATH` is set to a file with the wrong shape — schema-incompatible YAML silently leaves the registry with only `raw`. | `unset WEBHOOK_MAPPINGS_PATH` or fix the file (top-level `providers:` key, per-event `mapping:`). |
| `401 missing x-hub-signature header` (github only)        | Friday has `WEBHOOK_SECRET` set but the GitHub webhook has no Secret. | Paste the secret into the GitHub form. |
| `401 invalid signature` (github only)                     | Secrets don't match. | Verify byte-for-byte; restart daemon after `.env` change. |
| `200 {"status":"skipped","reason":"irrelevant event"}` (github only) | github provider received an event not in its mapping. | Subscribe to a mapped event OR add a `WEBHOOK_MAPPINGS_PATH` override. For bitbucket/jira this response can no longer occur — they go through `raw` which forwards everything. |
| `502 Cannot reach atlasd: context deadline exceeded`      | Signal handler ran longer than the tunnel forwarder's 30s deadline. | Split the work: fast signal handler fires an internal signal; the slow part runs async. |
