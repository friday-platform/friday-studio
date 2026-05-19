---
name: wiring-external-webhooks
description: "Connects an external service's webhook (Bitbucket / Jira / GitHub / custom) to a workspace's HTTP signal via Friday's `/hook/raw/` tunnel URL. Use ONLY when the user asks how to point an upstream system at Friday: the URL shape, how to get the current tunnel host, the upstream UI steps, or the workspace.yml signal shape that accepts the body without stripping it. Everything that happens AFTER Friday receives the webhook — agent implementation, payload parsing, env wiring, HMAC verification, posting back to the upstream — is out of scope for this skill."
---

# Wiring external webhooks to HTTP signals

A `provider: http` signal in `workspace.yml` exposes a URL. To make
something fire it you register the URL with the upstream system (any
service that can POST JSON). Friday's webhook-tunnel is the public
entry point — it forwards the request body to atlasd's signal
endpoint.

The tunnel does **one thing**: take the POST body and hand it to the
workspace's signal. No HMAC verification, no event filtering, no
field extraction. Every webhook from every upstream uses the same
URL shape and the same body-passthrough semantics.

## URL pattern — always `/hook/raw/` on the PUBLIC tunnel host

```
https://<public-tunnel-url>/hook/raw/<workspaceId>/<signalId>
```

- `<public-tunnel-url>` is the cloudflared trycloudflare URL — fetch
  it live from `/status` (next section). It rotates on tunnel restart.
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

## Get the tunnel URL in one call

```bash
curl -sk https://localhost:9090/status | jq
# → { "url": "https://...trycloudflare.com",
#     "providers": ["raw"], "pattern": "/hook/raw/{workspaceId}/{signalId}", ... }
```

`/status` is the single source of truth — it shows the current
`trycloudflare` URL (rotates on tunnel restart) and confirms the
tunnel is up. Run it FIRST when something's wrong before guessing.

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

**Right** — let the body through:

```yaml
signals:
  bb-pr-comment:
    provider: http
    config: { path: /bb-pr-comment }
    schema:
      type: object
      additionalProperties: true
```

Or, if you want to document the expected shape without stripping:

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

## Where the payload lands inside the workspace

Once the tunnel forwards the body to atlasd, the workspace's signal fires and
the body is available to the triggered agent under `ctx.input.config` (or
`ctx.input.raw` as a fallback for signal-direct invocations):

```python
payload = ctx.input.config or ctx.input.raw
```

What the agent then does with the payload — extracting fields, branching on
event family, posting something back to the upstream — is agent-implementation
territory and out of scope for this skill.

## Bitbucket Cloud — UI steps

1. Repo settings → **Webhooks** → **Add webhook**
2. **Title**: anything (e.g. `Friday`)
3. **URL**: paste `https://<tunnel-url>/hook/raw/<workspaceId>/<signalId>`
4. **Secret**: leave blank — the tunnel does no verification.
5. **Status**: Active
6. **Triggers**: pick the events you want.

## GitHub — UI steps

1. Repo settings → **Webhooks** → **Add webhook**
2. **Payload URL**: `https://<tunnel-url>/hook/raw/<workspaceId>/<signalId>`
3. **Content type**: `application/json` (not the form-encoded default).
4. **Secret**: leave blank — the tunnel does no verification.
5. **Which events**: pick the events you want.

## Tunnel-level errors

| Tunnel response                                       | Cause | Fix |
|-------------------------------------------------------|---|---|
| `400 Unknown provider: X. Available: raw`             | Webhook URL uses anything other than `/hook/raw/...`. | Change the upstream's URL to `/hook/raw/<wsId>/<signalId>`. |
| `400 raw provider expects JSON object, got ...`       | Upstream is posting non-JSON or a JSON array. | Configure the upstream to send `application/json` with a top-level object body. |
| `400 empty body`                                      | Upstream is posting with no body. | Confirm the upstream is actually sending the event payload. |
| `413 body exceeds N bytes`                            | Webhook body bigger than the tunnel's max. | Reduce the body upstream. |
| `502 Cannot reach atlasd`                             | atlasd unreachable from the tunnel. | Check atlasd `/health` and the JetStream stream. |
