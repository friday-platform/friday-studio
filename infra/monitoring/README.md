# Atlas Monitoring

GCP Cloud Monitoring dashboard and observability for Atlas.

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
| Infrastructure Pod Restart Loop | Warning | >3 restarts in 10min | Slack |
| User Atlas Pod Restart Loop | Warning | >3 restarts in 10min | Slack |
| High Memory Usage | Warning | >80% limit for 5min | Slack |
| High CPU Usage | Warning | >80% limit for 10min | Slack |

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
```
