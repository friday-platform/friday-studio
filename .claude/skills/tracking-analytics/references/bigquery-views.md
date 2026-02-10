# BigQuery Views & Grafana Dashboard

## Raw Events Table

`tempest-production.friday_analytics.analytics_events`

## Pre-built Views

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

## Updating BigQuery Views

If a new event should appear in dashboard metrics, update
`analytics/dashboards/activation_metrics.sql`.

Example — adding a count to the overall summary:

```sql
-- In the overall_summary view
(SELECT COUNT(*) FROM `tempest-production.friday_analytics.analytics_events`
 WHERE event_name = 'your.new_event' AND environment = 'production') AS total_your_events,
```

Apply views to BigQuery:

```bash
bq query --use_legacy_sql=false < analytics/dashboards/activation_metrics.sql
```

## Query Examples

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

## Grafana Dashboard

**URL:** https://tempestteam.grafana.net/d/c89e9e3c-71af-4d62-87cf-a2745b85a8f8

Dashboard shows:
- **Top row**: Key metrics (signups, activated users, rates, artifacts, gists)
- **Funnel charts**: Weekly cohort progression
- **Time to milestone**: How fast users move through funnel
- **Session outcomes**: Success vs failure rates
- **Detailed tables**: Exact numbers per cohort

### Updating the Dashboard

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
