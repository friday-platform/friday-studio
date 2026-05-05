---
name: writing-workspace-signals
description: "Authors Friday workspace signals with correct provider configs, payload schemas, and runtime wiring. Use when creating or editing signals in workspace.yml; when a signal needs to accept user input from the Run dialog; or when signal validation or runtime dispatch fails."
---

# Writing workspace signals

## Checklist

- [ ] `description` present (required)
- [ ] `provider` matches exact enum: `http`, `schedule`, `system`, `fs-watch`, `slack`, `telegram`, `whatsapp`, `discord`, `teams`
- [ ] Provider `config` present and valid
- [ ] HTTP signals with params: `schema` declared with `type: object`, `properties`, `required`
- [ ] HTTP `config.path` unique across workspace
- [ ] Schedule `config.schedule` valid cron
- [ ] Signal referenced by at least one job trigger (or `dead_signal` warning)
- [ ] No `id` inside inline job `fsm:` — runtime injects from job name

## Two foot-guns

### Schemaless signals with payload params

No `schema` → Run dialog renders no input fields → payload arrives empty. Job gets `{}` instead of the params it expects.

Wrong:

```yaml
signals:
  draft-reply:
    description: "Draft a reply"
    provider: http
    config:
      path: /draft-reply
```

Right:

```yaml
signals:
  draft-reply:
    description: "Draft a reply to an email"
    provider: http
    config:
      path: /draft-reply
    schema:
      type: object
      properties:
        message_id:
          type: string
        instructions:
          type: string
      required:
        - message_id
```

### `id` inside inline FSM blocks

Runtime auto-injects `id` from `job.name`. Adding your own risks mismatch.

Wrong:

```yaml
jobs:
  review-inbox:
    fsm:
      id: review-inbox-job   # don't
```

Right:

```yaml
jobs:
  review-inbox:
    fsm:
      initial: idle
```

## Templates

### HTTP trigger, no payload

```yaml
signals:
  triage-now:
    description: "Triage unread emails immediately"
    provider: http
    config:
      path: /triage-now
```

### HTTP trigger with payload

```yaml
signals:
  draft-reply:
    description: "Draft a reply to a specific email"
    provider: http
    config:
      path: /draft-reply
    schema:
      type: object
      properties:
        message_id:
          type: string
        tone:
          type: string
      required:
        - message_id
```

### Cron trigger

```yaml
signals:
  daily-scan:
    description: "Triage inbox every morning at 9am"
    provider: schedule
    config:
      schedule: "0 9 * * *"
      timezone: "America/Los_Angeles"
      # Optional: what to do with firings the daemon was down for.
      # Defaults to manual — surfaces a pending row in /schedules,
      # operator decides. All non-skip policies are bounded by
      # missedWindow (default 24h) so a long outage can't produce
      # an unbounded burst.
      onMissed: manual        # default; other options: skip | coalesce | catchup
      missedWindow: 24h       # optional; default 24h
```

**`onMissed` policies:**

- `manual` (default) — surface the missed slot on the `/schedules` UI as a **pending** row; do **not** auto-fire. The operator clicks "Fire now" or "Dismiss". Right for jobs with expensive or visible side effects (paid API calls, email blasts, Slack posts) where you want oversight without auto-replay. Default since 2026-05-03 — silent drops surprised users.
- `skip` — drop missed firings entirely. Pick this when missing slots is a non-event because the next scheduled fire will pick up where it left off (e.g., "fetch latest prices" — recency is implicit in the next fire).
- `coalesce` — fire **once now** to represent every missed slot inside `missedWindow`. Payload carries `policy: "coalesce"`, `missedCount`, `firstMissedAt`. Right for "did this happen recently?" jobs (digests, syncs) where one make-up call covers the gap.
- `catchup` — fire **each** missed slot in chronological order, one signal per slot, payload tagged `policy: "catchup"`. Right for "every tick must run" jobs (rate-limit accruals, time-series ingest, slot-numbered exports). Use when missing a slot is incorrect, not just late.

`missedWindow` (Duration: `s`/`m`/`h`, default `24h`) caps the catch-up window for every policy. A daemon down for a week with `catchup` on an hourly cron only fires the slots inside the window — never all 168.

Missed-schedule events surface on the playground `/schedules` page under "Missed schedules" and persist in the JetStream `WORKSPACE_EVENTS` stream for 30 days. `manual` events that haven't been fired/dismissed show a pending badge + action buttons.

### Concurrency policy

`concurrency` controls what happens when a new envelope for the same `(workspace, signal)` arrives while a previous cascade is still running. Orthogonal to `onMissed` (which is the downtime catch-up policy). Lives on every signal provider, not just `schedule`.

```yaml
signals:
  send-alert:
    provider: schedule
    config:
      schedule: "*/5 * * * *"
      concurrency: skip   # default; other options: queue | concurrent | replace
```

**Policies:**

- `skip` (default) — drop the new envelope if a cascade is in flight for this `(workspace, signal)`. Right for cron jobs where the next tick will run anyway and you don't want pile-up if cascades exceed the schedule.
- `queue` — serialize: chain the new envelope after the current one in arrival order. Right when every tick must eventually run; risks unbounded backlog on slow cascades.
- `concurrent` — no overlap guard, full parallelism. Right for stateless / idempotent jobs that benefit from parallel runs (independent fetches, fan-out scrapes).
- `replace` — abort the in-flight cascade and start the new one. Right for "freshest input wins" workloads (cancel-in-flight semantics for non-chat signals).

For HTTP-trigger correlated callers, `skip` and `replace` publish `ok=false` on the response subject immediately so callers don't wait out their HTTP timeout. `queue` blocks the caller until the in-flight cascade settles. `concurrent` returns each cascade's own response.

### System trigger

```yaml
signals:
  workspace-ready:
    description: "Fired when workspace runtime finishes init"
    provider: system
```

## Validation error decoder

| Code | Fix |
|---|---|
| `invalid_type` on `description` | Add `description` field |
| `invalid_type` on `config.path` | HTTP signals need `config.path` (string, unique) |
| `invalid_type` on `config.schedule` | Schedule signals need `config.schedule` (valid cron) |
| `http_path_collision` | Make each HTTP path unique |
| `cron_parse_failed` | Fix cron; use crontab.guru |
| `dead_signal` | Add a job trigger or delete the signal |

## Runtime anti-patterns

- **Schema not `type: object`**. Run dialog reads `properties`. Bare string schema or missing `properties` = no fields rendered, empty payload. Symptom: dialog says "trigger immediately" when it should ask for inputs. Fix: add `type: object`, `properties`, `required`.
- **Payload type mismatch**. Schema says `string`, caller sends `number` → signal fails with 500, session never starts. Fix: prefer `string` for IDs even if they look numeric.
- **HTTP path collision**. Two signals same `config.path` → first one wins, second unreachable. Fix: unique paths per workspace.
- **Missing timezone on cron**. Defaults UTC. 9am PST becomes 5pm. Fix: explicit `timezone`.

## Order of declaration

Signals last — nothing depends on them. But declare `schema` before you test the signal. A signal without schema may pass `validate_workspace` yet fail at runtime when the Run dialog sends `{}` to a job expecting fields.

## Assets

- `assets/minimal-http-signal.yml` — trigger, no payload
- `assets/http-signal-with-schema.yml` — trigger with typed form fields
- `assets/schedule-signal.yml` — cron trigger with timezone
