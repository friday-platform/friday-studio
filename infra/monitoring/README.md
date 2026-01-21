# Atlas Monitoring

GCP Cloud Monitoring dashboard and observability for Atlas.

## Grafana Dashboards

### Friday Activation & Usage Metrics

Dashboard for tracking user activation funnel and usage metrics.

- **Grafana URL:** https://tempestteam.grafana.net/d/c89e9e3c-71af-4d62-87cf-a2745b85a8f8/friday-activation-and-usage-metrics
- **Data Source:** BigQuery (`tempest-production.friday_analytics`)
- **Dashboard JSON:** `friday-activation-dashboard.json`

**Panels:**
- Scorecards: Total Signups, Activated Users, Activation Rate, Median Minutes to Activation, Total Sessions, Successful Sessions
- Activation Funnel by Weekly Cohort (bar chart)
- Session Outcomes by Weekly Cohort (stacked bar)
- Time to Activation by Weekly Cohort in Minutes (bar chart)
- Usage per User by Weekly Cohort (bar chart)
- Weekly Cohort Funnel Table
- Session Outcomes Table

**To restore/update:**
```bash
# Import via Grafana API
curl -X POST \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  "https://tempestteam.grafana.net/api/dashboards/db" \
  -d "{\"dashboard\": $(cat friday-activation-dashboard.json), \"overwrite\": true}"
```

**BigQuery Views:** See `analytics/dashboards/activation_metrics.sql`

## Dashboard IDs

- Production: `projects/180211378242/dashboards/38286001-e8a9-49a4-a47f-9731d5a632bf`
- Sandbox: `projects/415092695556/dashboards/05c116e3-b402-4831-ba37-4542c7fc2ceb`

## Deploy Dashboard

```bash
# Create (first time)
gcloud monitoring dashboards create \
  --config-from-file=atlas-dashboard.json \
  --project=tempest-production

# List dashboards to find ID
gcloud monitoring dashboards list --project=tempest-production

# Update existing (requires etag in JSON)
gcloud monitoring dashboards describe DASHBOARD_ID --project=tempest-production --format=json > /tmp/current.json
# Edit /tmp/current.json, keeping the etag
gcloud monitoring dashboards update DASHBOARD_ID \
  --config-from-file=/tmp/current.json \
  --project=tempest-production
```

## Metrics Reference

### Daemon Metrics (atlasd)

| Metric | Type | Description |
|--------|------|-------------|
| `atlasd_active_workspaces` | gauge | Loaded workspace runtimes |
| `atlasd_sse_connections` | gauge | Active SSE connections |
| `atlasd_sessions_total` | counter | Sessions by status |
| `atlasd_signal_triggers_total` | counter | Signals by provider |
| `atlasd_mcp_tool_calls_total` | counter | Tool calls by name |

Source: `src/utils/metrics.ts`

**Important:** OTEL metrics require `OTEL_DENO=true` set at **compile time**. The config is
baked into the binary by `deno compile`. See `Dockerfile` line 40.

### Operator Metrics (atlas-operator)

| Metric | Type | Description |
|--------|------|-------------|
| `atlas_operator_users_total` | gauge | Managed users |
| `atlas_operator_reconciliation_duration_seconds` | histogram | Reconciliation time (has `status` label) |
| `atlas_operator_applications_created_total` | counter | Apps created |
| `atlas_operator_applications_deleted_total` | counter | Apps deleted |

Source: `apps/atlas-operator/cmd/manager/main.go`

## LLM & MCP Latency

LLM and MCP latency data is in Cloud Trace, not this dashboard.

View traces: https://console.cloud.google.com/traces/list?project=tempest-production

Useful filters:
- Slow LLM calls: `llm.generation_latency > 10000`
- MCP errors: `mcp.error_category`
- High token usage: `llm.inputTokens > 50000`

Source: `src/utils/telemetry.ts`

## Alert Policies

Alert policy YAML files are in `alerts/`. To recreate an alert:

```bash
gcloud alpha monitoring policies create \
  --policy-from-file=alerts/<alert-name>.yaml \
  --project=tempest-production
```

### Active Alerts

| Alert | Severity | Condition | Notification |
|-------|----------|-----------|--------------|
| GKE Container Restarts | Warning | >5 restarts in 10min (cluster-wide) | PagerDuty |
| Deployment Replicas Not Updated | Critical | Replicas mismatch for 30min (excludes atlas ns) | PagerDuty |
| Infrastructure Pod Restart Loop | Warning | >3 restarts in 10min | Slack |
| User Atlas Pod Restart Loop | Warning | >3 restarts in 10min | Slack |
| High Memory Usage | Warning | >80% limit for 5min | Slack |
| High CPU Usage | Warning | >80% limit for 10min | Slack |
| LLM Budget Warning | Warning | $50-$100 remaining | Slack |
| LLM Budget Critical | Critical | <$50 remaining | PagerDuty + Slack |

### LLM Budget Alerts

Budget alerts use `litellm_remaining_api_key_budget_metric` (a gauge that syncs from DB) instead of
`litellm_spend_metric_total` (a counter that resets on pod restart).

**Why remaining budget instead of spend counter?**
- The spend counter resets when LiteLLM pods restart
- User could accumulate spend over time but Prometheus only sees spend since last restart
- Remaining budget gauge reflects actual DB state, persists across restarts

**Query pattern:**
```promql
min by (api_key_alias) (litellm_remaining_api_key_budget_metric < +Inf) < 50
```
- `< +Inf` filters out workspaces without budget limits (infinite remaining)
- `min by` takes minimum across pods (each pod reports independently)
- `api_key_alias` format is `atlas-<workspace_id>` (e.g., `atlas-d401m99q1relnrg`)

**When you receive an alert:**

1. **Check actual spend in LiteLLM database:**
   ```bash
   psql "postgresql://postgres:$(gcloud secrets versions access latest --secret=litellm-config --project=tempest-production | grep database_url | cut -d: -f3 | cut -d@ -f1)@db.azaiddurrgijgnavxpdi.supabase.co:5432/litellm" \
     -c "SELECT key_alias, spend, max_budget FROM \"LiteLLM_VerificationToken\" WHERE key_alias = 'atlas-<workspace_id>';"
   ```

2. **To increase budget** (use LiteLLM API to update both DB and cache):
   ```bash
   # Get the key token
   TOKEN=$(psql "..." -t -c "SELECT token FROM \"LiteLLM_VerificationToken\" WHERE key_alias = 'atlas-<workspace_id>';")

   # Update via API
   kubectl port-forward svc/litellm-proxy 4000:4000 -n atlas-operator &
   curl -X POST "http://localhost:4000/key/update" \
     -H "Authorization: Bearer $(gcloud secrets versions access latest --secret=litellm-master-key --project=tempest-production)" \
     -H "Content-Type: application/json" \
     -d "{\"key\": \"$TOKEN\", \"max_budget\": 300}"
   ```

3. **If you updated DB directly** (not recommended), restart LiteLLM to sync:
   ```bash
   kubectl rollout restart deployment/litellm-proxy -n atlas-operator
   ```

**Note:** The metric only updates when the workspace makes LLM requests. After increasing budget, the alert will auto-close once the user makes a request and Prometheus scrapes the new value.

### Alert Auto-Close Policy

All alerts use `autoClose: 3600s` (1 hour) with `notificationPrompts: [OPENED, CLOSED]`.
This ensures PagerDuty/Slack receive resolution notifications when alerts auto-close.

**Important**: GCP Monitoring does NOT auto-resolve alerts when conditions clear.
Alerts stay open until the `autoClose` duration expires after the last violation.

### Blocked Alerts (need prometheus metrics)

| Alert | Issue |
|-------|-------|
| Operator Reconciliation Errors | Metric `atlas_operator_reconciliation_duration_seconds` not found |
| Session Failure Spike | Metric `atlasd_sessions_total` not found |

### Notification Channels

```bash
# List channels
gcloud alpha monitoring channels list --project=tempest-production

# Production Slack (#atlas-production-alerts)
projects/tempest-production/notificationChannels/3729882950865339162

# PagerDuty (tempest-production)
projects/tempest-production/notificationChannels/16532143224266859840

# LLM Budget Alerts Slack
projects/tempest-production/notificationChannels/5987427949135056090

# LLM Budget Alerts PagerDuty
projects/tempest-production/notificationChannels/12225858896805377076
```
