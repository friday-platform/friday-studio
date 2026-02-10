# Event Flow Reference

## Pipeline

```
Service emits event → OTLP → atlas-otel-collector → BigQuery → Grafana
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/analytics/src/types.ts` | TypeScript event constants |
| `pkg/analytics/analytics.go` | Go event constants |
| `apps/atlas-otel-collector/` | Custom OTel collector with BigQuery exporter |
| `analytics/dashboards/activation_metrics.sql` | BigQuery views |
| `infra/monitoring/friday-activation-dashboard.json` | Grafana dashboard JSON |
| `analytics/README.md` | Non-technical documentation |

## Adding Event Constants

**TypeScript** (`packages/analytics/src/types.ts`):

```typescript
export const EventNames = {
  // ... existing events
  YOUR_NEW_EVENT: "your.new_event",
} as const;
```

**Go** (`pkg/analytics/analytics.go`):

```go
const (
    // ... existing events
    EventYourNewEvent = "your.new_event"
)
```

Keep these in sync — same string values in both files.

## Emitting Events

**TypeScript** (using `@atlas/analytics`):

```typescript
import { analytics } from "@atlas/analytics";

analytics.emit({
  eventName: EventNames.YOUR_NEW_EVENT,
  userId: userId,
  workspaceId: workspaceId,  // optional
  sessionId: sessionId,      // optional
  attributes: { key: "value" },  // optional extra data
});
```

**Go** (using `pkg/analytics`):

```go
analytics.Emit(analytics.Event{
    Name:        analytics.EventYourNewEvent,
    UserID:      userID,
    WorkspaceID: workspaceID,  // optional
    SessionID:   sessionID,    // optional
    Attributes:  map[string]any{"key": "value"},  // optional
})
```

## Debugging Event Flow

### Check if events are flowing

```bash
# Recent events in BigQuery
bq query --use_legacy_sql=false \
  "SELECT event_name, COUNT(*) as count
   FROM \`tempest-production.friday_analytics.analytics_events\`
   WHERE timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
   GROUP BY event_name"
```

### Check GCP logs directly

```bash
gcloud logging read 'jsonPayload.log.type="analytics"' \
  --format=json --freshness=1h --limit=10
```
