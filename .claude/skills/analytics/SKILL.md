---
name: analytics
description: Use when adding, modifying, or debugging analytics events - covers event constants, BigQuery views, Grafana dashboard updates, and documentation.
---

# Friday Analytics

Analytics events flow: Service emits event → OTLP → atlas-otel-collector → BigQuery → Grafana

## Key Files

| File | Purpose |
|------|---------|
| `packages/analytics/src/types.ts` | TypeScript event constants |
| `pkg/analytics/analytics.go` | Go event constants |
| `apps/atlas-otel-collector/` | Custom OTel collector with BigQuery exporter |
| `analytics/dashboards/activation_metrics.sql` | BigQuery views |
| `infra/monitoring/friday-activation-dashboard.json` | Grafana dashboard JSON |
| `analytics/README.md` | Non-technical documentation |

## Adding New Events

### 1. Add Event Constants

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

Keep these in sync - same string values in both files.

### 2. Emit the Event

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

### 3. Update BigQuery Views (if needed)

If the event should appear in dashboard metrics, update `analytics/dashboards/activation_metrics.sql`.

Example - adding a count to the overall summary:

```sql
-- In the overall_summary view
(SELECT COUNT(*) FROM `tempest-production.friday_analytics.analytics_events`
 WHERE event_name = 'your.new_event' AND environment = 'production') AS total_your_events,
```

Apply views to BigQuery:

```bash
bq query --use_legacy_sql=false < analytics/dashboards/activation_metrics.sql
```

### 4. Update Grafana Dashboard

Edit `infra/monitoring/friday-activation-dashboard.json`:

1. Find the appropriate panel section
2. Add new stat panel or modify existing query
3. Update `gridPos` for layout

Push dashboard via API:

```bash
# Get dashboard UID from URL: .../d/<UID>/...
DASHBOARD_UID="c89e9e3c-71af-4d62-87cf-a2745b85a8f8"
GRAFANA_TOKEN="your-token"

# Update dashboard
curl -X POST "https://tempestteam.grafana.net/api/dashboards/db" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d @infra/monitoring/friday-activation-dashboard.json
```

### 5. Update README

If the event is user-facing or part of the activation funnel, update `analytics/README.md`:

- Add to the event table in "What We Track"
- Update funnel description if it's a funnel event
- Update dashboard description if adding new panels

## BigQuery Queries

Raw events table: `tempest-production.friday_analytics.analytics_events`

Pre-built views:

| View | Purpose |
|------|---------|
| `user_cohorts` | Users grouped by signup week |
| `user_funnel_events` | First occurrence of each funnel event per user |
| `activation_funnel_by_cohort` | Weekly funnel conversion rates |
| `time_to_activation_by_cohort` | Time from signup to each milestone |
| `session_success_by_cohort` | Session success/failure rates |
| `user_usage_metrics` | Per-user activity counts |
| `usage_summary_by_cohort` | Aggregated usage per cohort |
| `overall_summary` | High-level KPIs for scorecards |

Query examples:

```bash
# Recent events
bq query --use_legacy_sql=false \
  "SELECT * FROM \`tempest-production.friday_analytics.analytics_events\`
   WHERE event_name = 'your.new_event'
   ORDER BY timestamp DESC LIMIT 10"

# Event counts by day
bq query --use_legacy_sql=false \
  "SELECT DATE(timestamp) as day, COUNT(*) as count
   FROM \`tempest-production.friday_analytics.analytics_events\`
   WHERE event_name = 'your.new_event' AND environment = 'production'
   GROUP BY day ORDER BY day DESC"
```

## Debugging

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

## Grafana Dashboard

URL: https://tempestteam.grafana.net/d/c89e9e3c-71af-4d62-87cf-a2745b85a8f8

Dashboard shows:
- **Top row**: Key metrics (signups, activated users, rates, artifacts, gists)
- **Funnel charts**: Weekly cohort progression
- **Time to milestone**: How fast users move through funnel
- **Session outcomes**: Success vs failure rates
- **Detailed tables**: Exact numbers per cohort

## Checklist for New Events

- [ ] Add constant to `packages/analytics/src/types.ts`
- [ ] Add constant to `pkg/analytics/analytics.go`
- [ ] Emit event from relevant service
- [ ] Test event appears in BigQuery (wait ~1 min for propagation)
- [ ] Update BigQuery views if needed
- [ ] Update Grafana dashboard if needed
- [ ] Update `analytics/README.md` if user-facing
