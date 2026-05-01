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
```

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
