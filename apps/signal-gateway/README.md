# Signal Gateway

Event routing gateway for Slack integration. Routes Slack events to user Atlas instances based on team-to-user mapping.

## Architecture

**Key Features:**
- Slack HTTP webhooks with signature verification (Events API)
- Database-backed routing with in-memory caching (5-minute TTL)
- Stateless callback pattern for async Atlas responses
- High availability with horizontal scaling (Deployment, not StatefulSet)

## Quick Start

### Prerequisites

- Go 1.25.4+
- PostgreSQL 14+ with migrations applied
- Slack bot token and signing secret

### Local Development

1. **Copy environment configuration:**
   ```bash
   cp .env.example .env
   # Edit .env with your Slack credentials and database connection
   ```

2. **Run database migrations:**
   ```bash
   psql $POSTGRES_CONNECTION -f ../../supabase/migrations/20251210000000_create_platform_route_table.sql
   ```

3. **Build the service:**
   ```bash
   go build -o signal-gateway .
   ```

4. **Run locally:**
   ```bash
   ./signal-gateway
   ```

   The service will start on port 8080 (HTTPS) and 9090 (metrics).

### Local Development Configuration

For local testing without K8s infrastructure, use HTTP URLs in `.env`:

```bash
# Local Atlas instance (no user_id substitution)
ATLAS_URL_TEMPLATE=http://localhost:8080

# Local callback endpoint
CALLBACK_URL_PREFIX=http://localhost:8081/callback

# Disable TLS for local testing
# (Comment out TLS_* variables or don't set them)
```

## Testing

Run all tests:
```bash
go test ./...
```

Run with race detector:
```bash
go test -race ./...
```

Run specific test:
```bash
go test ./service -run TestParseSlackCallback
```

## Deployment

### Production Deployment

Signal Gateway is deployed to Kubernetes as a **Deployment** (not StatefulSet) since it's a stateless HTTP service.

**Kubernetes manifests location:** https://github.com/tempestteam/tempest-kustomize

Key resources:
- **Deployment** - 2+ replicas, horizontally scalable
- **Service** (ClusterIP) - Internal callbacks from Atlas pods
- **IngressRoute** (Traefik) - External Slack webhooks
- **NetworkPolicy** - Restricts callback access to Atlas namespace
- **Certificate** (cert-manager) - TLS certificates
- **ServiceAccount** - GCP service account for secrets access

### Environment Variables (Production)

```bash
# Service
SERVICE_NAME=signal-gateway
PORT=8080
METRICS_PORT=9090
LOG_LEVEL=info

# Database (read-only access)
POSTGRES_CONNECTION=postgresql://...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=abc123...

# Atlas routing
ATLAS_URL_TEMPLATE=https://atlas-%s.atlas.svc.cluster.local
CALLBACK_URL_PREFIX=https://signal-gateway.atlas-operator.svc.cluster.local/callback

# Timeouts & Cache
ATLAS_TIMEOUT_SECONDS=10
ROUTE_CACHE_TTL_MINUTES=5

# TLS (handled by cert-manager)
TLS_CERTIFICATE_PATH=/cert-volume/tls.crt
TLS_KEY_PATH=/cert-volume/tls.key
TLS_CA_PATH=/cert-volume/ca.crt
```

### Secrets Management

Secrets are stored in Google Secret Manager and loaded via `gsm-init` init container.

**GSM Secret:** `signal-gateway-env`

**Required secrets:**
- `POSTGRES_CONNECTION` - Database connection string
- `SLACK_BOT_TOKEN` - Slack bot user OAuth token (`xoxb-...`)
- `SLACK_SIGNING_SECRET` - Slack signing secret for webhook verification

### Scaling

Signal Gateway is stateless and scales horizontally:

```bash
kubectl scale deployment signal-gateway --replicas=5 -n atlas-operator
```

Load balancing:
- **External webhooks** - Traefik load balances Slack webhook requests
- **Internal callbacks** - Kubernetes Service load balances Atlas callback requests

### Health Checks

- **Liveness probe:** `GET /livez` - Returns 200 if process is responsive
- **Readiness probe:** `GET /healthz` - Returns 200 if database is healthy

Both probes use HTTPS on port 8080.

### Monitoring

**Metrics endpoint:** `https://signal-gateway.atlas-operator.svc.cluster.local:9090/metrics`

Prometheus scrapes metrics automatically via ServiceMonitor.

**Key metrics:**
- HTTP request latency and error rates
- Database query performance
- Cache hit/miss ratio
- Slack webhook processing time

**Logs:** Structured JSON logs sent to OTEL collector.

## Database Schema

Signal Gateway has **read-only access** to `public.platform_route` table.

**Table structure:**
```sql
CREATE TABLE public.platform_route (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES public."user"(id),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
```

**Query pattern:**
```sql
SELECT user_id FROM platform_route WHERE team_id = $1;
```

Routes are **created by Link Service** during Slack OAuth flow.

## Slack Configuration

### Slack App Setup

1. Create Slack app at https://api.slack.com/apps
2. Enable **Events API** (not Socket Mode)
3. Set event webhook URL: `https://signal.atlas.tempestdx.io/webhook/slack`
4. Subscribe to bot events:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - `app_mention`
5. Install app to workspace

### Bot Token Scopes

Required OAuth scopes:
- `channels:history` - Read messages in public channels
- `groups:history` - Read messages in private channels
- `im:history` - Read direct messages
- `mpim:history` - Read messages in multi-party DMs
- `chat:write` - Send messages

### Event Verification

Signal Gateway verifies Slack requests using HMAC-SHA256 signature validation per [Slack's verification docs](https://docs.slack.dev/messaging/webhooks/verifying-requests-from-slack).

## Troubleshooting

### Common Issues

**1. "No route found for Slack team"**
- Route doesn't exist in database
- User hasn't completed OAuth flow in Link Service
- Check: `SELECT * FROM platform_route WHERE team_id = 'T1234567'`

**2. "Atlas instance unreachable"**
- User's Atlas instance is down
- Check: `kubectl get pods -n atlas -l user_id=abc123`
- Network policy blocking traffic
- Check service URL construction in logs

**3. "Slack signature verification failed"**
- Wrong signing secret in config
- Clock skew > 5 minutes
- Replay attack (timestamp too old)

### Debug Mode

Enable debug logging:
```bash
LOG_LEVEL=debug
```

Debug logs include:
- Full request/response payloads
- Cache hit/miss details
- Database query timing
- Event routing decisions

## Development

### Code Generation

This service uses [sqlc](https://sqlc.dev/) for type-safe database queries.

**Regenerate after schema changes:**
```bash
cd apps/signal-gateway
sqlc generate
```

Generated code location: `repo/query.sql.go`

### Code Structure

```
apps/signal-gateway/
├── main.go                 # Service entry point
├── service/
│   ├── service.go         # Service initialization & HTTP setup
│   ├── slack.go           # Slack webhook handler
│   ├── router.go          # Event routing & caching
│   ├── callback.go        # Atlas callback handler
│   ├── config.go          # Configuration structs
│   └── log.go             # Logging setup
└── repo/
    ├── pool.go            # Database connection pool
    ├── query.sql          # SQL queries (sqlc source)
    ├── query.sql.go       # Generated code (DO NOT EDIT)
    └── sqlc.yaml          # sqlc configuration
```

### Adding Features

1. **New Slack event types:** Update `processSlackEvent()` in `slack.go`
2. **New callback platforms:** Add handler in `callback.go`, update router
3. **Schema changes:** Update migration → regenerate sqlc → update queries

## References

- [Slack Events API](https://docs.slack.dev/apis/events-api)
- [Slack Request Verification](https://docs.slack.dev/messaging/webhooks/verifying-requests-from-slack)
- [sqlc Documentation](https://sqlc.dev/)
- [Kubernetes Manifests](https://github.com/tempestteam/tempest-kustomize)
