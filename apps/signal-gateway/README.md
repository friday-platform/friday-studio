# Signal Gateway

Event routing gateway for Slack integration. Routes Slack events to user Atlas instances based on team-to-user mapping.

## Architecture

**Key Features:**
- Slack HTTP webhooks with signature verification (Events API)
- Database-backed routing with in-memory caching (5-minute TTL)
- Stateless HTTP forwarding to Atlas instances
- High availability with horizontal scaling (Deployment, not StatefulSet)

## Quick Start

### Prerequisites

- Go 1.25.4+
- PostgreSQL 14+ with migrations applied
- Slack signing secret (for webhook verification)

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

# Disable TLS for local testing
# (Comment out TLS_* variables or don't set them)
```

### Running with dev:full

Signal-gateway is included in `deno task dev:full` but only runs if you have the env file configured.

**1. Create your own Slack test app:**

Each developer needs their own Slack app since the webhook URL (ngrok) is unique per developer.

1. Go to https://api.slack.com/apps and create a new app (choose "From scratch")
2. Go to **Basic Information** → copy the **Signing Secret** (this is what signal-gateway needs)
3. Go to **OAuth & Permissions** → add the following bot scopes:
   - `app_mentions:read` - Receive @mentions
   - `channels:history`, `channels:read` - Public channel access
   - `groups:history`, `groups:read` - Private channel access
   - `im:history`, `im:read`, `im:write` - Direct message access
   - `mpim:history`, `mpim:read`, `mpim:write` - Group DM access
   - `chat:write` - Send messages
   - `users:read` - User directory access
4. Install the app to your test workspace

**2. Create the env file:**

> ⚠️ **Cannot use shared 1Password secrets**: Each developer must create their own Slack app because the webhook URL (ngrok) is unique per developer. You cannot share Slack app credentials from 1Password for local testing.

```bash
cat > ~/.atlas/signal-gateway.env << 'EOF'
SLACK_SIGNING_SECRET=your-signing-secret-here
POSTGRES_CONNECTION=postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable
ATLAS_URL_TEMPLATE=http://localhost:8080
LOG_LEVEL=debug
EOF
chmod 600 ~/.atlas/signal-gateway.env
```

> **Note:** Signal-gateway only needs the signing secret (for verifying webhook requests). It does NOT need a bot token - that's handled by Link service during OAuth.

**3. Expose signal-gateway with ngrok:**

Slack needs a public URL to send webhooks. Use ngrok to tunnel to your local signal-gateway:

```bash
# Install ngrok if needed
brew install ngrok  # macOS

# Start tunnel (signal-gateway runs on port 8081 in dev:full)
ngrok http 8081
```

Copy the HTTPS URL from ngrok output (e.g., `https://abc123.ngrok.io`).

**4. Configure Slack Event Subscriptions:**

1. Go to your Slack app at https://api.slack.com/apps
2. Navigate to **Event Subscriptions**
3. Toggle **Enable Events** to ON
4. Set **Request URL** to: `https://your-ngrok-url/webhook/slack`
5. Wait for Slack to verify the URL (signal-gateway must be running)
6. Under **Subscribe to bot events**, add the events you want to handle:
   - `message.im` - Direct messages to the bot (recommended for testing)
   - `app_mention` - @mentions in channels
   - Optionally: `message.channels`, `message.groups`, `message.mpim` for broader message handling
7. Click **Save Changes**

> **Minimal setup for testing:** Just `message.im` and `app_mention` are enough to verify the flow works.

**5. Create a test route:**

Signal-gateway needs a `platform_route` entry to know where to forward messages. Either complete the OAuth flow via Link, or insert manually:

```bash
psql postgresql://postgres:postgres@localhost:54322/postgres << 'EOF'
INSERT INTO platform_route (id, team_id, user_id, created_at, updated_at)
VALUES (gen_random_uuid()::text, 'YOUR_SLACK_TEAM_ID', 'test-user', now(), now())
ON CONFLICT (team_id) DO UPDATE SET user_id = EXCLUDED.user_id;
EOF
```

Find your Slack Team ID in your app's **Basic Information** page.

**6. Run dev:full:**

```bash
deno task dev:full
```

Signal-gateway will start on port 8081. Send a DM to your bot in Slack to test the flow.

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
- **Service** (ClusterIP) - Internal service discovery
- **IngressRoute** (Traefik) - External Slack webhooks
- **NetworkPolicy** - Restricts traffic to Atlas namespace
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

# Slack (signing secret for webhook verification)
SLACK_SIGNING_SECRET=abc123...

# Atlas routing
ATLAS_URL_TEMPLATE=https://atlas-%s.atlas.svc.cluster.local

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
- `SLACK_SIGNING_SECRET` - Slack signing secret for webhook verification

### Scaling

Signal Gateway is stateless and scales horizontally:

```bash
kubectl scale deployment signal-gateway --replicas=5 -n atlas-operator
```

Load balancing:
- **External webhooks** - Traefik load balances Slack webhook requests

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
3. Set event webhook URL: `https://signal.atlas.tempestdx.io/webhook/slack` (production) or your ngrok URL (development)
4. Subscribe to bot events:
   - `message.im` - Direct messages
   - `app_mention` - @mentions
   - Optionally: `message.channels`, `message.groups`, `message.mpim`
5. Add OAuth scopes (see [Slack App Scopes](#slack-app-scopes) below)
6. Install app to workspace

### Slack App Scopes

These OAuth scopes are configured on your Slack app (not signal-gateway itself). Signal-gateway only needs the signing secret for webhook verification - it never calls Slack APIs.

**Required scopes** (set in OAuth & Permissions):
- `app_mentions:read` - Receive @mention events
- `channels:history`, `channels:read` - Public channel access
- `groups:history`, `groups:read` - Private channel access
- `im:history`, `im:read`, `im:write` - Direct message access
- `mpim:history`, `mpim:read`, `mpim:write` - Group DM access
- `chat:write` - Send messages (used by Atlas, not signal-gateway)
- `users:read` - User directory (used by slack-mcp-server)

> **Note:** The bot token (`xoxb-...`) is stored by Link service after OAuth and used by Atlas to send replies. Signal-gateway is receive-only - it just forwards incoming webhooks to Atlas.

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
│   ├── context.go         # Request context helpers
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
2. **New signal platforms:** Add handler in appropriate file, update router
3. **Schema changes:** Update migration → regenerate sqlc → update queries

## References

- [Slack Events API](https://docs.slack.dev/apis/events-api)
- [Slack Request Verification](https://docs.slack.dev/messaging/webhooks/verifying-requests-from-slack)
- [sqlc Documentation](https://sqlc.dev/)
- [Kubernetes Manifests](https://github.com/tempestteam/tempest-kustomize)
