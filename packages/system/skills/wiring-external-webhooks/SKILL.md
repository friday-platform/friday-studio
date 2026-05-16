---
name: wiring-external-webhooks
description: "Wires Bitbucket / Jira / GitHub / custom webhooks to a workspace's HTTP signal via /hook/raw/. Use when a user asks how to configure an external service to call a Friday signal, how to set the webhook URL, why their webhook isn't firing, how an agent should parse the raw webhook body, or how to verify the upstream HMAC signature. Also use when authoring an agent that consumes a webhook payload or when avoiding webhook reply-loops."
---

# Wiring external webhooks to HTTP signals

A `provider: http` signal in `workspace.yml` exposes a URL. To make
something fire it you register the URL with the upstream system (any
service that can POST JSON). Friday's webhook-tunnel is the public
entry point — it forwards the request body to atlasd's signal
endpoint, then your workspace agent parses it.

The tunnel does **one thing**: take the POST body and hand it to the
workspace's signal. No HMAC verification, no event filtering, no
field extraction. Every webhook from every upstream uses the same
URL shape and the same body-passthrough semantics. The agent owns
all the upstream-specific logic (parsing, signature verification,
event-type filtering).

## URL pattern — always `/hook/raw/` on the PUBLIC tunnel host

```
https://<public-tunnel-url>/hook/raw/<workspaceId>/<signalId>
```

- `<public-tunnel-url>` is the cloudflared trycloudflare URL — fetch
  it live from `/status` (see next section). It rotates on tunnel
  restart.
- `<workspaceId>` is the runtime id (e.g. `light_papaya`, not the
  friendly name).
- `<signalId>` is the signal's key in `workspace.yml`.

**Never** give an external service a URL of the form
`<friday-host>/api/workspaces/<wsId>/signals/<signalId>` — that path
is atlasd's internal direct route. It is not exposed through
cloudflared, the upstream cannot reach it from the public internet,
and recommending it is the original foot-gun that motivated this
skill. If you cannot reach `/status` from your environment to fetch
the real tunnel URL (run_code does not always have network access to
localhost:9090), **STOP and ask the user to run the `/status` curl
themselves and paste the URL back** — do not synthesize a host or
fall back to the `/api/workspaces/...` path.

## Signal schema for raw webhooks — `additionalProperties: true` or you lose the body

The signal's JSON Schema is enforced by the runtime through Zod,
which STRIPS any fields not declared in `properties`. If you declare
nested objects without `additionalProperties: true`, every nested
field arrives as an empty `{}` and the agent sees nothing useful.

**Wrong** (what looks documentative but silently destroys the payload):

```yaml
signals:
  bb-pr-comment:
    provider: http
    config: { path: /bb-pr-comment }
    schema:
      type: object
      properties:
        actor:        { type: object, description: "Commenter" }
        comment:      { type: object, description: "Comment object" }
        pullrequest:  { type: object, description: "PR object" }
        repository:   { type: object, description: "Repo object" }
```
The agent's `inputs.actor`, `inputs.comment`, etc. all become `{}` —
LLM templates render as empty, Python agents see empty dicts.

**Right** — let the body through, let the agent inspect it:

```yaml
signals:
  bb-pr-comment:
    provider: http
    config: { path: /bb-pr-comment }
    schema:
      type: object
      additionalProperties: true
```

Or, if you want to document the expected shape without strip:

```yaml
schema:
  type: object
  additionalProperties: true
  properties:
    actor:        { type: object, additionalProperties: true }
    comment:      { type: object, additionalProperties: true }
    pullrequest:  { type: object, additionalProperties: true }
    repository:   { type: object, additionalProperties: true }
```

Rule of thumb for HTTP webhook signals: every `type: object` you
write must be paired with `additionalProperties: true`, or it strips
silently. The validator does not warn — the agent just sees `{}`.

## Fire-and-forget by default — `?nowait=true`

The webhook-tunnel posts to atlasd with `?nowait=true` so atlasd
publishes to JetStream and returns 202 immediately. The cascade runs
async on the CASCADES consumer; the tunnel doesn't hold the HTTP
connection open waiting for it.

This is the right shape for ANY caller that publishes a signal but
doesn't need the cascade's `output` to compose its own response —
webhooks, cron, fire-and-forget RPC. Avoids the failure mode where
the upstream (Bitbucket's 30s deadline, etc.) times out before a
long cascade finishes, even though the cascade itself runs to
completion in the background.

If you ARE building a custom forwarder or RPC client that needs to
follow the cascade, add `Accept: text/event-stream` to the POST —
same publish, streams cascade events on the same response. (There
is no follow-by-correlationId endpoint: the response is published on
core NATS without replay, so a follow-up GET arriving after the
response was published would silently miss it. Subscribe-then-publish
in a single handler is the only race-free shape.)

See `friday-cli` skill section 3 for the full mode breakdown
(nowait / sync JSON / SSE).

## Get the tunnel URL in one call

```bash
curl -sk https://localhost:9090/status | jq
# → { "url": "https://...trycloudflare.com",
#     "providers": ["raw"], "pattern": "/hook/raw/{workspaceId}/{signalId}", ... }
```

`/status` is the single source of truth — it shows the current
`trycloudflare` URL (rotates on tunnel restart) and confirms the
tunnel is up. Run it FIRST when something's wrong before guessing.

## Bitbucket Cloud — UI steps

1. Repo settings → **Webhooks** → **Add webhook**
2. **Title**: anything (e.g. `Friday`)
3. **URL**: paste `https://<tunnel-url>/hook/raw/<workspaceId>/<signalId>`
4. **Secret**: leave blank (the tunnel does no verification); set
   only if the agent will verify itself (see below)
5. **Status**: Active
6. **Triggers**: pick the events you want. Bitbucket's "Choose from
   a full list..." panel exposes ~23 trigger types; the ones most
   often useful for agents:
   - `repo:push` (body has `push.changes[]`)
   - `repo:commit_status_created` / `repo:commit_status_updated`
     (body has `commit_status` — failed builds, etc.)
   - `pullrequest:created` / `pullrequest:updated` /
     `pullrequest:approved` / `pullrequest:fulfilled` (body has
     `pullrequest`)
   - `pullrequest:comment_created` (body has `pullrequest` +
     `comment`)

   Bitbucket retries 3× on non-2xx. The event type itself only
   travels in the `x-event-key` header — and the tunnel does NOT
   forward headers, so the agent infers from payload shape.

## GitHub — UI steps

1. Repo settings → **Webhooks** → **Add webhook**
2. **Payload URL**: `https://<tunnel-url>/hook/raw/<workspaceId>/<signalId>`
3. **Content type**: `application/json` (not the form-encoded
   default — the agent expects JSON)
4. **Secret**: leave blank (the tunnel does no verification); set
   only if the agent will verify (see below)
5. **Which events**: pick individual events (or "Just the push event"
   for the simplest case). GitHub's event list is roughly: `push`,
   `pull_request`, `issues`, `issue_comment`, `pull_request_review`,
   `release`, `workflow_run`. The event type travels in the
   `X-GitHub-Event` header (which the tunnel does not forward) — the
   agent infers from the payload's top-level keys.

## Verifying signatures in the agent

The tunnel forwards the body only — no upstream headers reach the
agent. There is no Friday-level secret env var (`WEBHOOK_SECRET`
does not exist) and the tunnel never verifies HMAC. Verification, if
you want it, lives entirely in the agent.

Two choices:

- **Trust the tunnel URL + workspace-id-in-path as the boundary.**
  cloudflared rotates the URL on restart and the workspace+signal
  ids are random; this is the pragmatic choice for most cases and
  matches how the tunnel ships by default.
- **Compute HMAC in the agent.** Set a secret in the upstream's
  webhook form AND store it in the workspace `.env` under any name
  you choose (e.g. `MY_WORKSPACE_BB_SECRET`, `GH_HOOK_SECRET`). The
  agent reads the secret via `os.environ[...]` and computes HMAC on
  the raw body. Caveat: the signature header (`X-Hub-Signature`,
  `X-Hub-Signature-256`) does not reach the agent because the tunnel
  drops headers — so you cannot match what the upstream sent. The
  practical pattern is to put the secret IN the body (a custom
  field) or in the URL path segment.

## Reading the payload in the agent

The signal payload sits under `ctx.input.config` (the runtime
auto-seeds prepareResult from signal payloads under that key — see
`writing-friday-python-agents` Tier 0). Fallback to `ctx.input.raw`
for signal-direct invocations:

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

GitHub's payload top-level keys:
| Has key            | Event family                      |
|--------------------|-----------------------------------|
| `pull_request`     | PR (with `action`: opened/closed/etc.) |
| `issue`            | Issue (with `action`)             |
| `commits` / `head_commit` | Push                       |
| `comment`          | Comment-related (issue/PR comment) |
| `release`          | Release events                    |
| `workflow_run`     | GHA workflow                      |

## LLM agent prompts that invoke external tools MUST declare those tools

An `llm` agent whose prompt says "Run `gh api ...`" or "Use bash to ..."
or "Call the X MCP tool" needs the corresponding tool in its
`config.tools` array. Otherwise the LLM has no way to actually invoke
anything — it sees the instruction, sees no matching tool, and
hallucinates success by calling `complete({response: "Done"})`. The
session reports OK; nothing was actually posted/run.

**Wrong** — prompt promises bash, tools is empty:

```yaml
agents:
  ack-commenter:
    type: llm
    config:
      prompt: |
        ...
        Run: `gh api repos/.../issues/<N>/comments -X POST -f body='ACK'`
        ...
      tools: []   # ← the LLM cannot call gh; it fakes success
```

Symptom: session completes in <2s, `complete` is the only tool call,
no side effect lands in the upstream system. The error catalog below
calls this the "phantom-ACK" failure mode.

**Right** — declare what the prompt invokes:

```yaml
agents:
  ack-commenter:
    type: llm
    config:
      prompt: |
        ...
        Use the bash tool to run:
          gh api repos/.../issues/<N>/comments -X POST -f body='ACK'
      tools:
        - bash              # for shelling out to gh CLI / curl
        # OR use the github MCP tools directly:
        # - github/create_issue_comment
```

Rule of thumb: every imperative verb in the prompt that names an
external command, MCP tool, or HTTP call must have a corresponding
entry in `tools:`. If `tools` is empty, the agent can ONLY call
`complete` — make sure that's actually what you want.

## Loop trap — do NOT subscribe to events your own agent creates

If your agent posts a PR comment in response to a webhook, **do not
subscribe to `pullrequest:comment_created`** (Bitbucket) or
`issue_comment` (GitHub) — your own comment will re-fire the webhook
→ re-trigger the agent → infinite loop.

If you must process comment events:

- Guard at the agent level: skip when the comment author is the same
  identity as your bot's MCP credential, OR
- Guard on the content: skip when the comment body matches an exact
  marker (`"ACK"`, `"/friday processed"`).

Write the guard before the first send — a missing guard has been
observed to produce 18+ spam comments on a single PR before the loop
gets caught.

Friday's signal-level `concurrency: skip` default also blocks the
"agent acts → webhook fires → agent re-runs" cascade for the
duration of the first run, but it's a race-dependent backstop; the
prompt/code guard is the load-bearing one.

## Error catalog

| Tunnel response                                       | Cause | Fix |
|-------------------------------------------------------|---|---|
| `400 Unknown provider: X. Available: raw`             | Webhook URL uses anything other than `/hook/raw/...`. | Change the upstream's URL to `/hook/raw/<wsId>/<signalId>`. |
| `400 raw provider expects JSON object, got ...`       | Upstream is posting non-JSON or a JSON array. | Configure the upstream to send `application/json` with a top-level object body. |
| `400 empty body`                                      | Upstream is posting with no body (or a test ping). | Make sure the upstream is sending the actual event payload, not just a ping. |
| `413 body exceeds N bytes`                            | Webhook body bigger than the tunnel's max. | Split the work upstream, or trim the body before it leaves the upstream. |
| `502 Cannot reach atlasd: context deadline exceeded`  | Cascade hadn't completed and atlasd is hanging — but `?nowait=true` should be in play; if this fires, something has changed in the tunnel forwarder. | Check `/health` on atlasd and the JetStream stream. |
| **Phantom-ACK** (session completes in <2s, only tool call is `complete`, nothing posted upstream) | Agent prompt instructs an external action (`gh api …`, `curl …`, MCP tool) but `tools:` is empty — LLM has no way to act, fakes success. | Add the matching tool to `agents.<id>.config.tools` (e.g. `bash` for shell commands, or the specific MCP tool name). See "LLM agent prompts that invoke external tools" above. |
