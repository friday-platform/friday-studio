---
name: wiring-external-webhooks
description: "Wires Bitbucket / Jira / custom webhooks to a workspace's HTTP signal via /hook/raw/. Use when a user asks how to configure Bitbucket/Jira to call a Friday signal, how to set the webhook URL, why their webhook isn't firing, or how an agent should parse the raw webhook body and verify the signature. Also use when authoring an agent that consumes a webhook payload, when avoiding webhook reply-loops, or when migrating from the old /hook/bitbucket/ URL."
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
4. **Secret**: leave blank, OR set it and verify in the agent (see below)
5. **Status**: Active
6. **Triggers**: pick the events you want — Bitbucket sends a different
   payload shape per event:
   - `pullrequest:created/updated/approved/comment_created` → body has
     `pullrequest` (+ `approval` / `comment` / `changes_requested` for
     subtype)
   - `repo:push` → body has `push.changes[]`
   - `repo:commit_status_created/updated` → body has `commit_status`
   - Bitbucket retries 3× on non-2xx. The event type itself only travels
     in the `x-event-key` header — and the raw provider does NOT forward
     headers, so the agent infers from payload shape.

## Verifying signatures in the agent

If you set a Secret in Bitbucket and want the agent to verify, do it in
Python before processing:

```python
import hmac, hashlib, json, os
from friday_agent_sdk import agent, ok, err, AgentContext, run

WEBHOOK_SECRET = os.environ["BITBUCKET_WEBHOOK_SECRET"]  # set in workspace .env

@agent(id="bitbucket-webhook", version="1.0.0", description="…")
def execute(prompt: str, ctx: AgentContext):
    payload = ctx.input.config or ctx.input.raw
    # The raw provider doesn't forward headers. If you need HMAC, switch
    # the tunnel to /hook/github/ (which does verify) and require a
    # GitHub-shaped Secret — or accept the trade-off of unverified
    # webhooks behind cloudflared's transport security.
    return ok({…})
```

The raw provider drops request headers — Bitbucket's `x-hub-signature`
header doesn't reach the agent today. Treat the cloudflared tunnel +
secret-in-URL-path as the trust boundary unless you change the
forwarder.

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
guard was patched in. The skill takes precedence over your intuition —
write the guard before the first send.

## Custom event mapping (advanced, rarely needed)

`WEBHOOK_MAPPINGS_PATH` still works as a YAML override for the github
provider's event list. Schema:

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

Validate by hitting `/status` — `providers` should include any custom
provider you added.

## Error catalog

| Tunnel response                                           | Cause | Fix |
|-----------------------------------------------------------|---|---|
| `400 {"error":"Unknown provider: bitbucket. Available: github, raw"}` | You're still using the old `/hook/bitbucket/` URL. | Switch to `/hook/raw/<wsId>/<signalId>`. |
| `400 {"error":"Unknown provider: X. Available: Y"}`       | `WEBHOOK_MAPPINGS_PATH` is set to a file with the wrong shape. | `unset WEBHOOK_MAPPINGS_PATH` or fix the file (top-level `providers:` key, per-event `mapping:`). |
| `401 missing x-hub-signature header` (github only)        | Friday has `WEBHOOK_SECRET` set but the GitHub webhook has no Secret. | Paste the secret into the GitHub form. |
| `401 invalid signature` (github only)                     | Secrets don't match. | Verify byte-for-byte; restart daemon after `.env` change. |
| `502 Cannot reach atlasd: context deadline exceeded`      | Signal handler ran longer than the tunnel forwarder's 30s deadline. | Split the work: fast signal handler that fires an internal signal; do the slow part async. |

## Migrating off `/hook/bitbucket/` and `/hook/jira/`

These provider names were removed on 2026-05-15. Any webhook still
pointing at them returns 400. Update the URL in the upstream system to
`/hook/raw/<wsId>/<signalId>` and rely on the workspace agent to do
event filtering + payload parsing.
